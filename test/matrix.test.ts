// Format regression plan §6: the whole engine, every source family, every profile — with
// real media served by the local fakes and the real ffmpeg beside them. 5 families × 26
// profiles, plus slideshows and a carousel with a video (phase C6). Each output is probed
// and the probes are written as a manifest (`MDC_REPORT_DIR`, default `reports/`), for CI
// to keep beside the JUnit file.
//
//   MDC_MATRIX=1 npx tsx --test test/matrix.test.ts
//
// Skipped unless MDC_MATRIX=1 (it is the nightly run, ~2 minutes) and ffmpeg is on the PATH.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {genericChoices, rulesFor} from '../src/core/formats.js'
import {run} from '../src/core/process.js'
import {ffprobe, summarizeProbe} from '../src/core/validate.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {PlayerPageSource} from '../src/sources/player-page/source.js'
import type {DownloaderOptions, FormatProfile, JobSnapshot} from '../src/types.js'
import {startFakeFacebook} from './helpers/fake-facebook.js'
import {SESSION_COOKIE, startFakeInstagram} from './helpers/fake-instagram.js'
import {startFakePlayerSite} from './helpers/fake-player-site.js'
import {startFakeTikTok} from './helpers/fake-tiktok.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'
import {MediaLab} from './helpers/media-lab.js'

const available = await run('ffmpeg', ['-version']).then(
  result => result.code === 0,
  () => false,
)
const enabled = process.env['MDC_MATRIX'] === '1'
const skip = !enabled ? 'MDC_MATRIX=1 runs the matrix (nightly)' : !available ? 'ffmpeg not installed' : false

const REAL = {command: 'ffmpeg', args: []}
const PROBE = {command: 'ffprobe', args: []}
const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 60}

/** One probed output, as the manifest records it. */
type ManifestEntry = {
  readonly source: string
  readonly profile: string
  readonly ok: boolean
  readonly file?: string
  readonly container?: string
  readonly video?: {readonly codec: string; readonly width: number; readonly height: number}
  readonly audio?: {readonly codec: string}
  readonly duration?: number | undefined
  readonly sizeBytes?: number | undefined
  readonly attempts?: number
  readonly steps?: Readonly<Record<string, string>>
  readonly error?: string
  readonly hint?: string | undefined
  readonly note?: string
}

let root = ''
let fakes: FakeBinaries
let lab: MediaLab
const manifest: ManifestEntry[] = []
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-matrix-'))
  fakes = await writeFakes(path.join(root, 'bin'))
  lab = new MediaLab(path.join(root, 'fixtures'))
})
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  if (enabled && manifest.length > 0) {
    const dir = process.env['MDC_REPORT_DIR'] ?? 'reports'
    await fs.mkdir(dir, {recursive: true})
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `matrix-${stamp}.json`)
    const summary = {
      date: new Date().toISOString(),
      platform: `${process.platform} ${os.arch()} · node ${process.version}`,
      cases: manifest.length,
      ok: manifest.filter(entry => entry.ok).length,
      entries: manifest,
    }
    await fs.writeFile(file, JSON.stringify(summary, null, 2))
    console.log(`matrix manifest: ${file} (${summary.ok}/${summary.cases} ok)`)
  }
  await fs.rm(root, {recursive: true, force: true})
})

/** The real fixtures every site serves: an H.264 1080p clip, a portrait picture, an MP3 soundtrack. */
async function media() {
  return {
    video: await lab.fixture('mp4-h264-aac-1080'),
    duration: 1,
    image: await lab.fixture('image-portrait-jpg'),
    sound: await lab.fixture('audio-mp3-6s'),
    soundDuration: 6,
    audio: await lab.fixture('audio-aac-m4a'),
  }
}

/** The 26 profiles of the public matrix, labelled `video:mp4:720` / `audio:mp3`. */
const PROFILES = genericChoices().map(choice => choice.profile)
assert.equal(PROFILES.length, 26)
const label = (profile: FormatProfile) =>
  profile.kind === 'video' ? `video:${profile.container}:${profile.maxHeight ?? 'best'}` : `audio:${profile.container}`
/** A folder name for a profile (':' is no file name character on Windows). */
const folder = (profile: FormatProfile) => label(profile).replace(/:/g, '-')

type Family = {
  readonly name: string
  readonly options: Partial<DownloaderOptions>
  /** The url of one video post, read natively or by the (fake) yt-dlp. */
  readonly url: string
  close(): Promise<void>
}

/** Every family of source, each serving the same real clip. */
const FAMILIES: ReadonlyArray<[string, () => Promise<Family>]> = [
  [
    'yt-dlp',
    async () => {
      const m = await media()
      // the fake yt-dlp copies these as its downloads, and converts audio with the real ffmpeg
      process.env['MDC_FAKE_MEDIA_VIDEO'] = m.video
      process.env['MDC_FAKE_MEDIA_AUDIO'] = m.audio
      process.env['MDC_FAKE_MEDIA_DURATION'] = String(m.duration)
      process.env['MDC_FAKE_FFMPEG'] = 'ffmpeg'
      return {
        name: 'yt-dlp',
        options: {tiktok: false, instagram: false, facebook: false},
        url: 'https://fake.test/e1',
        close: async () => {
          delete process.env['MDC_FAKE_MEDIA_VIDEO']
          delete process.env['MDC_FAKE_MEDIA_AUDIO']
          delete process.env['MDC_FAKE_MEDIA_DURATION']
          delete process.env['MDC_FAKE_FFMPEG']
        },
      }
    },
  ],
  [
    'tiktok',
    async () => {
      const m = await media()
      const site = await startFakeTikTok({posts: 1, media: {video: m.video, duration: m.duration}})
      return {
        name: 'tiktok',
        options: {tiktok: {origin: site.origin, pacing: fast}, instagram: false, facebook: false},
        url: `${site.origin}/@${site.user}/video/${site.ids[0]}`,
        close: () => site.close(),
      }
    },
  ],
  [
    'instagram',
    async () => {
      const m = await media()
      const site = await startFakeInstagram({posts: 1, media: {video: m.video, image: m.image, duration: m.duration}})
      const [name, value] = SESSION_COOKIE.split('=') as [string, string]
      const host = new URL(site.origin).hostname
      return {
        name: 'instagram',
        options: {
          tiktok: false,
          facebook: false,
          instagram: {origin: site.origin, pacing: fast, cookies: async () => [{name, value, domain: host}]},
        },
        url: `${site.origin}/p/${site.codes[0]}/`,
        close: () => site.close(),
      }
    },
  ],
  [
    'facebook',
    async () => {
      const m = await media()
      const site = await startFakeFacebook({videos: 1, media: {video: m.video, duration: m.duration}})
      return {
        name: 'facebook',
        options: {tiktok: false, instagram: false, facebook: {origin: site.origin, pacing: fast}},
        url: `${site.origin}/watch/?v=${site.ids[0]}`,
        close: () => site.close(),
      }
    },
  ],
  [
    'player-page',
    async () => {
      const m = await media()
      const site = await startFakePlayerSite({results: 1, perPage: 1, media: {video: m.video, duration: m.duration}})
      const source = new PlayerPageSource({
        site: {name: 'Local Site', hosts: [site.host]},
        pacing: {concurrency: 4, ...fast},
        resolveMedia: site.resolve,
      })
      return {
        name: 'player-page',
        options: {tiktok: false, instagram: false, facebook: false, sources: [source]},
        url: `${site.origin}/video/${site.ids[0]}/clip-${site.ids[0]}`,
        close: () => site.close(),
      }
    },
  ],
]

/** An engine on the fake yt-dlp and the real ffmpeg, checking every file in full. */
function harness(name: string, options: Partial<DownloaderOptions>) {
  const dataDir = path.join(root, name)
  const engine = new MediaDownloader({
    dataDir,
    binaries: {ytDlp: fakes.ytDlp, ffmpeg: REAL, ffprobe: PROBE},
    validation: 'full',
    maxRetries: 1,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    concurrency: 3,
    ...options,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
  })
  return {engine, scheduler, dataDir, out: path.join(dataDir, 'out')}
}

const steps = (job: JobSnapshot) => Object.fromEntries(job.steps.map(step => [step.name, step.state]))

/** Probe an output and check it against the profile; the manifest gets the probe either way. */
async function record(source: string, profile: FormatProfile, job: JobSnapshot | undefined): Promise<ManifestEntry> {
  const name = label(profile)
  if (!job) return {source, profile: name, ok: false, error: 'no job'}
  if (job.status !== 'completed' || !job.filepath) {
    return {
      source,
      profile: name,
      ok: false,
      attempts: job.attempt,
      steps: steps(job),
      error: job.error?.message ?? job.status,
      hint: job.error?.hint,
    }
  }
  const summary = summarizeProbe(await ffprobe(PROBE, job.filepath))
  const rules = rulesFor(profile)
  const problems: string[] = []
  const ext = path.extname(job.filepath).slice(1).toLowerCase()
  if (ext !== rules.ext) problems.push(`extension .${ext}, expected .${rules.ext}`)
  if (!summary.container.split(',').some(part => rules.formatNames.includes(part)))
    problems.push(`container ${summary.container}`)
  if (profile.kind === 'video') {
    if (!summary.video) problems.push('no video stream')
    else if (rules.video && rules.video.length > 0 && !rules.video.includes(summary.video.codec_name ?? ''))
      problems.push(`video codec ${summary.video.codec_name}`)
    const short = Math.min(summary.video?.width ?? 0, summary.video?.height ?? 0)
    if (profile.maxHeight !== undefined && short > profile.maxHeight)
      problems.push(`short side ${short} above the ${profile.maxHeight} cap`)
    if (summary.audio && rules.audio.length > 0 && !rules.audio.includes(summary.audio.codec_name ?? ''))
      problems.push(`audio codec ${summary.audio.codec_name}`)
  } else {
    if (summary.video) problems.push('a video stream in an audio file')
    if (!summary.audio) problems.push('no audio stream')
    else if (!rules.audio.includes(summary.audio.codec_name ?? ''))
      problems.push(`audio codec ${summary.audio.codec_name}`)
  }
  if (job.attempt !== 1) problems.push(`${job.attempt} attempts`)
  if (steps(job)['validate'] !== 'success') problems.push(`validate step ${steps(job)['validate']}`)
  return {
    source,
    profile: name,
    ok: problems.length === 0,
    file: path.basename(job.filepath),
    container: summary.container,
    ...(summary.video && {
      video: {
        codec: summary.video.codec_name ?? 'unknown',
        width: summary.video.width ?? 0,
        height: summary.video.height ?? 0,
      },
    }),
    ...(summary.audio && {audio: {codec: summary.audio.codec_name ?? 'unknown'}}),
    duration: summary.duration,
    sizeBytes: job.validation?.sizeBytes,
    attempts: job.attempt,
    steps: steps(job),
    ...(problems.length > 0 && {error: problems.join('; ')}),
  }
}

describe('matrix · every family × 26 profiles (real media, real ffmpeg)', {skip}, () => {
  for (const [name, start] of FAMILIES) {
    it(`${name}: 26 profiles come out as promised, in one attempt, nothing left in the work folder`, async () => {
      const family = await start()
      cleanups.push(() => family.close())
      const {engine, scheduler, dataDir, out} = harness(name, family.options)
      const batches = PROFILES.map(profile => ({
        profile,
        batch: scheduler.schedule({url: family.url, profile, outDir: path.join(out, folder(profile))}),
      }))
      await Promise.race([
        scheduler.whenIdle(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${name}: not settled in 10 min`)), 600_000).unref(),
        ),
      ])
      const jobs = engine.jobs()
      const entries: ManifestEntry[] = []
      for (const {profile, batch} of batches) {
        const job = jobs.find(job => job.batchId === batch.id)
        entries.push(await record(name, profile, job))
      }
      manifest.push(...entries)
      const failed = entries.filter(entry => !entry.ok)
      assert.deepEqual(
        failed.map(entry => `${entry.profile}: ${entry.error}`),
        [],
        `${name}: ${failed.length} of ${entries.length} profiles off`,
      )
      // nothing left behind: every job's work folder is gone once it finished
      const left = await fs.readdir(path.join(dataDir, 'work')).catch(() => [] as string[])
      assert.deepEqual(left, [], `${name}: work folders left: ${left.join(', ')}`)
    })
  }
})

describe('matrix · slideshows and bundles (phase C6)', {skip}, () => {
  it('a TikTok slideshow with a soundtrack: MP4, WebM and MKV with sound, and its soundtrack as M4A', async () => {
    const m = await media()
    const site = await startFakeTikTok({
      posts: 1,
      slideshows: [0],
      media: {image: m.image, sound: m.sound, soundDuration: m.soundDuration},
    })
    cleanups.push(() => site.close())
    const {engine, scheduler, out} = harness('slides-sound', {
      tiktok: {origin: site.origin, pacing: fast},
      instagram: false,
      facebook: false,
    })
    const url = `${site.origin}/@${site.user}/video/${site.ids[0]}`
    const profiles: FormatProfile[] = [
      {kind: 'video', container: 'mp4'},
      {kind: 'video', container: 'webm', maxHeight: 720},
      {kind: 'video', container: 'mkv'},
      {kind: 'audio', container: 'm4a'},
    ]
    const batches = profiles.map(profile => ({
      profile,
      batch: scheduler.schedule({url, profile, outDir: path.join(out, folder(profile))}),
    }))
    await scheduler.whenIdle()
    const jobs = engine.jobs()
    for (const {profile, batch} of batches) {
      const job = jobs.find(job => job.batchId === batch.id)
      const entry = await record('tiktok-slideshow', profile, job)
      manifest.push(entry)
      assert.ok(entry.ok, `${entry.profile}: ${entry.error}`)
      if (profile.kind === 'video') {
        assert.ok(entry.audio, `${entry.profile}: the soundtrack rides along`)
        assert.ok((entry.duration ?? 0) >= 6, `${entry.profile}: three pictures over the soundtrack`)
      }
    }
  })

  it('a silent slideshow: a video without sound in every container; audio asked is "unavailable"', async () => {
    const m = await media()
    const site = await startFakeTikTok({posts: 1, slideshows: [0], silentSlides: [0], media: {image: m.image}})
    cleanups.push(() => site.close())
    const {engine, scheduler, out} = harness('slides-silent', {
      tiktok: {origin: site.origin, pacing: fast},
      instagram: false,
      facebook: false,
    })
    const url = `${site.origin}/@${site.user}/video/${site.ids[0]}`
    const profiles: FormatProfile[] = [
      {kind: 'video', container: 'mp4', maxHeight: 480},
      {kind: 'video', container: 'webm'},
      {kind: 'video', container: 'mkv'},
      {kind: 'audio', container: 'mp3'},
    ]
    const batches = profiles.map(profile => ({
      profile,
      batch: scheduler.schedule({url, profile, outDir: path.join(out, folder(profile))}),
    }))
    await scheduler.whenIdle()
    const jobs = engine.jobs()
    for (const {profile, batch} of batches) {
      const job = jobs.find(job => job.batchId === batch.id)
      const entry = await record('tiktok-slideshow-silent', profile, job)
      if (profile.kind === 'audio') {
        // refused at the check (no job is made) or failed as a job: either way the reason is the format
        const done = scheduler.batch(batch.id)
        const hint =
          job?.error?.hint ??
          Object.keys({...(done?.problems?.unavailable ?? {}), ...(done?.problems?.failed ?? {})})[0]
        manifest.push({...entry, ok: hint === 'format-unavailable', hint, note: 'expected to fail: no soundtrack'})
        assert.equal(hint, 'format-unavailable', JSON.stringify({job: job?.error, problems: done?.problems}))
        continue
      }
      manifest.push(entry)
      assert.ok(entry.ok, `${entry.profile}: ${entry.error}`)
      assert.equal(entry.audio, undefined, `${entry.profile}: no sound to add`)
    }
  })

  it('an Instagram carousel with a video, asked as WebM 480: a folder with its pictures and the clip made WebM', async () => {
    const m = await media()
    const site = await startFakeInstagram({
      posts: 1,
      carousels: [0],
      mixedCarousels: true,
      media: {video: m.video, image: m.image, duration: m.duration},
    })
    cleanups.push(() => site.close())
    const [name, value] = SESSION_COOKIE.split('=') as [string, string]
    const host = new URL(site.origin).hostname
    const {engine, scheduler, out} = harness('carousel', {
      tiktok: false,
      facebook: false,
      instagram: {origin: site.origin, pacing: fast, cookies: async () => [{name, value, domain: host}]},
    })
    const profile: FormatProfile = {kind: 'video', container: 'webm', maxHeight: 480}
    scheduler.schedule({
      url: `${site.origin}/p/${site.codes[0]}/`,
      profile,
      outDir: out,
      slideshow: {mode: 'images', secondsPerImage: 3},
    })
    await scheduler.whenIdle()
    const job = engine.jobs()[0]
    assert.ok(job, 'a job')
    assert.equal(job.status, 'completed', job.error?.message)
    assert.ok(job.filepath, 'a folder')
    const files = (await fs.readdir(job.filepath)).sort()
    assert.deepEqual(files, ['01.jpg', '02.jpg', '03.webm'], 'the pictures as they came, the clip as WebM')
    const clip = summarizeProbe(await ffprobe(PROBE, path.join(job.filepath, '03.webm')))
    assert.ok(clip.container.includes('webm') || clip.container.includes('matroska'), clip.container)
    assert.ok(['vp8', 'vp9', 'av1'].includes(clip.video?.codec_name ?? ''), clip.video?.codec_name)
    assert.ok(Math.min(clip.video?.width ?? 0, clip.video?.height ?? 0) <= 480, 'within the cap')
    assert.equal(steps(job)['convert'], 'success')
    assert.equal(steps(job)['validate'], 'success')
    manifest.push({
      source: 'instagram-carousel',
      profile: label(profile),
      ok: true,
      file: path.basename(job.filepath),
      container: 'folder',
      video: {codec: clip.video?.codec_name ?? '', width: clip.video?.width ?? 0, height: clip.video?.height ?? 0},
      attempts: job.attempt,
      steps: steps(job),
      note: files.join(', '),
    })
  })
})
