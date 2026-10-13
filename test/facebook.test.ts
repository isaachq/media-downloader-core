import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import type {DownloadError} from '../src/core/errors.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import type {BrowserAssist} from '../src/sources/browser.js'
import {checkWall, pageTokens, readVideoNode, renditionsOf} from '../src/sources/facebook/data.js'
import {isFacebookListing, parseFacebookLink} from '../src/sources/facebook/links.js'
import type {FacebookOptions} from '../src/sources/facebook/source.js'
import type {MetaError} from '../src/sources/meta/errors.js'
import {choicesOf, titleOf} from '../src/sources/meta/post.js'
import {type FakeFacebook, FB_SESSION_COOKIE, startFakeFacebook} from './helpers/fake-facebook.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const sd = {kind: 'video', container: 'mp4', maxHeight: 480} as const
const audio = {kind: 'audio', container: 'mp3'} as const
const images = {mode: 'images', secondsPerImage: 3} as const

describe('Facebook links', () => {
  it('recognizes videos, reels, posts, profiles, stories and short links in every shape', () => {
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/watch/?v=1000000000000001&ref=x'), {
      kind: 'video',
      id: '1000000000000001',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/watch/live/?v=1000000000000001'), {
      kind: 'video',
      id: '1000000000000001',
    })
    assert.deepEqual(parseFacebookLink('https://m.facebook.com/video.php?v=1000000000000001'), {
      kind: 'video',
      id: '1000000000000001',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/somepage/videos/1000000000000001/'), {
      kind: 'video',
      id: '1000000000000001',
      page: 'somepage',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/somepage/videos/a-title-slug/1000000000000001/'), {
      kind: 'video',
      id: '1000000000000001',
      page: 'somepage',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/reel/1000000000000001'), {
      kind: 'video',
      id: '1000000000000001',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/somepage/posts/pfbid0abc'), {
      kind: 'post',
      id: 'pfbid0abc',
      page: 'somepage',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/story.php?story_fbid=12345678&id=555'), {
      kind: 'post',
      id: '12345678',
      page: '555',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/somepage'), {kind: 'profile', page: 'somepage'})
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/somepage/videos/'), {
      kind: 'profile',
      page: 'somepage',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/profile.php?id=100044000000001'), {
      kind: 'profile',
      page: '100044000000001',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/stories/100044000000001/'), {
      kind: 'stories',
      bucket: '100044000000001',
    })
    assert.deepEqual(parseFacebookLink('https://www.facebook.com/stories/100044000000001/200000000000001/'), {
      kind: 'stories',
      bucket: '100044000000001',
      card: '200000000000001',
    })
    assert.equal(parseFacebookLink('https://fb.watch/abc123/')?.kind, 'short')
    assert.equal(parseFacebookLink('https://www.facebook.com/share/v/abc123/')?.kind, 'short')
    assert.equal(parseFacebookLink('https://www.facebook.com/login/'), undefined)
    assert.equal(parseFacebookLink('https://www.facebook.com/groups/123/'), undefined)
    assert.equal(parseFacebookLink('https://www.instagram.com/x/'), undefined)
    assert.equal(isFacebookListing('https://www.facebook.com/somepage/videos/'), true)
    assert.equal(isFacebookListing('https://www.facebook.com/watch/?v=1000000000000001'), false)
  })
})

describe('Facebook data', () => {
  it('reads a video node: HD first, duplicates dropped, title and owner, publication time', () => {
    const post = readVideoNode({
      id: '42',
      playable_url: 'https://cdn/sd.mp4',
      playable_url_quality_hd: 'https://cdn/hd.mp4',
      videoDeliveryLegacyFields: {
        browser_native_sd_url: 'https://cdn/sd.mp4',
        browser_native_hd_url: 'https://cdn/hd.mp4',
      },
      videoDeliveryResponseFragment: {
        videoDeliveryResponseResult: {
          progressive_urls: [{progressive_url: 'https://cdn/hd2.mp4', metadata: {quality: 'HD'}}],
        },
      },
      original_width: 1920,
      original_height: 1080,
      playable_duration_in_ms: 61_500,
      publish_time: 1_700_000_000,
      title: {text: 'Un título #tag'},
      owner: {name: 'Fake Page', url: 'https://www.facebook.com/fakepage/'},
    })
    assert.equal(post.url, 'https://www.facebook.com/watch/?v=42')
    assert.equal(titleOf(post, 'Facebook'), 'Un título')
    assert.equal(post.author, 'fakepage')
    assert.equal(post.authorName, 'Fake Page')
    assert.equal(post.createdAt, 1_700_000_000)
    const video = post.items[0]!
    assert.equal(video.kind, 'video')
    if (video.kind !== 'video') return
    assert.equal(video.duration, 61.5)
    assert.deepEqual(
      video.renditions.map(r => [r.resolution, r.urls[0]]),
      [
        [1080, 'https://cdn/hd.mp4'],
        [1080, 'https://cdn/hd2.mp4'],
        [360, 'https://cdn/sd.mp4'],
      ],
    )
    assert.deepEqual(
      choicesOf(post)
        .slice(0, 2)
        .map(c => c.label),
      ['1080p · MP4', '360p · MP4'],
    )
    assert.equal(renditionsOf({dash_manifest: '<MPD/>'}).length, 0, 'DASH is left to yt-dlp')
  })

  it('tells login walls, checkpoints and gone content apart, and reads the page tokens', () => {
    const problem = (page: {html: string; url: string}) => {
      try {
        checkWall(page)
      } catch (error) {
        return (error as MetaError).problem
      }
      return 'none'
    }
    assert.equal(problem({html: '<html/>', url: 'https://www.facebook.com/login/?next=%2Fwatch'}), 'challenge')
    assert.equal(problem({html: '<html/>', url: 'https://www.facebook.com/checkpoint/1501092823525282/'}), 'challenge')
    assert.equal(
      problem({
        html: "<html>This content isn't available right now</html>",
        url: 'https://www.facebook.com/watch/?v=1',
      }),
      'removed',
    )
    assert.equal(
      problem({
        html: '<html><script type="application/json">{}</script></html>',
        url: 'https://www.facebook.com/watch/?v=1',
      }),
      'none',
    )
    assert.deepEqual(pageTokens('["DTSGInitialData",[],{"token":"abc:1"}] ["LSD",[],{"token":"xyz"}]'), {
      dtsg: 'abc:1',
      lsd: 'xyz',
    })
  })
})

// ─── end to end against a local fake ────────────────────────────────────────

let root: string
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-facebook-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

const [sessionName, sessionValue] = FB_SESSION_COOKIE.split('=') as [string, string]

async function setup(
  name: string,
  config: Parameters<typeof startFakeFacebook>[0] = {},
  extra: {readonly signedIn?: boolean; readonly browser?: (origin: string) => BrowserAssist} = {},
) {
  const site = await startFakeFacebook(config)
  const host = new URL(site.origin).hostname
  const options: FacebookOptions = {
    origin: site.origin,
    pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 30, maxBackoffMs: 100},
    ...(extra.browser && {browser: extra.browser(site.origin)}),
    cookies: async () => (extra.signedIn ? [{name: sessionName, value: sessionValue, domain: host}] : undefined),
  }
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    maxRetries: 3,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: false,
    instagram: false,
    facebook: options,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {site, engine, scheduler, out: path.join(root, name, 'out')}
}

const watchUrl = (site: FakeFacebook, i = 0) => `${site.origin}/watch/?v=${site.ids[i]}`
const videosUrl = (site: FakeFacebook) => `${site.origin}/${site.page}/videos/`

describe('Facebook, end to end (local fake)', () => {
  it('downloads one video as MP4: objects merged by id, HD picked, CDN Referer, portable name', async () => {
    const {site, scheduler, out} = await setup('single')
    const batch = scheduler.schedule({url: watchUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const files = await fs.readdir(out)
    assert.equal(files.length, 1)
    assert.match(files[0]!, /^Video-numero-1-con-acentos-\d+\.mp4$/, 'the title came from another object than the urls')
    assert.equal((await fs.readFile(path.join(out, files[0]!), 'utf8')).slice(0, 1), 'h', 'the HD encoding')
    assert.equal(site.hits.video, 1, 'the preflight page read is reused by the download')
    assert.equal(site.hits.refusedMedia, 0)
  })

  it('a resolution cap picks the SD encoding; an audio format gets the soundtrack', async () => {
    const {site, scheduler, out} = await setup('sd', {videos: 2})
    scheduler.schedule({
      url: `${site.origin}/${site.page}/videos/${site.ids[0]}/`,
      profile: sd,
      outDir: path.join(out, 'sd'),
    })
    scheduler.schedule({url: `${site.origin}/reel/${site.ids[1]}`, profile: audio, outDir: path.join(out, 'audio')})
    await scheduler.whenIdle()
    assert.ok(
      scheduler.batches().every(b => b.status === 'completed'),
      JSON.stringify(scheduler.batches().map(b => b.error)),
    )
    const [sdFile] = await fs.readdir(path.join(out, 'sd'))
    assert.equal((await fs.readFile(path.join(out, 'sd', sdFile!), 'utf8')).slice(0, 1), '4', 'the SD encoding')
    assert.match((await fs.readdir(path.join(out, 'audio')))[0]!, /\.mp3$/)
  })

  it('backs up a page’s videos: the Videos tab, then the pagination query with the page’s tokens', async () => {
    const {site, scheduler, out} = await setup('listing', {videos: 20})
    const batch = scheduler.schedule({url: videosUrl(site), profile: mp4, outDir: out})
    assert.equal(batch.maxItems, 500)
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 20)
    assert.equal(site.hits.listing, 1)
    assert.equal(site.hits.graphql, 2, '20 videos, 8 per page: the tab, then two pages')
    assert.equal(
      site.hits.video,
      20,
      'each video page read once: at the check, reused by the download (the listing has no media links)',
    )
    const folder = (await fs.readdir(out))[0]!
    assert.equal(folder, 'Facebook-Fake-Page-videos')
    const files = await fs.readdir(path.join(out, folder))
    assert.equal(files.length, 20)
    assert.ok(files.every(f => /^\d{3}-Video-numero-\d+-con-acentos-\d+\.mp4$/.test(f)))
  })

  it('when the pagination query is gone, the listing keeps what the tab showed and says it is not complete', async () => {
    const {site, engine} = await setup('rotated', {videos: 20, rotatedQueries: true})
    const warnings: string[] = []
    engine.on('log', entry => entry.level === 'warn' && warnings.push(entry.message))
    const result = await engine.analyze(videosUrl(site))
    assert.equal(result.kind, 'playlist')
    if (result.kind !== 'playlist') return
    assert.equal(result.entries.length, 8)
    assert.equal(result.complete, false)
    assert.ok(
      warnings.some(w => /listing stopped at 8 of 500/.test(w)),
      warnings.join('\n'),
    )
  })

  it('a removed video fails with the reason; a DASH-only video goes to yt-dlp', async () => {
    const {site, engine, scheduler, out} = await setup('gone', {videos: 2, dashOnly: [1]})
    const gone = scheduler.schedule({url: `${site.origin}/watch/?v=1999999999999999`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(gone.id)?.status, 'failed')
    assert.equal(scheduler.batch(gone.id)?.error?.hint, 'removed')
    const dash = engine.add({url: watchUrl(site, 1), profile: mp4, outDir: out})
    await engine.whenIdle()
    const finished = engine.jobs().find(j => j.id === dash.id)!
    assert.equal(finished.status, 'completed', JSON.stringify(finished.error))
    assert.deepEqual(
      finished.attempts.map(a => a.strategy),
      ['primary', 'extractor-fallback'],
      'yt-dlp handles DASH',
    )
  })

  it('a video Facebook keeps for signed-in visitors says "sign in", not "the page changed"; with a session it downloads', async () => {
    const {site, engine} = await setup('signed-only', {videos: 1, videosSignedInOnly: true})
    await assert.rejects(engine.analyze(watchUrl(site)), (e: DownloadError) => {
      assert.equal(e.hint, 'needs-sign-in')
      assert.match(e.message, /signed-in accounts only/)
      return true
    })
    const signed = await setup('signed-only-session', {videos: 1, videosSignedInOnly: true}, {signedIn: true})
    const result = await signed.engine.analyze(watchUrl(signed.site))
    assert.equal(result.kind, 'video', 'the session went with the video page')
  })

  it('retries refusals natively after the shared cool-down', async () => {
    const {site, scheduler, out} = await setup('refused', {refusals: 2})
    const batch = scheduler.schedule({url: watchUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal(site.hits.refused, 2)
    assert.equal(site.hits.video, 1)
  })

  it('a login wall is not solved: Facebook goes to yt-dlp for a while, without knocking again', async () => {
    const {site, engine, scheduler, out} = await setup('wall', {loginWall: true, videos: 2})
    const batch = scheduler.schedule({url: watchUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    const second = scheduler.schedule({url: watchUrl(site, 1), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(second.id)?.status, 'completed')
    assert.equal(site.hits.login, 1, 'one login redirect, then hands off')
    assert.ok(engine.jobs().every(job => job.attempts.length === 1))
  })

  it('a login wall goes through a real browser once; its session then serves the pages over HTTP', async () => {
    const visits: string[] = []
    const browser = (): BrowserAssist => async url => {
      visits.push(url)
      const host = new URL(url).hostname
      // the browser signed in: its page is the real one and its cookies carry the session
      const response = await fetch(url, {headers: {Cookie: FB_SESSION_COOKIE}})
      return {
        html: await response.text(),
        cookies: [{name: sessionName, value: sessionValue, domain: host}],
        userAgent: 'FakeBrowser/1',
      }
    }
    const {site, scheduler, out} = await setup('browser', {loginWall: true, videos: 2}, {browser})
    const batch = scheduler.schedule({url: videosUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 2)
    assert.equal(visits.length, 1, 'one browser visit; the video pages went over HTTP with its session')
  })

  it('with the user’s session, stories are listed and downloaded; images stay images', async () => {
    const {site, engine, scheduler, out} = await setup('stories', {stories: ['video', 'image']}, {signedIn: true})
    const listing = await engine.analyze(`${site.origin}/stories/${site.bucket}/`)
    assert.equal(listing.kind, 'playlist')
    if (listing.kind !== 'playlist') return
    assert.equal(listing.entries.length, 2)
    assert.equal(listing.title, 'Facebook stories Fake Page')
    assert.equal(listing.entries[0]!.title, 'Primera historia')
    assert.deepEqual(listing.entries[1]!.slideshow, {images: 1, audio: false})
    const batch = scheduler.schedule({
      url: `${site.origin}/stories/${site.bucket}/`,
      profile: mp4,
      outDir: out,
      slideshow: images,
      selection: {
        title: listing.title,
        entries: listing.entries.map(e => ({...e, url: e.url.replace('https://www.facebook.com', site.origin)})),
      },
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 2)
    assert.equal(site.hits.stories, 1, 'read once for the preview and the downloads')
    const folder = (await fs.readdir(out))[0]!
    const entries = await fs.readdir(path.join(out, folder), {withFileTypes: true})
    assert.equal(entries.filter(e => e.isFile()).length, 1)
    assert.equal(entries.filter(e => e.isDirectory()).length, 1)
  })

  it('stories without a session fail with "needs sign-in"', async () => {
    const {site, scheduler, out} = await setup('nostories', {stories: ['video']})
    const batch = scheduler.schedule({url: `${site.origin}/stories/${site.bucket}/`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'failed')
    assert.equal(scheduler.batch(batch.id)?.error?.hint, 'needs-sign-in')
    assert.equal(site.hits.stories, 0)
  })

  it('resolves share links and dates the file by the video’s publication', async () => {
    const {site, scheduler, out} = await setup('share')
    const batch = scheduler.schedule({url: `${site.origin}/share/v/abc/`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal(site.hits.short, 1)
    const [file] = await fs.readdir(out)
    assert.equal(Math.floor((await fs.stat(path.join(out, file!))).mtimeMs / 1000), 1_790_000_000)
  })

  it('reopens a listing from memory and lists only what is new for a sync', async () => {
    const {site, engine} = await setup('memory', {videos: 40})
    const first = await engine.analyze(videosUrl(site), {maxEntries: 20})
    assert.equal(first.kind === 'playlist' && first.entries.length, 20)
    const queries = site.hits.graphql
    const again = await engine.analyze(videosUrl(site), {maxEntries: 20})
    assert.equal(again.kind === 'playlist' && again.entries.length, 20)
    assert.equal(site.hits.graphql, queries, 'answered from memory')
    const all = await engine.analyze(videosUrl(site), {maxEntries: 40})
    assert.equal(all.kind === 'playlist' && all.entries.length, 40)
    assert.equal(all.kind === 'playlist' && all.complete, true)
    const known = new Set(site.ids.slice(2))
    const incremental = await engine.analyze(videosUrl(site), {maxEntries: 500, known})
    assert.equal(incremental.kind === 'playlist' && incremental.caughtUp, true)
    assert.ok(incremental.kind === 'playlist' && incremental.entries.length < 40)
  })
})

describe('Facebook that stops accepting the listing query', () => {
  it('a 400 is not waited out: yt-dlp reads the link at once', async () => {
    const {site, engine} = await setup('bad-request', {videos: 30, badRequest: true})
    const started = Date.now()
    const result = await engine.analyze(videosUrl(site))
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
    assert.ok(site.hits.graphql >= 1, 'the query was tried')
    assert.ok(result.kind === 'playlist' || result.kind === 'video')
  })
})
