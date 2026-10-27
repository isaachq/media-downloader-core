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
import {isBlueskyListing, parseBlueskyLink} from '../src/sources/bluesky/links.js'
import {type BlueskyOptions, BlueskySource} from '../src/sources/bluesky/source.js'
import {needsFallback, type SourceDownload} from '../src/sources/source.js'
import type {AnalysisResult, PlaylistAnalysis, VideoAnalysis} from '../src/types.js'
import {DIDS, HANDLES, RKEYS, startFakeBluesky} from './helpers/fake-bluesky.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 50} as const
const ALICE = `https://bsky.app/profile/${HANDLES.alice}`
const post = (rkey: string, actor: string = HANDLES.alice) => `https://bsky.app/profile/${actor}/post/${rkey}`

describe('Bluesky links', () => {
  it('recognizes posts and profiles by handle or DID, on the web app and as at-uris', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [
        'https://bsky.app/profile/bsky.app/post/3mnslrkd6ok2g',
        {kind: 'post', actor: 'bsky.app', rkey: '3mnslrkd6ok2g'},
      ],
      [
        'https://bsky.app/profile/Jay.Bsky.Team/post/3mwhqanugyc2z/quotes',
        {kind: 'post', actor: 'jay.bsky.team', rkey: '3mwhqanugyc2z'},
      ],
      [
        'https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3myi3k45jh22z?ref=share',
        {kind: 'post', actor: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3myi3k45jh22z'},
      ],
      [
        'https://bsky.app/profile/did%3Aplc%3Az72i7hdynmk6r22z27h6tvur/post/3myi3k45jh22z',
        {kind: 'post', actor: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3myi3k45jh22z'},
      ],
      [
        'https://main.bsky.dev/profile/nytimes.com/post/3mytan74flu22',
        {kind: 'post', actor: 'nytimes.com', rkey: '3mytan74flu22'},
      ],
      [
        'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3mnslrkd6ok2g',
        {kind: 'post', actor: 'did:plc:z72i7hdynmk6r22z27h6tvur', rkey: '3mnslrkd6ok2g'},
      ],
      ['https://bsky.app/profile/bsky.app', {kind: 'profile', actor: 'bsky.app'}],
      ['https://www.bsky.app/profile/theverge.com/', {kind: 'profile', actor: 'theverge.com'}],
      ['https://bsky.app/profile/theverge.com/media', {kind: 'profile', actor: 'theverge.com'}],
      ['https://bsky.app/profile/did:web:webby.example/video', {kind: 'profile', actor: 'did:web:webby.example'}],
    ]
    for (const [url, link] of cases) assert.deepEqual(parseBlueskyLink(url), link, url)
  })

  it('leaves out what it does not read', () => {
    for (const url of [
      'https://bsky.app/',
      'https://bsky.app/search?q=cats',
      'https://bsky.app/profile/bsky.app/feed/whats-hot',
      'https://bsky.app/profile/bsky.app/lists/3abc',
      'https://bsky.app/profile/nodot/post/3mnslrkd6ok2g',
      'https://bsky.app/profile/bsky.app/post/',
      'https://bsky.app/profile/bsky.app/post/3mnslrkd6ok2g/likes/extra',
      'https://bsky.app/profile/bsky.app/post/3mnslrkd6ok2g/edit',
      'https://bsky.app/profile/did:plc:short/post/3mnslrkd6ok2g',
      'at://bsky.app/app.bsky.feed.like/3mnslrkd6ok2g',
      'https://bsky.app.evil.test/profile/bsky.app',
      'https://notbsky.app/profile/bsky.app',
      'ftp://bsky.app/profile/bsky.app',
      'not a url',
    ]) {
      assert.equal(parseBlueskyLink(url), undefined, url)
    }
  })

  it('a profile is a list; a post is one item', () => {
    assert.equal(isBlueskyListing('https://bsky.app/profile/bsky.app'), true)
    assert.equal(isBlueskyListing('https://bsky.app/profile/bsky.app/post/3mnslrkd6ok2g'), false)
    assert.equal(isListingLink('https://bsky.app/profile/bsky.app/media', {defaultListSize: () => undefined}), true)
  })
})

let root: string
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-bluesky-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

async function setup(name: string, config: Parameters<typeof startFakeBluesky>[0] = {}, extra: BlueskyOptions = {}) {
  const site = await startFakeBluesky(config)
  const options: BlueskyOptions = {
    endpoints: {
      appView: site.origin,
      plc: `${site.origin}/plc`,
      didWebDocument: host => `${site.origin}/did-web/${host}/did.json`,
    },
    pacing: fast,
    pdsPacing: fast,
    ...extra,
  }
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
    threads: false,
    bluesky: options,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0, diskCheck: 'off'})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  const work = path.join(root, name, 'work')
  await fs.mkdir(work, {recursive: true})
  return {site, engine, scheduler, options, source: new BlueskySource(options), out: path.join(root, name, 'out'), work}
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
    fragments: 3,
    slideshow: {mode: 'images', secondsPerImage: 3},
    onInfo: () => {},
    onProgress: () => {},
    ...overrides,
  }
}

const sizes = async (folder: string) => {
  const names = (await fs.readdir(folder)).sort()
  return Promise.all(names.map(async name => [name, (await fs.stat(path.join(folder, name))).size] as const))
}

describe('Bluesky, end to end (local fake)', () => {
  it('a gallery: one post request, the PDS found once, every picture the original blob (not the CDN’s WebP)', {
    timeout: 5_000,
  }, async () => {
    const {site, engine, scheduler, out} = await setup('gallery')
    const url = post(RKEYS.gallery)
    const analysis = asVideo(await engine.analyze(url))
    assert.equal(analysis.media.id, RKEYS.gallery)
    assert.equal(analysis.media.extractor, 'Bluesky')
    assert.equal(analysis.media.uploader, 'Alice')
    assert.equal(analysis.media.title, 'Ten photos now')
    assert.equal(analysis.media.url, url)
    assert.deepEqual(analysis.media.slideshow, {images: 5, audio: false})
    assert.ok(
      analysis.choices.some(c => c.label.startsWith('Slideshow')),
      'pictures can be a slideshow',
    )
    const batch = scheduler.schedule({url, profile: mp4, outDir: out, slideshow: {mode: 'images', secondsPerImage: 3}})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const [folder] = await fs.readdir(out)
    assert.deepEqual(await sizes(path.join(out, folder!)), [
      ['01.jpg', 4096],
      ['02.jpg', 4096],
      ['03.jpg', 4096],
      ['04.jpg', 4096],
      ['05.jpg', 4096],
    ])
    assert.equal(site.hits.thread, 1, 'analyze, check and download share one read')
    assert.equal(site.hits.plc, 1, 'the DID document read once')
    assert.equal(site.hits.blob, 5)
    assert.equal(site.hits.cdn, 0, 'no re-encode')
  })

  it('pictures and quotes: a quote with media downloads its own pictures, never the quoted post’s', {
    timeout: 5_000,
  }, async () => {
    const {source, work} = await setup('pictures')
    assert.deepEqual(asVideo(await source.analyze(post(RKEYS.image))).media.slideshow, {images: 1, audio: false})
    assert.deepEqual(asVideo(await source.analyze(post(RKEYS.images))).media.slideshow, {images: 3, audio: false})
    const quote = asVideo(await source.analyze(post(RKEYS.withMedia)))
    assert.deepEqual(quote.media.slideshow, {images: 2, audio: false})
    const file = await source.download(task(post(RKEYS.withMedia), work))
    assert.equal(file.bundle, true)
    assert.deepEqual(
      (await sizes(file.filepath)).map(([name]) => name),
      ['01.jpg', '02.jpg'],
    )
  })

  it('a video: the blob’s progressive MP4 as one stream (no Range), sized by the record', {
    timeout: 5_000,
  }, async () => {
    const {site, source, work} = await setup('video')
    const analysis = asVideo(await source.analyze(post(RKEYS.video)))
    assert.equal(analysis.media.slideshow, undefined)
    assert.match(analysis.media.thumbnail ?? '', /thumbnail\.jpg$/)
    const file = await source.download(task(post(RKEYS.video), work))
    assert.equal(file.info.filesize, 64 * 1024)
    assert.equal(file.info.vcodec, 'avc1')
    assert.equal((await fs.stat(file.filepath)).size, 64 * 1024)
    assert.deepEqual(site.ranges, [false])
    const gif = await source.download(task(post(RKEYS.gif), work, {hasAudio: async () => false}))
    assert.equal(gif.info.acodec, 'none', 'a GIF-style clip is silent')
  })

  it('a video download that breaks starts over once (the PDS ignores Range)', {timeout: 5_000}, async () => {
    const {site, source, work} = await setup('restart', {brokenVideos: 1})
    const file = await source.download(task(post(RKEYS.video), work))
    assert.equal((await fs.stat(file.filepath)).size, 64 * 1024)
    assert.equal(site.hits.blob, 2, 'broken once, then whole')
    assert.deepEqual(site.ranges, [false, false], 'a restart, never a resume')
  })

  it('nothing of its own to download: a quote, a link card, a text post are format-unavailable', {
    timeout: 5_000,
  }, async () => {
    const {source} = await setup('empty')
    for (const [rkey, why] of [
      [RKEYS.quote, /quotes another post/],
      [RKEYS.link, /link card/],
      [RKEYS.text, /text only/],
    ] as const) {
      await assert.rejects(source.analyze(post(rkey)), (e: DownloadError) => {
        assert.equal(e.code, 'unavailable', rkey)
        assert.equal(e.hint, 'format-unavailable', rkey)
        assert.match(e.message, why)
        return true
      })
    }
    const checks = await source.preflight([{url: post(RKEYS.quote)}], {})
    assert.equal(checks.get(post(RKEYS.quote))?.ok, false)
  })

  it('a deleted or blocked post and an unknown account are removed', {timeout: 5_000}, async () => {
    const {source} = await setup('gone')
    for (const url of [post(RKEYS.gone), post(RKEYS.blocked), 'https://bsky.app/profile/nobody.bsky.social']) {
      await assert.rejects(source.analyze(url), (e: DownloadError) => {
        assert.equal(e.code, 'unavailable', url)
        assert.equal(e.hint, 'removed', url)
        return true
      })
    }
  })

  it('an account hidden from signed-out visitors (!no-unauthenticated) needs a sign-in, post and profile', {
    timeout: 5_000,
  }, async () => {
    const {source} = await setup('hidden')
    for (const url of [post(RKEYS.hidden, HANDLES.hidden), `https://bsky.app/profile/${HANDLES.hidden}`]) {
      await assert.rejects(source.analyze(url), (e: DownloadError) => {
        assert.equal(e.hint, 'needs-sign-in', url)
        return true
      })
    }
  })

  it('an embed nobody knows says so itself: never handed to yt-dlp, which reads the same API', {
    timeout: 5_000,
  }, async () => {
    const {source, engine} = await setup('changed')
    await assert.rejects(source.analyze(post(RKEYS.strange)), (e: DownloadError) => {
      assert.equal(needsFallback(e.details), false)
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'retry-later')
      assert.match(e.message, /app\.bsky\.embed\.hologram.*yt-dlp’s Bluesky extractor/)
      return true
    })
    await assert.rejects(engine.analyze(post(RKEYS.strange), {retryWaitMs: () => 0}), /yt-dlp’s Bluesky extractor/)
  })

  it('a profile: one getProfile, getAuthorFeed pages of 100 by its cursor, the pinned post first and once', {
    timeout: 5_000,
  }, async () => {
    const {site, source, work} = await setup('profile')
    const list = asList(await source.analyze(ALICE))
    assert.equal(list.extractor, 'Bluesky')
    assert.equal(list.title, `Bluesky @${HANDLES.alice}`)
    assert.equal(list.uploader, 'Alice')
    assert.equal(list.id, DIDS.alice)
    assert.deepEqual(
      list.entries.map(e => e.id),
      site.aliceMedia,
      'media posts in order, pinned first and once, reposts and others’ posts out',
    )
    assert.equal(list.complete, true)
    assert.equal(site.hits.profile, 1)
    assert.equal(site.hits.feed, 3, '240 feed entries, 100 a page')
    assert.ok(
      site.feeds.every(
        q => q['actor'] === DIDS.alice && q['filter'] === 'posts_with_media' && q['includePins'] === 'true',
      ),
    )
    assert.ok(site.feeds.every(q => q['limit'] === '100'))
    assert.deepEqual(
      site.feeds.map(q => q['cursor']),
      [undefined, '2026-01-01T00:00:00.000Z#100', '2026-01-01T00:00:00.000Z#200'],
    )
    // the listing feeds every entry: checks and downloads ask the AppView for nothing more
    const checks = await source.preflight(
      list.entries.slice(0, 30).map(e => ({url: e.url})),
      {},
    )
    assert.ok([...checks.values()].every(r => r.ok))
    const file = await source.download(task(list.entries[3]!.url, work))
    assert.equal(file.info.id, list.entries[3]!.id)
    assert.equal(site.hits.thread + site.hits.posts + site.hits.resolve, 0, 'no request per post')
    assert.equal(source.defaultListSize(ALICE), 500)
    assert.equal(source.defaultListSize(post(RKEYS.video)), undefined)
  })

  it('maxEntries stops the walk early; known stops an incremental walk, the pinned post never counted', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('profile-cut')
    const fifty = asList(await source.analyze(ALICE, {maxEntries: 50}))
    assert.equal(fifty.entries.length, 50)
    assert.equal(fifty.complete, false)
    assert.equal(site.hits.feed, 1, 'one page had enough')
    // everything but the two newest is known (the pinned post too, which comes first)
    const known = new Set([site.aliceMedia[0]!, ...site.aliceMedia.slice(3)])
    const newer = asList(await source.analyze(ALICE, {known}))
    assert.equal(newer.caughtUp, true)
    assert.ok(newer.entries.length < site.aliceMedia.length, 'not the whole profile')
    assert.deepEqual(
      newer.entries.slice(1, 3).map(e => e.id),
      site.aliceMedia.slice(1, 3),
    )
  })

  it('a cursor that never moves ends the walk after a few stalls', {timeout: 5_000}, async () => {
    const {site, source} = await setup('stuck')
    const stuck = asList(await source.analyze(`https://bsky.app/profile/${HANDLES.stuck}`))
    assert.equal(stuck.entries.length, 1)
    assert.equal(stuck.complete, false)
    assert.ok(site.hits.feed <= 4, `stopped after a few stalls (${site.hits.feed})`)
  })

  it('checks of posts not read yet: handles resolved once, getPosts 25 at a time', {timeout: 5_000}, async () => {
    const {site, source} = await setup('batch')
    const urls = [...site.aliceMedia.slice(0, 28), RKEYS.strange, RKEYS.gone].map(rkey => post(rkey))
    const checks = await source.preflight(
      urls.map(url => ({url})),
      {},
    )
    assert.equal(checks.size, 30)
    assert.equal([...checks.values()].filter(r => r.ok).length, 28, 'an embed nobody knows fails alone, not its batch')
    const gone = checks.get(post(RKEYS.gone))
    assert.equal(gone?.ok === false && gone.error.hint, 'removed')
    assert.equal(site.hits.resolve, 1, 'one handle, one resolveHandle')
    assert.deepEqual(
      site.posts.map(uris => uris.length),
      [25, 5],
    )
    assert.ok(
      site.posts.flat().every(uri => uri.startsWith(`at://${DIDS.alice}/`)),
      'DIDs only',
    )
    assert.equal(site.hits.thread, 0)
  })

  it('retries the AppView after the shared cool-down when it refuses', {timeout: 5_000}, async () => {
    const {site, source} = await setup('refused', {refusals: 2})
    asVideo(await source.analyze(post(RKEYS.image)))
    assert.equal(site.hits.refused, 2)
    assert.equal(site.hits.thread, 1)
  })

  it('a PDS that limits this network (429) or is down: pictures from the CDN, the next post CDN first', {
    timeout: 5_000,
  }, async () => {
    const limited = await setup('limited', {rateLimited: 0})
    const first = await limited.source.download(task(post(RKEYS.images), limited.work))
    assert.deepEqual(
      (await sizes(first.filepath)).map(([name]) => name),
      ['01.webp', '02.webp', '03.webp'],
    )
    const blobs = limited.site.hits.blob
    assert.ok(blobs >= 1 && blobs <= 3, String(blobs))
    const second = await limited.source.download(task(post(RKEYS.image), limited.work))
    assert.deepEqual(
      (await sizes(second.filepath)).map(([name]) => name),
      ['01.webp'],
    )
    assert.equal(limited.site.hits.blob, blobs, 'the CDN first while the PDS limits')
    const down = await setup('pds-down', {pdsDown: true})
    const file = await down.source.download(task(post(RKEYS.image), down.work))
    assert.deepEqual(
      (await sizes(file.filepath)).map(([name]) => name),
      ['01.webp'],
    )
    assert.equal(down.site.hits.cdn, 1)
  })

  it('a did:web account: its PDS from its own host’s DID document', {timeout: 5_000}, async () => {
    const {site, source, work} = await setup('did-web')
    const file = await source.download(task(post(RKEYS.web, DIDS.web), work))
    assert.deepEqual(await sizes(file.filepath), [['01.jpg', 4096]])
    assert.equal(site.hits.didWeb, 1)
    assert.equal(site.hits.plc, 0)
  })

  it('analyze, checks and download of one post at the same time make one AppView and one PLC request', {
    timeout: 5_000,
  }, async () => {
    const {site, source, work} = await setup('together')
    const url = post(RKEYS.gallery)
    const [analysis, checks, file] = await Promise.all([
      source.analyze(url),
      source.preflight([{url}, {url}], {}),
      source.download(task(url, work)),
    ])
    assert.equal(asVideo(analysis).media.id, RKEYS.gallery)
    assert.ok([...checks.values()].every(r => r.ok))
    assert.equal(file.info.id, RKEYS.gallery)
    assert.equal(site.hits.thread, 1)
    assert.equal(site.hits.plc, 1)
    const listed = await source.preflight([{url: ALICE}], {})
    assert.equal(listed.get(ALICE)?.ok, false, 'a profile is not one item')
  })

  it('in a mix list: posts are items (query left out), a profile is a list', {timeout: 5_000}, async () => {
    const {engine} = await setup('mix')
    const mix = await engine.analyzeMix(
      [`${post(RKEYS.video)}?ref_src=embed`, post(RKEYS.video), post(RKEYS.image), ALICE].join('\n'),
      {profile: mp4},
    )
    assert.deepEqual(
      mix.valid.map(item => [item.line, item.site]),
      [
        [1, 'bluesky'],
        [3, 'bluesky'],
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
