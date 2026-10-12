import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {MAX_REQUESTED_ITEMS} from '../src/core/analyze.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import type {BatchSnapshot, BatchStatus, LogEntry} from '../src/types.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

let root = ''
let fakes: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-sched-'))
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
  })
  const scheduler = new BatchScheduler(engine, options)
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

const audio = {kind: 'audio', container: 'm4a'} as const

describe('BatchScheduler', () => {
  it('runs batches one at a time: the next waits, then starts by itself', async () => {
    const {scheduler, statuses, out} = setup('fifo')
    let maxActive = 0
    scheduler.on('batch', () => {
      const active = scheduler.batches().filter(b => b.status === 'checking' || b.status === 'running').length
      maxActive = Math.max(maxActive, active)
    })
    const first = scheduler.schedule({url: 'https://fake.test/list-a', profile: audio, outDir: out})
    const second = scheduler.schedule({url: 'https://fake.test/slow-b', profile: audio, outDir: out})
    assert.equal(second.status, 'scheduled')
    assert.equal(scheduler.batch(second.id)?.position, 1)

    await scheduler.whenIdle()
    assert.equal(maxActive, 1, 'never two batches at once')
    assert.deepEqual(statuses.get(first.id), ['scheduled', 'checking', 'running', 'completed'])
    assert.deepEqual(statuses.get(second.id), ['scheduled', 'checking', 'running', 'completed'])
    const done = scheduler.batch(first.id)!
    assert.equal(done.kind, 'playlist')
    assert.deepEqual(done.jobs, {total: 3, queued: 0, running: 0, succeeded: 3, failed: 0})
    assert.ok(done.startedAt! <= scheduler.batch(second.id)!.startedAt!)
  })

  it('caps a list at maxItems (listed by yt-dlp itself) and rejects invalid caps', async () => {
    const {scheduler, out} = setup('cap')
    const capped = scheduler.schedule({url: 'https://fake.test/list?n=80', profile: audio, outDir: out, maxItems: 30})
    assert.equal(capped.maxItems, 30)
    await scheduler.whenIdle()
    const done = scheduler.batch(capped.id)!
    assert.equal(done.preflight.total, 30)
    assert.equal(done.jobs.succeeded, 30)
    for (const bad of [0, -1, 1.5, MAX_REQUESTED_ITEMS + 1]) {
      assert.throws(
        () => scheduler.schedule({url: 'https://fake.test/list', profile: audio, outDir: out, maxItems: bad}),
        /maxItems/,
      )
    }
  })

  it('downloads exactly a preview selection without listing the url again', async () => {
    const {scheduler, out} = setup('selection')
    const entry = (id: string, index: number) => ({
      id,
      index,
      url: `https://fake.test/${id}`,
      title: `Picked ${id}`,
      duration: 10,
      extractor: 'Fake',
      isLive: false,
    })
    // the url would list 80 items; the selection holds 2 of them
    const batch = scheduler.schedule({
      url: 'https://fake.test/list?n=80',
      profile: audio,
      outDir: out,
      selection: {title: 'My picks', entries: [entry('b3', 3), entry('b7', 7)]},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.title, 'My picks')
    assert.equal(done.preflight.total, 2)
    assert.equal(done.jobs.succeeded, 2)
    assert.deepEqual(
      scheduler.items(batch.id).map(item => item.index),
      [3, 7],
    )
    assert.throws(
      () =>
        scheduler.schedule({
          url: 'https://fake.test/x',
          profile: audio,
          outDir: out,
          selection: {title: 'x', entries: []},
        }),
      /must not be empty/,
    )
  })

  it('a YouTube Mix is capped at 50 items unless the request says otherwise', () => {
    const {scheduler, out} = setup('mix')
    const mix = 'https://www.youtube.com/watch?v=k1gsZ-OsGpI&list=RDk1gsZ-OsGpI&start_radio=1'
    const byDefault = scheduler.schedule({url: mix, profile: audio, outDir: out})
    const chosen = scheduler.schedule({url: mix, profile: audio, outDir: out, maxItems: 10})
    const plain = scheduler.schedule({url: 'https://www.youtube.com/playlist?list=PLx', profile: audio, outDir: out})
    assert.equal(byDefault.maxItems, 50)
    assert.equal(chosen.maxItems, 10)
    assert.equal(plain.maxItems, undefined)
    for (const batch of [byDefault, chosen, plain]) scheduler.cancel(batch.id)
  })

  it('running batches report weighted progress and, once measured, the time left', async () => {
    const {scheduler, out} = setup('eta', {progressIntervalMs: 0})
    const seen: Array<NonNullable<BatchSnapshot['progress']>> = []
    scheduler.on('batch', batch => {
      if (batch.progress) seen.push(batch.progress)
    })
    const batch = scheduler.schedule({url: 'https://fake.test/list?n=6', profile: audio, outDir: out})
    await scheduler.whenIdle()
    assert.ok(seen.length > 0, 'progress is reported while running')
    for (const p of seen) assert.ok(p.fraction >= 0 && p.fraction <= 1)
    assert.ok(seen.some(p => p.fraction > 0))
    assert.equal(scheduler.batch(batch.id)?.progress, undefined, 'gone once closed')
  })

  it('preflight closes unavailable items with their hint and reuses the checked metadata', async () => {
    const {scheduler, dataDir, out} = setup('preflight')
    const batch = scheduler.schedule({url: 'https://fake.test/list-mixed', profile: audio, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed-with-errors')
    assert.deepEqual(done.preflight, {total: 4, checked: 4, ok: 3, unavailable: 1})
    const items = scheduler.items(batch.id)
    assert.equal(items.length, 4)
    assert.deepEqual(
      scheduler.items(batch.id, {offset: 1, limit: 2}).map(i => i.index),
      [2, 3],
    )
    const bad = items.find(item => item.state === 'unavailable')!
    assert.equal(bad.error?.code, 'unavailable')
    assert.equal(bad.error?.hint, 'removed')
    assert.equal(bad.jobId, undefined, 'unavailable items never become jobs')
    assert.equal(done.jobs.succeeded, 3)
    // the download step loaded the metadata fetched by the preflight instead of extracting again
    for (const id of ['e1', 'e2', 'e4']) await fs.access(path.join(dataDir, `used-info-json-${id}`))
  })

  it('a batch where nothing is downloadable fails without creating jobs', async () => {
    const {scheduler, out} = setup('allbad')
    const batch = scheduler.schedule({url: 'https://fake.test/unavailable-solo', profile: audio, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'failed')
    assert.equal(done.jobs.total, 0)
    assert.equal(done.error?.code, 'unavailable')
  })

  it('cancels a scheduled batch before it ever starts', async () => {
    const {scheduler, statuses, out} = setup('cancel')
    const first = scheduler.schedule({url: 'https://fake.test/slow-c', profile: audio, outDir: out})
    const second = scheduler.schedule({url: 'https://fake.test/slow-d', profile: audio, outDir: out})
    scheduler.cancel(second.id)
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(first.id)?.status, 'completed')
    assert.deepEqual(statuses.get(second.id), ['scheduled', 'cancelled'])
  })

  it('falls back to the best available format when the requested resolution does not exist', async () => {
    const {engine, scheduler, out} = setup('fallback')
    const logs: LogEntry[] = []
    engine.on('log', entry => logs.push(entry))
    const batch = scheduler.schedule({
      url: 'https://fake.test/nofmt-v',
      profile: {kind: 'video', container: 'mp4', maxHeight: 720},
      outDir: out,
    })
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed')
    const job = engine.jobs().find(j => j.batchId === batch.id)!
    assert.equal(job.outcome, 'success')
    assert.deepEqual(
      job.attempts.map(a => [a.strategy, a.error?.hint]),
      [
        ['primary', 'format-unavailable'],
        ['format-fallback', undefined],
      ],
    )
    assert.ok(logs.some(l => l.batchId === batch.id && /format not available — trying video:mp4:best/.test(l.message)))
  })

  it('runs long videos at ⌊N/3⌋ at once (weight 1.5) and classifies them', async () => {
    const {engine, scheduler, out} = setup('long')
    let running = 0
    let peak = 0
    engine.on('job', job => {
      const active = engine
        .jobs()
        .filter(j => ['downloading', 'processing', 'converting', 'validating', 'finalizing'].includes(j.status))
      running = active.length
      peak = Math.max(peak, running)
      assert.equal(job.tier, 'long')
    })
    const video = {kind: 'video', container: 'mp4', maxHeight: 1080} as const
    const batch = scheduler.schedule({url: 'https://fake.test/list?n=8&dur=3600', profile: video, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed')
    assert.equal(done.estimate?.long, 8)
    assert.ok(
      peak <= Math.max(1, Math.floor(engine.concurrency / 1.5)),
      `peak ${peak} with capacity ${engine.concurrency}`,
    )
  })

  it('blocks a batch that does not fit on disk before downloading anything', async () => {
    const {scheduler, out} = setup('disk')
    const huge = 10 ** 15 // 1 PB per item
    const batch = scheduler.schedule({url: `https://fake.test/list?n=3&size=${huge}`, profile: audio, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'failed')
    assert.equal(done.error?.code, 'disk-full')
    assert.equal(done.jobs.total, 0, 'nothing was downloaded')
    assert.ok((done.estimate?.bytes ?? 0) >= 3 * huge)
    assert.match(done.error?.message ?? '', /needs [0-9.,]+ [kMGT]?B and .* has [0-9.,]+ [kMGT]?B free/)
  })

  it("'warn' mode logs the shortage and continues", async () => {
    const {engine, scheduler, out} = setup('disk-warn', {diskCheck: 'warn'})
    const logs: LogEntry[] = []
    engine.on('log', entry => logs.push(entry))
    const batch = scheduler.schedule({url: `https://fake.test/list?n=2&size=${10 ** 15}`, profile: audio, outDir: out})
    await scheduler.whenIdle()
    assert.ok(logs.some(l => l.batchId === batch.id && l.code === 'disk-full' && l.level === 'warn'))
    assert.notEqual(scheduler.batch(batch.id)?.status, 'scheduled')
  })

  it('already downloaded items cost no disk in the forecast', async () => {
    const {scheduler, out} = setup('forecast-archived')
    const first = scheduler.schedule({url: 'https://fake.test/list?n=3', profile: audio, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(first.id)?.estimate?.archived, 0)
    const second = scheduler.schedule({url: 'https://fake.test/list?n=3', profile: audio, outDir: out})
    await scheduler.whenIdle()
    const again = scheduler.batch(second.id)!
    assert.equal(again.estimate?.archived, 3)
    assert.equal(again.estimate?.bytes, 0)
    assert.ok(scheduler.items(second.id).every(item => item.archived))
  })

  it('every batch log line carries the batch id', async () => {
    const {engine, scheduler, out} = setup('trace')
    const logs: LogEntry[] = []
    engine.on('log', entry => logs.push(entry))
    const batch = scheduler.schedule({url: 'https://fake.test/list-t', profile: audio, outDir: out})
    await scheduler.whenIdle()
    const mine = logs.filter(l => l.batchId === batch.id)
    assert.match(mine[0]!.message, /^batch scheduled/)
    assert.match(mine.at(-1)!.message, /^batch closed: completed — 3\/3 succeeded/)
    assert.ok(
      mine.some(l => l.jobId !== undefined),
      'job logs are linked to their batch',
    )
  })

  it('restores scheduled batches after a restart and skips what was already done', async () => {
    const first = setup('restore')
    const done = first.scheduler.schedule({url: 'https://fake.test/list-r', profile: audio, outDir: first.out})
    await first.scheduler.whenIdle()
    assert.equal(first.scheduler.batch(done.id)?.status, 'completed')
    first.engine.pause() // the next batch can't make progress before the "crash"
    first.scheduler.schedule({url: 'https://fake.test/list-r', profile: audio, outDir: first.out})
    await new Promise(resolve => setTimeout(resolve, 300))
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
    const restored = await scheduler.restore()
    assert.equal(restored.length, 1)
    await scheduler.whenIdle()
    const again: BatchSnapshot = scheduler.batch(restored[0]!.id)!
    assert.equal(again.status, 'completed')
    assert.ok(
      engine.jobs().every(job => job.status === 'skipped'),
      'already archived items are skipped',
    )
  })
})
