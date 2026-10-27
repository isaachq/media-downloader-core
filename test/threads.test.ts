import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {toExecutable} from '../src/binaries/executable.js'
import type {DownloadError} from '../src/core/errors.js'
import {isListingLink} from '../src/core/mix.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {needsFallback, type SourceDownload} from '../src/sources/source.js'
import {isThreadsListing, parseThreadsLink} from '../src/sources/threads/links.js'
import {type ThreadsOptions, ThreadsSource} from '../src/sources/threads/source.js'
import type {AnalysisResult, PlaylistAnalysis, VideoAnalysis} from '../src/types.js'
import {startFakeThreads} from './helpers/fake-threads.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 50} as const
const POST = 'https://www.threads.com/@zuck/post/'

describe('Threads links', () => {
  it('recognizes posts and profiles on every host the site and its share sheet use', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [`${POST}DHV7vTivqWD`, {kind: 'post', code: 'DHV7vTivqWD', user: 'zuck'}],
      [
        'https://www.threads.net/@zuck/post/DHV7vTivqWD?xmt=AQF0&slof=1',
        {kind: 'post', code: 'DHV7vTivqWD', user: 'zuck'},
      ],
      ['https://threads.com/@zuck/post/DJDhoQfxb43/media', {kind: 'post', code: 'DJDhoQfxb43', user: 'zuck'}],
      ['https://threads.net/@zuck/post/DJDhoQfxb43/', {kind: 'post', code: 'DJDhoQfxb43', user: 'zuck'}],
      ['https://www.threads.com/t/Ddt7cL5EfUG', {kind: 'post', code: 'Ddt7cL5EfUG'}],
      ['https://www.threads.com/@zuck', {kind: 'profile', user: 'zuck'}],
      ['https://www.threads.com/@mosseri/', {kind: 'profile', user: 'mosseri'}],
      ['https://www.threads.com/%40zuck', {kind: 'profile', user: 'zuck'}],
      ['https://www.threads.net/@zuck/media', {kind: 'profile', user: 'zuck'}],
      ['https://www.threads.com/@zuck/replies', {kind: 'profile', user: 'zuck'}],
      ['https://www.threads.com/@first.last_1/reposts', {kind: 'profile', user: 'first.last_1'}],
    ]
    for (const [url, link] of cases) assert.deepEqual(parseThreadsLink(url), link, url)
  })

  it('leaves out what it does not read', () => {
    for (const url of [
      'https://www.threads.com/',
      'https://www.threads.com/search?q=x',
      'https://www.threads.com/zuck',
      'https://www.threads.com/@zuck/post/',
      'https://www.threads.com/@zuck/post/abc',
      'https://www.threads.com/@zuck/post/DHV7vTivqWD/likes',
      'https://www.threads.com/@zuck/somethingelse',
      'https://www.threads.com/t/',
      'https://notthreads.com/@zuck',
      'https://threads.com.evil.test/@zuck',
      'ftp://www.threads.com/@zuck',
      'not a url',
    ]) {
      assert.equal(parseThreadsLink(url), undefined, url)
    }
  })

  it('a profile is a list; a post is one item', () => {
    assert.equal(isThreadsListing('https://www.threads.com/@zuck'), true)
    assert.equal(isThreadsListing(`${POST}DHV7vTivqWD`), false)
    assert.equal(isListingLink('https://www.threads.net/@zuck/media', {defaultListSize: () => undefined}), true)
  })
})

let root: string
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-threads-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

const session = async () => [{name: 'sessionid', value: '63055343223%3Aabc', domain: '127.0.0.1', path: '/'}]

async function setup(name: string, config: Parameters<typeof startFakeThreads>[0] = {}, extra: ThreadsOptions = {}) {
  const site = await startFakeThreads(config)
  const options: ThreadsOptions = {origin: site.origin, pacing: fast, ...extra}
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    maxRetries: 2,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: false,
    instagram: false,
    facebook: false,
    x: false,
    vk: false,
    snapchat: false,
    threads: options,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0, diskCheck: 'off'})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {site, engine, scheduler, source: new ThreadsSource(options), out: path.join(root, name, 'out')}
}

const asVideo = (analysis: AnalysisResult): VideoAnalysis => {
  assert.equal(analysis.kind, 'video', 'one item')
  return analysis as VideoAnalysis
}
const asList = (analysis: AnalysisResult): PlaylistAnalysis => {
  assert.equal(analysis.kind, 'playlist', 'a listing')
  return analysis as PlaylistAnalysis
}

function task(url: string, workDir: string, overrides: Partial<SourceDownload> = {}): SourceDownload {
  return {
    url,
    profile: mp4,
    workDir,
    signal: AbortSignal.timeout(5_000),
    fresh: false,
    hasAudio: async () => true,
    ffmpeg: toExecutable('ffmpeg'),
    threads: 1,
    slideshow: {mode: 'images', secondsPerImage: 3},
    onInfo: () => {},
    onProgress: () => {},
    ...overrides,
  }
}

describe('Threads, end to end (local fake)', () => {
  it('a video post: its page read as a page load, its MP4 sized by the post, downloaded through a batch', {
    timeout: 5_000,
  }, async () => {
    const {site, engine, scheduler, out} = await setup('video')
    const url = `https://www.threads.net/@zuck/post/${site.codes.video}`
    const analysis = asVideo(await engine.analyze(url))
    assert.equal(analysis.media.id, '3591039013441414531')
    assert.equal(analysis.media.extractor, 'Threads')
    assert.equal(analysis.media.uploader, 'Mark Zuckerberg')
    assert.equal(analysis.media.title, 'Me finding out Llama hit 1 BILLION downloads.')
    assert.equal(analysis.media.duration, 11.146, 'the length from the DASH manifest')
    assert.equal(analysis.media.url, `https://www.threads.com/@zuck/post/${site.codes.video}`)
    assert.ok(
      analysis.choices.some(c => c.label === '720p · MP4'),
      JSON.stringify(analysis.choices.map(c => c.label)),
    )
    const batch = scheduler.schedule({url, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal((await fs.readdir(out)).length, 1)
    assert.equal(site.hits.media, 1, 'one media request: three versions, one file')
    assert.equal(site.hits.page, 1, 'analyze, check and download share one page read')
    assert.equal(site.hits.shell, 0, 'every page asked for as a page load')
  })

  it('a photo is a one-image photo post; a carousel of photos and a video is a folder of both', {
    timeout: 5_000,
  }, async () => {
    const {site, engine, scheduler, out} = await setup('photo')
    const photo = asVideo(await engine.analyze(`${POST}${site.codes.photo}`))
    assert.deepEqual(photo.media.slideshow, {images: 1, audio: false})
    const mixed = asVideo(await engine.analyze(`${POST}${site.codes.carousel}`))
    assert.deepEqual(mixed.media.slideshow, {images: 3, audio: true, videos: true})
    const photos = asVideo(await engine.analyze(`${POST}${site.codes.photos}`))
    assert.deepEqual(photos.media.slideshow, {images: 3, audio: false})
    assert.ok(
      photos.choices.some(c => c.label.startsWith('Slideshow')),
      'a photo carousel can be a slideshow',
    )
    const batch = scheduler.schedule({
      url: `${POST}${site.codes.carousel}`,
      profile: mp4,
      outDir: out,
      slideshow: {mode: 'images', secondsPerImage: 3},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const [folder] = await fs.readdir(out)
    assert.deepEqual((await fs.readdir(path.join(out, folder!))).sort(), ['01.jpg', '02.mp4', '03.jpg'])
  })

  it('a text post has nothing to download: unavailable, format-unavailable', {timeout: 5_000}, async () => {
    const {site, source} = await setup('text')
    const url = `${POST}${site.codes.text}`
    await assert.rejects(source.analyze(url), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'format-unavailable')
      assert.match(e.message, /text only/)
      return true
    })
    const checks = await source.preflight([{url}], {})
    assert.equal(checks.get(url)?.ok, false)
  })

  it('a profile: one page, then GraphQL pages of 10 by its own cursor; no request per post', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('profile')
    const list = asList(await source.analyze('https://www.threads.com/@zuck'))
    assert.equal(list.extractor, 'Threads')
    assert.equal(list.title, 'Threads @zuck')
    assert.deepEqual(
      list.entries.map(e => e.id),
      site.zuckMedia,
      'media posts in order, self-thread photos in, texts and reposts out',
    )
    assert.equal(list.complete, true)
    assert.equal(site.hits.page, 1)
    assert.equal(site.hits.graphql, 4, '33 threads, 10 a page')
    assert.ok(site.queries.every(q => q['first'] === 10 && q['userID'] === '63055343223'))
    assert.equal(site.queries[0]!['after'], undefined, 'the walk starts with GraphQL, not the page’s cursor')
    assert.deepEqual(
      site.queries.slice(1).map(q => q['after']),
      ['AQH10', 'AQH20', 'AQH30'],
    )
    // the listing feeds every entry: checks and downloads ask for no page
    const work = path.join(root, 'profile-work')
    await fs.mkdir(work, {recursive: true})
    const checks = await source.preflight(
      list.entries.slice(0, 5).map(e => ({url: e.url})),
      {},
    )
    assert.ok([...checks.values()].every(r => r.ok))
    const file = await source.download(task(list.entries[0]!.url, work))
    assert.equal(file.info.id, list.entries[0]!.id)
    assert.equal(site.hits.page, 1, 'no page read per post')
    assert.equal(source.defaultListSize('https://www.threads.com/@zuck'), 500)
    assert.equal(source.defaultListSize(`${POST}${site.codes.video}`), undefined)
  })

  it('maxEntries stops the walk early; known stops an incremental walk where known posts start', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('profile-cut')
    const five = asList(await source.analyze('https://www.threads.com/@zuck', {maxEntries: 5}))
    assert.equal(five.entries.length, 5)
    assert.equal(five.complete, false)
    assert.equal(site.hits.graphql, 1, 'one page had enough')
    const known = new Set(site.zuckMedia.slice(2))
    const newer = asList(await source.analyze('https://www.threads.com/@zuck', {known}))
    assert.equal(newer.caughtUp, true)
    assert.ok(newer.entries.length < site.zuckMedia.length, 'not the whole profile')
    assert.deepEqual(
      newer.entries.slice(0, 2).map(e => e.id),
      site.zuckMedia.slice(0, 2),
    )
  })

  it('a cursor that repeats itself ends the walk; pages of text posts are read on', {timeout: 5_000}, async () => {
    const {site, source} = await setup('profile-stall')
    const stuck = asList(await source.analyze('https://www.threads.com/@stuck'))
    assert.equal(stuck.entries.length, 10)
    assert.equal(stuck.complete, false)
    assert.ok(site.hits.graphql <= 4, `stopped after a few stalls (${site.hits.graphql})`)
    const before = site.hits.graphql
    const chatty = asList(await source.analyze('https://www.threads.com/@chatty'))
    assert.equal(chatty.entries.length, 1, 'the one photo after 34 text threads')
    assert.equal(chatty.entries[0]!.title, 'Finally a photo')
    assert.equal(chatty.complete, true)
    assert.equal(site.hits.graphql - before, 4)
  })

  it('a private account needs a session; the session is sent only when the host gives one', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('private')
    for (const url of [
      'https://www.threads.com/@hiddenone',
      `https://www.threads.com/@hiddenone/post/${site.codes.hidden}`,
    ]) {
      await assert.rejects(source.analyze(url), (e: DownloadError) => {
        assert.equal(e.code, 'unavailable', url)
        assert.equal(e.hint, 'needs-sign-in', url)
        return true
      })
    }
    await asVideo(await source.analyze(`${POST}${site.codes.video}`))
    assert.equal(site.signedInRequests, 0, 'no session given, none sent')
    const signed = new ThreadsSource({origin: site.origin, pacing: fast, cookies: session})
    const list = asList(await signed.analyze('https://www.threads.com/@hiddenone'))
    assert.deepEqual(
      list.entries.map(e => e.title),
      ['Only for followers'],
    )
    const post = asVideo(await signed.analyze(`https://www.threads.com/@hiddenone/post/${site.codes.hidden}`))
    assert.equal(post.media.id, '7770001110000000001')
    // the post itself came with the listing: no page read for it
    assert.ok(site.signedInRequests >= 2, 'the page and the query with the session')
  })

  it('a gone post or account: needs a session anonymously (Threads tells nothing more), removed with one', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('gone')
    for (const url of [`${POST}${site.codes.gone}`, 'https://www.threads.com/@nobodyhere']) {
      await assert.rejects(source.analyze(url), (e: DownloadError) => e.hint === 'needs-sign-in')
    }
    const signed = new ThreadsSource({origin: site.origin, pacing: fast, cookies: session})
    for (const url of [`${POST}${site.codes.gone}`, 'https://www.threads.com/@nobodyhere']) {
      await assert.rejects(signed.analyze(url), (e: DownloadError) => e.hint === 'removed')
    }
  })

  it('a page whose data moved says so itself: never handed to yt-dlp, which has no Threads extractor', {
    timeout: 5_000,
  }, async () => {
    const {site, source, engine} = await setup('changed')
    for (const url of [`${POST}${site.codes.changed}`, 'https://www.threads.com/@movedthings']) {
      await assert.rejects(source.analyze(url), (e: DownloadError) => {
        assert.equal(needsFallback(e.details), false, url)
        assert.equal(e.code, 'unavailable', url)
        assert.equal(e.hint, 'retry-later', url)
        assert.match(e.message, /^Threads.*yt-dlp has no Threads extractor/, url)
        return true
      })
    }
    // the engine reports it as it is (the fake yt-dlp would have answered "Fake")
    await assert.rejects(
      engine.analyze(`${POST}${site.codes.changed}`, {retryWaitMs: () => 0}),
      /yt-dlp has no Threads extractor/,
    )
    // a rotated listing query id: the threads the page embeds, not a failure
    const rotated = new ThreadsSource({origin: site.origin, pacing: fast, queries: {threadsTabId: '1'}})
    const list = asList(await rotated.analyze('https://www.threads.com/@zuck'))
    assert.ok(list.entries.length > 0 && list.entries.length <= 5, String(list.entries.length))
    assert.equal(list.complete, false)
  })

  it('a page asked for the way Node’s fetch asks (Sec-Fetch-Mode: cors) is the gating shell: no data', {
    timeout: 5_000,
  }, async () => {
    const {site} = await setup('shell')
    const plain = new ThreadsSource({origin: site.origin, pacing: fast, fetch: (input, init) => fetch(input, init)})
    await assert.rejects(plain.analyze(`${POST}${site.codes.video}`), /Threads.*no BarcelonaPostPageTargetQuery result/)
    assert.ok(site.hits.shell > 0)
  })

  it('analyze, checks and download of one post at the same time make one page request', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('together')
    const url = `https://www.threads.com/t/${site.codes.video}`
    const work = path.join(root, 'together-work')
    await fs.mkdir(work, {recursive: true})
    const [analysis, checks, file] = await Promise.all([
      source.analyze(url),
      source.preflight([{url}, {url}], {}),
      source.download(task(url, work)),
    ])
    assert.equal(asVideo(analysis).media.id, '3591039013441414531')
    assert.ok([...checks.values()].every(r => r.ok))
    assert.equal(file.info.id, '3591039013441414531')
    // 4 callers, one page read: /t/ answered with its 301, followed to the post page
    assert.deepEqual(site.pages, [`/t/${site.codes.video}`, `/@zuck/post/${site.codes.video}`])
    asVideo(await source.analyze(`${POST}${site.codes.video}`))
    assert.equal(site.hits.page, 2, 'kept while its links are good')
    const listed = await source.preflight([{url: 'https://www.threads.com/@zuck'}], {})
    assert.equal(listed.get('https://www.threads.com/@zuck')?.ok, false, 'a profile is not one item')
  })

  it('retries a refused page after the shared cool-down', {timeout: 5_000}, async () => {
    const {site, source} = await setup('refused', {refusals: 2})
    asVideo(await source.analyze(`${POST}${site.codes.photo}`))
    assert.equal(site.hits.refused, 2)
    assert.equal(site.hits.page, 3)
  })

  it('in a mix list: posts are items (tracking left out), a profile is a list', {timeout: 5_000}, async () => {
    const {site, engine} = await setup('mix')
    const mix = await engine.analyzeMix(
      [
        `${POST}${site.codes.video}?xmt=AQF0abc&slof=1`,
        `${POST}${site.codes.video}`,
        `${POST}${site.codes.photo}`,
        'https://www.threads.com/@zuck',
      ].join('\n'),
      {profile: mp4},
    )
    assert.deepEqual(
      mix.valid.map(item => [item.line, item.site]),
      [
        [1, 'threads'],
        [3, 'threads'],
      ],
    )
    assert.deepEqual(
      mix.skipped.map(skip => [skip.line, skip.reason]),
      [
        [2, 'duplicate'],
        [4, 'listing'],
      ],
    )
  })
})
