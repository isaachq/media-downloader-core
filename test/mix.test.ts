import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {isYouTubeListing, MAX_LISTED_ITEMS} from '../src/core/analyze.js'
import {isListingLink, skipReasonOf} from '../src/core/mix.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {linkKey, MIX_MAX_LINKS, planMix} from '../src/sources/mix-plan.js'
import type {BatchSnapshot, MixProgress} from '../src/types.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

let root = ''
let fakes: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-mix-'))
  fakes = await writeFakes(path.join(root, 'fakes'))
})

after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

function setup(name: string, options: ConstructorParameters<typeof BatchScheduler>[1] = {}) {
  const dataDir = path.join(root, name)
  const engine = new MediaDownloader({
    dataDir,
    binaries: fakes,
    validation: 'none',
    maxRetries: 2,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    // a bot check pauses YouTube for 5 minutes by default: a test waits milliseconds
    youtube: {pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 50, maxBackoffMs: 200}},
  })
  const scheduler = new BatchScheduler(engine, options)
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
  })
  return {engine, scheduler, dataDir, out: path.join(dataDir, 'out')}
}

const audio = {kind: 'audio', container: 'm4a'} as const

/** How many links the engine's network check is handed from now on, over how many calls. */
function countPreflight(engine: MediaDownloader): () => {calls: number; items: number} {
  const counted = {calls: 0, items: 0}
  const original = engine.preflight.bind(engine)
  engine.preflight = (list, opts) => {
    counted.calls++
    counted.items += list.length
    return original(list, opts)
  }
  return () => ({...counted})
}

describe('planMix: the links of a pasted text, locally', () => {
  it('takes every link once, in order, with its site and line — one or several per line', () => {
    const plan = planMix(
      [
        'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        '',
        'Look at this! https://www.tiktok.com/@nasa/video/7300000000000000000 and https://x.com/nasa/status/1',
        'https://vk.com/video-1_2,https://www.instagram.com/reel/C1abcDEF/',
        '   ',
        'https://www.facebook.com/reel/1158775390014135/.',
        'https://cdn.example.com/clip.mp4',
      ].join('\n'),
    )
    assert.deepEqual(
      plan.links.map(link => [link.line, link.site, link.url]),
      [
        [1, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa'],
        [3, 'tiktok', 'https://www.tiktok.com/@nasa/video/7300000000000000000'],
        [3, 'x', 'https://x.com/nasa/status/1'],
        [4, 'vk', 'https://vk.com/video-1_2'],
        [4, 'instagram', 'https://www.instagram.com/reel/C1abcDEF/'],
        [6, 'facebook', 'https://www.facebook.com/reel/1158775390014135/'],
        [7, 'web', 'https://cdn.example.com/clip.mp4'],
      ],
    )
    assert.equal(plan.links.at(-1)!.file, true)
    assert.deepEqual(plan.skipped, [], 'empty and blank lines are not reported')
  })

  it('reports a line with no link, a repeat (with the line it repeats) and links past the cap', () => {
    const plan = planMix(
      [
        'https://fake.test/a1',
        'my favourite videos:',
        'https://fake.test/a2',
        'http://www.fake.test/a1/#comments',
        'https://fake.test/a3',
      ].join('\r\n'),
      {maxLinks: 2},
    )
    assert.deepEqual(
      plan.links.map(link => link.url),
      ['https://fake.test/a1', 'https://fake.test/a2'],
    )
    assert.deepEqual(plan.skipped, [
      {line: 2, input: 'my favourite videos:', reason: 'not-a-link'},
      {line: 4, input: 'http://www.fake.test/a1/#comments', site: 'web', reason: 'duplicate', duplicateOf: 1},
      {line: 5, input: 'https://fake.test/a3', site: 'web', reason: 'too-many'},
    ])
  })

  it('accepts a list of texts as lines, unwraps trackers and echoes at most 200 characters of a line', () => {
    const plan = planMix([
      'https://l.instagram.com/?u=https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F7300000000000000001&e=x',
      'x'.repeat(500),
    ])
    assert.equal(plan.links[0]!.url, 'https://www.tiktok.com/@a/video/7300000000000000001')
    assert.equal(plan.links[0]!.site, 'tiktok')
    assert.equal(plan.skipped[0]!.input.length, 200)
  })

  it('caps at 5000 links, the ceiling of one list', () => {
    assert.equal(MIX_MAX_LINKS, MAX_LISTED_ITEMS)
    const text = Array.from({length: MIX_MAX_LINKS + 3}, (_, i) => `https://fake.test/v${i}`).join('\n')
    const plan = planMix(text, {maxLinks: 1_000_000})
    assert.equal(plan.links.length, MIX_MAX_LINKS)
    assert.equal(plan.skipped.length, 3)
  })

  it('stays linear: 50,000 lines (half of them repeats) plan in well under a second', () => {
    const lines = Array.from({length: 50_000}, (_, i) => `https://fake.test/v${i % 25_000}?utm_source=x${i}`)
    const started = performance.now()
    const plan = planMix(lines)
    const elapsed = performance.now() - started
    assert.equal(plan.links.length, MIX_MAX_LINKS)
    assert.equal(plan.skipped.filter(skip => skip.reason === 'duplicate').length, 25_000)
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`)
  })
})

describe('linkKey: what makes two links the same link', () => {
  it('ignores scheme, www and mobile hosts, a trailing slash, the fragment and tracking parameters', () => {
    const same = [
      'https://www.youtube.com/watch?v=abc&si=XYZ&feature=shared',
      'http://youtube.com/watch?utm_source=share&v=abc',
      'https://youtube.com/watch?v=abc#t=5',
    ]
    assert.equal(new Set(same.map(url => linkKey(url, 'youtube'))).size, 1)
    assert.equal(
      linkKey('https://m.facebook.com/watch/?v=1', 'facebook'),
      linkKey('https://facebook.com/watch?v=1', 'facebook'),
    )
  })

  it('keeps parameters that name the media, in any order', () => {
    assert.notEqual(
      linkKey('https://youtube.com/watch?v=abc', 'youtube'),
      linkKey('https://youtube.com/watch?v=abd', 'youtube'),
    )
    assert.equal(
      linkKey('https://www.facebook.com/story.php?story_fbid=1&id=2', 'facebook'),
      linkKey('https://www.facebook.com/story.php?id=2&story_fbid=1', 'facebook'),
    )
  })

  it('drops the whole query of sites whose post is in the path, and a mobile host only for known sites', () => {
    assert.equal(
      linkKey('https://www.tiktok.com/@a/video/1?_r=1&_t=8abc&is_from_webapp=1', 'tiktok'),
      linkKey('https://tiktok.com/@a/video/1', 'tiktok'),
    )
    assert.equal(linkKey('https://x.com/a/status/1?s=20&t=abc', 'x'), 'x.com/a/status/1')
    assert.equal(linkKey('https://www.instagram.com/reel/C1/?igsh=abc', 'instagram'), 'instagram.com/reel/C1')
    assert.notEqual(linkKey('https://m.example.com/v/1', 'web'), linkKey('https://example.com/v/1', 'web'))
  })
})

describe('what a mix list leaves out', () => {
  it('a YouTube playlist or channel is a list; a video inside a list is a video', () => {
    assert.equal(isYouTubeListing('https://www.youtube.com/playlist?list=PL1'), true)
    assert.equal(isYouTubeListing('https://www.youtube.com/@nasa'), true)
    assert.equal(isYouTubeListing('https://www.youtube.com/@nasa/videos'), true)
    assert.equal(isYouTubeListing('https://www.youtube.com/channel/UC1'), true)
    assert.equal(isYouTubeListing('https://www.youtube.com/watch?list=PL1'), true)
    assert.equal(isYouTubeListing('https://www.youtube.com/watch?v=abc&list=PL1'), false)
    assert.equal(isYouTubeListing('https://www.youtube.com/shorts/abc'), false)
    assert.equal(isYouTubeListing('https://youtu.be/abc'), false)
  })

  it('profiles and stories of the sites read natively are lists', () => {
    const engine = {defaultListSize: () => undefined}
    assert.equal(isListingLink('https://www.tiktok.com/@nasa', engine), true)
    assert.equal(isListingLink('https://www.instagram.com/nasa/', engine), true)
    assert.equal(isListingLink('https://www.instagram.com/stories/nasa/', engine), true)
    assert.equal(isListingLink('https://vk.com/video/playlist/-1_2', engine), true)
    assert.equal(isListingLink('https://www.tiktok.com/@nasa/video/7300000000000000000', engine), false)
    assert.equal(isListingLink('https://www.instagram.com/reel/C1abcDEF/', engine), false)
    assert.equal(isListingLink('https://x.com/nasa', engine), true)
    assert.equal(isListingLink('https://twitter.com/nasa/', engine), true)
    assert.equal(isListingLink('https://x.com/nasa/status/1585341984679469056', engine), false)
    assert.equal(isListingLink('https://x.com/nasa/status/1585341984679469056/video/2', engine), false)
    assert.equal(isListingLink('https://fake.test/a', {defaultListSize: () => 500}), true, 'a source says so')
  })

  it('words the check’s answer by the code and hint every app already knows', () => {
    assert.equal(skipReasonOf({code: 'unavailable', hint: 'private', message: ''}), 'private')
    assert.equal(skipReasonOf({code: 'unavailable', hint: 'needs-sign-in', message: ''}), 'needs-sign-in')
    assert.equal(skipReasonOf({code: 'unavailable', hint: 'members-only', message: ''}), 'needs-sign-in')
    assert.equal(skipReasonOf({code: 'unavailable', hint: 'unsupported-url', message: ''}), 'unsupported')
    assert.equal(skipReasonOf({code: 'binary-missing', message: ''}), 'unsupported')
    assert.equal(skipReasonOf({code: 'unavailable', hint: 'removed', message: ''}), 'unavailable')
    assert.equal(skipReasonOf({code: 'unavailable', hint: 'damaged-source', message: ''}), 'damaged')
    assert.equal(skipReasonOf({code: 'network', message: ''}), 'error')
    // a link that turned out to hold several items: an X post with several videos, a short link to a profile
    assert.equal(
      skipReasonOf({code: 'invalid-request', message: 'This post has several videos: each is its own item.'}),
      'listing',
    )
    assert.equal(skipReasonOf({code: 'invalid-request', hint: 'unsupported-url', message: ''}), 'unsupported')
  })
})

describe('MediaDownloader.analyzeMix', () => {
  it('checks every link in one network pass and keeps them all when all can be downloaded', async () => {
    const {engine} = setup('all-valid')
    const counted = countPreflight(engine)
    const progress: MixProgress[] = []
    const mix = await engine.analyzeMix(['https://fake.test/a1', 'https://fake.test/a2', 'https://fake.test/a3'], {
      profile: audio,
      onProgress: step => progress.push(step),
    })
    assert.deepEqual(
      mix.valid.map(item => [item.line, item.url, item.analysis?.media.title]),
      [
        [1, 'https://fake.test/a1', 'Title a1'],
        [2, 'https://fake.test/a2', 'Title a2'],
        [3, 'https://fake.test/a3', 'Title a3'],
      ],
    )
    assert.deepEqual(mix.skipped, [])
    assert.deepEqual(mix.summary, {total: 3, valid: 3, skipped: 0, bySite: {web: 3}, byReason: {}})
    assert.deepEqual(counted(), {calls: 1, items: 3})
    assert.deepEqual(progress.at(0), {total: 3, checked: 0})
    assert.deepEqual(progress.at(-1), {total: 3, checked: 3})
  })

  it('leaves out, each with its reason, what is not a link, repeated, a list or not downloadable — in the order pasted', async () => {
    const {engine} = setup('mixed')
    const counted = countPreflight(engine)
    const mix = await engine.analyzeMix(
      [
        'https://fake.test/m1',
        'not a link',
        'https://fake.test/unavailable-m2',
        'https://www.youtube.com/playlist?list=PL1',
        'https://fake.test/m1/',
        'https://fake.test/nosite-m3',
        // another link, the same media (the fake names media by the last path segment)
        'https://fake.test/m1?from=share',
        'https://fake.test/m4',
      ].join('\n'),
      {profile: audio},
    )
    assert.deepEqual(
      mix.valid.map(item => item.url),
      ['https://fake.test/m1', 'https://fake.test/m4'],
    )
    assert.deepEqual(
      mix.skipped.map(skip => [skip.line, skip.reason, skip.duplicateOf]),
      [
        [2, 'not-a-link', undefined],
        [3, 'unavailable', undefined],
        [4, 'listing', undefined],
        [5, 'duplicate', 1],
        [6, 'unsupported', undefined],
        [7, 'duplicate', 1],
      ],
    )
    assert.equal(mix.skipped[1]!.error?.hint, 'removed')
    assert.deepEqual(mix.summary.byReason, {'not-a-link': 1, unavailable: 1, listing: 1, duplicate: 2, unsupported: 1})
    assert.deepEqual(mix.summary.bySite, {web: 2})
    assert.equal(mix.summary.total, 8)
    // the list and the repeat never reached the network
    assert.deepEqual(counted(), {calls: 1, items: 5})
  })

  it('an empty paste checks nothing and leaves nothing', async () => {
    const {engine} = setup('empty')
    const counted = countPreflight(engine)
    const mix = await engine.analyzeMix('\n  \n')
    assert.deepEqual(mix, {valid: [], skipped: [], summary: {total: 0, valid: 0, skipped: 0, bySite: {}, byReason: {}}})
    assert.deepEqual(counted(), {calls: 0, items: 0})
  })

  it('a link the site would not check now (a bot check) stays in, to be checked as it downloads', async () => {
    const {engine} = setup('bot')
    const mix = await engine.analyzeMix('https://www.youtube.com/watch?v=bot-b1\nhttps://fake.test/b2', {
      profile: audio,
    })
    assert.deepEqual(
      mix.valid.map(item => [item.url, item.analysis === undefined]),
      [
        ['https://www.youtube.com/watch?v=bot-b1', true],
        ['https://fake.test/b2', false],
      ],
    )
  })

  it('marks what is already downloaded with the profile, and leaves out what is damaged at the source', async () => {
    const {engine, scheduler, out} = setup('archived')
    scheduler.schedule({url: 'https://fake.test/d1', profile: audio, outDir: out})
    await scheduler.whenIdle()
    await engine.damaged.add({
      url: 'https://fake.test/d2',
      extractor: 'Fake',
      mediaId: 'd2',
      reason: 'broken at the source',
      issues: ['decode-failed'],
    })
    const mix = await engine.analyzeMix('https://fake.test/d1\nhttps://fake.test/d2\nhttps://fake.test/d3', {
      profile: audio,
    })
    assert.deepEqual(
      mix.valid.map(item => [item.url, item.archived === true]),
      [
        ['https://fake.test/d1', true],
        ['https://fake.test/d3', false],
      ],
    )
    assert.deepEqual(
      mix.skipped.map(skip => [skip.line, skip.reason, skip.error?.hint]),
      [[2, 'damaged', 'damaged-source']],
    )
    // without a profile nothing can be called downloaded already
    const plain = await engine.analyzeMix('https://fake.test/d1')
    assert.equal(plain.valid[0]!.archived, undefined)
  })

  it('a cancel rejects and leaves no metadata behind', async () => {
    const {engine, dataDir} = setup('cancel')
    const controller = new AbortController()
    const pending = engine.analyzeMix(
      Array.from({length: 40}, (_, i) => `https://fake.test/c${i}`),
      {signal: controller.signal, onProgress: step => step.checked >= 2 && controller.abort()},
    )
    await assert.rejects(pending, {code: 'cancelled'})
    const cache = await fs.readdir(path.join(dataDir, 'cache')).catch(() => [])
    assert.deepEqual(
      cache.filter(name => name.startsWith('info-')),
      [],
    )
  })

  it('checks hundreds of links in one pass, chunked by the engine', async () => {
    const {engine} = setup('large')
    const counted = countPreflight(engine)
    const links = Array.from({length: 300}, (_, i) => `https://fake.test/l${i}`)
    const mix = await engine.analyzeMix([...links, ...links.slice(0, 50)])
    assert.equal(mix.valid.length, 300)
    assert.equal(mix.summary.byReason.duplicate, 50)
    assert.deepEqual(counted(), {calls: 1, items: 300})
    assert.deepEqual(
      mix.valid.slice(0, 3).map(item => item.url),
      links.slice(0, 3),
      'in the order pasted, whatever order the checks answered in',
    )
  })
})

describe('BatchScheduler.scheduleMix: one batch', () => {
  it('downloads a checked mix list as exactly one batch, without checking it again, straight into the folder', async () => {
    const {engine, scheduler, out} = setup('one-batch')
    const mix = await engine.analyzeMix(
      'https://fake.test/o1\nhttps://fake.test/unavailable-o2\nhttps://fake.test/o3',
      {
        profile: audio,
      },
    )
    const counted = countPreflight(engine)
    const batch = scheduler.scheduleMix(mix, {profile: audio, outDir: out, title: 'Mix list · today'})
    assert.equal(batch.mix, true)
    assert.equal(scheduler.batches().length, 1)
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.title, 'Mix list · today')
    assert.equal(done.jobs.succeeded, 2)
    assert.deepEqual(counted(), {calls: 0, items: 0}, 'its checks were taken as they were')
    assert.equal(scheduler.batches().length, 1)
    const files = await fs.readdir(out)
    assert.equal(files.length, 2, `${files}`)
    assert.ok(
      files.every(name => !/^\d+ - /.test(name)),
      'named as single downloads, not numbered as a list',
    )
    assert.deepEqual(
      scheduler.items(batch.id).map(item => item.url),
      ['https://fake.test/o1', 'https://fake.test/o3'],
    )
  })

  it('takes a pasted text as it is: one batch that checks its links itself and shows the unavailable ones', async () => {
    const {engine, scheduler, out} = setup('from-text')
    const counted = countPreflight(engine)
    const batch = scheduler.scheduleMix(
      'https://fake.test/t1\nhttps://www.youtube.com/@nasa\nhttps://fake.test/t1#again\nhttps://fake.test/unavailable-t2',
      {profile: audio, outDir: out},
    )
    await scheduler.whenIdle()
    const done: BatchSnapshot = scheduler.batch(batch.id)!
    assert.equal(done.title, 'Mix list')
    assert.equal(done.preflight.total, 2, 'the channel and the repeat left out')
    assert.equal(done.preflight.unavailable, 1)
    assert.equal(done.jobs.succeeded, 1)
    assert.deepEqual(done.problems?.unavailable, {removed: 1})
    assert.deepEqual(counted(), {calls: 1, items: 2})
    assert.equal(scheduler.batches().length, 1)
  })

  it('a link can have a format of its own: one song as audio among videos, same batch, same folder, no second check', async () => {
    const {engine, scheduler, out} = setup('mix-formats')
    const video = {kind: 'video', container: 'mp4'} as const
    const mix = await engine.analyzeMix('https://fake.test/f1\nhttps://fake.test/f2\nhttps://fake.test/f3', {
      profile: video,
    })
    const counted = countPreflight(engine)
    const batch = scheduler.scheduleMix(mix, {
      profile: video,
      outDir: out,
      // f3 as the batch's own format: no target for it
      formats: {'https://fake.test/f2': audio, 'https://fake.test/f3': video},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 3)
    assert.equal(scheduler.batches().length, 1)
    assert.deepEqual(counted(), {calls: 0, items: 0})
    const files = (await fs.readdir(out)).sort()
    assert.deepEqual(
      files.map(name => path.extname(name)),
      ['.mp4', '.m4a', '.mp4'],
      `${files}`,
    )
    const jobs = engine.jobs().filter(job => job.batchId === batch.id)
    assert.deepEqual(jobs.map(job => [job.url, job.profile.kind]).sort(), [
      ['https://fake.test/f1', 'video'],
      ['https://fake.test/f2', 'audio'],
      ['https://fake.test/f3', 'video'],
    ])
  })

  it('a link can have a folder of its own: the song in Music, the videos in Movies, one batch', async () => {
    const {engine, scheduler, out} = setup('mix-folders')
    const video = {kind: 'video', container: 'mp4'} as const
    const movies = path.join(out, 'Movies')
    const music = path.join(out, 'Music')
    const mix = await engine.analyzeMix('https://fake.test/g1\nhttps://fake.test/g2\nhttps://fake.test/g3', {
      profile: video,
    })
    const batch = scheduler.scheduleMix(mix, {
      profile: video,
      outDir: movies,
      formats: {'https://fake.test/g2': audio},
      // g3's folder is the batch's own: no target for it
      outDirs: {'https://fake.test/g2': music, 'https://fake.test/g3': movies},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 3)
    assert.deepEqual(
      (await fs.readdir(movies)).map(name => path.extname(name)),
      ['.mp4', '.mp4'],
    )
    assert.deepEqual(
      (await fs.readdir(music)).map(name => path.extname(name)),
      ['.m4a'],
    )
    assert.throws(
      () => scheduler.scheduleMix(mix, {profile: video, outDir: movies, outDirs: {'https://fake.test/g1': 'Music'}}),
      {code: 'invalid-request'},
    )
  })

  it('a song in a list of videos is kept as M4A, not left out; a format of its own still wins', async () => {
    const {engine, scheduler, out} = setup('mix-song')
    const video = {kind: 'video', container: 'mp4'} as const
    const mix = await engine.analyzeMix('https://fake.test/v1\nhttps://fake.test/song-s1\nhttps://fake.test/song-s2', {
      profile: video,
    })
    assert.equal(mix.skipped.length, 0, JSON.stringify(mix.skipped))
    assert.deepEqual(
      mix.valid.map(item => [item.url, item.format?.container]),
      [
        ['https://fake.test/v1', undefined],
        ['https://fake.test/song-s1', 'm4a'],
        ['https://fake.test/song-s2', 'm4a'],
      ],
    )
    const counted = countPreflight(engine)
    const batch = scheduler.scheduleMix(mix, {
      profile: video,
      outDir: out,
      formats: {'https://fake.test/song-s2': {kind: 'audio', container: 'mp3'}},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 3)
    assert.deepEqual(counted(), {calls: 0, items: 0}, 'nothing checked twice')
    const jobs = engine.jobs().filter(job => job.batchId === batch.id)
    assert.deepEqual(jobs.map(job => [job.url, job.profile.kind, job.profile.container]).sort(), [
      ['https://fake.test/song-s1', 'audio', 'm4a'],
      ['https://fake.test/song-s2', 'audio', 'mp3'],
      ['https://fake.test/v1', 'video', 'mp4'],
    ])
  })

  it('a song already downloaded as M4A is marked archived in a list of videos', async () => {
    const {engine, scheduler, out} = setup('mix-song-archived')
    const video = {kind: 'video', container: 'mp4'} as const
    const first = await engine.analyzeMix('https://fake.test/song-a1', {profile: video})
    scheduler.scheduleMix(first, {profile: video, outDir: out})
    await scheduler.whenIdle()
    const again = await engine.analyzeMix('https://fake.test/song-a1', {profile: video})
    assert.equal(again.valid[0]?.archived, true)
  })

  it('refuses a mix list with nothing to download', async () => {
    const {engine, scheduler, out} = setup('nothing')
    const mix = await engine.analyzeMix('https://fake.test/unavailable-n1\nnothing here')
    assert.throws(() => scheduler.scheduleMix(mix, {profile: audio, outDir: out}), {code: 'invalid-request'})
    assert.throws(() => scheduler.scheduleMix('', {profile: audio, outDir: out}), {code: 'invalid-request'})
    assert.equal(scheduler.batches().length, 0)
  })

  it('a link not checked yet (a bot check) is checked by the batch, the rest are not', async () => {
    const {engine, scheduler, out} = setup('mix-bot')
    const mix = await engine.analyzeMix('https://www.youtube.com/watch?v=bot-k1\nhttps://fake.test/k2', {
      profile: audio,
    })
    const counted = countPreflight(engine)
    const batch = scheduler.scheduleMix(mix, {profile: audio, outDir: out})
    await scheduler.whenIdle()
    assert.deepEqual(counted(), {calls: 1, items: 1})
    assert.equal(scheduler.batch(batch.id)!.jobs.succeeded, 2)
  })

  it('cancels like any batch, and deletes the metadata its checks kept', async () => {
    // one batch at a time: the mix list is still scheduled, never checked, when it is cancelled
    const {engine, scheduler, out, dataDir} = setup('mix-cancel', {maxActiveBatches: 1})
    const blocker = scheduler.schedule({url: 'https://fake.test/list?n=2&p=slow-', profile: audio, outDir: out})
    const mix = await engine.analyzeMix('https://fake.test/x1\nhttps://fake.test/x2', {profile: audio})
    const batch = scheduler.scheduleMix(mix, {profile: audio, outDir: path.join(out, 'mix')})
    assert.equal(scheduler.batch(batch.id)!.status, 'scheduled')
    scheduler.cancel(batch.id)
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)!.status, 'cancelled')
    assert.equal(scheduler.batch(blocker.id)!.status, 'completed')
    await new Promise(resolve => setTimeout(resolve, 50))
    const cache = await fs.readdir(path.join(dataDir, 'cache')).catch(() => [])
    assert.deepEqual(
      cache.filter(name => name.startsWith('info-')),
      [],
    )
  })

  it('resumes after a restart as the same mix list, without checking it again', async () => {
    const first = setup('mix-restore')
    const mix = await first.engine.analyzeMix('https://fake.test/r1\nhttps://fake.test/r2', {profile: audio})
    first.engine.pause() // nothing downloads before the "crash"
    first.scheduler.scheduleMix(mix, {profile: audio, outDir: first.out, title: 'Saved mix'})
    await new Promise(resolve => setTimeout(resolve, 200))
    await first.scheduler.dispose()
    await first.engine.dispose()

    const engine = new MediaDownloader({
      dataDir: first.dataDir,
      binaries: fakes,
      validation: 'none',
      progressIntervalMs: 0,
    })
    const scheduler = new BatchScheduler(engine)
    cleanups.push(async () => {
      await scheduler.dispose()
      await engine.dispose()
    })
    const counted = countPreflight(engine)
    const [restored] = await scheduler.restore()
    assert.equal(restored?.mix, true)
    await scheduler.whenIdle()
    const done = scheduler.batch(restored!.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.title, 'Saved mix')
    assert.equal(done.jobs.succeeded, 2)
    assert.deepEqual(counted(), {calls: 0, items: 0})
  })

  it('without a preflight (the phone), the checked links still bring their titles and sizes', async () => {
    const {engine, scheduler, out} = setup('no-preflight', {preflight: false})
    const mix = await engine.analyzeMix('https://fake.test/p1?size=4000', {profile: audio})
    const batch = scheduler.scheduleMix(mix, {profile: audio, outDir: out})
    await scheduler.whenIdle()
    const [item] = scheduler.items(batch.id)
    assert.equal(item?.title, 'Title p1')
    assert.equal(item?.estimatedBytes, 4000)
    assert.equal(scheduler.batch(batch.id)!.status, 'completed')
  })
})
