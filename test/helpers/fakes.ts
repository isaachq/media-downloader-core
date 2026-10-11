// Fake yt-dlp / ffmpeg / ffprobe for tests: small Node scripts run as
// `node <script>` (a command with leading args), so they work on every OS.
// The fake yt-dlp speaks the same machine-readable protocol as the real one.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {FFMPEG_REQUIREMENTS} from '../../src/binaries/capabilities.js'

export type FakeBinaries = {
  readonly ytDlp: {command: string; args: string[]}
  readonly ffmpeg: {command: string; args: string[]}
  readonly ffprobe: {command: string; args: string[]}
}

/**
 * Behavior is driven by the url:
 *   …list…         a 3-item playlist (fake.test/e1..e3); …mixed… adds an unavailable 4th item
 *   …nofmt…        has no format matching a height cap (yt-dlp "format is not available")
 *   …slow…         downloads take ~400 ms
 *   …hang…         prints its info, then goes silent forever (a stall)
 *   …unavailable…  fails like a removed video
 *   …flaky…        fails with a network error on the first attempt only
 */
const FAKE_YTDLP = `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('2099.01.01'); process.exit(0) }

const infoJson = args.includes('--load-info-json') ? args[args.indexOf('--load-info-json') + 1] : undefined
const url = infoJson ? JSON.parse(fs.readFileSync(infoJson, 'utf8')).webpage_url : args[args.length - 1]
const id = url.split('/').pop()

if (args.includes('--dump-single-json')) {
  if (url.includes('unavailable')) { console.error('ERROR: [youtube] ' + id + ': Video unavailable. This video has been removed'); process.exit(1) }
  const audio = {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 1000}
  if (url.includes('list')) {
    const ids = url.includes('mixed') ? ['e1', 'e2', 'unavailable-e3', 'e4'] : ['e1', 'e2', 'e3']
    const entries = ids.map(e => ({_type: 'url', id: e, url: 'https://fake.test/' + e, title: 'Entry ' + e, duration: 10, ie_key: 'Fake'}))
    console.log(JSON.stringify({_type: 'playlist', id: 'PL1', title: 'Fake List', extractor_key: 'Fake', entries}))
  } else {
    const video = {format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 4000, filesize: 5000}
    console.log(JSON.stringify({id, title: 'Title ' + id, extractor_key: 'Fake', duration: 10, webpage_url: url, formats: [audio, video]}))
  }
  process.exit(0)
}

const home = args[args.indexOf('--paths') + 1].slice('home:'.length)
const dataDir = path.join(home, '..', '..')
if (infoJson) fs.writeFileSync(path.join(dataDir, 'used-info-json-' + id), '')
const selector = args[args.indexOf('--format') + 1] || ''
if (url.includes('nofmt') && selector.includes('height<=')) { console.error('ERROR: [youtube] ' + id + ': Requested format is not available'); process.exit(1) }
const ext = args.includes('--merge-output-format') ? 'mp4' : 'm4a'
const delay = url.includes('slow') ? 400 : 60
if (url.includes('hang')) {
  console.log('__MDC_INFO__' + JSON.stringify({id, title: 'Hang', duration: 10, extractor: 'Fake', formatId: '140'}))
  setInterval(() => {}, 1000)
  return
}
if (url.includes('unavailable')) { console.error('ERROR: [youtube] ' + id + ': Video unavailable'); process.exit(1) }
const counter = path.join(dataDir, 'attempts-' + id)
const attempts = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1
fs.writeFileSync(counter, String(attempts))
if (url.includes('flaky') && attempts === 1) { console.error('ERROR: Unable to download webpage: timed out'); process.exit(1) }
console.log('__MDC_INFO__' + JSON.stringify({id, title: 'Title ' + id, duration: 10, extractor: 'Fake', formatId: '140', acodec: 'mp4a.40.2', filesize: 1000}))
let sent = 0
const timer = setInterval(() => {
  sent += 250
  console.log('__MDC_PROGRESS__' + JSON.stringify({status: 'downloading', downloaded: sent, total: 1000, file: 'x.m4a'}))
  if (sent >= 1000) {
    clearInterval(timer)
    const file = path.join(home, 'Title ' + id + ' [' + id + '].' + ext)
    fs.writeFileSync(file, 'fake audio ' + id)
    console.log('__MDC_DONE__' + JSON.stringify({filepath: file}))
  }
}, delay / 4)
`

/** Answers -version and lists every codec/format the engine requires, so `doctor` sees a capable build. */
function fakeFfmpeg(): string {
  const names = (kind: keyof typeof FFMPEG_REQUIREMENTS) => FFMPEG_REQUIREMENTS[kind].map(anyOf => anyOf[0])
  const table = (kind: keyof typeof FFMPEG_REQUIREMENTS) =>
    [' ------', ...names(kind).map(name => ` V..... ${name}  fake`)].join('\n')
  const probe = JSON.stringify({
    format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.0'},
    streams: [
      {codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080},
      {codec_type: 'audio', codec_name: 'aac', channels: 2},
    ],
  })
  return `
if (process.argv.includes('-show_format')) { console.log(${JSON.stringify(probe)}); process.exit(0) }
const flag = process.argv.slice(2).filter(a => a !== '-hide_banner')[0]
const out = {
  '-version': 'ffmpeg version 9.9.9-fake',
  '-encoders': ${JSON.stringify(table('encoders'))},
  '-decoders': ${JSON.stringify(table('decoders'))},
  '-muxers': ${JSON.stringify(table('muxers'))},
}[flag]
if (out === undefined) process.exit(1)
console.log(out)
`
}

export async function writeFakes(dir: string): Promise<FakeBinaries> {
  await fs.mkdir(dir, {recursive: true})
  const script = async (name: string, body: string) => {
    const file = path.join(dir, `${name}.cjs`)
    await fs.writeFile(file, body)
    return {command: process.execPath, args: [file]}
  }
  return {
    ytDlp: await script('yt-dlp', FAKE_YTDLP),
    ffmpeg: await script('ffmpeg', fakeFfmpeg()),
    ffprobe: await script('ffprobe', fakeFfmpeg()),
  }
}
