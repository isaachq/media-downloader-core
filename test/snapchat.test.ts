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
import {readNextData} from '../src/sources/snapchat/data.js'
import {isSnapchatListing, parseSnapchatLink, snapchatUrl} from '../src/sources/snapchat/links.js'
import {type SnapchatOptions, SnapchatSource} from '../src/sources/snapchat/source.js'
import {SOURCE_FORMAT_CHANGED, type SourceDownload} from '../src/sources/source.js'
import type {AnalysisResult, PlaylistAnalysis, VideoAnalysis} from '../src/types.js'
import {startFakeSnapchat} from './helpers/fake-snapchat.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const audio = {kind: 'audio', container: 'mp3'} as const
const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 50} as const
const SPOT = 'W7_EDlXWTBiXAEEniNoMPwAAYeG9xcGd0ZWd3AZ14BVv0AZ14BQkrAAAAAQ'
const SNAP = 'sWO_duZfSV-aKluMi_U4sgAAgbnpwempiYm9oAaF5D6o6AaF5D5ecAAAAAA'
const HIGHLIGHT = 'ddf02468-ae16-4fc6-b1bc-bde7e1e22218'

describe('Snapchat links', () => {
  it('recognizes every shape the site and its share sheet produce', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [`https://www.snapchat.com/spotlight/${SPOT}`, {kind: 'spotlight', id: SPOT}],
      [`https://snapchat.com/spotlight/${SPOT}?share_id=x&locale=en-US`, {kind: 'spotlight', id: SPOT}],
      [`https://www.snapchat.com/@nasa/spotlight/${SPOT}`, {kind: 'spotlight', id: SPOT, user: 'nasa'}],
      [`https://www.snapchat.com/add/nasa/spotlight/${SPOT}`, {kind: 'spotlight', id: SPOT, user: 'nasa'}],
      ['https://www.snapchat.com/@nasa', {kind: 'profile', user: 'nasa'}],
      ['https://www.snapchat.com/@nasa/', {kind: 'profile', user: 'nasa'}],
      ['https://www.snapchat.com/%40nasa', {kind: 'profile', user: 'nasa'}],
      ['https://www.snapchat.com/add/djkhaled305', {kind: 'profile', user: 'djkhaled305'}],
      ['https://m.snapchat.com/add/djkhaled305?share_id=1', {kind: 'profile', user: 'djkhaled305'}],
      ['https://story.snapchat.com/s/djkhaled305', {kind: 'profile', user: 'djkhaled305'}],
      ['https://story.snapchat.com/@djkhaled305', {kind: 'profile', user: 'djkhaled305'}],
      ['https://www.snapchat.com/@nasa/spotlights', {kind: 'profile', user: 'nasa', section: 'spotlights'}],
      ['https://www.snapchat.com/@nasa/stories', {kind: 'profile', user: 'nasa', section: 'stories'}],
      ['https://www.snapchat.com/@nasa/highlights', {kind: 'profile', user: 'nasa', section: 'highlights'}],
      [`https://www.snapchat.com/@djkhaled305/${SNAP}`, {kind: 'snap', user: 'djkhaled305', id: SNAP}],
      [`https://www.snapchat.com/add/djkhaled305/${SNAP}`, {kind: 'snap', user: 'djkhaled305', id: SNAP}],
      [`https://www.snapchat.com/@nasa/highlight/${HIGHLIGHT}`, {kind: 'highlight', user: 'nasa', id: HIGHLIGHT}],
      [
        `https://www.snapchat.com/@nasa/highlight/${HIGHLIGHT}/3`,
        {kind: 'highlight', user: 'nasa', id: HIGHLIGHT, index: 3},
      ],
      ['https://www.snapchat.com/t/aBcD1234', {kind: 'short', url: 'https://www.snapchat.com/t/aBcD1234'}],
      ['https://snapchat.com/t/aBcD1234/', {kind: 'short', url: 'https://www.snapchat.com/t/aBcD1234'}],
      ['https://t.snapchat.com/eFgH5678', {kind: 'short', url: 'https://t.snapchat.com/eFgH5678'}],
    ]
    for (const [url, link] of cases) assert.deepEqual(parseSnapchatLink(url), link, url)
  })

  it('leaves out what it does not read', () => {
    for (const url of [
      'https://www.snapchat.com/',
      'https://www.snapchat.com/discover/some-show/123',
      'https://www.snapchat.com/lens/abc',
      'https://www.snapchat.com/u/nasa',
      'https://www.snapchat.com/@nasa/avatar',
      'https://www.snapchat.com/@nasa/shortid',
      'https://www.snapchat.com/spotlight/short',
      'https://www.snapchat.com/@nasa/highlight/x',
      'https://t.snapchat.com/',
      'https://notsnapchat.com/@nasa',
      'https://snapchat.com.evil.test/@nasa',
      'ftp://www.snapchat.com/@nasa',
      'not a url',
    ]) {
      assert.equal(parseSnapchatLink(url), undefined, url)
    }
  })

  it('profiles and whole highlights are lists; one snap of a highlight is one item', () => {
    assert.equal(isSnapchatListing('https://www.snapchat.com/@nasa'), true)
    assert.equal(isSnapchatListing(`https://www.snapchat.com/@nasa/highlight/${HIGHLIGHT}`), true)
    assert.equal(isSnapchatListing(`https://www.snapchat.com/@nasa/highlight/${HIGHLIGHT}/1`), false)
    assert.equal(isSnapchatListing(`https://www.snapchat.com/spotlight/${SPOT}`), false)
    assert.equal(isListingLink('https://story.snapchat.com/s/nasa', {defaultListSize: () => undefined}), true)
    for (const url of [
      `https://www.snapchat.com/@nasa/spotlight/${SPOT}`,
      `https://www.snapchat.com/@djkhaled305/${SNAP}`,
      `https://www.snapchat.com/@nasa/highlight/${HIGHLIGHT}/2`,
      'https://www.snapchat.com/@nasa/spotlights',
    ]) {
      const link = parseSnapchatLink(url)
      assert.ok(link && link.kind !== 'short', url)
      assert.deepEqual(parseSnapchatLink(snapchatUrl(link)), link, url)
    }
  })
})

describe('Snapchat page data', () => {
  it('finds __NEXT_DATA__ by its marker and parses it once; anything else is a format change', () => {
    const html = '<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"a":1}}}</script>'
    assert.deepEqual(readNextData(html, 'id="__NEXT_DATA__"'), {a: 1})
    for (const broken of [
      '<html><body>nothing</body></html>',
      '<script id="__NEXT_DATA__" type="application/json">{"props":',
      '<script id="__NEXT_DATA__" type="application/json">{not json}</script>',
      '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>',
    ]) {
      assert.throws(
        () => readNextData(broken, 'id="__NEXT_DATA__"'),
        (e: {problem?: string}) => e.problem === 'format-changed',
      )
    }
  })
})

let root: string
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-snapchat-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

async function setup(name: string, config: Parameters<typeof startFakeSnapchat>[0] = {}) {
  const site = await startFakeSnapchat(config)
  const options: SnapchatOptions = {endpoints: {origin: site.origin}, fetch: site.fetch, pacing: fast}
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
    snapchat: options,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0, diskCheck: 'off'})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {site, engine, scheduler, source: new SnapchatSource(options), out: path.join(root, name, 'out')}
}

const asVideo = (analysis: AnalysisResult): VideoAnalysis => {
  assert.equal(analysis.kind, 'video', 'one item')
  return analysis as VideoAnalysis
}
const asList = (analysis: AnalysisResult): PlaylistAnalysis => {
  assert.equal(analysis.kind, 'playlist', 'a listing')
  return analysis as PlaylistAnalysis
}

/** A download task for the source itself (no engine): what the engine would hand it. */
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

describe('Snapchat, end to end (local fake)', () => {
  it('a spotlight: its own entry of the feed (not a recommendation), downloaded through a batch', {
    timeout: 5_000,
  }, async () => {
    const {site, engine, scheduler, out} = await setup('spotlight')
    const url = `https://www.snapchat.com/spotlight/${site.ids.spotlight}`
    const analysis = asVideo(await engine.analyze(url))
    assert.equal(analysis.media.id, site.ids.spotlight)
    assert.equal(analysis.media.uploader, 'nasa')
    assert.equal(analysis.media.extractor, 'Snapchat')
    assert.equal(analysis.media.duration, 87.33)
    assert.equal(analysis.media.publishedAt, 1_775_835_089)
    assert.equal(analysis.media.title, 'nasa spotlight 2026-04-10', 'a generic name is no title')
    assert.equal(analysis.media.url, `https://www.snapchat.com/@nasa/spotlight/${site.ids.spotlight}`)
    assert.ok(
      analysis.choices.some(c => c.label === '540p · MP4'),
      JSON.stringify(analysis.choices.map(c => c.label)),
    )
    const batch = scheduler.schedule({url, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const files = await fs.readdir(out)
    assert.equal(files.length, 1)
    assert.match(files[0]!, /^nasa-spotlight-2026-04-10-W7-EDlXWTBiXAEEniNoMPwAAYeG9xcGd0.*\.mp4$/)
    assert.equal(site.hits.media, 1, 'one media request: the url the page serves, as served')
    // the redirect (/spotlight → /@nasa/spotlight) is the one extra page hop; analyze, check and download share it
    assert.deepEqual(site.pages, [`/spotlight/${site.ids.spotlight}`, `/@nasa/spotlight/${site.ids.spotlight}`])
  })

  it('a profile: its live story, its highlights’ snaps and its spotlights, placeholders skipped', {
    timeout: 5_000,
  }, async () => {
    const {site, engine} = await setup('profile')
    const list = asList(await engine.analyze('https://www.snapchat.com/add/djkhaled305'))
    assert.equal(list.extractor, 'Snapchat')
    assert.equal(list.uploader, 'djkhaled305')
    assert.deepEqual(
      list.entries.map(e => e.id),
      [
        site.ids.storySnap,
        site.ids.imageSnap,
        `${site.ids.khaledHighlight}-1`,
        site.ids.khaledSpotlight,
        site.ids.badSpotlight,
      ],
    )
    assert.deepEqual(
      list.entries.map(e => e.index),
      [1, 2, 3, 4, 5],
    )
    assert.equal(list.complete, true, 'no cursor: the page holds everything')
    assert.equal(list.total, 5)
    const [story, picture, highlight, spotlight] = list.entries
    assert.equal(story!.url, `https://www.snapchat.com/@djkhaled305/${site.ids.storySnap}`)
    assert.equal(story!.title, 'djkhaled305 story 2026-10-26 16:33')
    assert.deepEqual(picture!.slideshow, {images: 1, audio: false}, 'a picture is a one-image photo post')
    assert.equal(highlight!.url, `https://www.snapchat.com/@djkhaled305/highlight/${site.ids.khaledHighlight}/1`)
    assert.equal(highlight!.title, 'Studio #1')
    assert.equal(spotlight!.title, 'The bills don’t stop why should I')
    assert.deepEqual(site.pages, ['/@djkhaled305'], 'an /add link is read as /@ at once: one page read')
  })

  it('a profile whose page says there is more is not complete; maxEntries and known cut it in O(1) per item', {
    timeout: 5_000,
  }, async () => {
    const {site, engine, source} = await setup('profile-more')
    const nasa = asList(await engine.analyze('https://www.snapchat.com/@nasa'))
    assert.deepEqual(
      nasa.entries.map(e => e.id),
      [`${site.ids.highlight}-1`, `${site.ids.highlight}-2`, `${site.ids.highlight}-3`, site.ids.spotlight],
    )
    assert.equal(nasa.complete, false, 'a cursor: more than the page embeds')
    assert.equal(nasa.total, undefined)
    const capped = asList(await source.analyze('https://www.snapchat.com/@djkhaled305', {maxEntries: 2}))
    assert.equal(capped.entries.length, 2)
    assert.equal(capped.complete, false)
    assert.equal(capped.total, 5)
    const newer = asList(
      await source.analyze('https://www.snapchat.com/@djkhaled305', {
        known: new Set([site.ids.storySnap, site.ids.khaledSpotlight]),
      }),
    )
    assert.deepEqual(
      newer.entries.map(e => e.id),
      [site.ids.imageSnap, `${site.ids.khaledHighlight}-1`, site.ids.badSpotlight],
    )
    assert.equal(newer.caughtUp, true)
    const spotlights = asList(await source.analyze('https://www.snapchat.com/@djkhaled305/spotlights'))
    assert.deepEqual(
      spotlights.entries.map(e => e.id),
      [site.ids.khaledSpotlight, site.ids.badSpotlight],
    )
    assert.equal(source.defaultListSize('https://www.snapchat.com/@nasa'), 500)
    assert.equal(source.defaultListSize(`https://www.snapchat.com/spotlight/${site.ids.spotlight}`), undefined)
  })

  it('a whole profile downloads from its one page read: the listing feeds every entry', {timeout: 8_000}, async () => {
    const {site, scheduler, out} = await setup('profile-batch')
    const batch = scheduler.schedule({
      url: 'https://www.snapchat.com/@nasa',
      profile: mp4,
      outDir: out,
      slideshow: {mode: 'images', secondsPerImage: 3},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 4)
    assert.equal(site.hits.page, 1, 'one page for the listing, its checks and its four downloads')
    assert.equal(site.hits.media, 4)
  })

  it('a highlight is a playlist of its snaps; one of them is one item from the same page', {
    timeout: 5_000,
  }, async () => {
    const {site, engine} = await setup('highlight')
    const list = asList(await engine.analyze(`https://www.snapchat.com/@nasa/highlight/${site.ids.highlight}`))
    assert.equal(list.id, site.ids.highlight)
    assert.equal(list.title, 'Snapchat nasa Moon Joy')
    assert.deepEqual(
      list.entries.map(e => e.title),
      ['Moon Joy #1', 'Moon Joy #2', 'Moon Joy #3'],
    )
    assert.ok(list.entries[2]!.slideshow, 'the third snap is a picture')
    const third = asVideo(await engine.analyze(list.entries[2]!.url))
    assert.equal(third.media.id, `${site.ids.highlight}-3`)
    assert.equal(site.hits.page, 1)
    await assert.rejects(
      engine.analyze(`https://www.snapchat.com/@nasa/highlight/${site.ids.highlight}/9`),
      /no snap 9/,
    )
  })

  it('one story snap: its page, that snap', {timeout: 5_000}, async () => {
    const {site, scheduler, engine, out} = await setup('story')
    const url = `https://www.snapchat.com/@djkhaled305/${site.ids.storySnap}`
    const analysis = asVideo(await engine.analyze(url))
    assert.equal(analysis.media.id, site.ids.storySnap)
    assert.equal(analysis.media.publishedAt, 1_793_032_427)
    const batch = scheduler.schedule({url, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal((await fs.readdir(out)).length, 1)
    assert.equal(site.hits.page, 1)
  })

  it('a picture snap is a one-image photo post: the picture itself, or nothing for an audio format', {
    timeout: 5_000,
  }, async () => {
    const {site, scheduler, engine, out} = await setup('image')
    const url = `https://www.snapchat.com/@djkhaled305/${site.ids.imageSnap}`
    const analysis = asVideo(await engine.analyze(url))
    assert.deepEqual(analysis.media.slideshow, {images: 1, audio: false})
    assert.ok(
      analysis.choices.every(c => c.profile.kind === 'video'),
      'no audio choices: a picture has no sound',
    )
    const batch = scheduler.schedule({
      url,
      profile: mp4,
      outDir: out,
      slideshow: {mode: 'images', secondsPerImage: 3},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const [folder] = await fs.readdir(out)
    assert.deepEqual(await fs.readdir(path.join(out, folder!)), ['01.jpg'])
    const source = new SnapchatSource({endpoints: {origin: site.origin}, fetch: site.fetch, pacing: fast})
    await assert.rejects(
      source.download(task(url, path.join(root, 'image-audio'), {profile: audio})),
      (e: DownloadError) => e.code === 'unavailable' && e.hint === 'format-unavailable',
    )
  })

  it('an expired snap, a page that is gone, a private account: unavailable, each with its reason', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('gone')
    await assert.rejects(
      source.analyze(`https://www.snapchat.com/@djkhaled305/${site.ids.expiredSnap}`),
      (e: DownloadError) => {
        assert.equal(e.code, 'unavailable')
        assert.equal(e.hint, 'removed')
        assert.match(e.message, /stories last 24 hours/)
        return true
      },
    )
    for (const url of [
      'https://www.snapchat.com/@nobodyhere',
      `https://www.snapchat.com/spotlight/${'X'.repeat(59)}`,
      `https://www.snapchat.com/@nasa/highlight/00000000-0000-0000-0000-000000000000`,
    ]) {
      await assert.rejects(source.analyze(url), (e: DownloadError) => {
        assert.equal(e.code, 'unavailable', url)
        assert.equal(e.hint, 'removed', url)
        return true
      })
    }
    await assert.rejects(source.analyze('https://www.snapchat.com/@hiddenfriend'), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'private')
      assert.match(e.message, /private Snapchat account/)
      return true
    })
  })

  it('a page whose data moved says so, for the engine to hand the url to yt-dlp', {timeout: 5_000}, async () => {
    const {source, engine} = await setup('changed')
    for (const url of ['https://www.snapchat.com/@movedthings', 'https://www.snapchat.com/@nodatascript']) {
      await assert.rejects(source.analyze(url), (e: DownloadError) => {
        assert.equal(e.details, SOURCE_FORMAT_CHANGED, url)
        assert.match(e.message, /^Snapchat: /)
        return true
      })
    }
    // the engine falls back: the (fake) yt-dlp answers instead
    const fallback = await engine.analyze('https://www.snapchat.com/@movedthings')
    assert.equal(fallback.kind === 'video' ? fallback.media.extractor : fallback.extractor, 'Fake')
  })

  it('bytes that are no media (a 200 from the CDN) fail cleanly and leave no file', {timeout: 5_000}, async () => {
    const {site, source} = await setup('not-media')
    const work = path.join(root, 'not-media-work')
    await fs.mkdir(work, {recursive: true})
    const url = `https://www.snapchat.com/@djkhaled305/spotlight/${site.ids.badSpotlight}`
    await source.analyze('https://www.snapchat.com/@djkhaled305')
    await assert.rejects(source.download(task(url, work)), (e: DownloadError) => {
      assert.equal(e.details, SOURCE_FORMAT_CHANGED)
      assert.match(e.message, /not an MP4 video/)
      return true
    })
    assert.deepEqual(await fs.readdir(work), [])
  })

  it('analyze, check and download of one link at the same time make one page request', {timeout: 5_000}, async () => {
    const {site, source} = await setup('together')
    const url = `https://www.snapchat.com/@nasa/spotlight/${site.ids.spotlight}`
    const work = path.join(root, 'together-work')
    await fs.mkdir(work, {recursive: true})
    const [analysis, checks, file] = await Promise.all([
      source.analyze(url),
      source.preflight([{url}, {url}], {}),
      source.download(task(url, work)),
    ])
    assert.equal(asVideo(analysis).media.id, site.ids.spotlight)
    assert.ok([...checks.values()].every(r => r.ok))
    assert.equal(file.info.id, site.ids.spotlight)
    assert.equal(site.hits.page, 1, '4 callers, 1 page request')
    // a profile link is a list, never one item
    const listed = await source.preflight([{url: 'https://www.snapchat.com/@nasa'}], {})
    const result = listed.get('https://www.snapchat.com/@nasa')!
    assert.equal(result.ok, false)
  })

  it('follows short links on both hosts; one that leads elsewhere on Snapchat says so', {timeout: 5_000}, async () => {
    const {site, source} = await setup('short')
    const spotlight = asVideo(await source.analyze('https://www.snapchat.com/t/aBcD1234'))
    assert.equal(spotlight.media.id, site.ids.spotlight)
    const profile = asList(await source.analyze('https://t.snapchat.com/eFgH5678'))
    assert.equal(profile.uploader, 'djkhaled305')
    await assert.rejects(source.analyze('https://www.snapchat.com/t/toNowhere'), /does not lead to a spotlight/)
    await assert.rejects(source.analyze('https://www.snapchat.com/t/deadCode1'), /leads nowhere/)
    assert.equal(site.hits.short, 4)
  })

  it('retries a refused page after the shared cool-down', {timeout: 5_000}, async () => {
    const {site, source} = await setup('refused', {refusals: 2})
    asList(await source.analyze('https://www.snapchat.com/@nasa'))
    assert.equal(site.hits.refused, 2)
    assert.equal(site.hits.page, 3)
  })

  it('in a mix list: a spotlight and a snap are items; a profile and a highlight are lists', {
    timeout: 5_000,
  }, async () => {
    const {site, engine} = await setup('mix')
    const mix = await engine.analyzeMix(
      [
        `https://www.snapchat.com/@nasa/spotlight/${site.ids.spotlight}?share_id=abc`,
        `https://www.snapchat.com/@nasa/spotlight/${site.ids.spotlight}`,
        `https://www.snapchat.com/@djkhaled305/${site.ids.storySnap}`,
        'https://www.snapchat.com/@nasa',
        `https://www.snapchat.com/@nasa/highlight/${site.ids.highlight}`,
      ].join('\n'),
      {profile: mp4},
    )
    assert.deepEqual(
      mix.valid.map(item => [item.line, item.site]),
      [
        [1, 'snapchat'],
        [3, 'snapchat'],
      ],
    )
    assert.deepEqual(
      mix.skipped.map(skip => [skip.line, skip.reason]),
      [
        [2, 'duplicate'],
        [4, 'listing'],
        [5, 'listing'],
      ],
    )
  })
})
