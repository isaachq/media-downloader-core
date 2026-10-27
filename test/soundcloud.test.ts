import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import type {DownloadError} from '../src/core/errors.js'
import {isListingLink} from '../src/core/mix.js'
import {MediaDownloader} from '../src/downloader.js'
import {isSoundcloudListing, parseSoundcloudLink} from '../src/sources/soundcloud/links.js'
import {type SoundcloudOptions, SoundcloudSource} from '../src/sources/soundcloud/source.js'
import {needsFallback, SOURCE_BLOCKED, SOURCE_FORMAT_CHANGED, type SourceDownload} from '../src/sources/source.js'
import type {AnalysisResult, JobSnapshot, PlaylistAnalysis, VideoAnalysis} from '../src/types.js'
import {writeCopyFfmpeg} from './helpers/fake-hls.js'
import {
  BUNDLE_ID,
  type FakeSoundcloudConfig,
  HYDRATION_ID,
  IDS,
  OPTION_ID,
  PRIVATE_STUBS,
  PROFILE_TRACKS,
  REMOVED_STUBS,
  SECRET,
  SET_SECRET,
  SET_STUBS,
  startFakeSoundcloud,
  trackUrl,
} from './helpers/fake-soundcloud.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const m4a = {kind: 'audio', container: 'm4a'} as const
const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 50} as const
const T = {timeout: 5_000}
const ARTIST = 'https://soundcloud.com/artist'
const BIG_SET = `${ARTIST}/sets/big-set`

describe('SoundCloud links', () => {
  it('recognizes tracks, private tracks, sets, profiles and their tabs, short links and the embed player', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['https://soundcloud.com/forss/flickermood', {kind: 'track', user: 'forss', slug: 'flickermood'}],
      [
        'https://m.soundcloud.com/forss/flickermood?si=abc&utm_source=x',
        {kind: 'track', user: 'forss', slug: 'flickermood'},
      ],
      ['https://www.soundcloud.com/forss/flickermood/recommended', {kind: 'track', user: 'forss', slug: 'flickermood'}],
      [
        'https://soundcloud.com/jaimemf/youtube-dl-test-video-a-y-baw/s-8Pjrp',
        {kind: 'track', user: 'jaimemf', slug: 'youtube-dl-test-video-a-y-baw', secret: 's-8Pjrp'},
      ],
      ['https://soundcloud.com/lofi_chill/sets/lofi-study', {kind: 'set', user: 'lofi_chill', slug: 'lofi-study'}],
      ['https://soundcloud.com/u/sets/private/s-AbC123', {kind: 'set', user: 'u', slug: 'private', secret: 's-AbC123'}],
      ['https://soundcloud.com/flume', {kind: 'profile', user: 'flume', tab: 'tracks'}],
      ['https://soundcloud.com/flume/tracks', {kind: 'profile', user: 'flume', tab: 'tracks'}],
      ['https://soundcloud.com/flume/likes', {kind: 'profile', user: 'flume', tab: 'likes'}],
      ['https://soundcloud.com/flume/sets', {kind: 'profile', user: 'flume', tab: 'sets'}],
      ['https://soundcloud.com/flume/albums/', {kind: 'profile', user: 'flume', tab: 'albums'}],
      [
        'https://on.soundcloud.com/fqRmvhVEbVvCLEJ29',
        {kind: 'short', url: 'https://on.soundcloud.com/fqRmvhVEbVvCLEJ29'},
      ],
      [
        `https://w.soundcloud.com/player/?url=${encodeURIComponent('https://soundcloud.com/u/t')}&secret_token=s-xyz9`,
        {kind: 'track', user: 'u', slug: 't', secret: 's-xyz9'},
      ],
    ]
    for (const [url, link] of cases) assert.deepEqual(parseSoundcloudLink(url), link, url)
  })

  it('leaves out what it does not read', () => {
    for (const url of [
      'https://soundcloud.com/',
      'https://soundcloud.com/discover',
      'https://soundcloud.com/search?q=lofi',
      'https://soundcloud.com/stream',
      'https://soundcloud.com/flume/reposts',
      'https://soundcloud.com/flume/followers',
      'https://soundcloud.com/flume/stay/edit/more',
      'https://soundcloud.com/flume/stay/not-a-token',
      'https://soundcloud.com/flume/sets/a-set/not-a-token',
      'https://api-v2.soundcloud.com/tracks/293',
      'https://soundcloud.com.evil.test/flume/stay',
      'https://notsoundcloud.com/flume/stay',
      'ftp://soundcloud.com/flume/stay',
      'https://on.soundcloud.com/',
      'not a url',
    ]) {
      assert.equal(parseSoundcloudLink(url), undefined, url)
    }
  })

  it('a set or a profile is a list; a track is one item', () => {
    assert.equal(isSoundcloudListing('https://soundcloud.com/flume'), true)
    assert.equal(isSoundcloudListing('https://soundcloud.com/lofi_chill/sets/lofi-study'), true)
    assert.equal(isSoundcloudListing('https://soundcloud.com/forss/flickermood'), false)
    assert.equal(isListingLink('https://soundcloud.com/flume/likes', {defaultListSize: () => undefined}), true)
  })
})

let root: string
let bins: FakeBinaries
let copyFfmpeg: {command: string; args: string[]}
const cleanups: Array<() => Promise<void>> = []
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-soundcloud-'))
  bins = await writeFakes(path.join(root, 'bin'))
  copyFfmpeg = await writeCopyFfmpeg(path.join(root, 'copy-bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

async function setup(
  name: string,
  config: FakeSoundcloudConfig = {hydrationId: HYDRATION_ID},
  extra: SoundcloudOptions = {},
) {
  const site = await startFakeSoundcloud(config)
  const options: SoundcloudOptions = {
    endpoints: {api: site.api, web: site.origin, short: `${site.origin}/short`, assetHost: `${site.origin}/assets`},
    pacing: fast,
    ...extra,
  }
  cleanups.push(() => site.close())
  const work = path.join(root, name, 'work')
  await fs.mkdir(work, {recursive: true})
  return {site, options, source: new SoundcloudSource(options), work}
}

const asTrack = (analysis: AnalysisResult): VideoAnalysis => {
  assert.equal(analysis.kind, 'video', 'one track')
  return analysis as VideoAnalysis
}
const asList = (analysis: AnalysisResult): PlaylistAnalysis => {
  assert.equal(analysis.kind, 'playlist', 'a listing')
  return analysis as PlaylistAnalysis
}

let tasks = 0
function task(url: string, workDir: string, overrides: Partial<SourceDownload> = {}): SourceDownload {
  return {
    url,
    profile: m4a,
    // each download its own work folder (the engine's is per url + profile)
    workDir: path.join(workDir, String(++tasks)),
    signal: AbortSignal.timeout(4_000),
    fresh: false,
    hasAudio: async () => true,
    ffmpeg: copyFfmpeg,
    threads: 1,
    fragments: 3,
    slideshow: {mode: 'images', secondsPerImage: 3},
    onInfo: () => {},
    onProgress: () => {},
    ...overrides,
  }
}

const refusal = async (promise: Promise<unknown>): Promise<DownloadError> => {
  try {
    await promise
  } catch (error) {
    return error as DownloadError
  }
  assert.fail('expected a refusal')
}

describe('SoundCloud, end to end (local fake)', () => {
  it('a track: the hydration client id, one resolve, one mint, the clear HLS AAC 160k as one fMP4 m4a', T, async () => {
    const {site, source, work} = await setup('track')
    const analysis = asTrack(await source.analyze(trackUrl('clear-track')))
    assert.equal(analysis.media.id, String(IDS.clear))
    assert.equal(analysis.media.extractor, 'SoundCloud')
    assert.equal(analysis.media.duration, 60)
    assert.equal(analysis.media.uploader, 'The Artist')
    assert.match(analysis.media.thumbnail ?? '', /-t500x500\.jpg$/)
    assert.ok(
      analysis.choices.length > 0 && analysis.choices.every(c => c.profile.kind === 'audio'),
      'audio choices only',
    )
    let info: unknown
    const file = await source.download(task(trackUrl('clear-track'), work, {onInfo: i => (info = i)}))
    assert.equal(path.extname(file.filepath), '.m4a')
    assert.deepEqual(await fs.readFile(file.filepath), site.hls.expected(`t${IDS.clear}`), 'init + segments in order')
    assert.equal(file.info.formatId, 'aac_160k/hls')
    assert.equal(file.info.acodec, 'aac')
    assert.equal(file.info.vcodec, 'none')
    assert.equal(file.tags?.artist, 'Credited Artist')
    assert.equal((info as {duration?: number}).duration, 60)
    assert.equal(site.hits.home, 1, 'the home page read once')
    assert.equal(site.hits.script, undefined, 'the hydration id needs no bundle')
    assert.equal(site.hits.resolve, 1, 'analyze and download share one read')
    assert.equal(site.hits.mint, 1)
    assert.equal(site.mints[0]?.get('track_authorization'), `jwt-${IDS.clear}`)
    assert.ok(site.clientIds.every(id => id === HYDRATION_ID))
  })

  it('a video profile is refused before any request: SoundCloud is audio only', T, async () => {
    const {site, source, work} = await setup('video')
    const error = await refusal(
      source.download(task(trackUrl('clear-track'), work, {profile: {kind: 'video', container: 'mp4'}})),
    )
    assert.equal(error.code, 'invalid-request')
    assert.equal(error.hint, 'format-unavailable')
    assert.deepEqual(site.hits, {})
  })

  it(
    'client id rotation: a 401 refuses the hydration id once, the bundle’s is read as it streams and kept',
    T,
    async () => {
      const {site, source, work} = await setup('rotate')
      asTrack(await source.analyze(trackUrl('clear-track')))
      site.setValid([BUNDLE_ID])
      await source.download(task(trackUrl('low-only'), work))
      assert.equal(site.hits.denied, 1, 'one 401')
      assert.equal(site.hits.home, 2, 'the page read again once')
      assert.equal(site.hits.script, 1, 'the last script first: the id is there, the others are never asked')
      const after = site.clientIds.length
      asTrack(await source.analyze(trackUrl('old-upload')))
      assert.equal(site.hits.home, 2, 'the new id is kept')
      assert.ok(site.clientIds.slice(after).every(id => id === BUNDLE_ID))
    },
  )

  it('every id refused: a changed client id scheme goes to yt-dlp', T, async () => {
    const {site, source} = await setup('refused', {hydrationId: HYDRATION_ID, valid: []})
    const error = await refusal(source.analyze(trackUrl('clear-track')))
    assert.equal(error.details, SOURCE_FORMAT_CHANGED)
    assert.ok(needsFallback(error.details))
    assert.ok((site.hits.denied ?? 0) <= 2, 'at most one retry per request')
  })

  it('a client id option skips the page; a bot check on the page is source:blocked', T, async () => {
    const own = await setup('option', {hydrationId: HYDRATION_ID}, {clientId: OPTION_ID})
    asTrack(await own.source.analyze(trackUrl('clear-track')))
    assert.equal(own.site.hits.home, undefined)
    assert.deepEqual([...new Set(own.site.clientIds)], [OPTION_ID])
    const waf = await setup('waf', {wafHome: true})
    const error = await refusal(waf.source.analyze(trackUrl('clear-track')))
    assert.equal(error.details, SOURCE_BLOCKED)
    assert.equal(waf.source.available, false, 'yt-dlp takes SoundCloud for a while')
  })

  it(
    'an expiring playlist: a link that ran out before it was read is minted again; expired segments re-sign',
    T,
    async () => {
      const {site, source, work} = await setup('expiring')
      site.expireNextMint(IDS.expiring)
      const file = await source.download(task(trackUrl('long-mix'), work))
      assert.deepEqual(await fs.readFile(file.filepath), site.hls.expected(`t${IDS.expiring}`))
      assert.equal(site.hits.expired, 1, 'the stale playlist link was tried once')
      // 1 stale + 1 good + the refreshes for 12 segments (and an init) signed for 4 requests each
      assert.ok((site.hits.mint ?? 0) >= 4, `minted ${site.hits.mint} times`)
    },
  )

  it(
    'DRM is refused as format-unavailable and never handed to yt-dlp, from the formats or from the playlist',
    T,
    async () => {
      const {site, source, work} = await setup('drm')
      const drm = await refusal(source.analyze(trackUrl('label-release')))
      assert.equal(drm.hint, 'format-unavailable')
      assert.match(drm.message, /DRM/)
      assert.equal(drm.details, undefined)
      assert.equal(site.hits.mint, undefined, 'nothing minted')
      const checks = await source.preflight([{url: trackUrl('label-release')}], {})
      assert.equal(checks.get(trackUrl('label-release'))?.ok, false)
      const sneaky = await refusal(source.download(task(trackUrl('sneaky-drm'), work)))
      assert.equal(sneaky.hint, 'format-unavailable')
      assert.equal(needsFallback(sneaky.details), false)
    },
  )

  it('a Go+ snippet is refused; a track with a preview and a whole format downloads the whole one', T, async () => {
    const {site, source, work} = await setup('snip')
    const snip = await refusal(source.analyze(trackUrl('go-plus')))
    assert.equal(snip.hint, 'format-unavailable')
    assert.match(snip.message, /preview/)
    assert.equal(snip.details, undefined)
    const file = await source.download(task(trackUrl('preview-and-full'), work))
    assert.equal(file.info.formatId, 'aac_96k/hls', 'the snipped 160k is passed over')
    assert.equal(site.hits.mint, 1)
    const stream = await refusal(source.download(task(trackUrl('preview-stream'), work)))
    assert.equal(stream.hint, 'format-unavailable', 'a minted preview is not saved as the track')
  })

  it('region-blocked, deleted, and formats nobody knows', T, async () => {
    const {source} = await setup('errors')
    assert.equal((await refusal(source.analyze(trackUrl('not-here')))).hint, 'geo-blocked')
    const gone = await refusal(source.analyze(trackUrl('no-such-track')))
    assert.equal(gone.hint, 'removed')
    assert.equal(gone.details, undefined)
    assert.equal((await refusal(source.analyze(trackUrl('odd-formats')))).details, SOURCE_FORMAT_CHANGED)
  })

  it('a private track opens with its secret link: the token in the resolve and in the mint', T, async () => {
    const {site, source, work} = await setup('secret')
    const without = await refusal(source.analyze(trackUrl('secret-demo')))
    assert.equal(without.hint, 'removed')
    assert.match(without.message, /private/)
    const url = trackUrl('secret-demo', SECRET)
    assert.equal(asTrack(await source.analyze(url)).media.url, url)
    const file = await source.download(task(url, work))
    assert.equal(path.extname(file.filepath), '.m4a')
    const mint = site.mints.at(-1)
    assert.equal(mint?.get('secret_token'), SECRET, 'the url already carried it: the rest appended with &')
    assert.equal(mint?.get('client_id'), HYDRATION_ID)
    assert.equal(mint?.get('track_authorization'), `jwt-${IDS.privateTrack}`)
  })

  it('legacy MP3: progressive first (one request, resumable), else the MP3 HLS assembled as .mp3', T, async () => {
    const {site, source, work} = await setup('legacy')
    const progressive = await source.download(
      task(trackUrl('old-upload'), work, {profile: {kind: 'audio', container: 'mp3'}}),
    )
    assert.equal(path.extname(progressive.filepath), '.mp3')
    assert.equal(progressive.info.formatId, 'mp3_0_0/progressive')
    assert.equal((await fs.stat(progressive.filepath)).size, 32 * 1024)
    assert.equal(site.hits.cdn, 1)
    const packed = await source.download(task(trackUrl('old-hls'), work))
    assert.equal(path.extname(packed.filepath), '.mp3')
    assert.deepEqual(await fs.readFile(packed.filepath), site.hls.expected(`t${IDS.hlsMp3}`))
  })

  it('a set: whole tracks as they are, stubs 50 a request, put back in the set’s order by id', T, async () => {
    const {site, source} = await setup('set')
    const list = asList(await source.analyze(BIG_SET, {maxEntries: 500}))
    const expected = [
      IDS.clear,
      IDS.low,
      3000,
      3001,
      3002,
      ...Array.from({length: SET_STUBS}, (_, i) => 3003 + i).filter(id => !REMOVED_STUBS.includes(id)),
    ].map(String)
    assert.deepEqual(
      list.entries.map(e => e.id),
      expected,
      'set order, the removed stub left out',
    )
    assert.deepEqual(
      list.entries.map(e => e.index),
      expected.map((_, i) => i + 1),
    )
    assert.equal(list.complete, true)
    assert.equal(list.total, 5 + SET_STUBS)
    assert.deepEqual(
      site.idRequests.map(q => (q.get('ids') ?? '').split(',').length),
      [50, 50, 20],
    )
    const capped = await setup('set-capped')
    const few = asList(await capped.source.analyze(BIG_SET, {maxEntries: 30}))
    assert.equal(few.entries.length, 29, 'the first 30 of the set, its removed stub (3007) left out')
    assert.equal(few.complete, false)
    assert.deepEqual(
      capped.site.idRequests.map(q => (q.get('ids') ?? '').split(',').length),
      [25],
      'only the stubs asked for',
    )
  })

  it('a private set: its stubs come with its id and secret token', T, async () => {
    const {site, source} = await setup('private-set')
    const list = asList(await source.analyze(`${ARTIST}/sets/private-set/${SET_SECRET}`))
    assert.deepEqual(
      list.entries.slice(-3).map(e => e.id),
      PRIVATE_STUBS.map(String),
    )
    assert.equal(site.idRequests[0]?.get('playlistId'), '801')
    assert.equal(site.idRequests[0]?.get('playlistSecretToken'), SET_SECRET)
  })

  it('a profile: next_href to its end through short pages; listed tracks are never read again', T, async () => {
    const {site, source, work} = await setup('profile')
    const list = asList(await source.analyze(ARTIST))
    assert.equal(list.entries.length, PROFILE_TRACKS)
    assert.equal(list.complete, true)
    assert.equal(list.total, PROFILE_TRACKS)
    assert.equal(new Set(list.entries.map(e => e.id)).size, PROFILE_TRACKS, 'no duplicates')
    assert.equal(site.hits.page, 3, '130 tracks in pages of 47 (50 asked)')
    assert.equal(site.hits.resolve, 1, 'the user only')
    // fillers (clear AAC): the profile's first tracks are the refused ones (DRM, Go+, a region block)
    const urls = list.entries.slice(-3).map(e => e.url)
    const checks = await source.preflight(
      urls.map(url => ({url})),
      {},
    )
    assert.ok(urls.every(url => checks.get(url)?.ok))
    await source.download(task(urls[0]!, work))
    assert.equal(site.hits.resolve, 1, 'checks and download read nothing more')
    assert.equal(site.hits.mint, 1)
  })

  it('maxEntries stops a profile early; known stops an incremental walk', T, async () => {
    const {site, source} = await setup('profile-known')
    const first = asList(await source.analyze(ARTIST, {maxEntries: 60}))
    assert.equal(first.entries.length, 60)
    assert.equal(first.complete, false)
    assert.equal(site.hits.page, 2)
    const known = new Set(first.entries.slice(5).map(e => e.id))
    const fresh = await setup('profile-known-2')
    const sync = asList(await fresh.source.analyze(ARTIST, {known}))
    assert.equal(sync.caughtUp, true)
    assert.ok(sync.entries.length < PROFILE_TRACKS, `stopped at ${sync.entries.length}`)
    assert.equal(fresh.site.hits.page, 1)
  })

  it('likes are the liked tracks (liked sets left out); sets and albums are their tracks, each once', T, async () => {
    const {source} = await setup('tabs')
    const likes = asList(await source.analyze(`${ARTIST}/likes`))
    assert.equal(likes.entries.length, 40)
    assert.equal(likes.title, 'SoundCloud The Artist · likes')
    const sets = asList(await source.analyze(`${ARTIST}/sets`, {maxEntries: 500}))
    assert.equal(sets.entries.length, 5 + SET_STUBS - REMOVED_STUBS.length, 'the same set twice lists its tracks once')
    const albums = asList(await source.analyze(`${ARTIST}/albums`, {maxEntries: 10}))
    assert.equal(albums.entries.length, 9, 'the first 10 tracks, the removed stub left out')
  })

  it('a short link: one 302, the sharer’s tracking left out of the resolve', T, async () => {
    const {site, source} = await setup('short')
    const track = asTrack(await source.analyze('https://on.soundcloud.com/AbCdEf123'))
    assert.equal(track.media.id, String(IDS.clear))
    assert.equal(site.hits.short, 1)
    const gone = await refusal(source.analyze('https://on.soundcloud.com/gone'))
    assert.equal(gone.hint, 'removed')
  })

  it('DataDome on a listing is source:blocked: yt-dlp takes SoundCloud for a while', T, async () => {
    const {source} = await setup('datadome', {hydrationId: HYDRATION_ID, datadome: true})
    const error = await refusal(source.analyze(ARTIST))
    assert.equal(error.details, SOURCE_BLOCKED)
    assert.equal(source.available, false)
  })

  it('in the engine: a track downloads as M4A; in a mix list a track is an item and a set a list', T, async () => {
    const site = await startFakeSoundcloud({hydrationId: HYDRATION_ID})
    cleanups.push(() => site.close())
    const engine = new MediaDownloader({
      dataDir: path.join(root, 'engine'),
      binaries: bins,
      validation: 'none',
      maxRetries: 1,
      retryDelayMaxMs: 20,
      progressIntervalMs: 0,
      tiktok: false,
      instagram: false,
      facebook: false,
      x: false,
      vk: false,
      snapchat: false,
      threads: false,
      bluesky: false,
      twitch: false,
      soundcloud: {
        endpoints: {api: site.api, web: site.origin, short: `${site.origin}/short`, assetHost: `${site.origin}/assets`},
        pacing: fast,
      },
    })
    cleanups.push(() => engine.dispose())
    const mix = await engine.analyzeMix(
      [`${trackUrl('clear-track')}?si=abc`, trackUrl('clear-track'), BIG_SET].join('\n'),
      {
        profile: m4a,
      },
    )
    assert.deepEqual(
      mix.valid.map(item => [item.line, item.site]),
      [[1, 'soundcloud']],
    )
    assert.deepEqual(
      mix.skipped.map(skip => [skip.line, skip.reason]),
      [
        [2, 'duplicate'],
        [3, 'listing'],
      ],
    )
    const out = path.join(root, 'engine-out')
    const job = engine.add({url: trackUrl('clear-track'), profile: m4a, outDir: out})
    const done = await new Promise<JobSnapshot>(resolve => {
      engine.on('job', snapshot => {
        if (snapshot.id === job.id && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) resolve(snapshot)
      })
    })
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(path.extname(done.filepath ?? ''), '.m4a')
  })
})
