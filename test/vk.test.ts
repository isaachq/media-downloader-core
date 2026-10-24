import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import type {DownloadError} from '../src/core/errors.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {rankRenditions} from '../src/sources/renditions.js'
import {SOURCE_FORMAT_CHANGED} from '../src/sources/source.js'
import {decodeBody, decodeWindows1251, problemOf, readAnswer, readVideo} from '../src/sources/vk/data.js'
import {isVkListing, parseVkLink} from '../src/sources/vk/links.js'
import {type VkOptions, VkSource} from '../src/sources/vk/source.js'
import {DELETED_VIDEO, encodeWindows1251, FAKE_VK_ALBUM, PRIVATE_VIDEO, startFakeVk} from './helpers/fake-vk.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const sd = {kind: 'video', container: 'mp4', maxHeight: 480} as const
const audio = {kind: 'audio', container: 'mp3'} as const
const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 30, maxBackoffMs: 100} as const

describe('VK links', () => {
  it('recognizes videos and clips on every host', () => {
    for (const host of ['vk.com', 'm.vk.com', 'www.vk.com', 'vk.ru', 'm.vk.ru', 'vkvideo.ru', 'm.vkvideo.ru']) {
      assert.deepEqual(parseVkLink(`https://${host}/video-22822305_456242110`), {
        kind: 'video',
        oid: '-22822305',
        id: '456242110',
      })
    }
    assert.deepEqual(parseVkLink('https://vk.com/video1_456239025'), {kind: 'video', oid: '1', id: '456239025'})
    assert.deepEqual(parseVkLink('https://vk.com/clip-22822305_456243500'), {
      kind: 'video',
      oid: '-22822305',
      id: '456243500',
      clip: true,
    })
    assert.deepEqual(parseVkLink('https://vkvideo.ru/clip-22822305_456243500/'), {
      kind: 'video',
      oid: '-22822305',
      id: '456243500',
      clip: true,
    })
  })

  it('reads the access key a hidden video carries, in its three shapes', () => {
    assert.deepEqual(parseVkLink('https://vk.com/video-1_2?list=ln-AbC123'), {
      kind: 'video',
      oid: '-1',
      id: '2',
      list: 'ln-AbC123',
    })
    assert.deepEqual(parseVkLink('https://vk.com/video-1_2_abcdef12'), {
      kind: 'video',
      oid: '-1',
      id: '2',
      list: 'abcdef12',
    })
    assert.deepEqual(parseVkLink('https://vk.com/wall-1_5?z=video-1_2%2Fabcdef12'), {
      kind: 'video',
      oid: '-1',
      id: '2',
      list: 'abcdef12',
    })
    assert.deepEqual(
      parseVkLink('https://m.vk.com/video-1_2?list='),
      {kind: 'video', oid: '-1', id: '2'},
      'an empty list is no key',
    )
  })

  it('a video opened over a wall post, a profile or a playlist page', () => {
    assert.deepEqual(parseVkLink('https://vk.com/wall-22822305_1?z=video-22822305_456242110'), {
      kind: 'video',
      oid: '-22822305',
      id: '456242110',
    })
    assert.deepEqual(parseVkLink('https://vk.com/durov?z=video1_456239025%2Fpl_1_-2'), {
      kind: 'video',
      oid: '1',
      id: '456239025',
    })
    assert.deepEqual(parseVkLink('https://vk.com/feed?z=clip-1_2'), {kind: 'video', oid: '-1', id: '2', clip: true})
    assert.equal(parseVkLink('https://vk.com/wall-22822305_1'), undefined, 'a wall post without a video opened')
  })

  it('embeds, playlists, an owner’s videos and short links', () => {
    assert.deepEqual(parseVkLink('https://vk.com/video_ext.php?oid=-22822305&id=456242110&hash=e037414127166efe'), {
      kind: 'video',
      oid: '-22822305',
      id: '456242110',
    })
    assert.equal(parseVkLink('https://vk.com/video_ext.php?oid=abc&id=1'), undefined)
    assert.deepEqual(parseVkLink('https://vk.com/video/playlist/-22822305_1'), {
      kind: 'playlist',
      oid: '-22822305',
      album: '1',
    })
    assert.deepEqual(parseVkLink('https://vkvideo.ru/playlist/-22822305_-4'), {
      kind: 'playlist',
      oid: '-22822305',
      album: '-4',
    })
    assert.deepEqual(parseVkLink('https://vk.com/videos-22822305?section=album_3'), {
      kind: 'playlist',
      oid: '-22822305',
      album: '3',
    })
    assert.deepEqual(parseVkLink('https://vk.com/videos-22822305'), {kind: 'playlist', oid: '-22822305', album: 'all'})
    assert.ok(isVkListing('https://vk.com/videos1'))
    assert.ok(!isVkListing('https://vk.com/video1_2'))
    assert.deepEqual(parseVkLink('https://vk.cc/cPNGz8'), {kind: 'short', url: 'https://vk.cc/cPNGz8'})
    assert.equal(parseVkLink('https://vk.cc/'), undefined)
    assert.deepEqual(
      parseVkLink('https://vkontakte.ru/away.php?cc_key=x&to=https%3A%2F%2Fvk.ru%2Fvideo-1_2'),
      {kind: 'video', oid: '-1', id: '2'},
      'where a vk.cc link leads',
    )
  })

  it('leaves other pages and sites alone', () => {
    for (const url of [
      'https://vk.com/',
      'https://vk.com/durov',
      'https://vk.com/video',
      'https://vk.com/videoabc_1',
      'https://vkvideo.ru/@vk',
      'https://notvk.com/video-1_2',
      'https://vk.com.evil.test/video-1_2',
      'not a url',
    ]) {
      assert.equal(parseVkLink(url), undefined, url)
    }
  })
})

describe('VK answers', () => {
  it('decodes windows-1251 exactly as the WHATWG decoder does, byte for byte', () => {
    const all = Uint8Array.from({length: 256}, (_, i) => i)
    assert.equal(decodeWindows1251(all), new TextDecoder('windows-1251').decode(all))
    const title = 'Анимированные vmoji в VK Звонках: Ёё'
    assert.equal(decodeBody(encodeWindows1251(title), 'application/json; charset=windows-1251'), title)
    assert.equal(decodeBody(Buffer.from('café'), 'application/json; charset=UTF-8'), 'café')
  })

  it('titles come out as shown: Cyrillic decoded, entities and emoji unescaped', () => {
    const body = encodeWindows1251(
      JSON.stringify({
        payload: [
          0,
          [
            'x',
            '',
            '',
            '',
            {
              player: {
                type: 'vk',
                params: [
                  {
                    oid: -1,
                    vid: 2,
                    md_title: 'Тест &#128077; caf&#233; &amp; &quot;co&quot;',
                    md_author: 'Канал',
                    duration: 15,
                    date: 1671701032,
                    url240: 'https://cdn.test/240',
                    url1080: 'https://cdn.test/1080',
                    url720: 'https://cdn.test/720',
                    hls: 'https://cdn.test/x.m3u8',
                  },
                ],
              },
            },
          ],
        ],
      }),
    )
    const video = readVideo(readAnswer(decodeBody(body, 'charset=windows-1251')), '-1', '2')
    assert.equal(video.title, 'Тест 👍 café & "co"')
    assert.equal(video.author, 'Канал')
    assert.equal(video.duration, 15)
    assert.equal(video.date, 1671701032)
    assert.deepEqual(
      video.renditions.map(r => r.resolution),
      [1080, 720, 240],
    )
  })

  it('picks the largest size within the cap, the smallest for audio', () => {
    const video = readVideo(
      [
        0,
        {
          player: {
            type: 'vk',
            params: [
              {url144: 'https://a/144', url360: 'https://a/360', url720: 'https://a/720', url1080: 'https://a/1080'},
            ],
          },
        },
      ],
      '1',
      '2',
    )
    assert.equal(rankRenditions(video.renditions, mp4)[0]!.resolution, 1080)
    assert.equal(rankRenditions(video.renditions, sd)[0]!.resolution, 360)
    assert.equal(
      rankRenditions(video.renditions, {kind: 'video', container: 'mp4', maxHeight: 720})[0]!.resolution,
      720,
    )
    assert.equal(
      rankRenditions(video.renditions, {kind: 'video', container: 'mp4', maxHeight: 100})[0]!.resolution,
      144,
    )
    assert.equal(rankRenditions(video.renditions, audio)[0]!.resolution, 144)
  })

  it('reads the older "<!--" answer and names VK’s refusals', () => {
    assert.deepEqual(readAnswer('<!--{"payload":[0,["a"]]}'), ['a'])
    assert.throws(
      () => readAnswer('<html>captcha</html>'),
      (e: {problem: string}) => e.problem === 'format-changed',
    )
    assert.throws(
      () => readAnswer('{"payload":"x"}'),
      (e: {problem: string}) => e.problem === 'format-changed',
    )
    const reason = (message: string) => problemOf('8', [JSON.stringify(message)]).problem
    assert.equal(reason('This video has been deleted and is no longer available.'), 'removed')
    assert.equal(reason('Видеозапись была удалена'), 'removed')
    assert.equal(reason('Access restricted'), 'private')
    assert.equal(reason('Access denied (1)'), 'private')
    assert.equal(reason('This video is not available in your region.'), 'geo-blocked')
    assert.equal(reason('Please log in to watch this video'), 'login-required')
    assert.equal(reason('Enter the captcha'), 'blocked')
    assert.equal(reason('Error'), 'removed')
  })

  it('an answer without its player data is a changed format', () => {
    assert.throws(
      () => readVideo([0, {mvData: {}}], '1', '2'),
      (e: {problem: string}) => e.problem === 'format-changed',
    )
  })
})

let root: string
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-vk-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

/** Sends vk.cc to the fake (the short links' own host can't be served locally). */
const shortLinksTo =
  (origin: string): VkOptions['fetch'] =>
  (input, init) =>
    fetch(input.replace(/^https:\/\/vk\.cc\//, `${origin}/cc/`), init)

async function setup(name: string, config: Parameters<typeof startFakeVk>[0] = {}) {
  const site = await startFakeVk(config)
  const options: VkOptions = {origin: site.origin, pacing: fast, fetch: shortLinksTo(site.origin)}
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    maxRetries: 3,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: false,
    instagram: false,
    facebook: false,
    vk: options,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {site, engine, scheduler, options, out: path.join(root, name, 'out')}
}

const videoLink = (site: {origin: string; oid: string; ids: readonly string[]}, i = 0) =>
  `${site.origin}/video${site.oid}_${site.ids[i]}`

describe('VK, end to end (local fake)', () => {
  it('downloads one video as MP4: the largest size, the title decoded, read once', async () => {
    const {site, engine, scheduler, out} = await setup('single')
    const analysis = await engine.analyze(videoLink(site))
    assert.equal(analysis.kind, 'video')
    if (analysis.kind !== 'video') return
    assert.equal(analysis.media.title, site.title(0))
    assert.equal(analysis.media.uploader, 'Фейк Канал')
    assert.equal(analysis.media.duration, 10)
    assert.equal(analysis.media.extractor, 'VK')
    assert.equal(analysis.media.url, `https://vk.com/video${site.oid}_${site.ids[0]}`)
    assert.ok(analysis.choices.some(c => c.profile.kind === 'video' && c.profile.maxHeight === 1080))

    const batch = scheduler.schedule({url: videoLink(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const files = await fs.readdir(out)
    assert.equal(files.length, 1)
    assert.match(files[0]!, /\.mp4$/)
    assert.equal((await fs.readFile(path.join(out, files[0]!), 'utf8')).slice(0, 5), 'q1080', 'the 1080p file')
    assert.equal(site.hits.show, 1, 'the analysis read is reused by the check and the download')
    assert.equal(site.hits.refusedMedia, 0, 'the media came with the browser’s user agent')
  })

  it('a resolution cap picks the size within it; an audio format gets the soundtrack of the smallest', async () => {
    const {site, scheduler, out} = await setup('caps', {videos: 2})
    scheduler.schedule({url: videoLink(site, 0), profile: sd, outDir: path.join(out, 'sd')})
    scheduler.schedule({url: videoLink(site, 1), profile: audio, outDir: path.join(out, 'audio')})
    await scheduler.whenIdle()
    assert.ok(
      scheduler.batches().every(b => b.status === 'completed'),
      JSON.stringify(scheduler.batches().map(b => b.error)),
    )
    const [sdFile] = await fs.readdir(path.join(out, 'sd'))
    assert.equal((await fs.readFile(path.join(out, 'sd', sdFile!), 'utf8')).slice(0, 4), 'q480')
    assert.match((await fs.readdir(path.join(out, 'audio')))[0]!, /\.mp3$/)
    assert.ok(
      site.served.some(p => p.endsWith('/240.mp4')),
      'audio comes from the smallest file',
    )
  })

  it('a clip downloads like a video; the older answer format reads the same', async () => {
    const {site, scheduler, out} = await setup('clip', {legacyPrefix: true})
    const batch = scheduler.schedule({url: `${site.origin}/clip${site.oid}_${site.ids[0]}`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)!.status, 'completed', JSON.stringify(scheduler.batch(batch.id)!.error))
    assert.equal((await fs.readdir(out)).length, 1)
  })

  it('a video opened over a wall post sends its access key', async () => {
    const {site, engine} = await setup('wall')
    const result = await engine.analyze(`${site.origin}/wall${site.oid}_9?z=video${site.oid}_${site.ids[0]}%2Fabcdef12`)
    assert.equal(result.kind, 'video')
    assert.deepEqual(site.shows.at(-1), {video: `${site.oid}_${site.ids[0]}`, list: 'abcdef12'})
  })

  it('private and deleted videos fail with the reason, not a retry', async () => {
    const {site, engine, scheduler, out} = await setup('gone')
    await assert.rejects(engine.analyze(`${site.origin}/video${PRIVATE_VIDEO}`), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'private')
      return true
    })
    const gone = scheduler.schedule({url: `${site.origin}/video${DELETED_VIDEO}`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(gone.id)?.status, 'failed')
    assert.equal(scheduler.batch(gone.id)?.error?.hint, 'removed')
    assert.match(scheduler.batch(gone.id)?.error?.message ?? '', /deleted/)
  })

  it('live streams fail clearly; an HLS-only video goes to yt-dlp', async () => {
    const {site, engine, out} = await setup('live', {live: [0], hlsOnly: [1]})
    const live = engine.add({url: videoLink(site, 0), profile: mp4, outDir: out})
    await engine.whenIdle()
    const failed = engine.jobs().find(j => j.id === live.id)!
    assert.equal(failed.status, 'failed')
    assert.match(failed.error?.message ?? '', /live streams cannot be downloaded/)
    const hls = engine.add({url: videoLink(site, 1), profile: mp4, outDir: out})
    await engine.whenIdle()
    const finished = engine.jobs().find(j => j.id === hls.id)!
    assert.equal(finished.status, 'completed', JSON.stringify(finished.error))
    assert.deepEqual(
      finished.attempts.map(a => a.strategy),
      ['primary', 'extractor-fallback'],
    )
  })

  it('a changed answer is SOURCE_FORMAT_CHANGED (the engine falls back to yt-dlp)', async () => {
    const site = await startFakeVk({changed: true})
    cleanups.push(() => site.close())
    const source = new VkSource({origin: site.origin, pacing: fast})
    await assert.rejects(source.analyze(videoLink(site)), (e: DownloadError) => {
      assert.equal(e.details, SOURCE_FORMAT_CHANGED)
      assert.match(e.message, /^VK/)
      return true
    })
  })

  it('a refusal (429) is waited out and retried', async () => {
    const {site, engine} = await setup('refused', {refusals: 2})
    const result = await engine.analyze(videoLink(site))
    assert.equal(result.kind, 'video')
    assert.equal(site.hits.refused, 2)
  })

  it('follows a vk.cc short link through VK’s redirect page', async () => {
    const {site, engine} = await setup('short')
    const result = await engine.analyze('https://vk.cc/abc123')
    assert.equal(result.kind, 'video')
    assert.equal(result.kind === 'video' && result.media.id, `${site.oid}_${site.ids[0]}`)
    assert.equal(site.hits.short, 1)
    const source = new VkSource({
      origin: site.origin,
      pacing: fast,
      fetch: (input, init) => fetch(input.replace('https://vk.cc/nowhere', `${site.origin}/cc-nowhere`), init),
    })
    await assert.rejects(source.analyze('https://vk.cc/nowhere'), (e: DownloadError) => e.hint === 'removed')
  })

  it('lists an owner’s videos page by page, capped by maxEntries', async () => {
    const {site, engine, scheduler, out} = await setup('listing', {videos: 10, pageSize: 4})
    const all = await engine.analyze(`${site.origin}/videos${site.oid}`)
    assert.equal(all.kind, 'playlist')
    if (all.kind !== 'playlist') return
    assert.equal(all.entries.length, 10)
    assert.equal(all.total, 10)
    assert.equal(all.complete, true)
    assert.equal(all.title, 'VK Фейк Канал videos')
    assert.equal(all.entries[0]!.title, site.title(0))
    assert.equal(site.hits.listing, 3, '10 videos, 4 per page')

    const capped = await engine.analyze(`${site.origin}/videos${site.oid}`, {maxEntries: 5})
    assert.equal(capped.kind === 'playlist' && capped.entries.length, 5)
    assert.equal(site.hits.listing, 5, 'two pages for five')

    const batch = scheduler.schedule({
      url: `${site.origin}/video/playlist/${site.oid}_${FAKE_VK_ALBUM}`,
      profile: mp4,
      outDir: out,
    })
    assert.equal(batch.maxItems, 500)
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 5, 'the album holds every other video')
    const folder = (await fs.readdir(out))[0]!
    assert.match(folder, /Лучшее|Luchshee|VK/, folder)
    assert.equal((await fs.readdir(path.join(out, folder))).length, 5)
  })
})
