import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {setImmediate as tick} from 'node:timers/promises'
import {type Executable, toExecutable} from '../src/binaries/executable.js'
import {archiveKey} from '../src/core/archive.js'
import type {CookieRecord} from '../src/core/cookies.js'
import type {DownloadError} from '../src/core/errors.js'
import {isListingLink} from '../src/core/mix.js'
import {MediaDownloader} from '../src/downloader.js'
import {SESSION_REFUSED_MS} from '../src/sources/meta/client.js'
import {SOURCE_BLOCKED, SOURCE_FORMAT_CHANGED, type SourceDownload} from '../src/sources/source.js'
import {DEFAULT_CLIENT_ID} from '../src/sources/twitch/endpoints.js'
import {isTwitchListing, parseTwitchLink} from '../src/sources/twitch/links.js'
import {isTwitchAd, liveTitle, type TwitchOptions, TwitchSource} from '../src/sources/twitch/source.js'
import type {AnalysisResult, JobProgress, JobSnapshot, PlaylistAnalysis, VideoAnalysis} from '../src/types.js'
import {type FakeHls, LIVE_T0, startFakeHls, startFakeLive, writeCopyFfmpeg} from './helpers/fake-hls.js'
import {
  AUTH,
  CHANNELS,
  LIVE,
  LIVE_TRACKS,
  SLUGS,
  startFakeTwitch,
  VOD_TRACKS,
  VODS,
  WEB_ID,
} from './helpers/fake-twitch.js'
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

  it('clips, VODs and both listings are read here; channels checked here', () => {
    const source = new TwitchSource()
    assert.equal(source.handles(clip(SLUGS.old)), true)
    assert.equal(source.handles(clips('shroud')), true)
    assert.equal(source.handles('https://www.twitch.tv/videos/2602093345'), true)
    assert.equal(source.handles('https://www.twitch.tv/shroud'), true)
    assert.equal(source.handles('https://www.twitch.tv/shroud/videos'), true)
    assert.equal(source.defaultListSize('https://www.twitch.tv/shroud/videos?filter=archives'), 500)
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
let copy: Executable
const cleanups: Array<() => Promise<void>> = []
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-twitch-'))
  bins = await writeFakes(path.join(root, 'bin'))
  copy = await writeCopyFfmpeg(path.join(root, 'copy-ffmpeg'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

async function setup(name: string, config: Parameters<typeof startFakeTwitch>[0] = {}, extra: TwitchOptions = {}) {
  const hls: FakeHls = await startFakeHls({tracks: VOD_TRACKS})
  const live = await startFakeLive({tracks: LIVE_TRACKS})
  const site = await startFakeTwitch({...config, hls, live})
  // live recordings run on the live origin's simulated clock: each wait moves it, nothing waits in real time
  const options: TwitchOptions = {
    endpoints: {gql: site.gql, usher: site.usher},
    pacing: fast,
    ...extra,
    live: {
      emptyReloads: 3,
      now: () => LIVE_T0 + live.clock.now(),
      sleep: async (ms, signal) => {
        if (signal.aborted) return
        live.clock.advance(ms)
        await tick()
      },
      ...extra.live,
    },
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
    bluesky: false,
    twitch: options,
  })
  cleanups.push(async () => {
    await engine.dispose()
    await site.close()
    await hls.close()
    await live.close()
  })
  const work = path.join(root, name, 'work')
  await fs.mkdir(work, {recursive: true})
  let jobs = 0
  /** A fresh work folder per VOD download (core/hls resumes from what a folder holds). */
  const workDir = () => path.join(work, `job-${++jobs}`)
  return {site, hls, live, engine, options, source: new TwitchSource(options), work, workDir}
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

  it('a VOD still on the air is live-now, natively: never handed to yt-dlp', {timeout: 5_000}, async () => {
    const {site, source, engine, work} = await setup('vod-live')
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
    assert.equal(site.hits.usher, 0, 'usher is never asked for a broadcast on the air')
  })

  it('a channel streaming now: checked as live-now in a batch (a list never records); offline says so', {
    timeout: 5_000,
  }, async () => {
    const {source, engine} = await setup('channel-live')
    const url = `https://www.twitch.tv/${CHANNELS.live}`
    const check = (await source.preflight([{url}], {})).get(url)
    assert.equal(check?.ok === false && check.error.hint, 'live-now')
    assert.equal(check?.ok === false && check.error.details, undefined, 'nothing for the engine to hand to yt-dlp')
    assert.match(check?.ok === false ? check.error.message : '', /recorded from its channel link/)
    // an offline channel page has nothing to download, and says so itself
    await assert.rejects(engine.analyze(`https://www.twitch.tv/${CHANNELS.mid}`), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.match(e.message, /not live/)
      return true
    })
    // live detection on its own
    assert.deepEqual(await source.liveStream('LiveOnAir'), {
      id: '320926770780',
      login: CHANNELS.live,
      channelName: CHANNELS.live.toUpperCase(),
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
    // while clips go to yt-dlp, a live channel is still read here, never handed over
    const live = asVideo(await engine.analyze(`https://www.twitch.tv/${CHANNELS.live}`))
    assert.equal(live.media.extractor, 'Twitch')
    assert.equal(live.media.isLive, true)
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

describe('Twitch VODs and video listings, end to end (local fake + fake HLS origin)', () => {
  const vod = (id: string) => `https://www.twitch.tv/videos/${id}`
  const videos = (channel: string, query = '') => `https://www.twitch.tv/${channel}/videos${query}`
  const bytesOf = async (file: string) => fs.readFile(file)

  it('a finished VOD: one query and one usher request, its variants as choices, then segments only', {
    timeout: 10_000,
  }, async () => {
    const {site, hls, source, workDir} = await setup('vod-finished')
    const analysis = asVideo(await source.analyze(vod(VODS.recorded)))
    assert.equal(analysis.media.id, `v${VODS.recorded}`, 'recorded under yt-dlp’s id')
    assert.equal(analysis.media.duration, 12)
    assert.equal(analysis.media.extractor, 'Twitch')
    assert.equal(analysis.media.isLive, false)
    const labels = analysis.choices.map(choice => choice.label)
    assert.ok(labels.includes('1080p · MP4'), labels.join(', '))
    assert.deepEqual(
      [site.hits.vod, site.hits.token, site.hits.usher],
      [1, 0, 1],
      'the VOD and its token in one query, then usher',
    )
    assert.equal(site.ushers[0]?.codecs, 'av1,h265,h264', 'an analysis asks usher for every codec')
    const file = await source.download(task(vod(VODS.recorded), workDir(), {ffmpeg: copy}))
    assert.deepEqual(await bytesOf(file.filepath), hls.expected('rec'), 'the source variant, byte for byte, in order')
    assert.equal(file.info.id, `v${VODS.recorded}`)
    assert.equal(file.info.vcodec, 'avc1')
    assert.equal(file.info.duration, 12)
    assert.deepEqual(
      [site.hits.vod, site.hits.token, site.hits.usher],
      [1, 0, 1],
      'the analysis read feeds the download',
    )
    assert.equal(hls.count('/t/high/index.m3u8'), 0, 'a variant without sound is never chosen')
    assert.equal(hls.count('/t/rec/index.m3u8'), 1)
  })

  it('usher is asked for H.264 for an mp4 profile and for every codec otherwise; audio is the audio_only variant', {
    timeout: 10_000,
  }, async () => {
    const {site, hls, source, workDir} = await setup('vod-codecs')
    await source.download(task(vod(VODS.recorded), workDir(), {ffmpeg: copy}))
    assert.equal(site.ushers.at(-1)?.codecs, 'h264')
    const mkv = await source.download(
      task(vod(VODS.recorded), workDir(), {ffmpeg: copy, profile: {kind: 'video', container: 'mkv'}}),
    )
    assert.equal(site.ushers.at(-1)?.codecs, 'av1,h265,h264')
    assert.deepEqual(await bytesOf(mkv.filepath), hls.expected('rec'))
    const audio = await source.download(
      task(vod(VODS.recorded), workDir(), {ffmpeg: copy, profile: {kind: 'audio', container: 'm4a'}}),
    )
    assert.deepEqual(await bytesOf(audio.filepath), hls.expected('recaudio'))
    assert.equal(audio.info.vcodec, 'none')
    assert.equal(site.hits.vod, 1, 'one read of the VOD for every download')
    const capped = await source.download(
      task(vod(VODS.recorded), workDir(), {ffmpeg: copy, profile: {kind: 'video', container: 'mp4', maxHeight: 720}}),
    )
    assert.deepEqual(await bytesOf(capped.filepath), hls.expected('rec720'))
  })

  it('highlights and uploads are VODs too', {timeout: 10_000}, async () => {
    const {source} = await setup('vod-kinds')
    for (const id of [VODS.highlight, VODS.upload]) {
      const analysis = asVideo(await source.analyze(`https://www.twitch.tv/shroud/v/${id}`))
      assert.equal(analysis.media.id, `v${id}`)
      assert.ok(analysis.choices.length > 0)
    }
  })

  it('a muted VOD: its -unmuted parts are asked as -muted (no 403 on the way)', {timeout: 10_000}, async () => {
    const {hls, source, workDir} = await setup('vod-muted')
    const file = await source.download(task(vod(VODS.muted), workDir(), {ffmpeg: copy}))
    assert.deepEqual(await bytesOf(file.filepath), hls.expected('muted'))
    assert.equal(hls.count('/t/muted/s2-unmuted.ts'), 0)
    assert.equal(hls.count('/t/muted/s3-unmuted.ts'), 0)
    assert.equal(hls.count('/t/muted/s2-muted.ts'), 1)
  })

  it('a token running out mid-download: the refusal re-signs through a fresh token and usher, the same variant', {
    timeout: 10_000,
  }, async () => {
    const {site, hls, source, workDir} = await setup('vod-expiring')
    const file = await source.download(task(vod(VODS.expiring), workDir(), {ffmpeg: copy}))
    assert.deepEqual(await bytesOf(file.filepath), hls.expected('signed'), 'every segment once, in order')
    assert.ok(site.hits.token >= 1, `re-signed with a token of its own (${site.hits.token})`)
    assert.ok(site.hits.usher >= 2, `and a new master (${site.hits.usher} usher requests)`)
    assert.equal(hls.count('/t/high/index.m3u8'), 0)
    assert.ok(hls.count('/t/signed/index.m3u8') >= 2)
  })

  it('a subscriber-only VOD needs a sign-in (usher’s 403, or a forbidden token), and yt-dlp is not asked', {
    timeout: 10_000,
  }, async () => {
    const {source, engine, workDir} = await setup('vod-subs')
    const needsSignIn = (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'needs-sign-in')
      assert.equal(e.details, undefined)
      assert.match(e.message, /subscribers/)
      return true
    }
    await assert.rejects(source.analyze(vod(VODS.subsOnly)), needsSignIn)
    await assert.rejects(source.download(task(vod(VODS.subsOnly), workDir(), {ffmpeg: copy})), needsSignIn)
    await assert.rejects(source.analyze(vod(VODS.locked)), (e: DownloadError) => {
      needsSignIn(e)
      assert.match(e.message, /UNAUTHORIZED_ENTITLEMENTS/)
      return true
    })
    await assert.rejects(engine.analyze(vod(VODS.subsOnly)), needsSignIn)
  })

  it('a deleted VOD is removed (analysis, check and download)', {timeout: 10_000}, async () => {
    const {site, source, workDir} = await setup('vod-gone')
    const removed = (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'removed')
      return true
    }
    await assert.rejects(source.analyze(vod(VODS.gone)), removed)
    await assert.rejects(source.download(task(vod(VODS.gone), workDir(), {ffmpeg: copy})), removed)
    const check = (await source.preflight([{url: vod(VODS.gone)}], {})).get(vod(VODS.gone))
    assert.equal(check?.ok === false && check.error.hint, 'removed')
    assert.equal(site.hits.usher, 0)
  })

  it('a native failure (usher answers a page, not a playlist) hands the VOD to yt-dlp', {timeout: 10_000}, async () => {
    const {source, engine} = await setup('vod-broken')
    await assert.rejects(source.analyze(vod(VODS.broken)), (e: DownloadError) => {
      assert.equal(e.details, SOURCE_FORMAT_CHANGED)
      return true
    })
    const fallback = await engine.analyze(vod(VODS.broken))
    assert.equal(fallback.kind === 'video' ? fallback.media.extractor : fallback.extractor, 'Fake')
  })

  it('a VOD that says RECORDED but whose playlist is still open is live-now, never handed to yt-dlp', {
    timeout: 10_000,
  }, async () => {
    const {hls, source, workDir} = await setup('vod-racing')
    const isLive = (e: DownloadError) => {
      assert.equal(e.hint, 'live-now')
      assert.equal(e.details, undefined, 'nothing for the engine to hand to yt-dlp')
      return true
    }
    await assert.rejects(source.download(task(vod(VODS.racing), workDir(), {ffmpeg: copy})), isLive)
    assert.equal(hls.segmentRequests('open'), 0, 'no segment asked')
  })

  it('a channel’s videos: pages of 100 by the page’s cursor, filter and sort from the link, listed VODs never read again', {
    timeout: 10_000,
  }, async () => {
    const {site, hls, source, workDir} = await setup('videos')
    const list = asList(await source.analyze(videos(CHANNELS.mid)))
    assert.equal(list.entries.length, 250)
    assert.equal(list.total, 250)
    assert.equal(list.complete, true)
    assert.match(list.title, /MIDCHANNEL · videos/)
    assert.equal(site.hits.videoPage, 3)
    const afters = site.videoPages.map(page => page['after'])
    assert.equal(afters[0], undefined)
    assert.match(String(afters[1]), /^\d+\|100\|2026-[\d-]+T[\d:]+Z\|\d+$/, 'the cursor as Twitch writes it')
    assert.match(String(afters[2]), /^\d+\|200\|/)
    assert.deepEqual(
      site.videoPages.map(page => [page['sort'], page['type']]),
      [
        ['TIME', undefined],
        ['TIME', undefined],
        ['TIME', undefined],
      ],
    )
    assert.equal(new Set(list.entries.map(entry => entry.id)).size, 250, 'no entry twice')
    assert.ok(list.entries.every(entry => entry.id.startsWith('v')))
    // the newest is still recording: listed as live (the engine skips it), live-now when asked for
    const recording = list.entries[0]!
    assert.equal(recording.isLive, true)
    assert.equal(list.entries[1]!.isLive, false)
    // a listed VOD: checked from the listing, downloaded with its token alone
    const url = list.entries[5]!.url
    const checks = await source.preflight([{url}, {url: recording.url}], {})
    assert.equal(checks.get(url)?.ok, true)
    const live = checks.get(recording.url)
    assert.equal(live?.ok === false && live.error.hint, 'live-now')
    assert.deepEqual([site.hits.vod, site.hits.vodBatch, site.hits.token, site.hits.usher], [0, 0, 0, 0])
    const file = await source.download(task(url, workDir(), {ffmpeg: copy}))
    assert.deepEqual(await bytesOf(file.filepath), hls.expected('rec'))
    assert.deepEqual(
      [site.hits.vod, site.hits.token, site.hits.usher],
      [0, 1, 1],
      'its token, its master, nothing else',
    )
    await assert.rejects(source.download(task(recording.url, workDir(), {ffmpeg: copy})), (e: DownloadError) => {
      assert.equal(e.hint, 'live-now')
      assert.equal(e.details, undefined)
      return true
    })
    assert.equal(site.hits.usher, 1, 'never asked for the recording one')
    // filter and sort from the link
    const highlights = asList(await source.analyze(videos(CHANNELS.mid, '?filter=highlights&sort=views')))
    assert.equal(highlights.entries.length, 25)
    assert.deepEqual([site.videoPages.at(-1)?.['type'], site.videoPages.at(-1)?.['sort']], ['HIGHLIGHT', 'VIEWS'])
    assert.match(highlights.title, /highlights, most viewed/)
    const uploads = asList(await source.analyze(videos(CHANNELS.mid, '?filter=uploads')))
    assert.equal(site.videoPages.at(-1)?.['type'], 'UPLOAD')
    assert.equal(uploads.entries.length, 25)
  })

  it('a videos listing: maxEntries, an incremental walk that stops at known VODs, an empty channel, one not there', {
    timeout: 10_000,
  }, async () => {
    const {site, source} = await setup('videos-limits')
    const some = asList(await source.analyze(videos(CHANNELS.mid), {maxEntries: 120}))
    assert.equal(some.entries.length, 120)
    assert.equal(some.complete, false)
    assert.equal(site.hits.videoPage, 2)
    const known = new Set(some.entries.slice(3, 60).map(entry => entry.id))
    const fresh = new TwitchSource({endpoints: {gql: site.gql, usher: site.usher}, pacing: fast})
    const newer = asList(await fresh.analyze(videos(CHANNELS.mid), {known}))
    assert.equal(newer.caughtUp, true)
    assert.equal(newer.entries.length, 100, 'the walk stops at the end of the page the known run is in')
    assert.equal(site.hits.videoPage, 3, 'one page, not three')
    assert.equal(asList(await source.analyze(videos(CHANNELS.empty))).entries.length, 0)
    await assert.rejects(source.analyze(videos('nosuchchannel')), (e: DownloadError) => e.hint === 'removed')
  })

  it('checks of VODs not read yet: 15 a request, a recording one live-now, a deleted one removed', {
    timeout: 10_000,
  }, async () => {
    const {site, source} = await setup('vod-batch')
    const ids = Array.from({length: 16}, (_, i) => String(3_000_000_000 + 248 - i))
    const urls = [...ids.map(vod), vod(VODS.recording), vod(VODS.gone), videos(CHANNELS.mid)]
    const results = await source.preflight(
      urls.map(url => ({url})),
      {},
    )
    assert.equal(results.size, urls.length)
    assert.deepEqual(
      site.vodBatches.map(batch => batch.length),
      [15, 3],
    )
    assert.equal([...results.values()].filter(result => result.ok).length, 16)
    const live = results.get(vod(VODS.recording))
    assert.equal(live?.ok === false && live.error.hint, 'live-now')
    const gone = results.get(vod(VODS.gone))
    assert.equal(gone?.ok === false && gone.error.hint, 'removed')
    assert.equal(results.get(videos(CHANNELS.mid))?.ok, false, 'a listing link is no item')
    assert.equal(site.hits.usher, 0, 'checks never ask usher')
  })
})

describe('Twitch live channels, recorded (fake GraphQL + usher + live origin on a simulated clock)', () => {
  const channel = (login: string) => `https://www.twitch.tv/${login}`
  /** A stop that fires once `n` segments are in. */
  const stopAfter = (n: number) => {
    const stop = new AbortController()
    const progress: JobProgress[] = []
    return {
      stop,
      progress,
      onProgress: (p: JobProgress) => {
        progress.push(p)
        if ((p.fragmentIndex ?? 0) >= n) stop.abort()
      },
    }
  }

  it('a channel on the air: one live item (1 query, 1 usher request); recorded from the window, then stop keeps it', {
    timeout: 5_000,
  }, async () => {
    const {site, live, source, workDir} = await setup('live-record')
    const analysis = asVideo(await source.analyze(channel(LIVE.onAir)))
    assert.equal(analysis.media.isLive, true)
    assert.equal(analysis.media.id, 'live-320926770780')
    assert.equal(analysis.media.url, channel(LIVE.onAir))
    assert.match(analysis.media.title, /^LIVEONAIR \d{4}-\d\d-\d\d \d\d-\d\d On the air$/)
    const labels = analysis.choices.map(choice => choice.label)
    assert.ok(labels.includes('1080p · MP4'), labels.join(', '))
    assert.deepEqual([site.hits.live, site.hits.liveUsher], [1, 1])

    const {stop, progress, onProgress} = stopAfter(9)
    let info: unknown
    const file = await source.download(
      task(channel(LIVE.onAir), workDir(), {
        profile: {kind: 'video', container: 'mkv'},
        ffmpeg: copy,
        stop: stop.signal,
        onProgress,
        onInfo: next => {
          info = next
        },
      }),
    )
    assert.deepEqual(
      [site.hits.live, site.hits.liveUsher],
      [1, 1],
      'the analysis read (stream, token, master) feeds the recording',
    )
    assert.deepEqual(await fs.readFile(file.filepath), live.expected(LIVE.onAir, 0, 9), 'the window, then what came')
    assert.equal(file.recording?.ended, 'stopped')
    assert.equal(file.recording?.seconds, 18)
    assert.equal(file.info.duration, 18, 'the duration the file is checked against')
    assert.equal(file.info.vcodec, 'avc1')
    const stream = {
      id: '320926770780',
      login: CHANNELS.live,
      channelName: CHANNELS.live.toUpperCase(),
      title: 'On the air',
      startedAt: Date.parse('2026-10-26T20:59:27Z') / 1000,
      type: 'live',
    }
    assert.equal(file.info.title, liveTitle(stream, 0), '<channel> <started-at> <title>')
    assert.match(String(file.info.id), /^live-320926770780-\d+$/)
    assert.equal((info as {title?: string}).title, file.info.title, 'named before the first segment')
    assert.equal(file.tags?.comment, channel(LIVE.onAir))
    assert.ok(progress.length > 0 && progress.every(p => p.live === true && p.fraction === undefined))
    assert.equal(site.liveUshers[0], 'av1,h265,h264')
  })

  it('an mp4 profile asks usher for H.264; audio records the audio_only variant', {timeout: 5_000}, async () => {
    const {site, live, source, workDir} = await setup('live-codecs')
    const a = stopAfter(3)
    await source.download(
      task(channel(LIVE.onAir), workDir(), {ffmpeg: copy, stop: a.stop.signal, onProgress: a.onProgress}),
    )
    assert.equal(site.liveUshers.at(-1), 'h264')
    const b = stopAfter(3)
    const sound = await source.download(
      task(channel(LIVE.onAir), workDir(), {
        profile: {kind: 'audio', container: 'm4a'},
        ffmpeg: copy,
        fresh: true,
        stop: b.stop.signal,
        onProgress: b.onProgress,
      }),
    )
    assert.ok(live.segmentRequests(`${LIVE.onAir}~audio`) >= 3, 'the audio_only variant')
    assert.equal(sound.info.vcodec, 'none')
  })

  it('ads: segments titled "Amazon|…" and those inside a twitch-stitched-ad date range are left out, their seconds counted', {
    timeout: 5_000,
  }, async () => {
    const {live, source, workDir} = await setup('live-ads')
    const file = await source.download(task(channel(LIVE.ads), workDir(), {ffmpeg: copy}))
    assert.equal(file.recording?.ended, 'endlist')
    assert.equal(file.recording?.skippedSeconds, 10, '3 titled + 2 dated segments of 2 s')
    const ads = new Set([8, 9, 10, 14, 15])
    assert.deepEqual(await fs.readFile(file.filepath), live.expected(LIVE.ads, 0, 20, ads))
    assert.equal(live.count(`/l/${LIVE.ads}/s9.ts`), 0, 'an ad is never asked')
    assert.equal(file.recording?.gaps, 0, 'an ad is not a gap')

    // skipAds: false keeps them
    const {options, live: live2, workDir: dir2} = await setup('live-ads-kept')
    const withAds = new TwitchSource({...options, live: {...options.live, skipAds: false}})
    const all = await withAds.download(task(channel(LIVE.ads), dir2(), {ffmpeg: copy}))
    assert.equal(all.recording?.skippedSeconds, 0)
    assert.equal(all.recording?.seconds, 40)
    assert.deepEqual(await fs.readFile(all.filepath), live2.expected(LIVE.ads, 0, 20))
  })

  it('isTwitchAd: a title other than "live", or a date inside a stitched-ad range (end excluded)', () => {
    const segment = (title: string | undefined, date: number | undefined) =>
      ({
        index: 0,
        sequence: 0,
        uri: 'x',
        duration: 2,
        period: 0,
        discontinuity: 0,
        key: -1,
        gap: false,
        title,
        programDateTime: date,
      }) as const
    const playlist = {
      dateRanges: [{id: 'stitched-ad-1', class: 'twitch-stitched-ad', startDate: 1000, duration: 4, attributes: {}}],
    } as unknown as Parameters<typeof isTwitchAd>[1]
    assert.equal(isTwitchAd(segment('Amazon|123', undefined), playlist), true)
    assert.equal(isTwitchAd(segment('live', 999), playlist), false)
    assert.equal(isTwitchAd(segment('live', 1000), playlist), true)
    assert.equal(isTwitchAd(segment(undefined, 4999), playlist), true)
    assert.equal(isTwitchAd(segment('live', 5000), playlist), false)
  })

  it('a token running out: the 403 re-signs through a new query and usher (the same quality), no gap', {
    timeout: 5_000,
  }, async () => {
    const {site, live, source, workDir} = await setup('live-refresh')
    const file = await source.download(task(channel(LIVE.expiring), workDir(), {ffmpeg: copy}))
    assert.equal(file.recording?.ended, 'endlist')
    assert.ok((file.recording?.refreshes ?? 0) >= 2, `refreshes: ${file.recording?.refreshes}`)
    assert.equal(file.recording?.gaps, 0)
    assert.deepEqual(await fs.readFile(file.filepath), live.expected(LIVE.expiring, 0, 20))
    assert.equal(site.hits.live, 1 + (file.recording?.refreshes ?? 0), 'one query per refresh')
    assert.equal(site.hits.liveUsher, 1 + (file.recording?.refreshes ?? 0), 'one usher request per refresh')
  })

  it('the broadcast ends (ENDLIST): the recording ends with it, kept', {timeout: 5_000}, async () => {
    const {live, source, workDir} = await setup('live-ending')
    const file = await source.download(task(channel(LIVE.ending), workDir(), {ffmpeg: copy}))
    assert.equal(file.recording?.ended, 'endlist')
    assert.deepEqual(await fs.readFile(file.filepath), live.expected(LIVE.ending, 0, 10))
  })

  it('an offline channel: nothing to record; a channel going offline mid-recording ends it, kept', {
    timeout: 5_000,
  }, async () => {
    const {site, live, source, workDir} = await setup('live-offline')
    await assert.rejects(
      source.download(task(channel(CHANNELS.mid), workDir(), {ffmpeg: copy})),
      (e: DownloadError) => {
        assert.equal(e.code, 'unavailable')
        assert.match(e.message, /not live/)
        assert.equal(e.details, undefined)
        return true
      },
    )
    assert.equal(site.hits.liveUsher, 0, 'usher is not asked for a channel off the air')
    // the stream stops growing at segment 9 and the channel leaves the air: three empty reloads end it
    live.update(LIVE.onAir, {...LIVE_TRACKS[LIVE.onAir], stopAfter: 9})
    const file = await source.download(
      task(channel(LIVE.onAir), workDir(), {
        ffmpeg: copy,
        onProgress: p => {
          if ((p.fragmentIndex ?? 0) >= 9) site.setOnAir(LIVE.onAir, false)
        },
      }),
    )
    assert.equal(file.recording?.ended, 'offline')
    assert.deepEqual(await fs.readFile(file.filepath), live.expected(LIVE.onAir, 0, 9))
  })

  it('a token refused after the channel left the air: the refresh finds it offline and the recording ends, kept', {
    timeout: 5_000,
  }, async () => {
    const {site, live, source, workDir} = await setup('live-offline-refresh')
    const file = await source.download(
      task(channel(LIVE.expiring), workDir(), {
        ffmpeg: copy,
        onProgress: p => {
          if ((p.fragmentIndex ?? 0) >= 3) site.setOnAir(LIVE.expiring, false)
        },
      }),
    )
    assert.equal(file.recording?.ended, 'offline')
    assert.equal(file.recording?.refreshes, 1)
    assert.ok((file.recording?.segments ?? 0) >= 3)
    assert.deepEqual(await fs.readFile(file.filepath), live.expected(LIVE.expiring, 0, file.recording?.segments ?? 0))
  })

  it('a native failure on a live channel is never handed to yt-dlp (it would record the stream itself)', {
    timeout: 5_000,
  }, async () => {
    const {source, engine, work} = await setup('live-broken')
    await assert.rejects(
      source.download(task(channel(LIVE.broken), path.join(work, 'b'), {ffmpeg: copy})),
      (e: DownloadError) => {
        assert.equal(e.details, undefined, 'no source:format-changed: the engine keeps it native')
        return true
      },
    )
    const out = path.join(root, 'live-broken', 'out')
    const job = engine.add({url: channel(LIVE.broken), profile: mp4, outDir: out})
    await engine.whenIdle()
    const done = engine.job(job.id)!
    assert.equal(done.status, 'failed')
    assert.ok(
      done.attempts.every(a => a.strategy !== 'extractor-fallback'),
      `never yt-dlp: ${done.attempts.map(a => a.strategy)}`,
    )
  })

  it('through the engine: Stop finalizes, validates and archives the recording; Cancel discards another', {
    timeout: 5_000,
  }, async () => {
    const {engine, work} = await setup('live-engine')
    const out = path.join(root, 'live-engine', 'out')
    const job = engine.add({url: channel(LIVE.onAir), profile: mp4, outDir: out})
    let stopped = false
    let sawLive: JobProgress | undefined
    engine.on('job', snapshot => {
      if (snapshot.id !== job.id || !snapshot.progress.live) return
      sawLive = snapshot.progress
      if (!stopped && (snapshot.progress.fragmentIndex ?? 0) >= 7) stopped = engine.stop(job.id)
    })
    await engine.whenIdle()
    const done = engine.job(job.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(stopped, true, 'stop() took')
    assert.equal(sawLive?.live, true)
    assert.equal(sawLive?.fraction, undefined)
    assert.ok((sawLive?.elapsedSec ?? 0) > 0 && (sawLive?.bytes ?? 0) > 0)
    const files = await fs.readdir(out)
    assert.equal(files.length, 1, files.join(', '))
    assert.match(files[0] ?? '', /^LIVEONAIR-\d{4}-\d\d-\d\d-\d\d-\d\d-On-the-air-live-320926770780-\d+\.mp4$/)
    const steps = new Map(done.steps.map(step => [step.name, step.state]))
    assert.equal(steps.get('finalize'), 'success')
    const archived = await engine.archive.find(archiveKey('Twitch', done.mediaId ?? '', mp4))
    assert.ok(archived, 'archived under the recording’s own id')
    assert.equal(engine.stop(job.id), false, 'a finished job does not stop again')

    const out2 = path.join(root, 'live-engine', 'out2')
    const second = engine.add({url: channel(LIVE.ads), profile: mp4, outDir: out2})
    engine.on('job', snapshot => {
      if (snapshot.id === second.id && (snapshot.progress.fragmentIndex ?? 0) >= 3) engine.cancel(second.id)
    })
    await engine.whenIdle()
    assert.equal(engine.job(second.id)?.status, 'cancelled')
    assert.deepEqual(await fs.readdir(out2).catch(() => []), [], 'nothing kept')
    const left = (await fs.readdir(work, {recursive: true})).filter(name => String(name).includes('hls'))
    assert.deepEqual(left, [], 'the cancelled recording’s folder is gone')
  })
})

describe('Twitch sign-in, live playback and how a recording ended (local fake)', () => {
  const vod = (id: string) => `https://www.twitch.tv/videos/${id}`
  const channel = (login: string) => `https://www.twitch.tv/${login}`
  const listedVod = 'https://www.twitch.tv/videos/3000000100'
  const TOKEN_OPS = new Set(['Clip', 'Vod', 'VodToken', 'LiveStream'])
  const refusals = (warnings: readonly string[]) => warnings.filter(w => /signed-in session was refused/.test(w)).length

  /** A source whose host session holds the .twitch.tv auth-token `token()` (none while undefined). */
  const withSession = async (name: string, token: () => string | undefined, extra: TwitchOptions = {}) => {
    const asked = {count: 0}
    const warnings: string[] = []
    const made = await setup(name, {}, extra)
    const source = new TwitchSource({
      ...made.options,
      cookies: async (): Promise<readonly CookieRecord[] | undefined> => {
        asked.count++
        const value = token()
        return value === undefined ? undefined : [{name: 'auth-token', value, domain: '.twitch.tv'}]
      },
      log: (level, message) => {
        if (level === 'warn') warnings.push(message)
      },
    })
    return {...made, source, asked, warnings}
  }

  it('the auth-token goes only on the reads that mint a playback token, on the web player’s id; listings and checks stay anonymous', {
    timeout: 10_000,
  }, async () => {
    const {site, source, asked, workDir} = await withSession('auth-scope', () => AUTH.sub)
    asList(await source.analyze(clips(CHANNELS.mid), {maxEntries: 150}))
    asList(await source.analyze(`https://www.twitch.tv/${CHANNELS.mid}/videos`, {maxEntries: 120}))
    await source.preflight(
      [{url: clip(SLUGS.old)}, {url: vod(VODS.highlight)}, {url: channel(CHANNELS.mid)}, {url: listedVod}],
      {},
    )
    asVideo(await source.analyze(clip(SLUGS.good)))
    asVideo(await source.analyze(vod(VODS.recorded)))
    // a listed VOD: only its token is read at download
    await source.download(task(listedVod, workDir(), {ffmpeg: copy}))
    asVideo(await source.analyze(channel(LIVE.onAir)))

    const ops = new Set(site.requests.map(r => r.op))
    const every = ['ChannelClips', 'ChannelVideos', 'Clips', 'Vods', 'ChannelStream', ...TOKEN_OPS]
    for (const op of every) assert.ok(ops.has(op), `${op} was asked (${[...ops].join(', ')})`)
    for (const r of site.requests) {
      if (TOKEN_OPS.has(r.op)) {
        assert.equal(r.auth, `OAuth ${AUTH.sub}`, `${r.op} is signed`)
        assert.equal(r.clientId, WEB_ID, `${r.op} on the web player’s id`)
      } else {
        assert.equal(r.auth, undefined, `${r.op} is anonymous`)
        assert.equal(r.clientId, DEFAULT_CLIENT_ID, `${r.op} on yt-dlp’s id`)
      }
    }
    assert.equal(site.hits.unauthorized, 0)
    assert.equal(asked.count, 1, 'the host’s cookies are read once (then every 6 h)')
  })

  it('subscribed: a subscriber-only VOD (usher’s 403, a forbidden token) and a forbidden clip download', {
    timeout: 10_000,
  }, async () => {
    const {source, work, workDir} = await withSession('auth-sub', () => AUTH.sub)
    assert.ok(asVideo(await source.analyze(vod(VODS.subsOnly))).choices.length > 0)
    const file = await source.download(task(vod(VODS.subsOnly), workDir(), {ffmpeg: copy}))
    assert.ok((await fs.stat(file.filepath)).size > 0)
    asVideo(await source.analyze(vod(VODS.locked)))
    const clipped = await source.download(task(clip(SLUGS.forbidden), work))
    assert.ok((await fs.stat(clipped.filepath)).size > 0)
  })

  it('signing in after a visitor’s read: a forbidden clip passes its check and downloads; a subscriber-only VOD is signed once more', {
    timeout: 10_000,
  }, async () => {
    let token: string | undefined
    const {site, source, work, workDir} = await withSession('auth-later', () => token)
    await assert.rejects(source.analyze(clip(SLUGS.forbidden)), (e: DownloadError) => e.hint === 'needs-sign-in')
    await assert.rejects(source.analyze(vod(VODS.subsOnly)), (e: DownloadError) => e.hint === 'needs-sign-in')
    assert.equal(site.hits.signed, 0, 'nothing signed without a session')
    const before = {clip: site.hits.clip, token: site.hits.token}
    token = AUTH.sub
    const checks = await source.preflight([{url: clip(SLUGS.forbidden)}], {})
    assert.equal(checks.get(clip(SLUGS.forbidden))?.ok, true, 'signed in, the check lets it through')
    await source.download(task(clip(SLUGS.forbidden), work))
    assert.equal(site.hits.clip, before.clip + 1, 'one signed read of the clip')
    await source.download(task(vod(VODS.subsOnly), workDir(), {ffmpeg: copy}))
    assert.equal(site.hits.token, before.token + 1, 'one signed token for the VOD')
  })

  it('signed in without access: members-only (not needs-sign-in), and yt-dlp is not asked', {
    timeout: 10_000,
  }, async () => {
    const {source, workDir} = await withSession('auth-free', () => AUTH.free)
    const membersOnly = (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'members-only', e.message)
      assert.equal(e.details, undefined)
      assert.match(e.message, /signed-in Twitch account has no access/)
      return true
    }
    await assert.rejects(source.analyze(vod(VODS.locked)), membersOnly)
    await assert.rejects(source.analyze(vod(VODS.subsOnly)), membersOnly)
    await assert.rejects(source.download(task(vod(VODS.subsOnly), workDir(), {ffmpeg: copy})), membersOnly)
    await assert.rejects(source.analyze(clip(SLUGS.forbidden)), membersOnly)
  })

  it('a refused session (401): dropped, told once, the read retried anonymously; anonymous for the window, asked again after it', {
    timeout: 10_000,
  }, async () => {
    let now = 1_000_000
    const {site, source, asked, warnings} = await withSession('auth-stale', () => AUTH.stale, {now: () => now})
    asVideo(await source.analyze(clip(SLUGS.good)))
    assert.deepEqual(
      site.requests.map(r => [r.op, r.auth !== undefined]),
      [
        ['Clip', true],
        ['Clip', false],
      ],
      'one signed try, then the same read anonymously',
    )
    assert.equal(site.hits.unauthorized, 1)
    assert.equal(refusals(warnings), 1, warnings.join('\n'))
    // inside the window: anonymous, the host is not asked, nothing refused again
    asVideo(await source.analyze(vod(VODS.recorded)))
    await assert.rejects(source.analyze(vod(VODS.subsOnly)), (e: DownloadError) => e.hint === 'needs-sign-in')
    assert.equal(site.hits.signed, 1, 'no signed read inside the window')
    assert.equal(asked.count, 1)
    // the window is over: the host's cookies are asked for again (refused again, told again)
    now += SESSION_REFUSED_MS + 1
    asVideo(await source.analyze(vod(VODS.highlight)))
    assert.equal(asked.count, 2)
    assert.equal(site.hits.unauthorized, 2)
    assert.equal(refusals(warnings), 2)
  })

  it('reads refused at the same time are told once, each retried once', {timeout: 10_000}, async () => {
    const {site, source, warnings} = await withSession('auth-stale-many', () => AUTH.stale)
    const ids = [VODS.recorded, VODS.highlight, VODS.upload]
    await Promise.all(ids.map(id => source.analyze(vod(id))))
    assert.equal(site.hits.unauthorized, site.hits.signed)
    assert.ok(site.hits.signed <= ids.length, `at most one signed try per read in flight (${site.hits.signed})`)
    assert.equal(site.hits.vod, ids.length, 'each read answered once, anonymously')
    assert.equal(refusals(warnings), 1)
  })

  it('livePlayback: the signed H.264 master url from the analysis’ read (no extra query, no usher request); undefined off the air', {
    timeout: 10_000,
  }, async () => {
    const {site, source, engine, workDir} = await withSession('live-playback', () => AUTH.sub)
    asVideo(await source.analyze(channel(LIVE.onAir)))
    assert.deepEqual([site.hits.live, site.hits.liveUsher], [1, 1])
    const playback = await source.livePlayback(channel(LIVE.onAir))
    assert.ok(playback, 'on the air')
    assert.deepEqual([site.hits.live, site.hits.liveUsher], [1, 1], 'the kept read; usher is not asked')
    const url = new URL(playback.url)
    assert.equal(url.origin + url.pathname, `${site.usher}/api/channel/hls/${LIVE.onAir}.m3u8`)
    assert.equal(url.searchParams.get('supported_codecs'), 'h264')
    assert.match(url.searchParams.get('sig') ?? '', /^ssig-/)
    assert.equal(playback.media.isLive, true)
    assert.equal(playback.media.id, 'live-320926770780')
    assert.ok((playback.expiresAt ?? 0) > Date.now())
    const master = await fetch(playback.url, {signal: AbortSignal.timeout(2_000)})
    assert.equal(master.status, 200, 'the url is signed')
    assert.match(await master.text(), /^#EXTM3U/)
    // a recording right after shares the same read
    const stop = new AbortController()
    await source.download(
      task(channel(LIVE.onAir), workDir(), {
        ffmpeg: copy,
        stop: stop.signal,
        onProgress: p => {
          if ((p.fragmentIndex ?? 0) >= 2) stop.abort()
        },
      }),
    )
    assert.equal(site.hits.live, 1, 'one query served the analysis, the player and the recording')
    await source.livePlayback(channel(LIVE.onAir), {fresh: true})
    assert.equal(site.hits.live, 2, 'fresh reads again')
    assert.ok(site.requests.filter(r => r.op === 'LiveStream').every(r => r.auth === `OAuth ${AUTH.sub}`))

    assert.equal(await source.livePlayback(channel(CHANNELS.mid)), undefined, 'off the air')
    assert.equal(await source.livePlayback(clip(SLUGS.good)), undefined, 'not a channel')
    assert.ok(await engine.livePlayback(channel(LIVE.onAir)), 'through the engine')
    assert.equal(await engine.livePlayback('https://example.com/live'), undefined, 'no source plays it live')
  })

  it('JobSnapshot.recording says how a recording ended (stopped, max-duration, offline, endlist), its gaps and the ads left out', {
    timeout: 10_000,
  }, async () => {
    /** One recording through the engine; `during` may stop it or take the channel off the air. */
    const record = async (
      name: string,
      login: string,
      extra: TwitchOptions = {},
      during?: (made: Awaited<ReturnType<typeof setup>>, snapshot: JobSnapshot) => void,
      prepare?: (made: Awaited<ReturnType<typeof setup>>) => void,
    ) => {
      const made = await setup(name, {}, extra)
      prepare?.(made)
      const job = made.engine.add({url: channel(login), profile: mp4, outDir: path.join(root, name, 'out')})
      /** Download-step states of the snapshots that carried a recording. */
      const told: string[] = []
      let recording = 0
      made.engine.on('job', snapshot => {
        if (snapshot.id !== job.id) return
        if (snapshot.progress.live && snapshot.recording === undefined) recording++
        if (snapshot.recording) told.push(snapshot.steps.find(step => step.name === 'download')?.state ?? '')
        during?.(made, snapshot)
      })
      await made.engine.whenIdle()
      const done = made.engine.job(job.id)!
      assert.equal(done.status, 'completed', JSON.stringify(done.error))
      assert.ok(recording > 0, 'snapshots while recording say nothing yet')
      assert.ok(told.length > 0 && told.every(state => state === 'success'), `told once it ended: ${told}`)
      return done
    }

    const stopped = await record('rec-stop', LIVE.onAir, {}, (made, snapshot) => {
      if ((snapshot.progress.fragmentIndex ?? 0) >= 6) made.engine.stop(snapshot.id)
    })
    assert.equal(stopped.recording?.ended, 'stopped')
    assert.ok((stopped.recording?.seconds ?? 0) >= 12, JSON.stringify(stopped.recording))
    assert.equal(stopped.recording?.gaps, 0)
    assert.equal(stopped.recording?.skippedSeconds, 0)

    const capped = await record('rec-cap', LIVE.onAir, {live: {maxDuration: 10}})
    assert.equal(capped.recording?.ended, 'max-duration')
    assert.ok((capped.recording?.seconds ?? 0) >= 10, JSON.stringify(capped.recording))

    // the stream stops growing at segment 9 and the channel leaves the air
    const offline = await record(
      'rec-offline',
      LIVE.onAir,
      {},
      (made, snapshot) => {
        if ((snapshot.progress.fragmentIndex ?? 0) >= 9) made.site.setOnAir(LIVE.onAir, false)
      },
      made => made.live.update(LIVE.onAir, {...LIVE_TRACKS[LIVE.onAir], stopAfter: 9}),
    )
    assert.equal(offline.recording?.ended, 'offline')

    const ads = await record('rec-ads', LIVE.ads)
    assert.equal(ads.recording?.ended, 'endlist')
    assert.equal(ads.recording?.skippedSeconds, 10, 'the ads left out')

    // a download that records nothing says nothing
    const made = await setup('rec-none')
    const plain = made.engine.add({url: vod(VODS.recorded), profile: mp4, outDir: path.join(root, 'rec-none', 'out')})
    await made.engine.whenIdle()
    assert.equal(made.engine.job(plain.id)?.status, 'completed')
    assert.equal(made.engine.job(plain.id)?.recording, undefined)
  })

  it('through the engine: the .twitch.tv auth-token of its cookies (a browser’s, or a cookies file) signs the token reads', {
    timeout: 10_000,
  }, async () => {
    const {site, options} = await setup('auth-engine')
    const dir = path.join(root, 'auth-engine-signed')
    const jar = path.join(dir, 'cookies.txt')
    await fs.mkdir(dir, {recursive: true})
    await fs.writeFile(
      jar,
      '# Netscape HTTP Cookie File\n' +
        `.twitch.tv\tTRUE\t/\tTRUE\t0\tauth-token\t${AUTH.sub}\n` +
        '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tx\n',
    )
    const engine = new MediaDownloader({
      dataDir: dir,
      binaries: bins,
      validation: 'none',
      cookiesFile: jar,
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
    cleanups.push(() => engine.dispose())
    asVideo(await engine.analyze(vod(VODS.subsOnly)))
    assert.deepEqual(
      site.requests.filter(r => r.auth !== undefined).map(r => [r.op, r.auth, r.clientId]),
      [['Vod', `OAuth ${AUTH.sub}`, WEB_ID]],
    )
  })
})
