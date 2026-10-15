// Format regression plan, phase C5/C7: what happens at the edges of a conversion —
// a cancel in the middle of it, a file whose name lies about its container, the right
// container with the wrong codec, a cap above the source. Real ffmpeg on synthetic clips.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {ensureContainer, extractAudio} from '../src/core/convert.js'
import {checkVerdict, isTransformationDefect} from '../src/core/damaged.js'
import {DownloadError} from '../src/core/errors.js'
import {VIDEO_RULES} from '../src/core/formats.js'
import {run} from '../src/core/process.js'
import {ffprobe, summarizeProbe, validateFile} from '../src/core/validate.js'
import type {ProcessingKind} from '../src/types.js'
import {MediaLab} from './helpers/media-lab.js'

const ffmpeg = {command: 'ffmpeg', args: []}
const ffprobeExe = {command: 'ffprobe', args: []}
const available = await run('ffmpeg', ['-version']).then(
  result => result.code === 0,
  () => false,
)

let dir = ''
let lab: MediaLab

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-resilience-'))
  lab = new MediaLab(path.join(dir, 'fixtures'))
})
after(async () => {
  await fs.rm(dir, {recursive: true, force: true})
})

/** A fresh copy of a fixture, in its own folder, so what a step leaves behind is visible. */
async function copyOf(name: Parameters<MediaLab['fixture']>[0], as: string): Promise<{file: string; folder: string}> {
  const folder = path.join(dir, as.replace(/\W+/g, '-'))
  await fs.mkdir(folder, {recursive: true})
  const file = path.join(folder, as)
  await fs.copyFile(await lab.fixture(name), file)
  return {file, folder}
}

const cancelled = (error: unknown) => error instanceof DownloadError && error.code === 'cancelled'

/** An ffmpeg stand-in: a node script that answers every call the way `body` says (the real ffprobe beside it). */
async function scriptedFfmpeg(name: string, body: string): Promise<{command: string; args: string[]}> {
  const file = path.join(dir, `${name}.cjs`)
  await fs.writeFile(file, body)
  return {command: process.execPath, args: [file]}
}

describe('conversion resilience', {skip: !available && 'ffmpeg not installed'}, () => {
  it('a cancel during a transcode rejects as cancelled and leaves no output behind', async () => {
    const {file, folder} = await copyOf('webm-vp9-opus-720', 'clip.webm')
    const controller = new AbortController()
    await assert.rejects(
      ensureContainer({
        ffmpeg,
        ffprobe: ffprobeExe,
        input: file,
        container: 'mp4',
        expectAudio: true,
        threads: 2,
        signal: controller.signal,
        // the conversion is about to start: cancel it there, before or as ffmpeg spawns
        onStart: () => controller.abort(),
      }),
      cancelled,
    )
    assert.deepEqual(await fs.readdir(folder), ['clip.webm'], 'the input stays, no partial output')
  })

  it('a cancel during an audio extraction rejects as cancelled and leaves no output behind', async () => {
    // a minute of sound: the MP3 encoder reports progress several times before it is done,
    // and the first report is where the cancel lands
    const folder = path.join(dir, 'extract-cancel')
    await fs.mkdir(folder, {recursive: true})
    const file = path.join(folder, 'long.m4a')
    const made = await run('ffmpeg', [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=60:frequency=440',
      '-c:a',
      'aac',
      file,
    ])
    assert.equal(made.code, 0, made.stderr)
    const controller = new AbortController()
    await assert.rejects(
      extractAudio({
        ffmpeg,
        ffprobe: ffprobeExe,
        input: file,
        container: 'mp3',
        threads: 2,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
      cancelled,
    )
    assert.deepEqual(await fs.readdir(folder), ['long.m4a'])
  })

  it('a valid file under a false extension is a transformation defect, and the remux makes it real', async () => {
    // an MP4 named .mkv: the validator must not take the name's word for it
    const {file} = await copyOf('mp4-h264-aac-480', 'liar.mkv')
    const report = await validateFile({
      ffmpeg,
      ffprobe: ffprobeExe,
      file,
      rules: VIDEO_RULES.mkv,
      level: 'quick',
      expectAudio: true,
      threads: 2,
    })
    assert.equal(report.ok, false)
    const codes = report.issues.map(issue => issue.code)
    assert.ok(codes.includes('unexpected-container'), codes.join(', '))
    // deterministic: downloading it again would give the same file — never a retry
    assert.equal(isTransformationDefect(codes), true)

    let kind: ProcessingKind | undefined
    const out = await ensureContainer({
      ffmpeg,
      ffprobe: ffprobeExe,
      input: file,
      container: 'mkv',
      expectAudio: true,
      threads: 2,
      onKind: k => {
        kind = k
      },
    })
    assert.equal(kind, 'remux')
    assert.equal(path.extname(out), '.mkv')
    const summary = summarizeProbe(await ffprobe(ffprobeExe, out))
    assert.ok(summary.container.includes('matroska'), summary.container)
    assert.equal(summary.video?.codec_name, 'h264', 'a remux keeps the stream')
  })

  it('the right container with the wrong codec is transcoded, not copied', async () => {
    // H.265 in an MP4 asked as the mp4 profile (H.264 + AAC): container fine, video not
    const {file} = await copyOf('mp4-h265-aac-720', 'hevc.mp4')
    let kind: ProcessingKind | undefined
    const out = await ensureContainer({
      ffmpeg,
      ffprobe: ffprobeExe,
      input: file,
      container: 'mp4',
      expectAudio: true,
      threads: 2,
      onKind: k => {
        kind = k
      },
    })
    assert.equal(kind, 'transcode')
    const report = await validateFile({
      ffmpeg,
      ffprobe: ffprobeExe,
      file: out,
      rules: VIDEO_RULES.mp4,
      level: 'full',
      expectAudio: true,
      threads: 2,
    })
    assert.equal(report.ok, true, report.issues.map(issue => issue.message).join('; '))
    assert.equal(report.video?.codec, 'h264')
    assert.equal(report.audio?.codec, 'aac', 'the compliant audio is copied')
  })

  it('a cap above the source never upscales: the file is left as it is', async () => {
    const {file} = await copyOf('mp4-h264-aac-360', 'small.mp4')
    let kind: ProcessingKind | undefined
    const out = await ensureContainer({
      ffmpeg,
      ffprobe: ffprobeExe,
      input: file,
      container: 'mp4',
      maxHeight: 1080,
      expectAudio: true,
      threads: 2,
      onKind: k => {
        kind = k
      },
    })
    assert.equal(kind, 'none')
    assert.equal(out, file)
  })

  it('a missing encoder fails the conversion at once, not retryable, nothing left behind', async () => {
    // an ffmpeg built without libx264: the same source would fail the same way every time
    const {file, folder} = await copyOf('webm-vp9-opus-720', 'clip.webm')
    const noEncoder = await scriptedFfmpeg(
      'no-encoder',
      'console.error("Unknown encoder \'libx264\'"); process.exit(1)',
    )
    await assert.rejects(
      ensureContainer({
        ffmpeg: noEncoder,
        ffprobe: ffprobeExe,
        input: file,
        container: 'mp4',
        expectAudio: true,
        threads: 2,
      }),
      (error: unknown) =>
        error instanceof DownloadError && error.code === 'conversion' && /libx264/.test(error.details ?? ''),
    )
    assert.deepEqual(await fs.readdir(folder), ['clip.webm'])
  })

  it('an ffmpeg that returns 0 but writes an unreadable file: the check catches it, and it is a defect, not source damage', async () => {
    const {file} = await copyOf('webm-vp9-opus-720', 'clip.webm')
    const liar = await scriptedFfmpeg(
      'liar',
      "const out = process.argv[process.argv.length - 1]; require('node:fs').writeFileSync(out, 'not a video at all'); process.exit(0)",
    )
    const out = await ensureContainer({
      ffmpeg: liar,
      ffprobe: ffprobeExe,
      input: file,
      container: 'mp4',
      expectAudio: true,
      threads: 2,
    })
    assert.equal(path.extname(out), '.mp4')
    const report = await validateFile({
      ffmpeg,
      ffprobe: ffprobeExe,
      file: out,
      rules: VIDEO_RULES.mp4,
      level: 'full',
      expectAudio: true,
      threads: 2,
    })
    assert.equal(report.ok, false, 'the validator is the oracle: ffmpeg saying 0 is not enough')
    const codes = report.issues.map(issue => issue.code)
    // the same issues on a file as the site served it mean a damaged source; on a converted one, a defect
    assert.equal(checkVerdict(codes, 'downloaded'), 'damage')
    assert.equal(checkVerdict(codes, 'converted'), 'defect')
  })

  it('the verdict on a failed check: container, codec and cap are defects; a torn download is damage', () => {
    assert.equal(checkVerdict(['unexpected-container'], 'downloaded'), 'defect')
    assert.equal(checkVerdict(['resolution-exceeded'], 'converted'), 'defect')
    assert.equal(checkVerdict(['decode-failed'], 'downloaded'), 'damage')
    assert.equal(checkVerdict(['duration-mismatch'], 'downloaded'), 'damage')
    assert.equal(checkVerdict(['duration-mismatch'], 'converted'), 'defect')
    assert.equal(checkVerdict(['unknown-duration'], 'downloaded'), 'other')
    assert.equal(checkVerdict([], 'converted'), 'other')
  })

  it('a silent source asked for audio fails as unavailable, not as a conversion error', async () => {
    const {file} = await copyOf('video-silent-720', 'silent.mp4')
    await assert.rejects(
      extractAudio({ffmpeg, ffprobe: ffprobeExe, input: file, container: 'mp3', threads: 2}),
      (error: unknown) => error instanceof DownloadError && error.code === 'unavailable',
    )
  })
})
