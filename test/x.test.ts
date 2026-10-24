import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import type {DownloadError} from '../src/core/errors.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import type {MetaError} from '../src/sources/meta/errors.js'
import {rankRenditions} from '../src/sources/renditions.js'
import {SOURCE_FORMAT_CHANGED} from '../src/sources/source.js'
import {cleanText, readTweetResult, syndicationToken, titleOf} from '../src/sources/x/data.js'
import {parseXLink} from '../src/sources/x/links.js'
import {type XOptions, XSource} from '../src/sources/x/source.js'
import {startFakeX} from './helpers/fake-x.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const hd = {kind: 'video', container: 'mp4', maxHeight: 720} as const
const audio = {kind: 'audio', container: 'mp3'} as const

describe('X links', () => {
  const id = '1585341984679469056'
  it('recognizes a post in every shape, on every host', () => {
    const post = {kind: 'post', id, user: 'elonmusk'}
    for (const url of [
      `https://x.com/elonmusk/status/${id}`,
      `https://www.x.com/elonmusk/status/${id}/`,
      `https://twitter.com/elonmusk/status/${id}?s=20&t=AbCdEf_gh`,
      `https://mobile.twitter.com/elonmusk/status/${id}`,
      `https://mobile.x.com/elonmusk/status/${id}`,
      `https://www.twitter.com/elonmusk/statuses/${id}`,
      `https://x.com/elonmusk/status/${id}/photo/1`,
      `https://x.com/elonmusk/status/${id}/analytics`,
      `https://fxtwitter.com/elonmusk/status/${id}`,
      `https://vxtwitter.com/elonmusk/status/${id}`,
      `https://fixupx.com/elonmusk/status/${id}`,
      `https://twitter.com/#!/elonmusk/status/${id}`,
    ]) {
      assert.deepEqual(parseXLink(url), post, url)
    }
    for (const url of [
      `https://x.com/i/status/${id}`,
      `https://twitter.com/i/web/status/${id}`,
      `https://twitter.com/statuses/${id}`,
    ]) {
      assert.deepEqual(parseXLink(url), {kind: 'post', id}, url)
    }
  })

  it('a /video/<n> link means that video alone', () => {
    assert.deepEqual(parseXLink(`https://x.com/elonmusk/status/${id}/video/2`), {
      kind: 'post',
      id,
      user: 'elonmusk',
      index: 2,
    })
    assert.deepEqual(parseXLink(`https://x.com/i/web/status/${id}/video/1?s=20`), {kind: 'post', id, index: 1})
    assert.equal(parseXLink(`https://x.com/elonmusk/status/${id}/video/0`)?.kind, 'post', 'not a video number')
    assert.equal((parseXLink(`https://x.com/elonmusk/status/${id}/video/0`) as {index?: number}).index, undefined)
  })

  it('short links, profiles, and what is not X', () => {
    assert.deepEqual(parseXLink('https://t.co/D68z4K2wq7'), {kind: 'short', url: 'https://t.co/D68z4K2wq7'})
    assert.deepEqual(parseXLink('http://t.co/D68z4K2wq7/'), {kind: 'short', url: 'https://t.co/D68z4K2wq7'})
    assert.equal(parseXLink('https://t.co/'), undefined)
    assert.deepEqual(parseXLink('https://x.com/elonmusk'), {kind: 'profile', user: 'elonmusk'})
    assert.deepEqual(parseXLink('https://twitter.com/elonmusk/media'), {kind: 'profile', user: 'elonmusk'})
    assert.equal(parseXLink('https://x.com/home'), undefined)
    assert.equal(parseXLink('https://x.com/i/bookmarks'), undefined)
    assert.equal(parseXLink('https://x.com/search?q=cats'), undefined)
    assert.equal(parseXLink('https://x.com/elonmusk/status/notanid'), undefined)
    assert.equal(parseXLink('https://xx.com/elonmusk/status/1'), undefined)
    assert.equal(parseXLink('https://example.com/elonmusk/status/1'), undefined)
    assert.equal(parseXLink('ftp://x.com/elonmusk/status/1'), undefined)
    assert.deepEqual(parseXLink('http://127.0.0.1:9/u/status/12', '127.0.0.1'), {kind: 'post', id: '12', user: 'u'})
  })
})

describe('X data', () => {
  it('computes the request token the embed widget sends', () => {
    // what the live endpoint accepted for this post (October 2026)
    assert.equal(syndicationToken('1585341984679469056'), '3uchycv2wqc')
  })

  it('cleans the text: t.co links out, entities decoded; the title is its first line', () => {
    assert.equal(cleanText('Fish &amp; chips  https://t.co/abc123 \n next'), 'Fish & chips\nnext')
    const post = {id: '9', user: 'u', text: 'Fish & chips\nnext', videos: []}
    assert.equal(titleOf(post), 'Fish & chips')
    assert.equal(titleOf({...post, text: ''}), 'X 9')
    assert.ok(titleOf({...post, text: 'word '.repeat(40)}).endsWith('…'))
  })

  it('reads tombstones, unavailable posts and a changed answer as their reasons', () => {
    const problem = (body: unknown) => {
      try {
        readTweetResult(body)
      } catch (error) {
        return [(error as MetaError).problem, (error as MetaError).message]
      }
      return undefined
    }
    assert.deepEqual(problem({__typename: 'TweetTombstone', tombstone: {}})?.[0], 'removed')
    assert.deepEqual(problem({__typename: 'TweetTombstone', tombstone: {text: {text: 'Gone. Learn more'}}}), [
      'removed',
      'X: Gone.',
    ])
    assert.equal(problem({__typename: 'TweetUnavailable', reason: 'Protected'})?.[0], 'private')
    assert.equal(problem({})?.[0], 'format-changed', 'no token accepted: `{}`')
    assert.equal(problem({__typename: 'Something'})?.[0], 'format-changed')
    assert.equal(problem({__typename: 'Tweet', id_str: '1'})?.[0], 'format-changed', 'no account')
    assert.equal(problem([])?.[0], 'format-changed')
  })
})

let root: string
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-x-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

async function setup(name: string, config: Parameters<typeof startFakeX>[0] = {}) {
  const site = await startFakeX(config)
  const options: XOptions = {
    origin: site.origin,
    fetch: site.fetch,
    pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 30, maxBackoffMs: 100},
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
    facebook: false,
    vk: false,
    x: options,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {site, engine, scheduler, source: new XSource(options), out: path.join(root, name, 'out')}
}

const postUrl = (id: string) => `https://x.com/fakeaccount/status/${id}`
const head = async (file: string) => (await fs.readFile(file, 'utf8')).split('|', 1)[0]

describe('X, choosing a variant', () => {
  it('the highest bitrate within the cap, the smallest when none fits; audio from the smallest file', async () => {
    const {site, source} = await setup('variants')
    const analysis = await source.analyze(postUrl(site.ids.single))
    assert.equal(analysis.kind, 'video')
    if (analysis.kind !== 'video') return
    assert.equal(analysis.media.title, 'Entering the office & more – let that sink in!')
    assert.equal(analysis.media.uploader, 'fakeaccount')
    assert.equal(analysis.media.duration, 9.301)
    assert.equal(analysis.media.publishedAt, 1_666_809_958)
    assert.equal(analysis.media.id, '1585341912877146112', "X's media id, as yt-dlp names it")
    assert.match(analysis.media.thumbnail ?? '', /thumb\.jpg$/)
    assert.deepEqual(
      analysis.choices.filter(c => c.profile.kind === 'video' && c.profile.container === 'mp4').map(c => c.label),
      ['1080p · MP4', '720p · MP4', '360p · MP4', '270p · MP4'],
      'the HLS playlist is not a choice',
    )
    // the renditions as read, ranked per profile
    const post = readTweetResult({
      __typename: 'Tweet',
      id_str: '1',
      user: {screen_name: 'u'},
      mediaDetails: [
        {
          type: 'video',
          video_info: {
            variants: [
              {content_type: 'video/mp4', bitrate: 832_000, url: 'https://v/vid/640x360/a.mp4'},
              {content_type: 'video/mp4', bitrate: 2_176_000, url: 'https://v/vid/1280x720/b.mp4'},
              {content_type: 'video/mp4', bitrate: 10_368_000, url: 'https://v/vid/1920x1080/c.mp4'},
              {content_type: 'application/x-mpegURL', url: 'https://v/pl/d.m3u8'},
            ],
          },
        },
      ],
    })
    const renditions = post.videos[0]!.renditions
    const best = (profile: Parameters<typeof rankRenditions>[1]) => rankRenditions(renditions, profile)[0]!.urls[0]
    assert.equal(best(mp4), 'https://v/vid/1920x1080/c.mp4')
    assert.equal(best(hd), 'https://v/vid/1280x720/b.mp4')
    assert.equal(best({kind: 'video', container: 'mp4', maxHeight: 480}), 'https://v/vid/640x360/a.mp4')
    assert.equal(best({kind: 'video', container: 'mp4', maxHeight: 144}), 'https://v/vid/640x360/a.mp4')
    assert.equal(best(audio), 'https://v/vid/640x360/a.mp4')
  })
})

describe('X, end to end (local fake)', () => {
  it('downloads a post’s video as MP4 through a batch: the best size, a portable name, the post’s date', async () => {
    const {site, scheduler, out} = await setup('single')
    const batch = scheduler.schedule({url: `${postUrl(site.ids.single)}?s=20&t=x`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const files = await fs.readdir(out)
    assert.equal(files.length, 1)
    assert.match(files[0]!, /^Entering-the-office-more-let-that-sink-in-1585341912877146112\.mp4$/)
    assert.equal(await head(path.join(out, files[0]!)), '1920x1080')
    assert.equal(site.hits.post, 1, 'one read of the post: the check, reused by the download')
  })

  it('a resolution cap picks 720p; an audio format gets the soundtrack', async () => {
    const {site, scheduler, out} = await setup('caps')
    scheduler.schedule({url: postUrl(site.ids.single), profile: hd, outDir: path.join(out, 'hd')})
    scheduler.schedule({url: postUrl(site.ids.single), profile: audio, outDir: path.join(out, 'audio')})
    await scheduler.whenIdle()
    assert.ok(
      scheduler.batches().every(b => b.status === 'completed'),
      JSON.stringify(scheduler.batches().map(b => b.error)),
    )
    const [hdFile] = await fs.readdir(path.join(out, 'hd'))
    assert.equal(await head(path.join(out, 'hd', hdFile!)), '1280x720')
    assert.match((await fs.readdir(path.join(out, 'audio')))[0]!, /\.mp3$/)
    assert.ok(site.served.includes('/ext_tw_video/1585341912877146112/pu/vid/480x270/file.mp4'), 'the smallest file')
  })

  it('a post with several videos is a playlist of them (the picture between is not an item)', async () => {
    const {site, engine, scheduler, out} = await setup('multi')
    const analysis = await engine.analyze(postUrl(site.ids.multi))
    assert.equal(analysis.kind, 'playlist')
    if (analysis.kind !== 'playlist') return
    assert.equal(analysis.title, 'Two videos and a picture')
    assert.equal(analysis.total, 2)
    assert.deepEqual(
      analysis.entries.map(e => [e.index, e.id, e.url, e.title]),
      [
        [
          1,
          '1600649511827038209',
          `https://x.com/fakeaccount/status/${site.ids.multi}/video/1`,
          'Two videos and a picture #1',
        ],
        [
          2,
          '1600649511827013632',
          `https://x.com/fakeaccount/status/${site.ids.multi}/video/2`,
          'Two videos and a picture #2',
        ],
      ],
    )
    const batch = scheduler.schedule({url: postUrl(site.ids.multi), profile: hd, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 2)
    const folder = (await fs.readdir(out))[0]!
    const files = (await fs.readdir(path.join(out, folder))).sort()
    assert.equal(files.length, 2)
    assert.match(files[0]!, /^001-.*-1600649511827038209\.mp4$/)
    assert.match(files[1]!, /^002-.*-1600649511827013632\.mp4$/)
    assert.equal(await head(path.join(out, folder, files[1]!)), '720x1280', 'portrait: 720 is the short side')
    // one video alone, by its own page
    const alone = await engine.analyze(`${postUrl(site.ids.multi)}/video/2`)
    assert.equal(alone.kind, 'video')
    if (alone.kind === 'video') assert.equal(alone.media.id, '1600649511827013632')
    await assert.rejects(engine.analyze(`${postUrl(site.ids.multi)}/video/3`), /2 videos, not 3/)
  })

  it('an animated GIF is a video (its one MP4, its size from the media); it has no sound to extract', async () => {
    const {site, engine, scheduler, out} = await setup('gif')
    const analysis = await engine.analyze(postUrl(site.ids.gif))
    assert.equal(analysis.kind, 'video')
    if (analysis.kind !== 'video') return
    assert.deepEqual(
      analysis.choices.map(c => c.label),
      ['280p · MP4', '280p · WEBM', '280p · MKV'],
      'no audio choices',
    )
    assert.equal(analysis.media.id, site.ids.gif, 'no media id in a GIF’s urls: the post’s')
    const batch = scheduler.schedule({url: postUrl(site.ids.gif), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal(await head(path.join(out, (await fs.readdir(out))[0]!)), 's-gif')
    const sound = scheduler.schedule({url: postUrl(site.ids.gif), profile: audio, outDir: path.join(out, 'a')})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(sound.id)?.status, 'failed')
  })

  it('a video card and a quote of a post with a video are read; the quote as the quoted post', async () => {
    const {site, source} = await setup('card-quote')
    const card = await source.analyze(postUrl(site.ids.card))
    assert.equal(card.kind, 'video')
    if (card.kind === 'video') assert.equal(card.media.id, '1349774757969989634')
    const quote = await source.analyze(postUrl(site.ids.quote))
    assert.equal(quote.kind, 'video')
    if (quote.kind !== 'video') return
    assert.equal(quote.media.title, 'Some test animation')
    assert.equal(quote.media.uploader, 'quotedartist')
    assert.equal(quote.media.url, 'https://x.com/quotedartist/status/1284162907446501377')
  })

  it('a post with pictures only fails clearly, and is not retried', async () => {
    const {site, scheduler, out} = await setup('photos')
    const batch = scheduler.schedule({url: postUrl(site.ids.photos), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'failed')
    assert.equal(done.error?.message, 'This post has no video.')
    assert.equal(done.error?.hint, 'format-unavailable')
    assert.equal(site.hits.post, 1)
  })

  it('deleted, withdrawn and never-existing posts fail as removed', async () => {
    const {site, source} = await setup('gone')
    for (const [url, message] of [
      [postUrl(site.ids.deleted), /deleted by the Post author\.$/],
      [postUrl(site.ids.withdrawn), /not available/],
      [postUrl('1585341984679469057'), /does not exist/],
    ] as const) {
      await assert.rejects(source.analyze(url), (e: DownloadError) => {
        assert.equal(e.code, 'unavailable')
        assert.equal(e.hint, 'removed')
        assert.match(e.message, message)
        return true
      })
    }
  })

  it('a changed answer says so, for the engine to hand the url to yt-dlp', async () => {
    const {site, source} = await setup('changed')
    for (const id of [site.ids.changed, site.ids.hlsOnly]) {
      await assert.rejects(source.analyze(postUrl(id)), (e: DownloadError) => {
        assert.equal(e.details, SOURCE_FORMAT_CHANGED)
        assert.match(e.message, /^Twitter: X: /)
        return true
      })
    }
  })

  it('follows t.co links (a refresh page) to the whole post; one that leaves X says where it goes', async () => {
    const {site, source, scheduler, out} = await setup('short')
    const multi = await source.analyze('https://t.co/multiLink1')
    assert.equal(multi.kind, 'playlist', 't.co names /video/1 of every post: the whole post is meant')
    const batch = scheduler.schedule({url: 'https://t.co/singleLink', profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal((await fs.readdir(out)).length, 1)
    await assert.rejects(source.analyze('https://t.co/outside01'), (e: DownloadError) => {
      assert.equal(e.hint, 'unsupported-url')
      assert.match(e.message, /leads to example\.com/)
      return true
    })
    await assert.rejects(source.analyze('https://t.co/deadLink01'), /leads nowhere/)
    await assert.rejects(source.analyze('https://x.com/fakeaccount'), /profiles and timelines are not supported/)
    assert.equal(site.hits.short, 4, 'example.com itself is never asked')
  })

  it('retries refusals after the shared cool-down', async () => {
    const {site, scheduler, out} = await setup('refused', {refusals: 2})
    const batch = scheduler.schedule({url: postUrl(site.ids.single), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal(site.hits.refused, 2)
  })
})
