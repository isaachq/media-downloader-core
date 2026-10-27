// The live URL matrix: real public links on Facebook, Instagram, TikTok and Snapchat, read
// (and optionally downloaded) by the whole engine against the real sites. Local
// only — it is never part of `npm test` or CI: it talks to the live sites, takes
// minutes to hours, and its links rot.
//
//   npm run live:matrix                         # analyze every link
//   npm run live:matrix -- --download           # and download each single item, ffprobed
//   npm run live:matrix -- --only FB-05,TT-02   # some scenarios
//   npm run live:matrix -- --platform tiktok
//   npm run live:matrix -- --native             # as the Android app runs it: no yt-dlp
//
// Optional signed-in sessions (Netscape cookie files, e.g. exported from a browser):
//   MDC_LIVE_COOKIES_FACEBOOK=… MDC_LIVE_COOKIES_INSTAGRAM=… MDC_LIVE_COOKIES_TIKTOK=…
// Without one, a link that needs it must fail cleanly as LOGIN_WALL_DETECTED: that
// is reported as `auth`, apart from passes and failures.
//
// Writes a JSON report to .local/live-matrix/report-<time>.json and exits 1 on any
// failure.
import {readFileSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {parseArgs} from 'node:util'
import {toExecutable} from '../../src/binaries/executable.js'
import {parseNetscape} from '../../src/core/cookies.js'
import {diagnoseFailure, type FailureDiagnostic, platformOf} from '../../src/core/diagnostic.js'
import {toJobError} from '../../src/core/errors.js'
import {ffprobe, summarizeProbe} from '../../src/core/validate.js'
import {MediaDownloader} from '../../src/downloader.js'
import {detectLink} from '../../src/sources/detect.js'
import type {SessionProvider} from '../../src/sources/session.js'
import type {AnalysisResult, JobSnapshot, SlideshowOptions} from '../../src/types.js'

/** What a link must give to pass. */
type Expect =
  /** One video with sound. */
  | 'video'
  /** Pictures and a sound track (a photo post with music). */
  | 'photo_with_audio'
  /** A photo post, with or without music. */
  | 'photo'
  /** Several items (pictures, or pictures and videos). */
  | 'carousel'
  /** A listing with entries. */
  | 'playlist'

type Scenario = {
  readonly id: string
  readonly category: string
  readonly expect: Expect
  /** Needs a signed-in session: without one, a clean LOGIN_WALL_DETECTED is the expected answer. */
  readonly session?: boolean
  readonly urls: readonly string[]
  readonly note?: string
}

type Outcome = 'pass' | 'fail' | 'auth'

type Row = {
  readonly scenario: string
  readonly url: string
  readonly outcome: Outcome
  readonly analyzeMs: number
  readonly downloadMs?: number | undefined
  readonly got?: string | undefined
  readonly reason?: string | undefined
  readonly diagnostic?: FailureDiagnostic | undefined
  readonly probe?: {readonly video?: string; readonly audio?: string; readonly duration?: number} | undefined
}

const {values: args} = parseArgs({
  options: {
    download: {type: 'boolean', default: false},
    /** As the phone runs it: no yt-dlp, the native sources only (the Android app's engine). */
    native: {type: 'boolean', default: false},
    only: {type: 'string'},
    platform: {type: 'string'},
    jitter: {type: 'string', default: '1500-4000'},
    compendium: {type: 'string', default: path.join(import.meta.dirname, 'compendium.json')},
  },
})

const ROOT = path.resolve(import.meta.dirname, '../../.local/live-matrix')
const [jitterMin, jitterMax] = args.jitter.split('-').map(Number) as [number, number]
const only = args.only ? new Set(args.only.split(',').map(s => s.trim().toUpperCase())) : undefined

type Compendium = {readonly scenarios: readonly Scenario[]}
const compendium = JSON.parse(readFileSync(args.compendium, 'utf8')) as Compendium
// share links (they carry the sharer's id) live beside the run, never in the repository: merged by scenario id
const LOCAL = path.join(ROOT, 'compendium.local.json')
let local: Compendium = {scenarios: []}
try {
  local = JSON.parse(readFileSync(LOCAL, 'utf8')) as Compendium
} catch {}
const extra = new Map(local.scenarios.map(s => [s.id, s.urls]))
const merged = compendium.scenarios.map(s => ({...s, urls: [...s.urls, ...(extra.get(s.id) ?? [])]}))
const wanted = merged.filter(
  s =>
    (!only || only.has(s.id)) &&
    // the diagnostic's platforms, else the site detection names (snapchat…)
    (!args.platform || s.urls.some(u => platformOf(u) === args.platform || detectLink(u)?.site === args.platform)),
)
/** Scenarios without a single link yet: reported, never counted as passed. */
const uncovered = wanted.filter(s => s.urls.length === 0)
const scenarios = wanted.filter(s => s.urls.length > 0)

function cookiesFrom(env: string, domains: readonly string[]): SessionProvider | undefined {
  const file = process.env[env]
  if (!file) return undefined
  const cookies = parseNetscape(readFileSync(file, 'utf8'), domains)
  return async () => cookies
}

const facebookCookies = cookiesFrom('MDC_LIVE_COOKIES_FACEBOOK', ['facebook.com'])
const instagramCookies = cookiesFrom('MDC_LIVE_COOKIES_INSTAGRAM', ['instagram.com'])
const tiktokCookies = cookiesFrom('MDC_LIVE_COOKIES_TIKTOK', ['tiktok.com'])
const signedIn = {
  facebook: Boolean(facebookCookies),
  instagram: Boolean(instagramCookies),
  tiktok: Boolean(tiktokCookies),
} as Record<string, boolean>

const runDir = path.join(ROOT, new Date().toISOString().replace(/[:.]/g, '-'))
await fs.mkdir(runDir, {recursive: true})
// a fresh archive each run (nothing is skipped as "already downloaded"); yt-dlp is kept between runs
const dataDir = path.join(ROOT, args.native ? 'data-native' : 'data')
await fs.mkdir(dataDir, {recursive: true})
await fs.rm(path.join(dataDir, 'archive.jsonl'), {force: true})
await fs.rm(path.join(dataDir, 'pending.jsonl'), {force: true})

const dl = new MediaDownloader({
  dataDir,
  validation: 'full',
  ...(args.native && {ytDlp: 'optional' as const, binaries: {ffmpeg: 'ffmpeg', ffprobe: 'ffprobe'}}),
  ...(facebookCookies && {facebook: {cookies: facebookCookies}}),
  ...(instagramCookies && {instagram: {cookies: instagramCookies}}),
  ...(tiktokCookies && {tiktok: {cookies: tiktokCookies}}),
})
dl.on('log', entry => {
  if (entry.level === 'warn' || entry.level === 'error') console.log(`    · ${entry.message}`)
})
// the first run installs yt-dlp (and ffmpeg when the PATH has none) into the matrix's own data folder
// (a native run is the phone's engine: no yt-dlp to install, ffmpeg / ffprobe from the PATH)
if (!args.native) await dl.setup()
const probeExe = args.native ? toExecutable('ffprobe') : (await dl.resolveBinaries()).ffprobe.exe

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const jitter = () => sleep(jitterMin + Math.random() * Math.max(0, jitterMax - jitterMin))

/** Does the analysis give what the scenario expects? A reason when it doesn't. */
function check(expect: Expect, result: AnalysisResult): string | undefined {
  if (expect === 'playlist') {
    if (result.kind !== 'playlist') return `a ${result.kind}, not a listing`
    return result.entries.length > 0 ? undefined : 'an empty listing'
  }
  if (result.kind !== 'video') return 'a listing, not one item'
  const show = result.media.slideshow
  switch (expect) {
    case 'video':
      if (show) return `a photo post (${show.images} images${show.videos ? ', with videos' : ''}), not a video`
      return result.choices.length > 0 ? undefined : 'no format to download'
    case 'photo':
      if (!show) return 'a video, not a photo post'
      return show.images > 0 && !show.videos ? undefined : 'not a photo post'
    case 'photo_with_audio':
      if (!show) return 'a video, not a photo post'
      if (!show.audio) return `a photo post without its music (${show.images} images)`
      return show.images > 0 ? undefined : 'a photo post without images'
    case 'carousel':
      if (!show) return 'one video, not a carousel'
      return show.images + (show.videos ? 1 : 0) > 1 ? undefined : 'a single picture, not a carousel'
  }
}

function describe(result: AnalysisResult): string {
  if (result.kind === 'playlist') return `listing · ${result.entries.length} entries · ${result.extractor}`
  const m = result.media
  const show = m.slideshow
  return show
    ? `photo post · ${show.images} images · audio ${show.audio}${show.videos ? ' · videos' : ''} · ${m.extractor}`
    : `video · ${m.duration ?? '?'} s · ${result.choices.length} choices · ${m.extractor}`
}

/** Download one item with the engine, as the app would, and say what the file holds. */
async function download(url: string, analysis: AnalysisResult, expect: Expect, outDir: string): Promise<Row['probe']> {
  const slideshow: SlideshowOptions = {mode: expect === 'video' ? 'video' : 'images-audio', secondsPerImage: 3}
  const media = analysis.kind === 'video' ? analysis.media : undefined
  const job = dl.add({
    url,
    profile: {kind: 'video', container: 'mp4'},
    outDir,
    slideshow,
    ...(media?.slideshow && {photoPost: true}),
    ...(media?.duration && {duration: media.duration}),
  })
  const done = await new Promise<JobSnapshot>(resolve => {
    const listen = (snapshot: JobSnapshot) => {
      if (snapshot.id !== job.id) return
      if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
        dl.off('job', listen)
        resolve(snapshot)
      }
    }
    dl.on('job', listen)
  })
  if (done.status !== 'completed' || !done.filepath) {
    throw Object.assign(new Error(done.error?.message ?? `download ${done.status}`), {jobError: done.error})
  }
  const stat = await fs.stat(done.filepath)
  if (stat.isDirectory()) {
    // a photo post kept as pictures + its sound
    const files = await fs.readdir(done.filepath)
    const audio = files.find(f => /\.(m4a|mp3|aac|opus|ogg)$/i.test(f))
    const images = files.filter(f => /\.(jpe?g|png|webp|heic)$/i.test(f)).length
    const videos = files.filter(f => /\.(mp4|mov|webm)$/i.test(f)).length
    if (expect === 'photo_with_audio' && !audio) throw new Error(`folder without its music: ${files.join(', ')}`)
    return {video: `${images} images${videos ? ` + ${videos} videos` : ''}`, ...(audio && {audio})}
  }
  const probe = summarizeProbe(await ffprobe(probeExe, done.filepath))
  if (!probe.video) throw new Error('the file has no video stream')
  if (!probe.audio && expect !== 'carousel') throw new Error('DASH audio missing: the file has no audio stream')
  return {
    video: `${probe.video.codec_name} ${probe.video.width}x${probe.video.height}`,
    ...(probe.audio && {audio: String(probe.audio.codec_name)}),
    ...(probe.duration !== undefined && {duration: Math.round(probe.duration)}),
  }
}

const rows: Row[] = []
const started = Date.now()
console.log(
  `live matrix · ${scenarios.length} scenarios · ${scenarios.reduce((n, s) => n + s.urls.length, 0)} links` +
    `${args.download ? ' · with downloads' : ''}${args.native ? ' · native only (no yt-dlp)' : ''} · sessions: ${Object.entries(signedIn)
      .filter(([, on]) => on)
      .map(([site]) => site)
      .join(', ')}`,
)
let first = true
for (const scenario of scenarios) {
  console.log(`\n${scenario.id} · ${scenario.category} (${scenario.expect})`)
  for (const url of scenario.urls) {
    if (!first) await jitter()
    first = false
    const t0 = performance.now()
    let analysis: AnalysisResult | undefined
    let stage: 'analyze' | 'download' = 'analyze'
    let analyzeMs = 0
    let downloadMs: number | undefined
    try {
      analysis = await dl.analyze(url, {maxEntries: 12, signal: AbortSignal.timeout(180_000)})
      analyzeMs = performance.now() - t0
      const wrong = check(scenario.expect, analysis)
      if (wrong) {
        rows.push({scenario: scenario.id, url, outcome: 'fail', analyzeMs, got: describe(analysis), reason: wrong})
        console.log(`  ✗ ${Math.round(analyzeMs)} ms  ${url}\n      ${wrong} — ${describe(analysis)}`)
        continue
      }
      let probe: Row['probe']
      if (args.download && analysis.kind === 'video') {
        stage = 'download'
        const t1 = performance.now()
        probe = await download(url, analysis, scenario.expect, path.join(runDir, scenario.id))
        downloadMs = performance.now() - t1
      }
      rows.push({scenario: scenario.id, url, outcome: 'pass', analyzeMs, downloadMs, got: describe(analysis), probe})
      console.log(
        `  ✓ ${Math.round(analyzeMs)} ms${downloadMs ? ` + ${Math.round(downloadMs)} ms` : ''}  ${url}\n      ${describe(analysis)}${probe ? ` → ${probe.video}${probe.audio ? ` + ${probe.audio}` : ''}` : ''}`,
      )
    } catch (error) {
      const elapsed = performance.now() - t0
      const jobError = (error as {jobError?: Parameters<typeof diagnoseFailure>[0]['error']}).jobError
      const diagnostic = diagnoseFailure({
        url,
        error: jobError ?? toJobError(error),
        stage,
        elapsedMs: elapsed,
        analysis,
      })
      const needsSession = scenario.session && !signedIn[diagnostic.platform]
      const outcome: Outcome =
        needsSession && diagnostic.error_code === 'LOGIN_WALL_DETECTED' ? 'auth' : ('fail' as Outcome)
      rows.push({
        scenario: scenario.id,
        url,
        outcome,
        analyzeMs: analyzeMs || elapsed,
        downloadMs: stage === 'download' ? elapsed - analyzeMs : undefined,
        reason: diagnostic.message,
        diagnostic,
      })
      console.log(
        `  ${outcome === 'auth' ? '○' : '✗'} ${Math.round(elapsed)} ms  ${url}\n      ${diagnostic.error_code} @ ${diagnostic.failure_stage}: ${diagnostic.message}`,
      )
    }
  }
}

await dl.dispose()
const count = (o: Outcome) => rows.filter(r => r.outcome === o).length
const times = rows.map(r => r.analyzeMs).sort((a, b) => a - b)
const pct = (p: number) => Math.round(times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0)
const summary = {
  links: rows.length,
  pass: count('pass'),
  fail: count('fail'),
  auth: count('auth'),
  analyzeMs: {p50: pct(0.5), p90: pct(0.9), max: pct(1)},
  wallMs: Date.now() - started,
  uncovered: uncovered.map(s => s.id),
}
const report = path.join(ROOT, `report-${path.basename(runDir)}.json`)
await fs.writeFile(report, JSON.stringify({summary, signedIn, download: args.download, native: args.native, rows}, null, 2))
console.log(
  `\n${summary.pass} pass · ${summary.fail} fail · ${summary.auth} need a session · analyze p50 ${summary.analyzeMs.p50} ms, p90 ${summary.analyzeMs.p90} ms\nreport: ${report}`,
)
if (uncovered.length) {
  console.log(`
without links yet (add them to ${LOCAL}): ${uncovered.map(s => `${s.id} ${s.category}`).join(' · ')}`)
}
const failed = rows.filter(r => r.outcome === 'fail')
if (failed.length) {
  console.log('\nfailures:')
  for (const r of failed) console.log(`  ${r.scenario}  ${r.url}\n      ${r.diagnostic?.error_code ?? 'WRONG_SHAPE'}: ${r.reason}`)
}
process.exitCode = failed.length ? 1 : 0
