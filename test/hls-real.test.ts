// downloadHls with the real ffmpeg on real HLS made by ffmpeg's own hls muxer (heavy: ffmpeg encodes
// the fixtures). Checks what the byte-level fake can't: that the -c copy output plays — streams,
// codecs, duration across a discontinuity, AES-128 decrypted, a demuxed audio track muxed in.
import {strict as assert} from 'node:assert'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {downloadHls, type HlsDownloadOptions} from '../src/core/hls/index.js'
import {HttpSession} from '../src/sources/http.js'
import {listenLocal} from './helpers/listen.js'

const T = {timeout: 30_000}
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-hls-real-'))
const media = path.join(tmp, 'media')
let origin = ''
let server: http.Server
let jobs = 0

function ffmpeg(args: readonly string[], cwd: string): void {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args], {cwd, encoding: 'utf8'})
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
}

type Probe = {
  streams: Array<{codec_type: string; codec_name: string}>
  format: {duration: string; format_name: string}
}
function probe(file: string): Probe {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`)
  return JSON.parse(r.stdout) as Probe
}
/** A full decode: what the engine's validation does. */
function decodes(file: string): string {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'], {encoding: 'utf8'})
  return r.status === 0 ? r.stderr.trim() : `exit ${r.status}: ${r.stderr}`
}

const VIDEO = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25']
const AUDIO = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100']
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p']
const AAC = ['-c:a', 'aac', '-b:a', '64k']
const HLS = (dir: string, extra: readonly string[] = []) => [
  '-f',
  'hls',
  '-hls_time',
  '1',
  '-hls_playlist_type',
  'vod',
  ...extra,
  '-hls_segment_filename',
  `${dir}/s%03d.${extra.includes('fmp4') ? 'm4s' : 'ts'}`,
  `${dir}/index.m3u8`,
]

before(async () => {
  for (const d of ['ts', 'fmp4', 'aes', 'a', 'b', 'vonly', 'aonly'])
    await fs.mkdir(path.join(media, d), {recursive: true})
  ffmpeg([...VIDEO, ...AUDIO, '-t', '4', ...H264, ...AAC, ...HLS('ts')], media)
  ffmpeg([...VIDEO, ...AUDIO, '-t', '4', ...H264, ...AAC, ...HLS('fmp4', ['-hls_segment_type', 'fmp4'])], media)
  // AES-128: key file + key info (uri, path, iv)
  await fs.writeFile(path.join(media, 'aes', 'k.bin'), Buffer.alloc(16, 0x2a))
  await fs.writeFile(path.join(media, 'aes', 'k.info'), `k.bin\n${path.join(media, 'aes', 'k.bin')}\n`)
  ffmpeg([...VIDEO, ...AUDIO, '-t', '3', ...H264, ...AAC, ...HLS('aes', ['-hls_key_info_file', 'aes/k.info'])], media)
  // two encodes, both starting at 0: a discontinuity between them
  ffmpeg([...VIDEO, ...AUDIO, '-t', '3', ...H264, ...AAC, ...HLS('a')], media)
  ffmpeg(
    ['-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=25', ...AUDIO, '-t', '2', ...H264, ...AAC, ...HLS('b')],
    media,
  )
  const a = await fs.readFile(path.join(media, 'a', 'index.m3u8'), 'utf8')
  const b = await fs.readFile(path.join(media, 'b', 'index.m3u8'), 'utf8')
  const body = (text: string, dir: string) =>
    text
      .split('\n')
      .filter(l => l && !l.startsWith('#EXTM3U') && !l.startsWith('#EXT-X-VERSION') && !l.startsWith('#EXT-X-TARGET'))
      .filter(
        l => !l.startsWith('#EXT-X-MEDIA-SEQUENCE') && !l.startsWith('#EXT-X-PLAYLIST-TYPE') && l !== '#EXT-X-ENDLIST',
      )
      .map(l => (l.startsWith('#') ? l : `${dir}/${l}`))
  await fs.writeFile(
    path.join(media, 'joined.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      ...body(a, 'a'),
      '#EXT-X-DISCONTINUITY',
      ...body(b, 'b'),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'),
  )
  // demuxed: video-only and audio-only renditions
  ffmpeg([...VIDEO, '-t', '3', ...H264, '-an', ...HLS('vonly')], media)
  ffmpeg([...AUDIO, '-t', '3', ...AAC, '-vn', ...HLS('aonly')], media)

  server = http.createServer(async (req, res) => {
    const file = path.join(media, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
    const body = await fs.readFile(file).catch(() => undefined)
    if (!body) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {'content-length': body.length}).end(body)
  })
  origin = `http://127.0.0.1:${await listenLocal(server)}`
})
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await fs.rm(tmp, {recursive: true, force: true})
})

const options = (playlist: string, over: Partial<HlsDownloadOptions> = {}): HlsDownloadOptions => ({
  session: new HttpSession(),
  site: 'Test',
  main: {playlist: `${origin}/${playlist}`},
  kind: 'video',
  codecs: ['avc1.64000d', 'mp4a.40.2'],
  workDir: path.join(tmp, `job-${++jobs}`),
  ffmpeg: {command: 'ffmpeg', args: []},
  signal: AbortSignal.timeout(25_000),
  onProgress: () => {},
  ...over,
})

const near = (actual: number, expected: number, slack: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= slack, `${what}: ${actual}, expected ${expected} ± ${slack}`)

describe('downloadHls with the real ffmpeg', () => {
  it('turns TS H.264 + ADTS AAC into an mp4 that decodes', T, async () => {
    const r = await downloadHls(options('ts/index.m3u8'))
    const p = probe(r.filepath)
    assert.deepEqual(p.streams.map(s => s.codec_name).sort(), ['aac', 'h264'])
    assert.match(p.format.format_name, /mp4/)
    near(Number(p.format.duration), 4, 0.3, 'duration')
    near(r.duration, 4, 0.2, 'Σ EXTINF')
    assert.equal(decodes(r.filepath), '')
  })

  it('hands a single fMP4 period over as is, and it decodes', T, async () => {
    const r = await downloadHls(options('fmp4/index.m3u8'))
    const p = probe(r.filepath)
    assert.deepEqual(p.streams.map(s => s.codec_name).sort(), ['aac', 'h264'])
    near(Number(p.format.duration), 4, 0.3, 'duration')
    assert.equal(decodes(r.filepath), '')
  })

  it('decrypts AES-128 segments (IV from the sequence)', T, async () => {
    const r = await downloadHls(options('aes/index.m3u8'))
    near(Number(probe(r.filepath).format.duration), 3, 0.3, 'duration')
    assert.equal(decodes(r.filepath), '')
  })

  it('keeps timestamps monotonic across a discontinuity (one file per period, concat)', T, async () => {
    const r = await downloadHls(options('joined.m3u8'))
    near(Number(probe(r.filepath).format.duration), 5, 0.4, 'duration of both encodes')
    assert.equal(decodes(r.filepath), '')
  })

  it('muxes a demuxed audio track in, and extracts audio only for an audio download', T, async () => {
    const r = await downloadHls(options('vonly/index.m3u8', {audio: {playlist: `${origin}/aonly/index.m3u8`}}))
    assert.deepEqual(
      probe(r.filepath)
        .streams.map(s => s.codec_type)
        .sort(),
      ['audio', 'video'],
    )
    assert.equal(decodes(r.filepath), '')
    const a = await downloadHls(options('ts/index.m3u8', {kind: 'audio'}))
    assert.equal(a.container, 'm4a')
    assert.deepEqual(
      probe(a.filepath).streams.map(s => s.codec_type),
      ['audio'],
    )
    assert.equal(decodes(a.filepath), '')
  })
})
