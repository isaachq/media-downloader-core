import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {toExecutable} from '../src/binaries/executable.js'
import type {DownloadError} from '../src/core/errors.js'
import {isListingLink} from '../src/core/mix.js'
import {MediaDownloader} from '../src/downloader.js'
import {SOURCE_BLOCKED, SOURCE_FORMAT_CHANGED, type SourceDownload} from '../src/sources/source.js'
import {isTwitchListing, parseTwitchLink} from '../src/sources/twitch/links.js'
import {type TwitchOptions, TwitchSource} from '../src/sources/twitch/source.js'
import type {AnalysisResult, PlaylistAnalysis, VideoAnalysis} from '../src/types.js'
import {CHANNELS, SLUGS, startFakeTwitch, VODS, WEB_ID} from './helpers/fake-twitch.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 50} as const
const clip = (slug: string) => `https://clips.twitch.tv/${slug}`
const clips = (channel: string, range?: string) =>
  `https://www.twitch.tv/${channel}/clips${range ? `?range=${range}` : ''}`

describe('Twitch links', () => {
  it('recognizes clips, clip listings, VODs, video listings and channels', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['https://clips.twitch.tv/FaintLightGullWholeWheat', {kind: 'clip', slug: 'FaintLightGullWholeWheat'}],
      [
        'https://clips.twitch.tv/embed?clip=PreciousRelievedCodCorgiDerp-IqjaHMAL8JQQH78F&parent=example.com',
        {kind: 'clip', slug: 'PreciousRelievedCodCorgiDerp-IqjaHMAL8JQQH78F'},
      ],
      [
        'https://www.twitch.tv/shroud/clip/PreciousRelievedCodCorgiDerp-IqjaHMAL8JQQH78F?filter=clips&range=7d',
        {kind: 'clip', slug: 'PreciousRelievedCodCorgiDerp-IqjaHMAL8JQQH78F'},
      ],
      ['https://m.twitch.tv/clip/FaintLightGullWholeWheat', {kind: 'clip', slug: 'FaintLightGullWholeWheat'}],
      ['https://go.twitch.tv/EA/clip/FaintLightGullWholeWheat', {kind: 'clip', slug: 'FaintLightGullWholeWheat'}],
      ['https://www.twitch.tv/Shroud/clips', {kind: 'clips', channel: 'shroud', period: '7d'}],
      ['https://www.twitch.tv/shroud/clips?filter=clips&range=all', {kind: 'clips', channel: 'shroud', period: 'all'}],
      ['https://twitch.tv/shroud/clips?range=24hr', {kind: 'clips', channel: 'shroud', period: '24hr'}],
      ['https://www.twitch.tv/shroud/clips?range=1y', {kind: 'clips', channel: 'shroud', period: '7d'}],
      ['https://www.twitch.tv/videos/2602093345', {kind: 'vod', id: '2602093345'}],
      ['https://www.twitch.tv/videos/2602093345?t=1h2m3s', {kind: 'vod', id: '2602093345', start: 3723}],
      ['https://www.twitch.tv/shroud/v/2602093345', {kind: 'vod', id: '2602093345'}],
      ['https://player.twitch.tv/?video=v2602093345&parent=x', {kind: 'vod', id: '2602093345'}],
      ['https://www.twitch.tv/shroud/schedule?vodID=2602093345', {kind: 'vod', id: '2602093345'}],
      [
        'https://www.twitch.tv/shroud/videos?filter=highlights&sort=views',
        {kind: 'videos', channel: 'shroud', filter: 'highlights', sort: 'views'},
      ],
      ['https://www.twitch.tv/shroud/videos', {kind: 'videos', channel: 'shroud', filter: 'all', sort: 'time'}],
      ['https://www.twitch.tv/shroud', {kind: 'channel', channel: 'shroud'}],
    ]
    for (const [url, link] of cases) assert.deepEqual(parseTwitchLink(url), link, url)
  })

  it('leaves out what it does not read', () => {
    for (const url of [
      'https://www.twitch.tv/',
      'https://www.twitch.tv/directory/category/just-chatting',
      'https://www.twitch.tv/settings/profile',
      'https://www.twitch.tv/shroud/about',
      'https://www.twitch.tv/shroud/clip/',
      'https://clips.twitch.tv/a/b',
      'https://clips.twitch.tv/embed',
      'https://www.twitch.tv/videos/notanumber',
      'https://twitch.tv.evil.test/shroud/clips',
      'https://nottwitch.tv/shroud',
      'ftp://www.twitch.tv/shroud',
      'not a url',
    ]) {
      assert.equal(parseTwitchLink(url), undefined, url)
    }
  })

  it('clips and clip listings are read here; VODs and channels checked here; video listings go to yt-dlp', () => {
    const source = new TwitchSource()
    assert.equal(source.handles(clip(SLUGS.old)), true)
    assert.equal(source.handles(clips('shroud')), true)
    // TODO(core-hls): these become native once the core reads HLS
    // VODs and channels are checked here (a live one is never handed to yt-dlp); video listings are not
    assert.equal(source.handles('https://www.twitch.tv/videos/2602093345'), true)
    assert.equal(source.handles('https://www.twitch.tv/shroud'), true)
    assert.equal(source.handles('https://www.twitch.tv/shroud/videos'), false)
    assert.equal(isTwitchListing(clips('shroud')), true)
    assert.equal(isTwitchListing('https://www.twitch.tv/shroud/videos?filter=archives'), true)
    assert.equal(isTwitchListing(clip(SLUGS.old)), false)
    assert.equal(isListingLink(clips('shroud', '30d'), {defaultListSize: () => undefined}), true)
    assert.equal(source.defaultListSize(clips('shroud')), 500)
    assert.equal(source.defaultListSize(clip(SLUGS.old)), undefined)
  })
})

let root: string
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-twitch-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

async function setup(name: string, config: Parameters<typeof startFakeTwitch>[0] = {}, extra: TwitchOptions = {}) {
  const site = await startFakeTwitch(config)
  const options: TwitchOptions = {endpoints: {gql: site.gql}, pacing: fast, ...extra}
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
    bluesky: false,
    twitch: options,
  })
  cleanups.push(async () => {
    await engine.dispose()
    await site.close()
  })
  const work = path.join(root, name, 'work')
  await fs.mkdir(work, {recursive: true})
  return {site, engine, options, source: new TwitchSource(options), work}
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

describe('Twitch, end to end (local fake)', () => {
  it('a clip: one query, its H.264 1080p for MP4, the token’s HEVC 1440p for MKV, signed', {
    timeout: 5_000,
  }, async () => {
    const {site, source, work} = await setup('clip')
    const analysis = asVideo(await source.analyze(clip(SLUGS.good)))
    assert.equal(analysis.media.id, '3573895506', 'the numeric id, as yt-dlp records it')
    assert.equal(analysis.media.uploader, 'SHROUD')
    assert.equal(analysis.media.duration, 51)
    assert.equal(analysis.media.extractor, 'Twitch')
    const labels = analysis.choices.map(choice => choice.label)
    assert.ok(labels.includes('1440p · MKV · H.265'), labels.join(', '))
    assert.ok(labels.includes('1080p · MP4'), labels.join(', '))
    const file = await source.download(task(clip(SLUGS.good), work))
    assert.match(path.basename(file.filepath), /-h264-1080\.mp4$/)
    assert.equal(file.info.vcodec, 'avc1')
    assert.equal((await fs.stat(file.filepath)).size, 48 * 1024)
    const best = await source.download(task(clip(SLUGS.good), work, {profile: {kind: 'video', container: 'mkv'}}))
    assert.match(path.basename(best.filepath), /-h265-1440\.mp4$/)
    assert.equal(site.hits.clip, 1, 'the analysis read feeds both downloads')
    assert.equal(site.hits.denied, 0)
  })

  it('a 2016 clip: its one AVC file', {timeout: 5_000}, async () => {
    const {source, work} = await setup('old')
    const analysis = asVideo(await source.analyze(`https://www.twitch.tv/ea/clip/${SLUGS.old}`))
    assert.equal(analysis.media.id, '396245304')
    const file = await source.download(task(clip(SLUGS.old), work))
    assert.match(path.basename(file.filepath), /-h264-1080\.mp4$/)
  })

  it('a token that ran out: the download reads the clip again once and gets a new signature', {
    timeout: 5_000,
  }, async () => {
    const {site, source, work} = await setup('stale')
    await source.analyze(clip(SLUGS.stale))
    const file = await source.download(task(clip(SLUGS.stale), work))
    assert.ok(file.filepath.endsWith('.mp4'))
    assert.equal(site.hits.clip, 2)
    assert.ok(site.hits.denied >= 1)
  })

  it('a deleted clip is removed; a subscriber-only clip needs a sign-in', {timeout: 5_000}, async () => {
    const {source} = await setup('gone')
    await assert.rejects(source.analyze(clip(SLUGS.gone)), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'removed')
      return true
    })
    await assert.rejects(source.analyze(clip(SLUGS.forbidden)), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'needs-sign-in')
      assert.match(e.message, /UNAUTHORIZED_ENTITLEMENTS/)
      return true
    })
    await assert.rejects(source.analyze(clips('nosuchchannel')), (e: DownloadError) => {
      assert.equal(e.hint, 'removed')
      assert.match(e.message, /no Twitch channel/)
      return true
    })
  })

  it('a renamed field or a clip without encodings: source:format-changed, and the engine asks yt-dlp', {
    timeout: 5_000,
  }, async () => {
    const {source, engine} = await setup('changed')
    for (const slug of [SLUGS.changed, SLUGS.empty]) {
      await assert.rejects(source.analyze(clip(slug)), (e: DownloadError) => {
        assert.equal(e.details, SOURCE_FORMAT_CHANGED, slug)
        assert.match(e.message, /^Twitch: /)
        return true
      })
    }
    const fallback = await engine.analyze(clip(SLUGS.changed))
    assert.equal(fallback.kind === 'video' ? fallback.media.extractor : fallback.extractor, 'Fake')
  })

  it('a finished VOD goes to yt-dlp after one status request (HLS: TODO(core-hls)); a deleted one is removed', {
    timeout: 5_000,
  }, async () => {
    const {site, engine, source} = await setup('vod')
    const vod = await engine.analyze(`https://www.twitch.tv/videos/${VODS.recorded}`)
    assert.equal(vod.kind === 'video' ? vod.media.extractor : vod.extractor, 'Fake')
    assert.equal(site.hits.vod, 1)
    await assert.rejects(source.analyze(`https://www.twitch.tv/videos/${VODS.gone}`), (e: DownloadError) => {
      assert.equal(e.hint, 'removed')
      return true
    })
  })

  it('a VOD still on the air is live-now, natively: never handed to yt-dlp', {timeout: 5_000}, async () => {
    const {source, engine, work} = await setup('vod-live')
    const url = `https://www.twitch.tv/${CHANNELS.live}/v/${VODS.recording}`
    const isLive = (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'live-now')
      assert.equal(e.details, undefined, 'nothing for the engine to hand to yt-dlp')
      assert.match(e.message, /still on the air/)
      return true
    }
    await assert.rejects(source.analyze(url), isLive)
    await assert.rejects(engine.analyze(url), isLive)
    await assert.rejects(source.download(task(url, work)), isLive)
    const check = (await source.preflight([{url}], {})).get(url)
    assert.equal(check?.ok === false && check.error.hint, 'live-now')
  })

  it('a channel streaming now is live-now, natively: never handed to yt-dlp (it would record it)', {
    timeout: 5_000,
  }, async () => {
    const {source, engine, work} = await setup('channel-live')
    const url = `https://www.twitch.tv/${CHANNELS.live}`
    const isLive = (e: DownloadError) => {
      assert.equal(e.hint, 'live-now')
      assert.equal(e.details, undefined)
      assert.match(e.message, /live on Twitch right now/)
      return true
    }
    await assert.rejects(source.analyze(url), isLive)
    await assert.rejects(engine.analyze(url), isLive)
    await assert.rejects(source.download(task(url, work)), isLive)
    // an offline channel page has nothing to download either, and says so itself
    await assert.rejects(engine.analyze(`https://www.twitch.tv/${CHANNELS.mid}`), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.match(e.message, /not live/)
      return true
    })
    // live detection on its own, for the recorder to come
    assert.deepEqual(await source.liveStream('LiveOnAir'), {
      id: '320926770780',
      login: CHANNELS.live,
      title: 'On the air',
      startedAt: Date.parse('2026-10-26T20:59:27Z') / 1000,
      type: 'live',
    })
    assert.equal(await source.liveStream(CHANNELS.mid), undefined)
  })

  it('a channel’s clips: pages of 100 by the last edge’s cursor, the period from the link, signed in the page', {
    timeout: 5_000,
  }, async () => {
    const {site, source, work} = await setup('listing')
    const list = asList(await source.analyze(clips(CHANNELS.mid, '30d')))
    assert.equal(list.entries.length, 250)
    assert.equal(list.complete, true)
    assert.equal(list.extractor, 'Twitch')
    assert.match(list.title, /MIDCHANNEL · clips, last 30 days/)
    assert.equal(site.hits.page, 3)
    assert.deepEqual(
      site.pages.map(page => [page['filter'], page['after']]),
      [
        ['LAST_MONTH', undefined],
        ['LAST_MONTH', 'MTAw'],
        ['LAST_MONTH', 'MjAw'],
      ],
    )
    assert.equal(new Set(list.entries.map(entry => entry.id)).size, 250, 'no entry twice')
    // a listed clip is checked and downloaded without another query
    const url = list.entries[7]!.url
    const checks = await source.preflight([{url}], {})
    assert.equal(checks.get(url)?.ok, true)
    await source.download(task(url, work))
    assert.equal(site.hits.clip + site.hits.batch, 0)
    // the default period is the site's: a week
    await source.analyze(clips(CHANNELS.mid))
    assert.equal(site.pages.at(-1)?.['filter'], 'LAST_WEEK')
  })

  it('maxEntries stops early; Twitch stops at 1,000 whatever is asked; an empty period is an empty list', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('limits')
    const some = asList(await source.analyze(clips(CHANNELS.big, 'all'), {maxEntries: 120}))
    assert.equal(some.entries.length, 120)
    assert.equal(some.complete, false)
    assert.equal(site.hits.page, 2)
    const all = asList(await source.analyze(clips(CHANNELS.big, 'all'), {maxEntries: 5000}))
    assert.equal(all.entries.length, 1000)
    assert.equal(all.complete, true)
    const quiet = asList(await source.analyze(clips(CHANNELS.empty)))
    assert.equal(quiet.entries.length, 0)
    assert.equal(quiet.complete, true)
  })

  it('the web player’s client id: page 2 is an integrity check, what was listed is kept, yt-dlp takes over', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('integrity', {}, {clientId: WEB_ID})
    assert.equal(source.available, true)
    const list = asList(await source.analyze(clips(CHANNELS.mid, 'all')))
    assert.equal(list.entries.length, 100)
    assert.equal(list.complete, false)
    assert.equal(site.hits.page, 2)
    // clips go to yt-dlp for a while, asked nothing; the source stays up for live checks
    assert.equal(source.available, true)
    await assert.rejects(source.analyze(clip(SLUGS.good)), (e: DownloadError) => e.details === SOURCE_BLOCKED)
    assert.equal(site.hits.clip, 0)
    // the default client id reads every page
    const other = new TwitchSource({endpoints: {gql: site.gql}, pacing: fast})
    assert.equal(asList(await other.analyze(clips(CHANNELS.mid, 'all'))).entries.length, 250)
  })

  it('an integrity check with nothing listed yet is source:blocked: the engine asks yt-dlp', {
    timeout: 5_000,
  }, async () => {
    const {source, engine} = await setup('blocked')
    await assert.rejects(source.analyze(clips(CHANNELS.gated)), (e: DownloadError) => {
      assert.equal(e.details, SOURCE_BLOCKED)
      assert.equal(e.hint, 'retry-later')
      assert.match(e.message, /integrity check/)
      return true
    })
    const fallback = await engine.analyze(clips(CHANNELS.gated))
    assert.equal(fallback.kind === 'video' ? fallback.media.extractor : fallback.extractor, 'Fake')
    // while clips go to yt-dlp, a live channel is still checked here, never handed over
    await assert.rejects(engine.analyze(`https://www.twitch.tv/${CHANNELS.live}`), (e: DownloadError) => {
      assert.equal(e.hint, 'live-now')
      return true
    })
  })

  it('checks of clips not read yet: 15 a request, deleted ones removed, a listing link is no item', {
    timeout: 5_000,
  }, async () => {
    const {site, source} = await setup('batch')
    const urls = [
      ...Array.from({length: 18}, (_, i) => `https://www.twitch.tv/${CHANNELS.mid}/clip/Listed${i}-${CHANNELS.mid}`),
      clip(SLUGS.gone),
      clip(SLUGS.forbidden),
      // the same clip twice: asked once
      clip('Listed3-midchannel'),
      clips(CHANNELS.mid),
    ]
    const results = await source.preflight(
      urls.map(url => ({url})),
      {},
    )
    assert.equal(results.size, urls.length)
    assert.equal(site.hits.batch, 2)
    assert.deepEqual(
      site.batches.map(batch => batch.length),
      [15, 5],
    )
    assert.equal([...results.values()].filter(r => r.ok).length, 19)
    const gone = results.get(clip(SLUGS.gone))
    assert.equal(gone?.ok === false && gone.error.hint, 'removed')
    const locked = results.get(clip(SLUGS.forbidden))
    assert.equal(locked?.ok === false && locked.error.hint, 'needs-sign-in')
    assert.equal(results.get(clips(CHANNELS.mid))?.ok, false)
  })

  it('retries GraphQL after the shared cool-down when it refuses', {timeout: 5_000}, async () => {
    const {site, source} = await setup('refused', {refusals: 2})
    const analysis = asVideo(await source.analyze(clip(SLUGS.good)))
    assert.equal(analysis.media.id, '3573895506')
    assert.equal(site.hits.refused, 2)
  })

  it('analyze, checks and download of one clip at the same time make one query', {timeout: 5_000}, async () => {
    const {site, source, work} = await setup('coalesce')
    const url = clip(SLUGS.good)
    await Promise.all([source.analyze(url), source.download(task(url, work))])
    assert.equal(site.hits.clip, 1)
  })

  it('in a mix list: clips are items (tracking left out), a clips page is a list', {timeout: 5_000}, async () => {
    const {engine} = await setup('mix')
    const mix = await engine.analyzeMix(
      [
        `https://www.twitch.tv/shroud/clip/${SLUGS.good}?tt_medium=clips_web&tt_content=url`,
        `https://www.twitch.tv/shroud/clip/${SLUGS.good}`,
        clip(SLUGS.old),
        clips(CHANNELS.mid),
      ].join('\n'),
      {profile: mp4},
    )
    assert.deepEqual(
      mix.valid.map(item => [item.line, item.site]),
      [
        [1, 'twitch'],
        [3, 'twitch'],
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
