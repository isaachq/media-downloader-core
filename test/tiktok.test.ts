import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {HttpSession} from '../src/sources/http.js'
import {Pacer} from '../src/sources/pacer.js'
import {readPageData, readPost} from '../src/sources/tiktok/data.js'
import type {TikTokError} from '../src/sources/tiktok/errors.js'
import {isTikTokProfile, parseTikTokLink} from '../src/sources/tiktok/links.js'
import {walkProfile} from '../src/sources/tiktok/profile.js'
import {rankRenditions} from '../src/sources/tiktok/renditions.js'
import {titleOf} from '../src/sources/tiktok/source.js'
import {type FakeTikTok, startFakeTikTok} from './helpers/fake-tiktok.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const audio = {kind: 'audio', container: 'mp3'} as const
const mp4 = {kind: 'video', container: 'mp4'} as const

describe('TikTok links', () => {
  it('recognizes posts, photos, profiles, embeds and short links', () => {
    assert.deepEqual(parseTikTokLink('https://www.tiktok.com/@some.user/video/7400000000000000001?is_from_webapp=1'), {
      kind: 'video',
      id: '7400000000000000001',
      user: 'some.user',
    })
    assert.equal(parseTikTokLink('https://www.tiktok.com/@a/photo/7400000000000000002')?.kind, 'photo')
    assert.deepEqual(parseTikTokLink('https://www.tiktok.com/@tiktok'), {kind: 'profile', user: 'tiktok'})
    assert.deepEqual(parseTikTokLink('https://www.tiktok.com/embed/v2/7400000000000000003'), {
      kind: 'video',
      id: '7400000000000000003',
    })
    assert.equal(parseTikTokLink('https://vm.tiktok.com/ZMabc123/')?.kind, 'short')
    assert.equal(parseTikTokLink('https://www.tiktok.com/t/ZTabc/')?.kind, 'short')
    assert.equal(parseTikTokLink('https://www.youtube.com/watch?v=x'), undefined)
    assert.equal(parseTikTokLink('https://www.tiktok.com/foryou'), undefined)
    assert.equal(isTikTokProfile('https://www.tiktok.com/@tiktok'), true)
    assert.equal(isTikTokProfile('https://www.tiktok.com/@tiktok/video/7400000000000000001'), false)
  })
})

describe('TikTok page data', () => {
  const html = (scope: unknown) =>
    `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({__DEFAULT_SCOPE__: scope})}</script></html>`

  it('reads the embedded data and tells verification pages from layout changes', () => {
    assert.deepEqual(readPageData(html({a: 1})), {a: 1})
    const problem = (page: string) => {
      try {
        readPageData(page)
      } catch (error) {
        return (error as TikTokError).problem
      }
      return 'none'
    }
    assert.equal(problem('<html>Please wait... _wafchallengeid</html>'), 'challenge')
    assert.equal(problem('<html><div id="new-app"></div></html>'), 'format-changed')
    assert.equal(problem(html(null).replace('{"__DEFAULT_SCOPE__":null}', '{oops')), 'format-changed')
  })

  it('keeps usable encodings only: no H.266, no redirector, resolution by the short side', () => {
    const post = readPost({
      id: '1',
      desc: 'x',
      author: {uniqueId: 'u'},
      video: {
        bitrateInfo: [
          {CodecType: 'bytevc2', PlayAddr: {UrlList: ['https://cdn/a'], Width: 1080, Height: 1920}},
          {
            CodecType: 'h265_hvc1',
            Bitrate: 2,
            PlayAddr: {UrlList: ['https://cdn/b'], Width: 1080, Height: 1920, DataSize: 800},
          },
          {
            CodecType: 'h264',
            Bitrate: 3,
            PlayAddr: {
              UrlList: ['https://www.tiktok.com/aweme/v1/play/?x', 'https://cdn/c'],
              Width: 720,
              Height: 1280,
              DataSize: 1000,
            },
          },
        ],
      },
    })
    assert.deepEqual(
      post.renditions.map(r => [r.codec, r.resolution, r.urls]),
      [
        ['h265', 1080, ['https://cdn/b']],
        ['h264', 720, ['https://cdn/c']],
      ],
    )
    assert.throws(
      () => readPost({desc: 'no id'}),
      (e: TikTokError) => e.problem === 'format-changed',
    )
  })

  it('titles: first caption line without trailing hashtags, the id when empty', () => {
    const base = readPost({id: '9', author: {uniqueId: 'u'}})
    assert.equal(
      titleOf({...base, description: 'Mi baile favorito 💃 #fyp #dance\nsecond line'}),
      'Mi baile favorito 💃',
    )
    assert.equal(titleOf({...base, description: '#fyp #viral'}), 'TikTok 9')
  })
})

describe('TikTok encodings', () => {
  const r = (codec: 'h264' | 'h265', resolution: number, bytes: number) =>
    ({codec, width: resolution, height: resolution, resolution, bitrate: bytes, bytes, urls: ['u']}) as const
  const all = [r('h265', 1080, 800), r('h264', 720, 1000), r('h265', 720, 600), r('h264', 540, 700)]

  it('mp4: H.264 first — plays in cars and TVs — highest within the cap', () => {
    assert.deepEqual(
      rankRenditions(all, mp4).map(x => `${x.codec}@${x.resolution}`),
      ['h264@720', 'h264@540', 'h265@1080', 'h265@720'],
    )
    assert.deepEqual(
      rankRenditions(all, {...mp4, maxHeight: 600}).map(x => `${x.codec}@${x.resolution}`),
      ['h264@540'],
    )
  })

  it('mkv: highest resolution first; audio: the smallest file (same soundtrack)', () => {
    assert.equal(rankRenditions(all, {kind: 'video', container: 'mkv'})[0]?.resolution, 1080)
    assert.equal(rankRenditions(all, audio)[0]?.bytes, 600)
  })
})

describe('TikTok profile walk', () => {
  const post = (id: number, at: number, pinned = false) => ({
    id: String(id),
    createTime: at,
    isPinnedItem: pinned || undefined,
    author: {uniqueId: 'u'},
  })

  it('dedupes repeated pages, resets identity once, ignores pinned dates and stops at the end', async () => {
    const posts = Array.from({length: 40}, (_, i) => post(1000 - i, 1_790_000_000 - i * 3600))
    let calls = 0
    const devices = new Set<string>()
    let device = 0
    const result = await walkProfile(
      async (cursor, deviceId) => {
        calls++
        devices.add(deviceId)
        // a pinned old post comes first; the 2nd call repeats the 1st page
        const older = posts.filter(p => p.createTime * 1000 < cursor)
        const page = calls === 2 ? posts.slice(0, 15) : older.slice(0, 15)
        return {posts: calls === 1 ? [post(1, 1_500_000_000, true), ...page] : page, more: older.length > 15}
      },
      {max: 500, now: () => 1_790_000_100_000, newDeviceId: () => String(++device)},
    )
    assert.equal(result.length, 41, '40 + the pinned one, no duplicates')
    assert.equal(new Set(result.map(p => p.id)).size, 41)
    assert.ok(devices.size >= 2, 'a fresh identity after the repeated page')
    assert.ok(calls < 10)
  })

  it('respects the cap and calls nothing listed a refusal', async () => {
    const many = Array.from({length: 100}, (_, i) => post(i + 1, 1_790_000_000 - i * 60))
    const capped = await walkProfile(
      async cursor => ({posts: many.filter(p => p.createTime * 1000 < cursor).slice(0, 15), more: true}),
      {
        max: 20,
        newDeviceId: () => 'd',
        now: () => 1_790_000_100_000,
      },
    )
    assert.equal(capped.length, 20)
    await assert.rejects(
      walkProfile(async () => ({posts: [], more: true}), {max: 10, newDeviceId: () => 'd'}),
      (e: TikTokError) => e.problem === 'refused',
    )
  })
})

describe('Pacer', () => {
  it('spaces request starts, caps concurrency and backs off together after a refusal', async () => {
    const pacer = new Pacer({concurrency: 2, spacingMs: 40, jitterMs: 0, backoffMs: 120, maxBackoffMs: 500})
    const starts: number[] = []
    let inFlight = 0
    let peak = 0
    const t0 = Date.now()
    await Promise.all(
      Array.from({length: 4}, () =>
        pacer.run(async () => {
          starts.push(Date.now() - t0)
          peak = Math.max(peak, ++inFlight)
          await new Promise(r => setTimeout(r, 30))
          inFlight--
        }),
      ),
    )
    assert.ok(peak <= 2)
    // the guarantee: start i never comes before slot i (a busy machine may only make it later)
    starts.sort((a, b) => a - b)
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! >= i * 40 - 5, `start ${i} at ${starts[i]}ms`)
    assert.equal(pacer.refused(), 120)
    assert.equal(pacer.refused(), 240, 'doubles')
    const before = Date.now()
    await pacer.run(async () => {})
    assert.ok(Date.now() - before >= 200, 'everyone waits the cool-down')
    pacer.succeeded()
    assert.equal(pacer.refused(), 120, 'back to the bottom after a success')
  })

  it('a cancelled caller frees its place', async () => {
    const pacer = new Pacer({concurrency: 1, spacingMs: 0, jitterMs: 0})
    let release!: () => void
    const first = pacer.run(() => new Promise<void>(r => (release = r)))
    const abort = new AbortController()
    const waiting = pacer.run(async () => 'never', abort.signal)
    abort.abort()
    await assert.rejects(waiting)
    release()
    await first
    assert.equal(await pacer.run(async () => 'ok'), 'ok')
  })
})

describe('HttpSession', () => {
  it('keeps cookies per domain and sends them to subdomains', async () => {
    const seen: string[] = []
    const session = new HttpSession({
      fetch: async (url, init) => {
        seen.push(`${url} ${((init?.headers ?? {}) as Record<string, string>)['Cookie'] ?? '-'}`)
        return new Response('ok', {
          headers: [
            ['Set-Cookie', 'a=1; Domain=.tiktok.com; Path=/'],
            ['Set-Cookie', 'b=2; Path=/'],
          ],
        })
      },
    })
    await session.get('https://www.tiktok.com/x')
    await session.get('https://v16.tiktok.com/media')
    await session.get('https://www.tiktok.com/y')
    assert.equal(seen[0], 'https://www.tiktok.com/x -')
    assert.equal(seen[1], 'https://v16.tiktok.com/media a=1', 'domain cookie only')
    assert.equal(seen[2], 'https://www.tiktok.com/y b=2; a=1')
  })
})

// ─── against a local fake TikTok ─────────────────────────────────────────────

let root = ''
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-tiktok-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

async function setup(name: string, config: Parameters<typeof startFakeTikTok>[0] = {}) {
  const site = await startFakeTikTok(config)
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    maxRetries: 3,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: {origin: site.origin, pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 30, maxBackoffMs: 100}},
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {site, engine, scheduler, out: path.join(root, name, 'out')}
}

const videoUrl = (site: FakeTikTok, i = 0) => `${site.origin}/@${site.user}/video/${site.ids[i]}`

describe('TikTok, end to end (local fake)', () => {
  it('downloads one post as MP4: page session cookie + Referer, H.264 picked, portable name', async () => {
    const {site, scheduler, out} = await setup('single')
    const batch = scheduler.schedule({url: videoUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const files = await fs.readdir(out)
    assert.equal(files.length, 1)
    assert.match(files[0]!, /^Post-numero-1-con-acentos-\d+\.mp4$/)
    assert.equal((await fs.readFile(path.join(out, files[0]!), 'utf8')).slice(0, 4), '4444', 'the H.264 encoding')
    assert.equal(site.hits.page, 1, 'preflight page read reused by the download')
    assert.equal(site.hits.refusedMedia, 0)
  })

  it('backs up a whole profile as MP3: listing de-duplicated, pinned post kept, each post read once', async () => {
    const {site, scheduler, out} = await setup('profile', {posts: 34, repeatPage: true, pinned: true})
    const batch = scheduler.schedule({url: `${site.origin}/@${site.user}`, profile: audio, outDir: out})
    assert.equal(batch.maxItems, undefined, 'the default cap applies to real tiktok.com profiles')
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 34)
    const folder = (await fs.readdir(out))[0]!
    assert.equal(folder, 'TikTok-fakeuser')
    const files = await fs.readdir(path.join(out, folder))
    assert.equal(files.length, 34)
    assert.ok(files.every(f => /^\d{3}-.+\.mp3$/.test(f)))
    assert.equal(site.hits.page, 34, 'one page read per post, at download time')
  })

  it('a private account fails at once with the reason', async () => {
    const {site, scheduler, out} = await setup('private', {private: true})
    const batch = scheduler.schedule({url: `${site.origin}/@${site.user}`, profile: audio, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'failed')
    assert.equal(done.error?.hint, 'private')
  })

  it('retries refusals (403) natively after the shared cool-down', async () => {
    const {site, scheduler, out} = await setup('refused', {refusals: 2})
    const batch = scheduler.schedule({url: videoUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed')
    assert.equal(site.hits.page, 3, '2 refusals + 1 success, all native')
    assert.match((await fs.readdir(out))[0]!, /^Post-numero-1/)
  })

  it('a verification page is not solved: TikTok goes to yt-dlp for a while, without knocking again', async () => {
    const {site, engine, scheduler, out} = await setup('challenge', {challenges: 1, posts: 2})
    const batch = scheduler.schedule({url: videoUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    // a second link right after: straight to yt-dlp, TikTok isn't asked again
    const second = scheduler.schedule({url: videoUrl(site, 1), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(second.id)?.status, 'completed')
    assert.equal(site.hits.page, 1, 'one verification page, then hands off')
    assert.ok(engine.jobs().every(job => job.attempts.length === 1))
  })

  it('skips an encoding without sound and takes the next one', async () => {
    const {site, scheduler, out} = await setup('silent', {silentH264: true})
    const batch = scheduler.schedule({url: videoUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed')
    const [file] = await fs.readdir(out)
    assert.equal((await fs.readFile(path.join(out, file!), 'utf8')).slice(0, 4), '5555', 'silent H.264 skipped → H.265')
  })

  it('falls back to yt-dlp when a page no longer has the data (layout changed)', async () => {
    const site = await startFakeTikTok({posts: 2})
    const broken = site.ids[0]!
    await site.close()
    const {site: live, engine, scheduler, out} = await setup('fallback', {posts: 2, brokenPost: broken})
    const job = engine.add({url: `${live.origin}/@${live.user}/video/${broken}`, profile: mp4, outDir: out})
    await engine.whenIdle()
    const finished = engine.jobs().find(j => j.id === job.id)!
    assert.equal(finished.status, 'completed', JSON.stringify(finished.error))
    assert.deepEqual(
      finished.attempts.map(a => a.strategy),
      ['primary', 'extractor-fallback'],
    )
    void scheduler
  })

  it('resolves short links', async () => {
    const {site, scheduler, out} = await setup('short')
    const batch = scheduler.schedule({url: `${site.origin}/t/ZTabc/`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.ok(site.hits.short >= 1)
  })
})
