import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {DownloadArchive} from '../src/core/archive.js'
import {DownloadError} from '../src/core/errors.js'
import {cpuShare, maxConcurrency} from '../src/core/pool.js'
import {cpuShares, MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import type {MediaResolver} from '../src/sources/browser.js'
import {PlayerPageSource} from '../src/sources/player-page/source.js'
import {type MediaSource, SOURCE_FORMAT_CHANGED} from '../src/sources/source.js'
import type {BatchStatus, PlaylistEntry} from '../src/types.js'
import {startFakePlayerSite} from './helpers/fake-player-site.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

let root = ''
let fakes: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-later-'))
  fakes = await writeFakes(path.join(root, 'fakes'))
})

after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

function setup(name: string, engineOptions: Partial<ConstructorParameters<typeof MediaDownloader>[0]> = {}) {
  const dataDir = path.join(root, name)
  const engine = new MediaDownloader({
    dataDir,
    binaries: fakes,
    validation: 'quick',
    maxRetries: 2,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: false,
    instagram: false,
    facebook: false,
    ...engineOptions,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  const statuses = new Map<string, BatchStatus[]>()
  scheduler.on('batch', batch => {
    const seen = statuses.get(batch.id) ?? []
    if (seen.at(-1) !== batch.status) seen.push(batch.status)
    statuses.set(batch.id, seen)
  })
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
  })
  return {engine, scheduler, statuses, dataDir, out: path.join(dataDir, 'out')}
}

const mp4 = {kind: 'video', container: 'mp4'} as const
const entry = (id: string, index: number): PlaylistEntry => ({
  id,
  index,
  url: `https://fake.test/${id}`,
  title: `Picked ${id}`,
  duration: 10,
  extractor: 'Fake',
  isLive: false,
})
const attempts = async (dataDir: string, id: string) =>
  Number(await fs.readFile(path.join(dataDir, `attempts-${id}`), 'utf8').catch(() => '0'))

describe('CPU share', () => {
  it('allows from half up to 60% of the processors, never less than one job', () => {
    assert.equal(maxConcurrency(10), 5)
    assert.equal(maxConcurrency(10, 0.6), 6)
    assert.equal(maxConcurrency(16, 0.6), 9)
    assert.equal(maxConcurrency(8, 0.6), 4, 'on 8 processors 60% is still 4 jobs')
    assert.equal(maxConcurrency(1, 0.6), 1)
    assert.equal(cpuShare(0.9), 0.6, 'never above 60%')
    assert.equal(cpuShare(0.2), 0.5)
    assert.equal(cpuShare(Number.NaN), 0.5)
  })

  it('shares the threads of a check by file size: every file one at least, all of them the budget', () => {
    assert.deepEqual(cpuShares(7, [1100, 684, 616, 431, 300, 270]), [2, 1, 1, 1, 1, 1])
    assert.deepEqual(cpuShares(12, [1000, 100, 100]), [8, 2, 2])
    assert.deepEqual(cpuShares(4, [5, 5, 5, 5, 5]), [1, 1, 1, 1, 1])
    assert.deepEqual(cpuShares(6, [0, 0]), [3, 3])
    assert.deepEqual(cpuShares(6, []), [])
    for (const weights of [
      [3, 1],
      [9, 9, 1],
      [1, 2, 3, 4],
    ]) {
      assert.equal(
        cpuShares(10, weights).reduce((a, b) => a + b, 0),
        10,
      )
    }
  })

  it('a lower share lowers a concurrency above its ceiling at once', () => {
    const {engine} = setup('share', {maxCpuShare: 0.6, concurrency: 999})
    assert.equal(engine.maxCpuShare, 0.6)
    assert.equal(engine.concurrency, engine.concurrencyCeiling)
    engine.setMaxCpuShare(0.5)
    assert.equal(engine.concurrency, MediaDownloader.maxConcurrency(0.5))
    assert.ok(engine.concurrency <= MediaDownloader.maxConcurrency(0.6))
  })
})

describe('cancelling one download of a batch', () => {
  it('drops only that item: the batch goes on, completes, and has nothing to retry', async () => {
    const {engine, scheduler, statuses, out} = setup('cancel-one', {validation: 'none', concurrency: 2})
    const entries = Array.from({length: 6}, (_, i) => entry(`slow-${i}`, i + 1))
    const batch = scheduler.schedule({
      url: 'https://fake.test/list',
      profile: mp4,
      outDir: out,
      selection: {title: 'Six', entries},
    })
    let running: string | undefined
    let queued: string | undefined
    engine.on('job', job => {
      if (running || job.status !== 'downloading') return
      running = job.id
      engine.cancel(job.id)
      // and one still waiting for its turn
      queued = engine.jobs().findLast(other => other.status === 'queued')?.id
      if (queued) engine.cancel(queued as never)
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.ok(running && queued, 'a running and a queued job were cancelled')
    assert.deepEqual(statuses.get(batch.id), ['scheduled', 'checking', 'running', 'completed'])
    assert.deepEqual(done.jobs, {total: 6, queued: 0, running: 0, succeeded: 4, failed: 0, cancelled: 2})
    assert.equal(done.problems, undefined, 'a cancel is not a problem of the batch')
    assert.equal(scheduler.retryFailed(batch.id), 0, '"retry failed" leaves cancelled items alone')

    // the user can still bring one back: the batch reopens for it
    assert.ok(scheduler.retryJob(running as never))
    await scheduler.whenIdle()
    assert.deepEqual(scheduler.batch(batch.id)!.jobs, {
      total: 6,
      queued: 0,
      running: 0,
      succeeded: 5,
      failed: 0,
      cancelled: 1,
    })
  })

  it('a batch whose every download was cancelled is cancelled', async () => {
    const {engine, scheduler, out} = setup('cancel-all', {validation: 'none', concurrency: 1})
    const batch = scheduler.schedule({url: 'https://fake.test/slow-only', profile: mp4, outDir: out})
    engine.on('job', job => {
      if (job.status === 'downloading') engine.cancel(job.id)
    })
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)!.status, 'cancelled')
  })
})

describe('damaged at the source', () => {
  it('a file that fails its check twice is marked damaged, not retried further, and never downloaded again', async () => {
    const {engine, scheduler, dataDir, out} = setup('damaged-during')
    const first = scheduler.schedule({url: 'https://fake.test/broken-1', profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const closed = scheduler.batch(first.id)!
    assert.equal(closed.status, 'failed')
    assert.deepEqual(closed.problems?.failed, {'damaged-source': 1})
    assert.equal(await attempts(dataDir, 'broken-1'), 2, 'two downloads prove it, the third is saved')
    assert.equal(scheduler.retryFailed(first.id), 0, '"retry failed" does not offer it again')
    const [job] = engine.jobs()
    assert.equal(job?.error?.hint, 'damaged-source')
    const known = await engine.isDamaged({url: 'https://fake.test/broken-1'})
    assert.ok(known)
    assert.deepEqual(known.issues, ['decode-failed'])
    assert.equal((await engine.damaged.list()).length, 1)

    // asked again (alone, or in a list): the check says so and nothing is downloaded
    const again = scheduler.schedule({
      url: 'https://fake.test/list',
      profile: mp4,
      outDir: out,
      selection: {title: 'Again', entries: [entry('broken-1', 1), entry('fine-1', 2)]},
    })
    await scheduler.whenIdle()
    const second = scheduler.batch(again.id)!
    assert.equal(second.status, 'completed-with-errors')
    assert.deepEqual(second.problems?.unavailable, {'damaged-source': 1})
    assert.equal(second.jobs.total, 1, 'only the good one became a job')
    const [damagedItem] = scheduler.items(again.id)
    assert.equal(damagedItem?.state, 'unavailable')
    assert.equal(damagedItem?.error?.hint, 'damaged-source')
    assert.equal(await attempts(dataDir, 'broken-1'), 2, 'not downloaded again')

    // a loose job of it fails at once too
    const loose = engine.add({url: 'https://fake.test/broken-1', profile: mp4, outDir: out})
    await engine.whenIdle()
    assert.equal(engine.job(loose.id)?.error?.hint, 'damaged-source')
    assert.equal(await attempts(dataDir, 'broken-1'), 2)

    // forgotten (the user wants to try again): it downloads again
    assert.equal(await engine.damaged.remove(known.key), true)
    assert.equal(await engine.isDamaged({url: 'https://fake.test/broken-1'}), undefined)
  })

  it('with checks after the batch: downloads first, then checks; a broken file is marked damaged and kept', async () => {
    const {engine, scheduler, statuses, dataDir, out} = setup('after-batch', {validationTiming: 'after-batch'})
    assert.equal(engine.validationTiming, 'after-batch')
    let validatingWhileDownloading = false
    engine.on('job', job => {
      if (job.status === 'validating' && job.progress.fraction !== undefined && job.progress.fraction > 0)
        validatingWhileDownloading = true
    })
    const batch = scheduler.schedule({
      url: 'https://fake.test/list',
      profile: mp4,
      outDir: out,
      selection: {title: 'Later', entries: [entry('ok-1', 1), entry('broken-2', 2), entry('ok-3', 3)]},
    })
    let pendingSeen = 0
    scheduler.on('batch', snapshot => {
      if (snapshot.id === batch.id && snapshot.status === 'validating') {
        pendingSeen = engine.jobs().filter(job => job.validationPending).length || pendingSeen
      }
    })
    await scheduler.whenIdle()
    assert.equal(validatingWhileDownloading, false)
    assert.deepEqual(statuses.get(batch.id), [
      'scheduled',
      'checking',
      'running',
      'validating',
      'completed-with-errors',
    ])
    assert.equal(pendingSeen > 0, true, 'files waited for the check')
    const done = scheduler.batch(batch.id)!
    assert.equal(done.jobs.succeeded, 2)
    assert.equal(done.jobs.failed, 1)
    assert.deepEqual(done.problems?.failed, {'damaged-source': 1})
    assert.equal(done.validation, undefined, 'no check in progress any more')
    assert.equal(await attempts(dataDir, 'broken-2'), 1, 'downloaded once, not retried')

    const jobs = engine.jobs()
    assert.ok(jobs.every(job => !job.validationPending))
    const broken = jobs.find(job => job.mediaId === 'broken-2')!
    assert.equal(broken.status, 'failed')
    assert.equal(broken.error?.hint, 'damaged-source')
    assert.equal(broken.steps.find(step => step.name === 'validate')?.state, 'failed')

    const history = await engine.archive.list({batchId: batch.id})
    assert.equal(history.total, 3)
    const byId = new Map(history.entries.map(item => [item.mediaId, item]))
    assert.equal(byId.get('ok-1')?.validation, 'quick')
    assert.equal(byId.get('ok-3')?.validation, 'quick')
    assert.equal(byId.get('broken-2')?.validation, 'quick')
    assert.match(byId.get('broken-2')?.damaged ?? '', /Decoding failed/)
    assert.ok(await fs.stat(byId.get('broken-2')!.filepath), 'the damaged file is kept where it is')
    assert.ok(await engine.isDamaged({extractor: 'Fake', mediaId: 'broken-2'}))
  })
})

describe('a batch longer than the jobs the engine keeps', () => {
  it('still checks every file after its downloads', async () => {
    const {engine, scheduler, out} = setup('long-batch-later', {
      validationTiming: 'after-batch',
      retainFinishedJobs: 2,
      concurrency: 2,
    })
    const entries = Array.from({length: 7}, (_, i) => entry(`long-${i}`, i + 1))
    const batch = scheduler.schedule({
      url: 'https://fake.test/list',
      profile: mp4,
      outDir: out,
      selection: {title: 'L', entries},
    })
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)!.status, 'completed')
    const history = await engine.archive.list({batchId: batch.id})
    assert.equal(history.total, 7)
    assert.ok(
      history.entries.every(item => item.validation === 'quick'),
      'every file was checked, the released ones too',
    )
  })
})

describe('cancelling a batch while it checks its files', () => {
  it('stops the check; what was not checked stays finished, unchecked, and no longer waits', async () => {
    const {engine, scheduler, out} = setup('cancel-while-checking', {
      validationTiming: 'after-batch',
      validation: 'full',
      concurrency: 1,
    })
    const entries = Array.from({length: 4}, (_, i) => entry(`chk-${i}`, i + 1))
    const batch = scheduler.schedule({
      url: 'https://fake.test/list',
      profile: mp4,
      outDir: out,
      selection: {title: 'C', entries},
    })
    scheduler.on('batch', snapshot => {
      if (snapshot.id === batch.id && snapshot.status === 'validating') scheduler.cancel(batch.id)
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'cancelled')
    assert.ok(
      engine.jobs().every(job => !job.validationPending),
      'nothing says it still waits',
    )
    assert.equal((await engine.archive.list({batchId: batch.id})).total, 4, 'the files stay in the history')
  })
})

describe('a batch gathering items of several batches', () => {
  it('puts each item in its own folder, with its own profile and list position', async () => {
    const {engine, scheduler, out} = setup('targets', {validation: 'none'})
    const a = path.join(out, 'List A')
    const b = path.join(out, 'List B')
    const batch = scheduler.schedule({
      url: 'https://fake.test/t1',
      profile: mp4,
      outDir: out,
      selection: {title: 'Failed downloads', entries: [entry('t1', 1), entry('t2', 2)]},
      targets: [
        {index: 1, outDir: a, profile: mp4, playlist: {id: 'A', title: 'List A', index: 7}},
        {index: 2, outDir: b, profile: {kind: 'audio', container: 'm4a'}},
      ],
    })
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)!.status, 'completed')
    const files = engine.jobs().map(job => job.filepath!)
    assert.equal(files.length, 2)
    assert.ok(files.some(file => path.dirname(file) === a && /^007/.test(path.basename(file))))
    assert.ok(files.some(file => path.dirname(file) === b && file.endsWith('.m4a')))
    assert.throws(
      () =>
        scheduler.schedule({
          url: 'https://fake.test/t1',
          profile: mp4,
          outDir: out,
          targets: [{index: 1, outDir: 'relative', profile: mp4}],
        }),
      /absolute outDir/,
    )
  })
})

describe('archive', () => {
  it('updates a record in place, filters with a host predicate, sorts by size and forgets many at once', async () => {
    const archive = new DownloadArchive(path.join(root, 'archive-test', 'archive.jsonl'))
    const base = {extractor: 'x', profile: 'video:mp4', url: 'https://x.test/', filepath: '/f'}
    for (const [id, size] of [
      ['a', 10],
      ['b', 30],
      ['c', 20],
    ] as const) {
      await archive.add({...base, key: id, mediaId: id, sizeBytes: size, filepath: `/f/${id}`})
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    const before = (await archive.list()).entries.map(item => item.key)
    assert.deepEqual(before, ['c', 'b', 'a'])
    const updated = await archive.update('a', {validation: 'full', damaged: 'broken'})
    assert.equal(updated?.damaged, 'broken')
    assert.deepEqual(
      (await archive.list()).entries.map(item => item.key),
      before,
      'same place in the history',
    )
    assert.equal(await archive.update('nope', {damaged: 'x'}), undefined)
    assert.deepEqual(
      (await archive.list({sort: 'largest'})).entries.map(item => item.key),
      ['b', 'c', 'a'],
    )
    assert.deepEqual(
      (await archive.list({sort: 'smallest'})).entries.map(item => item.key),
      ['a', 'c', 'b'],
    )
    assert.deepEqual(
      (await archive.list({sort: 'oldest'})).entries.map(item => item.key),
      ['a', 'b', 'c'],
    )
    const big = await archive.list({match: item => item.sizeBytes >= 20})
    assert.deepEqual([big.total, big.bytes], [2, 50])
    await archive.close()

    // after a restart the updated record keeps its place (by when it finished)
    const reopened = new DownloadArchive(archive.file)
    assert.deepEqual(
      (await reopened.list()).entries.map(item => item.key),
      before,
    )
    assert.equal((await reopened.list()).entries.at(-1)?.damaged, 'broken')
    assert.equal(await reopened.removeMany(['a', 'b', 'missing']), 2)
    assert.equal((await reopened.list()).total, 1)
    await reopened.close()
  })
})

describe('a player-page site that misbehaves', () => {
  async function siteSetup(
    name: string,
    config: Parameters<typeof startFakePlayerSite>[0],
    resolveMedia?: MediaResolver,
  ) {
    const site = await startFakePlayerSite({results: 3, perPage: 3, ...config})
    const source = new PlayerPageSource({
      site: {name: 'Local Site', hosts: [site.host]},
      pacing: {concurrency: 4, spacingMs: 0, jitterMs: 0},
      resolveMedia: resolveMedia ?? site.resolve,
      resolveTimeoutMs: 300,
    })
    const {engine, scheduler, dataDir, out} = setup(name, {validation: 'none', sources: [source], maxRetries: 3})
    cleanups.push(() => site.close())
    return {site, engine, scheduler, dataDir, out}
  }

  it('a page whose player never answers fails its attempts instead of holding a slot forever', async () => {
    let stuck = ''
    const {site, scheduler, out} = await siteSetup('player-stuck', {}, async (page, signal) => {
      // the first video's page never gives its player a link (and ignores being told to stop)
      if (page.includes(`/video/${stuck}/`)) return new Promise<never>(() => {})
      return site.resolve(page, signal)
    })
    stuck = site.ids[0]!
    const batch = scheduler.schedule({url: site.searchUrl('x'), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed-with-errors', 'the batch closes')
    assert.equal(done.jobs.succeeded, 2)
    assert.deepEqual(done.problems?.failed, {'retry-later': 1})
  })

  it('a file served whole but unreadable ("moov atom not found") is damaged at the source after two tries', async () => {
    const bad = await siteSetup('player-nomoov', {brokenMedia: ['10003']})
    const batch = bad.scheduler.schedule({url: bad.site.searchUrl('x'), profile: mp4, outDir: bad.out})
    await bad.scheduler.whenIdle()
    const done = bad.scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed-with-errors')
    assert.deepEqual(done.problems?.failed, {'damaged-source': 1})
    const failed = bad.engine.jobs().find(job => job.status === 'failed')!
    assert.equal(failed.attempt, 2, 'tried twice, not four times')
    assert.ok(await bad.engine.isDamaged({url: failed.url}))
  })
})

describe('a link neither the site’s source nor yt-dlp can read', () => {
  it('says the source’s reason, not yt-dlp’s "Unsupported URL"', async () => {
    const stub: MediaSource = {
      name: 'Stub',
      available: true,
      handles: url => url.includes('nosite-stub'),
      analyze: async () => {
        throw new DownloadError('unknown', 'Stub no longer accepts this request (HTTP 400).', SOURCE_FORMAT_CHANGED)
      },
      preflight: async () => new Map(),
      download: async () => {
        throw new Error('not used')
      },
    }
    const {engine} = setup('source-reason', {sources: [stub]})
    await assert.rejects(engine.analyze('https://fake.test/nosite-stub/videos'), (error: Error) => {
      assert.equal(error.message, 'Stub no longer accepts this request (HTTP 400).')
      return true
    })
  })
})
