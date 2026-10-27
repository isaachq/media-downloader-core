// Integration tests for the integrity guarantees. They synthesize media with
// ffmpeg, damage it on purpose, and check that validation catches every case.
// Skipped automatically when ffmpeg/ffprobe aren't installed.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {toExecutable} from '../src/binaries/executable.js'
import {ensureContainer} from '../src/core/convert.js'
import {AUDIO_RULES, VIDEO_RULES} from '../src/core/formats.js'
import {run} from '../src/core/process.js'
import {validateFile} from '../src/core/validate.js'
import type {ValidationReport} from '../src/types.js'

const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg'
const FFPROBE = process.env['FFPROBE'] ?? 'ffprobe'

const available = await run(FFMPEG, ['-version'])
  .then(r => r.code === 0)
  .catch(() => false)

let dir = ''

async function make(name: string, args: string[]): Promise<string> {
  const out = path.join(dir, name)
  const result = await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args, out])
  assert.equal(result.code, 0, result.stderr)
  return out
}

/** ffmpeg input from a lavfi generator (test patterns, tones). */
const generated = (source: string) => ['-f', 'lavfi', '-i', source]

const testVideo = (seconds: number) => [
  ...generated(`testsrc2=size=640x360:rate=30:duration=${seconds}`),
  ...generated(`sine=frequency=440:sample_rate=48000:duration=${seconds}`),
]

const codes = (report: ValidationReport) => report.issues.map(i => i.code)
const explain = (report: ValidationReport) => report.issues.map(i => `${i.code}: ${i.message}`).join('\n')

const base = {ffmpeg: toExecutable(FFMPEG), ffprobe: toExecutable(FFPROBE), threads: 2, expectAudio: true}

describe('integrity validation', {skip: !available && 'ffmpeg not installed'}, () => {
  let mp4 = ''
  let webm = ''
  let m4a = ''

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-integrity-'))
    // faststart puts the index first, so a truncated file still *opens* —
    // the hardest truncation case to detect
    mp4 = await make('ok.mp4', [
      ...testVideo(10),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
    ])
    webm = await make('ok.webm', [
      ...testVideo(6),
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-c:a',
      'libopus',
    ])
    m4a = await make('ok.m4a', [...generated('sine=frequency=440:duration=8'), '-c:a', 'aac'])
  })

  after(async () => {
    if (dir) await fs.rm(dir, {recursive: true, force: true})
  })

  it('smoke: accepts an intact H.264/AAC mp4 (full decode)', async () => {
    const report = await validateFile({...base, file: mp4, rules: VIDEO_RULES.mp4, level: 'full', expectedDuration: 10})
    assert.equal(report.ok, true, explain(report))
    assert.equal(report.video?.codec, 'h264')
    assert.equal(report.audio?.codec, 'aac')
    assert.ok(report.decodedDuration! > 9.5)
  })

  it('rejects a truncated file (download cut at 60%)', async () => {
    const data = await fs.readFile(mp4)
    const cut = path.join(dir, 'truncated.mp4')
    await fs.writeFile(cut, data.subarray(0, Math.floor(data.length * 0.6)))
    for (const level of ['quick', 'full'] as const) {
      const report = await validateFile({...base, file: cut, rules: VIDEO_RULES.mp4, level, expectedDuration: 10})
      assert.equal(report.ok, false, `${level} accepted a truncated file`)
    }
  })

  it('rejects bit corruption in the middle of the stream (full decode)', async () => {
    const data = Buffer.from(await fs.readFile(mp4))
    const start = Math.floor(data.length * 0.5)
    for (let i = start; i < start + 4096; i++) data[i] = (data[i]! * 31 + 7) & 0xff
    const corrupt = path.join(dir, 'corrupt.mp4')
    await fs.writeFile(corrupt, data)
    const report = await validateFile({
      ...base,
      file: corrupt,
      rules: VIDEO_RULES.mp4,
      level: 'full',
      expectedDuration: 10,
    })
    assert.equal(report.ok, false)
    assert.ok(
      codes(report).some(c => c === 'decode-errors' || c === 'decode-failed' || c === 'incomplete-decode'),
      explain(report),
    )
  })

  it('rejects a file whose duration does not match the site metadata', async () => {
    const report = await validateFile({
      ...base,
      file: mp4,
      rules: VIDEO_RULES.mp4,
      level: 'quick',
      expectedDuration: 60,
    })
    assert.equal(report.ok, false)
    assert.deepEqual(codes(report), ['duration-mismatch'])
  })

  it('rejects VP9/Opus labelled as the mp4 profile', async () => {
    const report = await validateFile({...base, file: webm, rules: VIDEO_RULES.mp4, level: 'quick'})
    assert.equal(report.ok, false)
    assert.ok(codes(report).includes('unexpected-video-codec'))
    assert.ok(codes(report).includes('unexpected-audio-codec'))
    assert.ok(codes(report).includes('unexpected-container'))
  })

  it('converts VP9/Opus into a valid H.264/AAC mp4', async () => {
    const copy = path.join(dir, 'source.webm')
    await fs.copyFile(webm, copy)
    let progressed = false
    const out = await ensureContainer({
      ...base,
      input: copy,
      container: 'mp4',
      onProgress: () => (progressed = true),
    })
    assert.equal(path.extname(out), '.mp4')
    assert.ok(progressed)
    const report = await validateFile({...base, file: out, rules: VIDEO_RULES.mp4, level: 'full', expectedDuration: 6})
    assert.equal(report.ok, true, explain(report))
    assert.equal(report.video?.codec, 'h264')
  })

  it('remuxes without re-encoding when only the container is wrong', async () => {
    // H.264/AAC inside mkv → mp4 should be a stream copy (fast, lossless)
    const mkv = await make('h264.mkv', ['-i', mp4, '-c', 'copy'])
    const started = Date.now()
    const out = await ensureContainer({...base, input: mkv, container: 'mp4'})
    assert.equal(path.extname(out), '.mp4')
    assert.ok(Date.now() - started < 5000)
    const report = await validateFile({...base, file: out, rules: VIDEO_RULES.mp4, level: 'full', expectedDuration: 10})
    assert.equal(report.ok, true, explain(report))
  })

  it('smoke: accepts an intact m4a and rejects it as mp3', async () => {
    const ok = await validateFile({...base, file: m4a, rules: AUDIO_RULES.m4a, level: 'full', expectedDuration: 8})
    assert.equal(ok.ok, true, explain(ok))
    const wrong = await validateFile({...base, file: m4a, rules: AUDIO_RULES.mp3, level: 'quick'})
    assert.equal(wrong.ok, false)
  })

  it('treats embedded cover art as a picture, not a video track', async () => {
    const cover = await make('cover.jpg', [...generated('color=red:size=300x300'), '-frames:v', '1'])
    const mp3 = await make('with-cover.mp3', [
      ...generated('sine=duration=5'),
      '-i',
      cover,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'libmp3lame',
      '-c:v',
      'mjpeg',
      '-disposition:v',
      'attached_pic',
    ])
    const report = await validateFile({...base, file: mp3, rules: AUDIO_RULES.mp3, level: 'full', expectedDuration: 5})
    assert.equal(report.ok, true, explain(report))
  })

  it('rejects empty and missing files', async () => {
    const empty = path.join(dir, 'empty.mp4')
    await fs.writeFile(empty, '')
    const emptyReport = await validateFile({...base, file: empty, rules: VIDEO_RULES.mp4, level: 'full'})
    assert.deepEqual(codes(emptyReport), ['file-empty'])
    const missing = await validateFile({
      ...base,
      file: path.join(dir, 'nope.mp4'),
      rules: VIDEO_RULES.mp4,
      level: 'full',
    })
    assert.deepEqual(codes(missing), ['file-missing'])
  })
})
