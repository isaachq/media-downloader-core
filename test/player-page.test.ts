import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {estimateBytes} from '../src/core/cost.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {parsePlayerPageSites} from '../src/sources/player-page/config.js'
import {decodeEntities, firstPage, readListing, readVideoPage, videoMatcher} from '../src/sources/player-page/parse.js'
import {candidates, PlayerPageSource, playerChoices} from '../src/sources/player-page/source.js'
import {startFakePlayerSite} from './helpers/fake-player-site.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const audio = {kind: 'audio', container: 'mp3'} as const

describe('player pages: reading', () => {
  const isVideo = videoMatcher(new Set(['example.test', 'www.example.test']))
  const page = `<html><nav><a href="/video/1/menu"><span class="content-title">Menu pick</span></a></nav>
    <h1>Results</h1>
    <a href="/video/22/first-clip"><img src="https://example.test/t/22.jpg" title="First &amp; best"/><div class="duration">HD 1:02:03</div></a>
    <a href="/video/22/first-clip"><span class="content-title">First &#38; best</span></a>
    <a href="https://example.test/video/23/second?ref=x"><img alt="Second" src="/t/23.jpg"></a>
    <a href="https://elsewhere.test/video/24/other">elsewhere</a>
    <a href="/videos/25">not a video page</a>
    <ul class="pagination"><li><a href="https://example.test/search/videos/x?type=public&amp;page=2">2</a></li>
    <li><a href="https://example.test/search/videos/y?page=3">other search</a></li></ul>
    <a href="/video/26/after-pagination">footer</a></html>`

  it('takes the results between the heading and the pagination, merged per video', () => {
    const listing = readListing(page, 'https://example.test/search/videos/x?type=public', isVideo)
    assert.deepEqual(listing.videos, [
      {
        id: '22',
        url: 'https://example.test/video/22/first-clip',
        title: 'First & best',
        duration: 3723,
        thumbnail: 'https://example.test/t/22.jpg',
      },
      {
        id: '23',
        url: 'https://example.test/video/23/second',
        title: 'Second',
        thumbnail: 'https://example.test/t/23.jpg',
      },
    ])
    assert.deepEqual([...listing.pages], [[2, 'https://example.test/search/videos/x?type=public&page=2']])
    assert.equal(listing.title, 'Results')
  })

  it('reads a video page: title, length, offered heights, player', () => {
    const video = readVideoPage(`<meta property="og:title" content="A &quot;quoted&quot; title">
      <script>var video_duration = "61.5";</script><script>'{"res":"720"},{"res":"1080"},{"res":"720"}'</script><video id="v"></video>`)
    assert.deepEqual(video, {
      title: 'A "quoted" title',
      duration: 61.5,
      thumbnail: undefined,
      heights: [1080, 720],
      player: true,
    })
    assert.equal(readVideoPage('<html><title>Gone</title></html>').player, false)
  })

  it('decodes entities and finds a listing’s first page', () => {
    assert.equal(decodeEntities('a &amp; b &#x41;&#66; &unknown; &#0;'), 'a & b AB &unknown; &#0;')
    assert.equal(firstPage('https://example.test/s/x?type=public&page=9#top'), 'https://example.test/s/x?type=public')
  })

  it('tries the sibling rendition within the cap (smallest for audio), the player’s link last', () => {
    const played = 'https://media.example.test/v/h264/9_1080p.mp4'
    const heights = [1080, 720, 480]
    assert.deepEqual(candidates(played, heights, {kind: 'video', container: 'mp4'}), [played])
    assert.deepEqual(candidates(played, heights, {kind: 'video', container: 'mp4', maxHeight: 720}), [
      'https://media.example.test/v/h264/9_720p.mp4',
      played,
    ])
    assert.deepEqual(candidates(played, heights, {kind: 'video', container: 'mp4', maxHeight: 360}), [
      'https://media.example.test/v/h264/9_480p.mp4',
      played,
    ])
    assert.deepEqual(candidates(played, heights, {kind: 'audio', container: 'mp3'}), [
      'https://media.example.test/v/h264/9_480p.mp4',
      played,
    ])
    assert.deepEqual(candidates('https://m.test/v/9.mp4', heights, {kind: 'audio', container: 'mp3'}), [
      'https://m.test/v/9.mp4',
    ])
  })

  it('sizes a video at the heights its player offers, never at an 8K-class "best"', () => {
    const hour = {duration: 3600}
    const best = {kind: 'video', container: 'mp4'} as const
    const at = (height: number) => estimateBytes({...best, maxHeight: height}, [], 3600)!
    // a 1080p page: "best" is 1080p (~2.8 GB/h at 6 Mbps), not 50 Mbps (~22 GB/h)
    assert.equal(estimateBytes(best, playerChoices({...hour, heights: [1080, 720]}), 3600), at(1080))
    assert.ok(at(1080) < 3e9)
    // a 480p-only page stays 480p whatever the cap
    assert.equal(estimateBytes(best, playerChoices({...hour, heights: [480]}), 3600), at(480))
    assert.equal(
      estimateBytes({...best, maxHeight: 720}, playerChoices({...hour, heights: [1080, 720]}), 3600),
      at(720),
    )
    // unknown heights: sized as 1080p
    assert.equal(estimateBytes(best, playerChoices({...hour, heights: []}), 3600), at(1080))
    // audio: the smallest rendition is what gets downloaded
    assert.equal(estimateBytes(audio, playerChoices({...hour, heights: [1080, 480]}), 3600), at(480))
    assert.equal(playerChoices({heights: [720], duration: undefined})[0]?.estimatedBytes, undefined)
  })

  it('validates the sites file strictly', () => {
    assert.deepEqual(parsePlayerPageSites({sites: [{name: ' Mine ', hosts: ['example.test']}]}), [
      {name: 'Mine', hosts: ['example.test']},
    ])
    const problem = (json: unknown) => {
      try {
        parsePlayerPageSites(json)
        return 'none'
      } catch (error) {
        return (error as Error).message
      }
    }
    assert.match(problem({}), /sites/)
    assert.match(problem({sites: [{name: '', hosts: ['a.test']}]}), /name/)
    assert.match(problem({sites: [{name: 'A', hosts: []}]}), /hosts/)
    assert.match(problem({sites: [{name: 'A', hosts: ['http://a.test']}]}), /not a host/)
    assert.match(problem({sites: [{name: 'A', hosts: ['a.test'], videoPath: '^/v/\\d+'}]}), /group/)
    assert.match(problem({sites: [{name: 'A', hosts: ['a.test'], videoPath: '('}]}), /regular expression/)
    assert.match(
      problem({
        sites: [
          {name: 'A', hosts: ['a.test']},
          {name: 'a', hosts: ['b.test']},
        ],
      }),
      /twice/,
    )
  })
})

// ─── end to end against a local fake site ──────────────────────────────────

let root = ''
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-player-'))
  bins = await writeFakes(path.join(root, 'bin'))
})

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

async function setup(name: string, config: Parameters<typeof startFakePlayerSite>[0] = {}, withBrowser = true) {
  const site = await startFakePlayerSite(config)
  const source = new PlayerPageSource({
    site: {name: 'Local Site', hosts: [site.host]},
    pacing: {concurrency: 6, spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 50},
    ...(withBrowser && {resolveMedia: site.resolve}),
  })
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    maxRetries: 1,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: false,
    sources: [source],
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {site, engine, scheduler, out: path.join(root, name, 'out')}
}

const allFiles = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir, {recursive: true, withFileTypes: true}))
    .filter(e => e.isFile())
    .map(e => path.join(e.parentPath, e.name))

describe('player pages, end to end (local fake)', () => {
  it('lists every page of a search from any of its pages: 195 results, 9 pages, each read once', async () => {
    const {site, engine} = await setup('listing')
    const progress: number[] = []
    const started = performance.now()
    const listing = await engine.analyze(site.searchUrl('term', 9), {onProgress: p => progress.push(p.listed)})
    const ms = performance.now() - started
    assert.ok(listing.kind === 'playlist')
    assert.equal(listing.entries.length, 195)
    assert.deepEqual(
      listing.entries.map(e => e.id),
      site.ids,
      'page order, menu and footer links left out',
    )
    assert.ok(site.hits.listing <= 9 + 6, `${site.hits.listing} pages read: each once, a few past the end`)
    assert.equal(site.hits.video, 0, 'a listing reads no video page')
    assert.equal(listing.title, 'Search - Videos · term')
    assert.equal(listing.entries[0]!.title, `Clip ${site.ids[0]} & more`)
    assert.ok(listing.entries.every(e => e.duration! > 0 && e.extractor === 'Local Site'))
    assert.equal(progress.at(-1), 195)
    assert.ok(ms < 2000, `listed in ${ms.toFixed(0)} ms`)
  })

  it('like a TikTok profile, a listing loads 500 by default, and a batch of it is capped there too', async () => {
    const {site, engine, scheduler, out} = await setup('default-cap', {results: 620})
    assert.equal(engine.defaultListSize(site.searchUrl('term', 3)), 500)
    assert.equal(engine.defaultListSize(`${site.origin}/video/${site.ids[0]}/x`), undefined, 'a video is not a list')
    const listing = await engine.analyze(site.searchUrl('term'))
    assert.ok(listing.kind === 'playlist')
    assert.equal(listing.entries.length, 500)
    assert.ok(site.hits.listing <= 26, `${site.hits.listing} of 26 pages read`)
    const batch = scheduler.schedule({url: site.searchUrl('term'), profile: mp4, outDir: out})
    assert.equal(batch.maxItems, 500)
    scheduler.cancel(batch.id)
    await scheduler.whenIdle()
  })

  for (const pastEnd of ['empty', 'missing'] as const) {
    it(`finds the end of a listing whose pages past it are ${pastEnd}`, async () => {
      const {site, engine} = await setup(`past-end-${pastEnd}`, {results: 100, pastEnd})
      const listing = await engine.analyze(site.searchUrl('term'), {maxEntries: 50_000})
      assert.ok(listing.kind === 'playlist')
      assert.deepEqual(
        listing.entries.map(e => e.id),
        site.ids,
      )
    })
  }

  it('stops reading pages once a capped listing has enough', async () => {
    const {site, engine} = await setup('listing-cap', {results: 480})
    const listing = await engine.analyze(site.searchUrl('term'), {maxEntries: 30})
    assert.ok(listing.kind === 'playlist')
    assert.deepEqual(
      listing.entries.map(e => e.id),
      site.ids.slice(0, 30),
    )
    // 30 results need pages 1–2; at most the opening round (7 pages) goes out, never all 20
    assert.ok(site.hits.listing <= 7, `${site.hits.listing} of 20 pages read`)
  })

  it('stops at the cap even when page 1 answers last', async () => {
    const {site, engine} = await setup('listing-cap-slow-first', {results: 480, firstPageDelayMs: 300})
    const listing = await engine.analyze(site.searchUrl('term'), {maxEntries: 30})
    assert.ok(listing.kind === 'playlist')
    assert.deepEqual(
      listing.entries.map(e => e.id),
      site.ids.slice(0, 30),
    )
    assert.ok(site.hits.listing <= 7, `${site.hits.listing} of 20 pages read`)
  })

  it('downloads a whole search: checked page by page, one player lookup each, dated by the server', async () => {
    const {site, scheduler, out} = await setup('batch', {results: 30, perPage: 12, removed: ['10025']})
    const batch = scheduler.schedule({url: site.searchUrl('term'), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed-with-errors', JSON.stringify({error: done.error, estimate: done.estimate}))
    // forecast at the offered 1080p: 29 × ~49 MB, not 29 × an 8K-class "best"
    const each = estimateBytes({...mp4, maxHeight: 1080}, [], 61.5)!
    assert.equal(done.estimate?.bytes, 29 * each)
    assert.equal(done.preflight.total, 30)
    assert.equal(done.preflight.unavailable, 1, 'the removed video')
    assert.equal(done.jobs.succeeded, 29)
    const files = await allFiles(out)
    assert.equal(files.length, 29)
    assert.equal(site.hits.resolved, 29, 'one player lookup per download')
    for (const file of files) {
      const stat = await fs.stat(file)
      assert.equal(Math.round(stat.mtimeMs / 1000), site.published, 'dated by the media’s Last-Modified')
    }
    assert.ok(
      site.mediaPaths.every(p => p.endsWith('_1080p.mp4')),
      'best rendition when uncapped',
    )
  })

  it('keeps an MP4 exactly as the server sent it: no conversion, no rewrite, only validated', async () => {
    const {site, engine, out} = await setup('untouched', {results: 1, perPage: 1, mediaBytes: 64 * 1024})
    const job = engine.add({url: `${site.origin}/video/${site.ids[0]}/x`, profile: mp4, outDir: out})
    await engine.whenIdle()
    const done = engine.job(job.id)!
    assert.equal(done.status, 'completed')
    const [file] = await allFiles(out)
    // the fake serves the 1080p file as 64 KiB of "0"
    assert.deepEqual(await fs.readFile(file!), Buffer.alloc(64 * 1024, '0'))
    const steps = new Map(done.steps.map(step => [step.name, step.state]))
    assert.equal(steps.get('convert'), 'skipped')
    assert.equal(steps.get('validate'), 'skipped', "validation is off in these tests; it runs with the app's setting")
  })

  it('takes the rendition within the quality cap, and the smallest one for audio', async () => {
    const {site, engine, out} = await setup('renditions', {results: 2, perPage: 2})
    const video = engine.add({
      url: `${site.origin}/video/${site.ids[0]}/x`,
      profile: {...mp4, maxHeight: 720},
      outDir: path.join(out, 'video'),
    })
    const sound = engine.add({
      url: `${site.origin}/video/${site.ids[1]}/x`,
      profile: audio,
      outDir: path.join(out, 'audio'),
    })
    await engine.whenIdle()
    assert.equal(engine.job(video.id)?.status, 'completed')
    assert.equal(engine.job(sound.id)?.status, 'completed')
    assert.deepEqual(
      site.mediaPaths.sort(),
      [`/media/videos/h264/${site.ids[0]}_720p.mp4`, `/media/videos/h264/${site.ids[1]}_480p.mp4`].sort(),
    )
  })

  it('without a browser, lists and checks but explains why it can’t download', async () => {
    const {site, engine, out} = await setup('no-browser', {results: 1, perPage: 1}, false)
    const job = engine.add({url: `${site.origin}/video/${site.ids[0]}/x`, profile: mp4, outDir: out})
    await engine.whenIdle()
    const failed = engine.job(job.id)!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error?.code, 'unavailable')
    assert.match(failed.error?.message ?? '', /built-in browser/)
    assert.equal(site.hits.media, 0)
  })
})
