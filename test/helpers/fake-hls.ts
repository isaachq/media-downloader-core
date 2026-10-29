// A local HLS origin with the shapes the real ones serve (research cards 1-7, design §11): master
// playlists with H.264 TS variants, an HEVC fMP4 variant whose EXT-X-MAP comes again after a
// discontinuity (Twitch, yt-dlp #10878), an audio-only variant and a demuxed audio group, I-frame
// variants; media playlists of 1 … 20,000 synthetic segments (TS packets, fMP4 boxes or MP3 frames,
// each stamped with its track and index so the output order can be checked byte for byte); a
// single-file BYTERANGE variant; AES-128 with key rotation, the IV in the tag or from the sequence;
// Twitch's muted parts (`-unmuted` 403, `-muted` 200); a signed `?tok=` that turns 403 after K
// segment requests, re-signed by `/sign`; per-segment faults (404, an HTML 200, a short body, a
// stall, a 500 once); a live playlist (no ENDLIST), EVENT with and without ENDLIST; DRM key formats;
// a wrong playlist Content-Type (Bluesky); a redirect before the playlist (relative uris against the
// final url); EXT-X-GAP. Every request is counted per path. Range requests answer 206.
import {createCipheriv} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import type {Socket} from 'node:net'
import * as path from 'node:path'
import {listenLocal} from './listen.js'

export type Fault = 'missing' | 'missing-once' | 'html' | 'html-once' | 'short' | 'short-once' | 'stall-once' | 'flaky'

export type FakeTrack = {
  readonly segments: number
  /** EXTINF of each segment. Default 2. */
  readonly duration?: number
  readonly format?: 'ts' | 'fmp4' | 'mp3'
  /** Bytes per segment (before encryption). Default 188 × 16. */
  readonly bytes?: number
  /** EXT-X-ENDLIST. Default true. */
  readonly ended?: boolean
  readonly playlistType?: 'VOD' | 'EVENT'
  readonly mediaSequence?: number
  readonly discontinuitySequence?: number
  /** Segment indexes that start a new period (EXT-X-DISCONTINUITY; fMP4: and a new EXT-X-MAP). */
  readonly discontinuities?: readonly number[]
  /** fMP4: repeat the same EXT-X-MAP after each discontinuity instead of a new one. */
  readonly sameInit?: boolean
  readonly gaps?: readonly number[]
  readonly aes?: {readonly rotateEvery?: number; readonly ivInTag?: boolean}
  /** All segments as byte ranges of one file. */
  readonly byteRange?: boolean
  /** Listed as `-unmuted` (403); the same part answers as `-muted`. */
  readonly muted?: readonly number[]
  /** Each token is good for this many segment / key requests, then 403. */
  readonly signed?: {readonly validFor: number}
  readonly faults?: Readonly<Record<number, Fault>>
  readonly contentType?: string
  readonly drm?: boolean
  /** Program date-time on the first segment and a date range (for parser tests over HTTP). */
  readonly dated?: boolean
  /** Each segment answers this many ms late (a slow CDN). */
  readonly delayMs?: number
}

export type FakeVariant = {
  readonly track: string
  readonly bandwidth: number
  readonly averageBandwidth?: number
  readonly resolution?: string
  readonly codecs?: string
  readonly audio?: string
  readonly video?: string
  readonly frameRate?: number
}

export type FakeMaster = {
  readonly variants: readonly FakeVariant[]
  readonly audio?: ReadonlyArray<{
    readonly group: string
    readonly name: string
    readonly track?: string
    readonly isDefault?: boolean
    readonly language?: string
  }>
  readonly videoNames?: Readonly<Record<string, string>>
  readonly iframes?: boolean
}

export type FakeHls = {
  readonly origin: string
  /** Media playlist url of a track (signed tracks: with a fresh token). */
  playlistUrl(name: string): string
  /** A url that redirects (302) to the track's playlist under another path. */
  redirectUrl(name: string): string
  readonly masterUrl: string
  /** Bytes the assembled (byte-concatenated) track must equal: inits per period + decrypted segments, gaps left out. */
  expected(name: string): Buffer
  /** Requests per path (query removed, the redirect prefix folded). */
  count(pathname: string): number
  /** Requests for a track's media segments (any variant name, byte ranges included). */
  segmentRequests(name: string): number
  /** Requests of every kind. */
  readonly total: () => number
  /** Most requests open at once so far. */
  readonly maxInFlight: () => number
  /** Change a track while the server runs (a fault cleared, a playlist that ends). */
  update(name: string, track: FakeTrack): void
  close(): Promise<void>
}

const DEFAULT_BYTES = 188 * 16
const codeOf = (name: string) => {
  let h = 7
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xff
  return h
}

export const keyBytes = (k: number): Buffer => Buffer.alloc(16, (k * 37 + 11) & 0xff)
const tagIv = (k: number): Buffer => {
  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(0xa0000000 + k, 12)
  return iv
}
const seqIv = (sequence: number): Buffer => {
  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(Math.floor(sequence / 2 ** 32), 8)
  iv.writeUInt32BE(sequence >>> 0, 12)
  return iv
}

/** The plain bytes of segment `i` of a track: stamped with the track's code and the index. */
export function segmentBody(name: string, i: number, track: FakeTrack): Buffer {
  const bytes = track.bytes ?? DEFAULT_BYTES
  const code = codeOf(name)
  const b = Buffer.alloc(bytes, i & 0xff)
  const format = track.format ?? 'ts'
  if (format === 'ts') {
    for (let o = 0; o < bytes; o += 188) {
      b[o] = 0x47
      if (o + 1 < bytes) b[o + 1] = code
      if (o + 6 <= bytes) b.writeUInt32BE(i, o + 2)
    }
  } else if (format === 'fmp4') {
    b.writeUInt32BE(bytes, 0)
    b.write('moof', 4, 'latin1')
    if (bytes >= 13) {
      b[8] = code
      b.writeUInt32BE(i, 9)
    }
  } else {
    b[0] = 0xff
    b[1] = 0xfb
    if (bytes >= 7) {
      b[2] = code
      b.writeUInt32BE(i, 3)
    }
  }
  return b
}

export function initBody(name: string, period: number): Buffer {
  const b = Buffer.alloc(24)
  b.writeUInt32BE(24, 0)
  b.write('ftypisom', 4, 'latin1')
  b[12] = codeOf(name)
  b.writeUInt32BE(period, 13)
  return b
}

const periodsOf = (t: FakeTrack): number[] => {
  const out: number[] = []
  let p = 0
  const starts = new Set(t.discontinuities ?? [])
  for (let i = 0; i < t.segments; i++) {
    if (i > 0 && starts.has(i)) p++
    out.push(p)
  }
  return out
}

const keyIndex = (t: FakeTrack, i: number) =>
  t.aes ? Math.floor(i / (t.aes.rotateEvery ?? Number.MAX_SAFE_INTEGER)) : -1

function encrypted(name: string, t: FakeTrack, i: number): Buffer {
  const body = segmentBody(name, i, t)
  if (!t.aes) return body
  const k = keyIndex(t, i)
  const iv = t.aes.ivInTag ? tagIv(k) : seqIv((t.mediaSequence ?? 0) + i)
  const c = createCipheriv('aes-128-cbc', keyBytes(k), iv)
  return Buffer.concat([c.update(body), c.final()])
}

const ext = (t: FakeTrack) => (t.format === 'fmp4' ? 'm4s' : t.format === 'mp3' ? 'mp3' : 'ts')

function playlistText(name: string, t: FakeTrack, token: string): string {
  const q = token ? `?tok=${token}` : ''
  const duration = t.duration ?? 2
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`]
  if (t.mediaSequence) lines.push(`#EXT-X-MEDIA-SEQUENCE:${t.mediaSequence}`)
  if (t.discontinuitySequence) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${t.discontinuitySequence}`)
  if (t.playlistType) lines.push(`#EXT-X-PLAYLIST-TYPE:${t.playlistType}`)
  if (t.drm) lines.push('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fake-key",KEYFORMAT="com.apple.streamingkeydelivery"')
  const periods = periodsOf(t)
  const starts = new Set(t.discontinuities ?? [])
  const gaps = new Set(t.gaps ?? [])
  const muted = new Set(t.muted ?? [])
  let lastKey = -1
  const bodyLength = (i: number) => encrypted(name, t, i).length
  if (t.format === 'fmp4') lines.push(`#EXT-X-MAP:URI="init0.mp4${q}"`)
  for (let i = 0; i < t.segments; i++) {
    if (i > 0 && starts.has(i)) {
      lines.push('#EXT-X-DISCONTINUITY')
      if (t.format === 'fmp4') lines.push(`#EXT-X-MAP:URI="init${t.sameInit ? 0 : periods[i]}.mp4${q}"`)
    }
    const k = keyIndex(t, i)
    if (k !== lastKey) {
      lines.push(
        `#EXT-X-KEY:METHOD=AES-128,URI="key${k}.bin${q}"${t.aes?.ivInTag ? `,IV=0x${tagIv(k).toString('hex')}` : ''}`,
      )
      lastKey = k
    }
    if (t.dated && i === 0) {
      lines.push('#EXT-X-PROGRAM-DATE-TIME:2026-10-26T12:00:00.000Z')
      lines.push(
        '#EXT-X-DATERANGE:ID="ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-26T12:00:02.000Z",DURATION=4.0,X-TV-TWITCH-AD-POD-LENGTH="1"',
      )
    }
    if (gaps.has(i)) lines.push('#EXT-X-GAP')
    lines.push(`#EXTINF:${duration.toFixed(3)},seg ${i}`)
    if (t.byteRange) {
      const length = bodyLength(i)
      lines.push(`#EXT-X-BYTERANGE:${length}${i === 0 ? '@0' : ''}`)
      lines.push(`all.${ext(t)}${q}`)
    } else lines.push(`s${i}${muted.has(i) ? '-unmuted' : ''}.${ext(t)}${q}`)
  }
  if (t.ended ?? true) lines.push('#EXT-X-ENDLIST')
  return `${lines.join('\n')}\n`
}

function masterText(m: FakeMaster): string {
  const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS']
  for (const a of m.audio ?? []) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${a.group}",NAME="${a.name}",DEFAULT=${a.isDefault ? 'YES' : 'NO'}` +
        `${a.language ? `,LANGUAGE="${a.language}"` : ''}${a.track ? `,URI="t/${a.track}/index.m3u8"` : ''}`,
    )
  }
  for (const [group, name] of Object.entries(m.videoNames ?? {})) {
    lines.push(`#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${group}",NAME="${name}",AUTOSELECT=YES,DEFAULT=YES`)
  }
  for (const v of m.variants) {
    const attrs = [
      `BANDWIDTH=${v.bandwidth}`,
      v.averageBandwidth ? `AVERAGE-BANDWIDTH=${v.averageBandwidth}` : '',
      v.resolution ? `RESOLUTION=${v.resolution}` : '',
      v.codecs ? `CODECS="${v.codecs}"` : '',
      v.frameRate ? `FRAME-RATE=${v.frameRate}` : '',
      v.audio ? `AUDIO="${v.audio}"` : '',
      v.video ? `VIDEO="${v.video}"` : '',
    ].filter(Boolean)
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`)
    lines.push('# a comment between the tag and its uri')
    lines.push(`t/${v.track}/index.m3u8`)
  }
  if (m.iframes) lines.push('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="t/iframes/index.m3u8"')
  return `${lines.join('\r\n')}\r\n`
}

function sendMedia(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, type: string): void {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1
    if (start >= body.length) {
      res.writeHead(416, {'content-range': `bytes */${body.length}`}).end()
      return
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${body.length}`,
    })
    res.end(body.subarray(start, end + 1))
    return
  }
  res.writeHead(200, {'content-type': type, 'content-length': body.length, 'accept-ranges': 'bytes'})
  res.end(body)
}

export async function startFakeHls(config: {
  readonly tracks: Readonly<Record<string, FakeTrack>>
  readonly master?: FakeMaster
}): Promise<FakeHls> {
  const tracks = new Map<string, FakeTrack>(Object.entries(config.tracks))
  const counts = new Map<string, number>()
  const once = new Set<string>()
  const tokens = new Map<string, number>() // token → uses left
  let tokenSeq = 0
  let total = 0
  let inFlight = 0
  let maxInFlight = 0
  const sockets = new Set<Socket>()
  const mint = (name: string) => {
    const t = tracks.get(name)
    if (!t?.signed) return ''
    const token = `${name}-${++tokenSeq}`
    tokens.set(token, t.signed.validFor)
    return token
  }

  const server = http.createServer((req, res) => {
    total++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    res.on('close', () => inFlight--)
    const url = new URL(req.url ?? '/', 'http://x')
    const pathname = url.pathname.replace(/^\/deep/, '')
    counts.set(pathname, (counts.get(pathname) ?? 0) + 1)
    if (pathname === '/master.m3u8' && config.master) {
      res.writeHead(200, {'content-type': 'application/vnd.apple.mpegurl'}).end(masterText(config.master))
      return
    }
    const redirect = /^\/r\/([^/]+)\.m3u8$/.exec(pathname)
    if (redirect?.[1]) {
      res.writeHead(302, {location: `/deep/t/${redirect[1]}/index.m3u8`}).end()
      return
    }
    const m = /^\/t\/([^/]+)\/(.+)$/.exec(pathname)
    const name = m?.[1] ?? ''
    const file = m?.[2] ?? ''
    const t = tracks.get(name)
    if (!t) {
      res.writeHead(404).end('not found')
      return
    }
    const token = url.searchParams.get('tok') ?? ''
    if (file === 'index.m3u8') {
      const tok = t.signed ? token || mint(name) : ''
      res
        .writeHead(200, {'content-type': t.contentType ?? 'application/vnd.apple.mpegurl'})
        .end(playlistText(name, t, tok))
      return
    }
    if (file === 'sign') {
      res
        .writeHead(200, {'content-type': 'application/json'})
        .end(JSON.stringify({url: `${origin}/t/${name}/index.m3u8?tok=${mint(name)}`}))
      return
    }
    if (t.signed) {
      const left = tokens.get(token)
      if (left === undefined || left <= 0) {
        res.writeHead(403, {'content-type': 'text/plain'}).end('expired')
        return
      }
      tokens.set(token, left - 1)
    }
    const key = /^key(\d+)\.bin$/.exec(file)
    if (key) {
      res.writeHead(200, {'content-type': 'application/octet-stream'}).end(keyBytes(Number(key[1])))
      return
    }
    const init = /^init(\d+)\.mp4$/.exec(file)
    if (init) {
      sendMedia(req, res, initBody(name, Number(init[1])), 'video/mp4')
      return
    }
    const type = t.format === 'fmp4' ? 'video/iso.segment' : t.format === 'mp3' ? 'audio/mpeg' : 'video/mp2t'
    if (/^all\./.test(file)) {
      const parts: Buffer[] = []
      for (let i = 0; i < t.segments; i++) parts.push(encrypted(name, t, i))
      sendMedia(req, res, Buffer.concat(parts), type)
      return
    }
    const seg = /^s(\d+)(-unmuted|-muted)?\.\w+$/.exec(file)
    if (!seg) {
      res.writeHead(404).end('not found')
      return
    }
    const i = Number(seg[1])
    if (i >= t.segments) {
      res.writeHead(404).end('not found')
      return
    }
    if (seg[2] === '-unmuted') {
      res.writeHead(403, {'content-type': 'text/plain'}).end('forbidden')
      return
    }
    const fault = t.faults?.[i]
    const first = fault && !once.has(`${name}/${i}`)
    if (first) once.add(`${name}/${i}`)
    const body = encrypted(name, t, i)
    if (fault === 'missing' || (fault === 'missing-once' && first)) {
      res.writeHead(404, {'content-type': 'text/plain'}).end('gone')
      return
    }
    if (fault === 'flaky' && first) {
      res.writeHead(500, {'content-type': 'text/plain'}).end('oops')
      return
    }
    if (fault === 'html' || (fault === 'html-once' && first)) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'}).end('<!doctype html><title>Error</title>')
      return
    }
    if (fault === 'short' || (fault === 'short-once' && first)) {
      res.writeHead(200, {'content-type': type, 'content-length': body.length})
      res.write(body.subarray(0, Math.floor(body.length / 2)), () => res.destroy())
      return
    }
    if (fault === 'stall-once' && first) {
      res.writeHead(200, {'content-type': type, 'content-length': body.length})
      res.write(body.subarray(0, Math.floor(body.length / 2)))
      return // never ends: the client's stall watchdog has to give up on it
    }
    if (t.delayMs) {
      const timer = setTimeout(() => sendMedia(req, res, body, type), t.delayMs)
      res.on('close', () => clearTimeout(timer))
      return
    }
    sendMedia(req, res, body, type)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const port = await listenLocal(server)
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    masterUrl: `${origin}/master.m3u8`,
    playlistUrl: name => {
      const tok = mint(name)
      return `${origin}/t/${name}/index.m3u8${tok ? `?tok=${tok}` : ''}`
    },
    redirectUrl: name => `${origin}/r/${name}.m3u8`,
    expected(name) {
      const t = tracks.get(name)
      if (!t) throw new Error(`no track ${name}`)
      const periods = periodsOf(t)
      const gaps = new Set(t.gaps ?? [])
      const parts: Buffer[] = []
      let period = -1
      for (let i = 0; i < t.segments; i++) {
        if (gaps.has(i)) continue
        const p = periods[i] ?? 0
        if (p !== period) {
          period = p
          if (t.format === 'fmp4') parts.push(initBody(name, t.sameInit ? 0 : p))
        }
        parts.push(segmentBody(name, i, t))
      }
      return Buffer.concat(parts)
    },
    count: pathname => counts.get(pathname) ?? 0,
    segmentRequests(name) {
      let n = 0
      for (const [p, c] of counts) if (p.startsWith(`/t/${name}/s`) || p.startsWith(`/t/${name}/all.`)) n += c
      return n
    },
    total: () => total,
    maxInFlight: () => maxInFlight,
    update(name, track) {
      tracks.set(name, track)
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

/**
 * A stand-in ffmpeg for fast tests: concatenates its inputs (a file, or the files of a concat list) into
 * the output, in order, and writes its arguments beside it as `<output>.args.json`. With
 * `MDC_FAKE_HLS_FFMPEG_FAIL=1` in the environment of the run it fails like ffmpeg does.
 */
const COPY_FFMPEG = `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === '-version') { console.log('ffmpeg version 9.9.9-fake'); process.exit(0) }
const output = args[args.length - 1]
if (process.env.MDC_FAKE_HLS_FFMPEG_FAIL === '1' || fs.existsSync(path.join(path.dirname(output), 'FAIL'))) {
  console.error('Non-monotonous DTS in output stream 0:1')
  process.exit(1)
}
const inputs = []
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] !== '-i') continue
  const input = args[i + 1]
  const concat = args[i - 2] === '-safe' || (args[i - 4] === '-f' && args[i - 3] === 'concat')
  if (concat) {
    for (const line of fs.readFileSync(input, 'utf8').split('\\n')) {
      const m = /^file '(.*)'$/.exec(line.trim())
      if (m) inputs.push(path.join(path.dirname(input), m[1].replace(/'\\\\''/g, "'")))
    }
  } else inputs.push(input)
}
const out = fs.openSync(output, 'w')
for (const f of inputs) fs.writeSync(out, fs.readFileSync(f))
fs.closeSync(out)
fs.writeFileSync(output + '.args.json', JSON.stringify(args))
console.log('out_time_us=1000000')
console.log('progress=end')
`

/** Writes the copy ffmpeg into `dir` and returns it as an Executable. */
export async function writeCopyFfmpeg(dir: string): Promise<{command: string; args: string[]}> {
  await fs.mkdir(dir, {recursive: true})
  const file = path.join(dir, 'ffmpeg-copy.cjs')
  await fs.writeFile(file, COPY_FFMPEG)
  return {command: process.execPath, args: [file]}
}

// ── a live origin ─────────────────────────────────────────────────────────────────────────────────
//
// A sliding-window live playlist that advances on a controllable clock (never real time): segment i
// (absolute, from 0) exists once the clock passes (i − made + 1) × duration, the playlist lists the
// last `window` of them with EXT-X-MEDIA-SEQUENCE, EXT-X-DISCONTINUITY-SEQUENCE and a program date-time
// on every segment, titled "live" as Twitch titles them. Ads are segments titled "Amazon|…" (or "live",
// to leave only the date range to tell them) inside an EXT-X-DATERANGE of CLASS "twitch-stitched-ad",
// with a discontinuity on both sides. The stream ends with ENDLIST after `endAfter` segments, or stops
// growing after `stopAfter` (and then answers 404 with `offline404`). A signed track's token is good for
// N requests (playlist included), then 403 until `/l/<name>/sign` mints another; `renumberOnSign` makes
// each new token a new session whose media sequence numbering starts elsewhere (same segments, same
// dates). AES-128 rotates its key every `rotateEvery` segments, the IV from the media sequence.

export type FakeLiveTrack = {
  /** EXTINF and EXT-X-TARGETDURATION. Default 2. */
  readonly duration?: number
  /** Segments the window lists. Default 6. */
  readonly window?: number
  /** Segments made already at clock 0 (the window shows the newest of them). Default `window`. */
  readonly made?: number
  /** Media sequence of segment 0. Default 100. */
  readonly mediaSequence?: number
  readonly format?: 'ts' | 'fmp4'
  /** Bytes per segment (before encryption). Default 188 × 16. */
  readonly bytes?: number
  /** ENDLIST once this many segments exist. */
  readonly endAfter?: number
  /** The window stops growing at this many segments (no ENDLIST). */
  readonly stopAfter?: number
  /** Once stopped: the playlist answers 404. */
  readonly offline404?: boolean
  /** Ad breaks: absolute segments [from, to); `titled: false` keeps their title "live" (date range only). */
  readonly ads?: ReadonlyArray<{readonly from: number; readonly to: number; readonly titled?: boolean}>
  /** Absolute segments that start a new period (EXT-X-DISCONTINUITY; fMP4: a new EXT-X-MAP). */
  readonly discontinuities?: readonly number[]
  readonly aes?: {readonly rotateEvery?: number}
  readonly signed?: {readonly validFor: number}
  /** Each token minted after the first starts the numbering this much further (a new session). */
  readonly renumberOnSign?: number
  /** Absolute segments that always answer 404. */
  readonly missing?: readonly number[]
  /** Absolute segments whose first request sends half its bytes, then nothing (a stalled CDN edge). */
  readonly stallOnce?: readonly number[]
}

export type FakeLive = {
  readonly origin: string
  /** The simulated clock, in ms from 0 (shared by every track: `reset` it before each recording). */
  readonly clock: {now(): number; advance(ms: number): void; reset(): void}
  /** Playlist url (a signed track: with a fresh token). */
  playlistUrl(name: string): string
  /** A fresh signed url, as the site's re-signing would give it. */
  signedUrl(name: string): string
  /** Absolute index of a media sequence number under the first token's numbering. */
  indexOf(name: string, sequence: number): number
  /** Bytes segments [from, to) (absolute) must give once appended, `except` left out, inits per period. */
  expected(name: string, from: number, to: number, except?: ReadonlySet<number>): Buffer
  /** Segments made so far. */
  made(name: string): number
  count(pathname: string): number
  /** Segment requests of a track. */
  segmentRequests(name: string): number
  readonly maxInFlight: () => number
  update(name: string, track: FakeLiveTrack): void
  close(): Promise<void>
}

export const LIVE_T0 = Date.parse('2026-10-27T12:00:00.000Z')

export async function startFakeLive(config: {
  readonly tracks: Readonly<Record<string, FakeLiveTrack>>
}): Promise<FakeLive> {
  const tracks = new Map<string, FakeLiveTrack>(Object.entries(config.tracks))
  const counts = new Map<string, number>()
  const tokens = new Map<string, {left: number; generation: number}>()
  const generations = new Map<string, number>()
  const stalled = new Set<string>()
  let tokenSeq = 0
  let now = 0
  let inFlight = 0
  let maxInFlight = 0
  const sockets = new Set<Socket>()

  const dur = (t: FakeLiveTrack) => t.duration ?? 2
  const win = (t: FakeLiveTrack) => t.window ?? 6
  const madeOf = (t: FakeLiveTrack) => {
    let n = (t.made ?? win(t)) + Math.floor(now / (dur(t) * 1000))
    if (t.endAfter !== undefined) n = Math.min(n, t.endAfter)
    if (t.stopAfter !== undefined) n = Math.min(n, t.stopAfter)
    return n
  }
  const asTrack = (t: FakeLiveTrack): FakeTrack => ({
    segments: 0,
    ...(t.bytes !== undefined && {bytes: t.bytes}),
    ...(t.format !== undefined && {format: t.format}),
  })
  const keyOf = (t: FakeLiveTrack, i: number) => (t.aes ? Math.floor(i / (t.aes.rotateEvery ?? 1e9)) : -1)
  const base = (t: FakeLiveTrack) => t.mediaSequence ?? 100
  const body = (name: string, t: FakeLiveTrack, i: number): Buffer => {
    const plain = segmentBody(name, i, asTrack(t))
    if (!t.aes) return plain
    const c = createCipheriv('aes-128-cbc', keyBytes(keyOf(t, i)), seqIv(base(t) + i))
    return Buffer.concat([c.update(plain), c.final()])
  }
  const startsPeriod = (t: FakeLiveTrack, i: number) =>
    i > 0 && ((t.discontinuities ?? []).includes(i) || (t.ads ?? []).some(ad => ad.from === i || ad.to === i))
  /** Period of segment i: the period starts at or before it (a few ads and discontinuities: O(d)). */
  const periodOf = (t: FakeLiveTrack, i: number) => {
    let p = 0
    for (const d of t.discontinuities ?? []) if (d > 0 && d <= i) p++
    for (const ad of t.ads ?? []) {
      if (ad.from > 0 && ad.from <= i) p++
      if (ad.to <= i) p++
    }
    return p
  }
  const iso = (ms: number) => new Date(ms).toISOString()
  const mint = (name: string) => {
    const t = tracks.get(name)
    if (!t?.signed) return ''
    const generation = generations.get(name) ?? 0
    generations.set(name, generation + 1)
    const token = `${name}-${++tokenSeq}`
    tokens.set(token, {left: t.signed.validFor, generation})
    return token
  }
  const ext = (t: FakeLiveTrack) => (t.format === 'fmp4' ? 'm4s' : 'ts')

  function playlist(t: FakeLiveTrack, token: string, generation: number): string {
    const q = token ? `?tok=${token}` : ''
    const made = madeOf(t)
    const first = Math.max(0, made - win(t))
    const shift = generation * (t.renumberOnSign ?? 0)
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-TARGETDURATION:${Math.ceil(dur(t))}`,
      `#EXT-X-MEDIA-SEQUENCE:${base(t) + first + shift}`,
    ]
    const discBefore = periodOf(t, first)
    if (discBefore) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discBefore}`)
    for (const ad of t.ads ?? []) {
      if (ad.to <= first || ad.from >= made) continue
      lines.push(
        `#EXT-X-DATERANGE:ID="stitched-ad-${ad.from}",CLASS="twitch-stitched-ad",START-DATE="${iso(LIVE_T0 + ad.from * dur(t) * 1000)}",DURATION=${((ad.to - ad.from) * dur(t)).toFixed(3)},X-TV-TWITCH-AD-POD-LENGTH="1"`,
      )
    }
    if (t.format === 'fmp4') lines.push(`#EXT-X-MAP:URI="init${periodOf(t, first)}.mp4${q}"`)
    let lastKey = -1
    for (let i = first; i < made; i++) {
      if (i > first && startsPeriod(t, i)) {
        lines.push('#EXT-X-DISCONTINUITY')
        if (t.format === 'fmp4') lines.push(`#EXT-X-MAP:URI="init${periodOf(t, i)}.mp4${q}"`)
      }
      const k = keyOf(t, i)
      if (k !== lastKey) {
        lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key${k}.bin${q}"`)
        lastKey = k
      }
      const ad = (t.ads ?? []).find(a => a.from <= i && i < a.to)
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(LIVE_T0 + i * dur(t) * 1000)}`)
      lines.push(`#EXTINF:${dur(t).toFixed(3)},${ad && ad.titled !== false ? `Amazon|${ad.from}` : 'live'}`)
      lines.push(`s${i}.${ext(t)}${q}`)
    }
    if (t.endAfter !== undefined && made >= t.endAfter) lines.push('#EXT-X-ENDLIST')
    return `${lines.join('\n')}\n`
  }

  const server = http.createServer((req, res) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    res.on('close', () => inFlight--)
    const url = new URL(req.url ?? '/', 'http://x')
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1)
    const m = /^\/l\/([^/]+)\/(.+)$/.exec(url.pathname)
    const name = m?.[1] ?? ''
    const file = m?.[2] ?? ''
    const t = tracks.get(name)
    if (!t) {
      res.writeHead(404).end('not found')
      return
    }
    if (file === 'sign') {
      res
        .writeHead(200, {'content-type': 'application/json'})
        .end(JSON.stringify({url: `${origin}/l/${name}/index.m3u8?tok=${mint(name)}`}))
      return
    }
    let generation = 0
    if (t.signed) {
      const token = tokens.get(url.searchParams.get('tok') ?? '')
      if (!token || token.left <= 0) {
        res.writeHead(403, {'content-type': 'text/plain'}).end('expired')
        return
      }
      token.left--
      generation = token.generation
    }
    if (file === 'index.m3u8') {
      if (t.offline404 && t.stopAfter !== undefined && madeOf(t) >= t.stopAfter) {
        res.writeHead(404, {'content-type': 'text/plain'}).end('offline')
        return
      }
      res
        .writeHead(200, {'content-type': 'application/vnd.apple.mpegurl'})
        .end(playlist(t, url.searchParams.get('tok') ?? '', generation))
      return
    }
    const key = /^key(\d+)\.bin$/.exec(file)
    if (key) {
      res.writeHead(200, {'content-type': 'application/octet-stream'}).end(keyBytes(Number(key[1])))
      return
    }
    const init = /^init(\d+)\.mp4$/.exec(file)
    if (init) {
      sendMedia(req, res, initBody(name, Number(init[1])), 'video/mp4')
      return
    }
    const seg = /^s(\d+)\.\w+$/.exec(file)
    const i = Number(seg?.[1] ?? -1)
    if (!seg || i >= madeOf(t) || (t.missing ?? []).includes(i)) {
      res.writeHead(404, {'content-type': 'text/plain'}).end('gone')
      return
    }
    const type = t.format === 'fmp4' ? 'video/iso.segment' : 'video/mp2t'
    if ((t.stallOnce ?? []).includes(i) && !stalled.has(`${name}/${i}`)) {
      stalled.add(`${name}/${i}`)
      const media = body(name, t, i)
      res.writeHead(200, {'content-type': type, 'content-length': media.length})
      res.write(media.subarray(0, Math.floor(media.length / 2)))
      return // never ends: the recorder's stall watchdog has to give up on it
    }
    sendMedia(req, res, body(name, t, i), type)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const port = await listenLocal(server)
  const origin = `http://127.0.0.1:${port}`
  const track = (name: string) => {
    const t = tracks.get(name)
    if (!t) throw new Error(`no live track ${name}`)
    return t
  }
  const urlOf = (name: string) => {
    const tok = mint(name)
    return `${origin}/l/${name}/index.m3u8${tok ? `?tok=${tok}` : ''}`
  }
  return {
    origin,
    clock: {
      now: () => now,
      advance: ms => {
        now += ms
      },
      reset: () => {
        now = 0
      },
    },
    playlistUrl: urlOf,
    signedUrl: urlOf,
    indexOf: (name, sequence) => sequence - base(track(name)),
    expected(name, from, to, except) {
      const t = track(name)
      const parts: Buffer[] = []
      let period = -1
      for (let i = from; i < to; i++) {
        if (except?.has(i)) continue
        const p = periodOf(t, i)
        if (p !== period) {
          period = p
          if (t.format === 'fmp4') parts.push(initBody(name, p))
        }
        parts.push(segmentBody(name, i, asTrack(t)))
      }
      return Buffer.concat(parts)
    },
    made: name => madeOf(track(name)),
    count: pathname => counts.get(pathname) ?? 0,
    segmentRequests(name) {
      let n = 0
      for (const [p, c] of counts) if (p.startsWith(`/l/${name}/s`)) n += c
      return n
    },
    maxInFlight: () => maxInFlight,
    update(name, t) {
      tracks.set(name, t)
    },
    close: () =>
      new Promise<void>(resolve => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
