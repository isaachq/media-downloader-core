import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import type {BrowserAssist} from '../src/sources/browser.js'
import {HttpSession} from '../src/sources/http.js'
import {Pacer} from '../src/sources/pacer.js'
import {readPageData, readPost} from '../src/sources/tiktok/data.js'
import type {TikTokError} from '../src/sources/tiktok/errors.js'
import {isTikTokProfile, parseTikTokLink} from '../src/sources/tiktok/links.js'
import {walkProfile} from '../src/sources/tiktok/profile.js'
import {rankRenditions} from '../src/sources/tiktok/renditions.js'
import {slideshowArgs, slideshowFrame, slideshowOptions} from '../src/sources/tiktok/slideshow.js'
import {TikTokSource, titleOf} from '../src/sources/tiktok/source.js'
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
    pacer.resume()
    const resumed = Date.now()
    await pacer.run(async () => {})
    assert.ok(Date.now() - resumed < 100, 'resume() drops the cool-down')
  })

  it('resume() wakes the callers already waiting out a cool-down', async () => {
    const pacer = new Pacer({concurrency: 4, spacingMs: 10, jitterMs: 0, backoffMs: 60_000})
    pacer.refused()
    const started = Date.now()
    const waiting = Promise.all([1, 2, 3].map(n => pacer.run(async () => n)))
    await new Promise(r => setTimeout(r, 30))
    pacer.resume()
    assert.deepEqual(await waiting, [1, 2, 3])
    assert.ok(Date.now() - started < 2000, 'nobody slept the minute through')
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

async function setup(
  name: string,
  config: Parameters<typeof startFakeTikTok>[0] = {},
  browser?: (origin: string) => BrowserAssist,
) {
  const site = await startFakeTikTok(config)
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    maxRetries: 3,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: {
      origin: site.origin,
      pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 30, maxBackoffMs: 100},
      ...(browser && {browser: browser(site.origin)}),
    },
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
    assert.equal(batch.maxItems, 500, 'profiles load 500 by default, wherever the source serves them')
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

  it('verification pages go through a real browser once; its session then serves listing and media over HTTP', async () => {
    let renders = 0
    // stands in for the app's Chromium: it "runs the script" and ends up with the cookie
    const browser =
      (origin: string): BrowserAssist =>
      async url => {
        renders++
        const response = await fetch(url, {headers: {Cookie: 'waf_ok=1'}})
        return {
          html: await response.text(),
          userAgent: 'FakeBrowser/1.0',
          cookies: [
            {name: 'waf_ok', value: '1', domain: new URL(origin).hostname},
            {name: 'tt_chain_token', value: 'from-browser', domain: new URL(origin).hostname},
          ],
        }
      }
    const {site, scheduler, out} = await setup('browser', {posts: 20, jsChallenge: true}, browser)
    const started = Date.now()
    const batch = scheduler.schedule({url: `${site.origin}/@${site.user}`, profile: audio, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 20)
    assert.equal(renders, 1, 'one browser page; everything after went over HTTP with its session')
    // the cool-down a refusal would add is told apart by the requests, not by a stopwatch (the
    // machine's load would decide that): the browser passed once, and nothing was refused after it
    assert.equal(site.hits.refusedMedia, 0, 'no media request was refused after the browser passed')
    assert.ok(Date.now() - started < 60_000, `finished (${Date.now() - started} ms)`)
    assert.equal(site.hits.challenge, 1, 'only the first plain request met the check')
  })

  it('a captcha even the browser cannot pass hands TikTok to yt-dlp (no solving)', async () => {
    const browser = (): BrowserAssist => async url => {
      const response = await fetch(url)
      return {html: await response.text(), userAgent: 'FakeBrowser/1.0', cookies: []}
    }
    const {site, scheduler, out} = await setup('captcha', {posts: 2, jsChallenge: true, captcha: true}, browser)
    const batch = scheduler.schedule({url: videoUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    // yt-dlp (fake) took over: done, without the built-in extractor knocking again
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal(site.hits.page, 0, 'no data page was ever served')
  })

  it('a profile listed short of its post count gets a second, merged pass', async () => {
    const {site, scheduler, out} = await setup('short-listing', {posts: 30, repeatPage: true})
    const batch = scheduler.schedule({url: `${site.origin}/@${site.user}`, profile: audio, outDir: out, maxItems: 30})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.preflight.total, 30)
  })

  it('reports listing progress, answers a reopened profile from memory, and lists only what is missing for more', async () => {
    const {site, engine} = await setup('listing-cache', {posts: 40})
    const url = `${site.origin}/@${site.user}`
    const seen: number[] = []
    const first = await engine.analyze(url, {maxEntries: 20, onProgress: p => seen.push(p.listed)})
    assert.equal(first.kind === 'playlist' && first.entries.length, 20)
    assert.equal(seen[0], 0)
    assert.equal(seen.at(-1), 20)
    const listCalls = site.hits.list

    const again = await engine.analyze(url, {maxEntries: 20})
    assert.equal(again.kind === 'playlist' && again.entries.length, 20)
    assert.equal(site.hits.list, listCalls, 'reopened: no request to TikTok')

    const more = await engine.analyze(url, {maxEntries: 40})
    assert.equal(more.kind === 'playlist' && more.entries.length, 40)
    assert.equal(new Set(more.kind === 'playlist' ? more.entries.map(e => e.id) : []).size, 40)
    assert.ok(
      site.hits.list - listCalls <= 2,
      `continued below the known posts (${site.hits.list - listCalls} pages), not from the start`,
    )
  })

  it('takes the host’s session like Instagram and Facebook: its cookies and agent on every request, asked once', async () => {
    const site = await startFakeTikTok({posts: 2})
    cleanups.push(() => site.close())
    const host = new URL(site.origin).hostname
    const sent: Array<{url: string; cookie: string; agent: string}> = []
    let asked = 0
    const source = new TikTokSource({
      origin: site.origin,
      pacing: {spacingMs: 0, jitterMs: 0},
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        sent.push({url: input, cookie: headers.get('cookie') ?? '', agent: headers.get('user-agent') ?? ''})
        return fetch(input, init)
      },
      cookies: async () => {
        asked++
        return {cookies: [{name: 'sessionid', value: 'tt-session', domain: `.${host}`}], userAgent: 'WebView/1'}
      },
    })
    assert.equal((await source.analyze(videoUrl(site, 0))).kind, 'video')
    assert.equal((await source.analyze(videoUrl(site, 1))).kind, 'video')
    assert.equal(asked, 1, 'asked once, kept for 6 hours')
    assert.ok(sent.length >= 2)
    assert.ok(
      sent.every(r => r.cookie.includes('sessionid=tt-session') && r.agent === 'WebView/1'),
      JSON.stringify(sent),
    )
    // the plain form (cookies only) keeps the source's own agent
    const plain = new TikTokSource({
      origin: site.origin,
      pacing: {spacingMs: 0, jitterMs: 0},
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        sent.push({url: input, cookie: headers.get('cookie') ?? '', agent: headers.get('user-agent') ?? ''})
        return fetch(input, init)
      },
      cookies: async () => [{name: 'sessionid', value: 'plain', domain: host}],
    })
    sent.length = 0
    await plain.analyze(videoUrl(site, 0))
    assert.ok(sent[0]!.cookie.includes('sessionid=plain') && sent[0]!.agent.startsWith('Mozilla/5.0'))
  })

  it('resolves short links', async () => {
    const {site, scheduler, out} = await setup('short')
    const batch = scheduler.schedule({url: `${site.origin}/t/ZTabc/`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.ok(site.hits.short >= 1)
  })
})

describe('TikTok whole profiles and publication dates (local fake)', () => {
  it('lists a whole profile past the 500 default, in chunks, and tells its total', async () => {
    const {site, engine} = await setup('whole-profile', {posts: 1100})
    const url = `${site.origin}/@${site.user}`
    const capped = await engine.analyze(url)
    assert.ok(capped.kind === 'playlist')
    assert.equal(capped.entries.length, 500, 'the default cap')
    assert.equal(capped.total, 1100, 'the account says how many there are')

    const before = site.hits.list
    const seen: number[] = []
    const all = await engine.analyze(url, {maxEntries: capped.total!, onProgress: p => seen.push(p.listed)})
    assert.ok(all.kind === 'playlist')
    assert.equal(all.entries.length, 1100)
    assert.equal(new Set(all.entries.map(e => e.id)).size, 1100, 'each post once')
    assert.deepEqual(
      all.entries.map(e => e.index),
      Array.from({length: 1100}, (_, i) => i + 1),
    )
    // continued below the 500 already listed: ~600 posts / 15 per page, not the whole profile again
    assert.ok(site.hits.list - before <= 42, `${site.hits.list - before} listing pages for 600 posts`)
    assert.ok(
      seen.every((n, i) => i === 0 || n >= seen[i - 1]!),
      'progress never goes back',
    )
    assert.equal(seen.at(-1), 1100)
    assert.ok(
      all.entries.every((e, i) => i === 0 || (e.publishedAt ?? 0) <= (all.entries[i - 1]!.publishedAt ?? 0)),
      'newest first, each with its publication time',
    )
  })

  it('a listing refused half-way keeps what it got, and loading again continues from there', async () => {
    const {site, engine} = await setup('refused-chunk', {posts: 700, listFailures: {after: 40, count: 6}})
    const url = `${site.origin}/@${site.user}`
    const first = await engine.analyze(url, {maxEntries: 700})
    assert.ok(first.kind === 'playlist')
    assert.ok(first.entries.length >= 500 && first.entries.length < 700, `partial: ${first.entries.length}`)
    assert.equal(first.total, 700, 'the preview can tell it is partial')

    const before = site.hits.list
    const second = await engine.analyze(url, {maxEntries: 700})
    assert.ok(second.kind === 'playlist')
    assert.equal(second.entries.length, 700)
    assert.equal(new Set(second.entries.map(e => e.id)).size, 700)
    assert.ok(site.hits.list - before < 30, `continued, not restarted (${site.hits.list - before} pages)`)
  })

  it('a cancelled listing keeps its chunks for the next request', async () => {
    const {site, engine} = await setup('cancelled-listing', {posts: 600})
    const url = `${site.origin}/@${site.user}`
    const stop = new AbortController()
    await assert.rejects(
      engine.analyze(url, {
        maxEntries: 600,
        signal: stop.signal,
        onProgress: p => {
          if (p.listed >= 510) stop.abort()
        },
      }),
    )
    const before = site.hits.list
    const again = await engine.analyze(url, {maxEntries: 600})
    assert.ok(again.kind === 'playlist')
    assert.equal(again.entries.length, 600)
    assert.ok(site.hits.list - before <= 10, `the first 500 came from memory (${site.hits.list - before} pages)`)
  })

  it('dates the downloaded file by the post’s publication', async () => {
    const {site, engine, out} = await setup('published-date', {posts: 3})
    engine.add({url: videoUrl(site, 1), profile: mp4, outDir: out})
    await engine.whenIdle()
    const [file] = await fs.readdir(out)
    const stat = await fs.stat(path.join(out, file!))
    // the fake's posts are an hour apart, newest at 1 790 000 000
    assert.equal(Math.round(stat.mtimeMs / 1000), 1_790_000_000 - 3600)
  })
})

describe('TikTok veteran profiles (local fake)', () => {
  it('lists a 10-year, 1,300-post profile to its very first post, from before TikTok existed (musical.ly)', async () => {
    // a post every 3 days back from 2026: the oldest from December 2015
    const {site, engine} = await setup('veteran', {posts: 1300, spacingSeconds: 3 * 86_400})
    const listing = await engine.analyze(`${site.origin}/@${site.user}`, {maxEntries: 1300})
    assert.ok(listing.kind === 'playlist')
    assert.equal(listing.entries.length, 1300)
    assert.equal(new Set(listing.entries.map(e => e.id)).size, 1300)
    assert.equal(listing.complete, true, 'the listing reached the end')
    const oldest = Math.min(...listing.entries.map(e => e.publishedAt!))
    assert.ok(oldest * 1000 < Date.UTC(2016, 8, 1), `oldest post ${new Date(oldest * 1000).toISOString()}`)
  })

  it('posts the account counts but never lists: the listing ends complete, and asking again costs nothing', async () => {
    const {site, engine} = await setup('unlisted', {posts: 40, unlisted: 4})
    const url = `${site.origin}/@${site.user}`
    const first = await engine.analyze(url, {maxEntries: 44})
    assert.ok(first.kind === 'playlist')
    assert.equal(first.entries.length, 40)
    assert.equal(first.total, 44)
    assert.equal(first.complete, true, 'the 4 missing are not listable: no use loading again')
    const before = site.hits.list
    const again = await engine.analyze(url, {maxEntries: 44})
    assert.ok(again.kind === 'playlist')
    assert.equal(again.entries.length, 40)
    assert.equal(again.complete, true)
    assert.equal(site.hits.list, before, 'answered from the kept listing')
  })

  it('a listing cut short is not complete', async () => {
    const {site, engine} = await setup('incomplete', {posts: 700, listFailures: {after: 40, count: 6}})
    const listing = await engine.analyze(`${site.origin}/@${site.user}`, {maxEntries: 700})
    assert.ok(listing.kind === 'playlist')
    assert.ok(listing.entries.length < 700)
    assert.equal(listing.complete, false, 'loading again continues')
  })
})

describe('TikTok slideshows (local fake)', () => {
  const slideshow = (mode: 'video' | 'images-audio' | 'images', secondsPerImage = 2) =>
    ({mode, secondsPerImage}) as const

  it("frames and options: the first image's shape, even sides, ≤ 1920; seconds kept within 1–30", () => {
    assert.deepEqual(
      slideshowFrame([
        {width: 1080, height: 1440},
        {width: 1080, height: 1920},
      ]),
      {width: 1080, height: 1440},
    )
    assert.deepEqual(slideshowFrame([{width: 3001, height: 4001}]), {width: 1440, height: 1920})
    assert.deepEqual(slideshowFrame([]), {width: 1080, height: 1920})
    assert.deepEqual(slideshowOptions({mode: 'images', secondsPerImage: 99}), {mode: 'images', secondsPerImage: 30})
    assert.deepEqual(slideshowOptions({mode: 'nope', secondsPerImage: 'x'}), {mode: 'video', secondsPerImage: 3})
  })

  it('a listing tells which posts are slideshows, and whether they have sound', async () => {
    const {site, engine} = await setup('slides-listing', {posts: 4, slideshows: [1, 2], silentSlides: [2]})
    const listing = await engine.analyze(`${site.origin}/@${site.user}`)
    assert.ok(listing.kind === 'playlist')
    assert.deepEqual(
      listing.entries.map(e => e.slideshow),
      [undefined, {images: 3, audio: true}, {images: 3, audio: false}, undefined],
    )
  })

  it('as a video: an MP4 of the images, each shown the chosen seconds, over the soundtrack', async () => {
    const {site, engine, out} = await setup('slides-video', {posts: 2, slideshows: [0]})
    const job = engine.add({url: videoUrl(site, 0), profile: mp4, outDir: out, slideshow: slideshow('video', 2)})
    await engine.whenIdle()
    const done = engine.job(job.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const [file] = await fs.readdir(out)
    assert.match(file!, /\.mp4$/)
    // the fake ffmpeg copies its first input — the first image — as the "video"
    assert.equal(await fs.readFile(path.join(out, file!), 'utf8'), `JPEG ${site.ids[0]} 1.jpg`)
    assert.equal(done.validation?.expectedDuration, 6, '3 images × 2 s')
  })

  it('builds the video from one input per image, each fitted on its own, the sound cut or padded', () => {
    const args = slideshowArgs({
      images: ['/w/01.jpg', '/w/02.jpg', "/w/03 it's.jpg"],
      frame: {width: 1080, height: 1440},
      audio: '/w/sound.mp3',
      secondsPerImage: 2,
    })
    assert.deepEqual(args.first, [
      ['-loop', '1'],
      ['-framerate', '30'],
      ['-t', '2'],
    ])
    const flat = args.rest.map(option => option.join(' '))
    assert.deepEqual(
      flat.filter(o => o.startsWith('-i ')),
      ['-i /w/02.jpg', "-i /w/03 it's.jpg", '-i /w/sound.mp3'],
      'images 2 and 3, then the sound',
    )
    const graph = args.rest.find(option => option[0] === '-filter_complex')![1]!
    assert.equal(graph.match(/scale=1080:1440:force_original_aspect_ratio=decrease:out_range=tv/g)?.length, 3)
    assert.match(graph, /\[v0\]\[v1\]\[v2\]concat=n=3:v=1:a=0\[v\]/)
    assert.match(graph, /\[3:a\]apad\[a\]$/)
    assert.ok(flat.includes('-t 6') && flat.includes('-pix_fmt yuv420p') && flat.includes('-map [a]'))

    const silent = slideshowArgs({images: ['/w/01.jpg'], frame: {width: 1080, height: 1920}, secondsPerImage: 3})
    const silentFlat = silent.rest.map(option => option.join(' '))
    assert.ok(!silentFlat.some(o => o.includes('[a]') || o.startsWith('-c:a')), 'no sound, no audio track')
    assert.ok(silentFlat.includes('-t 3'))
  })

  it('as images with their sound: a folder, archived, found again, listed in Finished', async () => {
    const {site, engine, out} = await setup('slides-folder', {posts: 2, slideshows: [0]})
    const job = engine.add({url: videoUrl(site, 0), profile: mp4, outDir: out, slideshow: slideshow('images-audio')})
    await engine.whenIdle()
    assert.equal(engine.job(job.id)?.status, 'completed', JSON.stringify(engine.job(job.id)?.error))
    const [folder] = await fs.readdir(out)
    assert.deepEqual((await fs.readdir(path.join(out, folder!))).sort(), ['01.jpg', '02.jpg', '03.jpg', 'sound.mp3'])
    assert.equal(
      await fs.readFile(path.join(out, folder!, '02.jpg'), 'utf8'),
      `JPEG ${site.ids[0]} 2.jpg`,
      'image 2 came from its second mirror',
    )
    const [entry] = (await engine.archive.list()).entries
    assert.equal(entry?.filepath, path.join(out, folder!))
    // the same request again finds the folder in the archive: nothing is downloaded twice
    const again = engine.add({
      url: videoUrl(site, 0),
      profile: mp4,
      outDir: out,
      slideshow: slideshow('images-audio'),
      // as the scheduler sends it: what the archive is looked up by
      mediaId: site.ids[0],
      extractor: 'TikTok',
    })
    await engine.whenIdle()
    assert.equal(engine.job(again.id)?.status, 'skipped')
  })

  it('as images only: no soundtrack in the folder', async () => {
    const {site, engine, out} = await setup('slides-images', {posts: 1, slideshows: [0]})
    engine.add({url: videoUrl(site, 0), profile: mp4, outDir: out, slideshow: slideshow('images')})
    await engine.whenIdle()
    const [folder] = await fs.readdir(out)
    assert.deepEqual((await fs.readdir(path.join(out, folder!))).sort(), ['01.jpg', '02.jpg', '03.jpg'])
  })

  it('with an audio format: just the soundtrack; a silent slideshow says why it has none', async () => {
    const {site, engine, out} = await setup('slides-audio', {posts: 2, slideshows: [0, 1], silentSlides: [1]})
    const withSound = engine.add({url: videoUrl(site, 0), profile: audio, outDir: path.join(out, 'a')})
    const silent = engine.add({url: videoUrl(site, 1), profile: audio, outDir: path.join(out, 'b')})
    await engine.whenIdle()
    assert.equal(engine.job(withSound.id)?.status, 'completed')
    assert.match((await fs.readdir(path.join(out, 'a')))[0]!, /\.mp3$/)
    const failed = engine.job(silent.id)!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error?.code, 'unavailable')
    assert.match(failed.error?.message ?? '', /no soundtrack/)
  })
})
