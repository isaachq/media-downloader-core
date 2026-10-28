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

function setup(
  name: string,
  options: ConstructorParameters<typeof BatchScheduler>[1] = {},
  engineOptions: Partial<ConstructorParameters<typeof MediaDownloader>[0]> = {},
) {
  const dataDir = path.join(root, name)
  const engine = new MediaDownloader({
    dataDir,
    binaries: fakes,
    validation: 'none',
    maxRetries: 2,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    ...engineOptions,
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
const video = {kind: 'video', container: 'mp4'} as const

/** How many items the scheduler hands to the engine's network check from now on. */
function countPreflight(engine: MediaDownloader): () => number {
  let items = 0
  const original = engine.preflight.bind(engine)
  engine.preflight = (list, opts) => {
    items += list.length
    return original(list, opts)
  }
  return () => items
}

describe('BatchScheduler', () => {
  it('with maxActiveBatches 1, runs batches one at a time: the next waits, then starts by itself', async () => {
    const {scheduler, statuses, out} = setup('fifo', {maxActiveBatches: 1})
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
    assert.deepEqual(done.jobs, {total: 3, queued: 0, running: 0, succeeded: 3, failed: 0, cancelled: 0})
    assert.ok(done.startedAt! <= scheduler.batch(second.id)!.startedAt!)
  })

  it('by default batches share the pool in turns: a slow one does not hold the next, which finishes first', async () => {
    // the pool is capped at ⌊CPUs/2⌋ (1 on a 3-core CI runner): two active batches are asked for
    // outright; with two slots the quick list also finishes first
    const {engine, scheduler, statuses, out} = setup('lanes', {maxActiveBatches: 2}, {concurrency: 2})
    let maxActive = 0
    scheduler.on('batch', () => {
      const active = scheduler.batches().filter(b => b.status === 'checking' || b.status === 'running').length
      maxActive = Math.max(maxActive, active)
    })
    // one video that takes ~3 s, then a quick list of three
    const slow = scheduler.schedule({url: 'https://fake.test/slowest-one', profile: audio, outDir: out})
    const quick = scheduler.schedule({url: 'https://fake.test/list-a', profile: audio, outDir: out})
    await scheduler.whenIdle()
    assert.equal(maxActive, 2, 'both batches active at once')
    assert.deepEqual(statuses.get(quick.id), ['scheduled', 'checking', 'running', 'completed'])
    const first = scheduler.batch(slow.id)!
    const second = scheduler.batch(quick.id)!
    assert.equal(first.status, 'completed')
    assert.ok(second.startedAt! < first.finishedAt!, 'the quick list started while the slow video still ran')
    if (engine.concurrency >= 2) {
      assert.ok(second.finishedAt! < first.finishedAt!, 'the quick list finished while the slow video still ran')
    }
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
    const {scheduler, statuses, out} = setup('cancel', {maxActiveBatches: 1})
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
    const checked = countPreflight(engine)
    const restored = await scheduler.restore()
    assert.equal(restored.length, 1)
    await scheduler.whenIdle()
    const again: BatchSnapshot = scheduler.batch(restored[0]!.id)!
    assert.equal(again.status, 'completed')
    assert.ok(
      engine.jobs().every(job => job.status === 'skipped'),
      'already archived items are skipped',
    )
    assert.equal(checked(), 0, 'a restored batch was checked before the app closed: no second network check')
  })

  it('a song (no picture) asked as a video downloads as M4A instead of failing', async () => {
    const {engine, scheduler, out} = setup('song-single')
    const batch = scheduler.schedule({url: 'https://fake.test/song-1', profile: video, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const [job] = engine.jobs().filter(j => j.batchId === batch.id)
    assert.deepEqual([job?.profile.kind, job?.profile.container], ['audio', 'm4a'])
    assert.deepEqual(
      (await fs.readdir(out)).map(name => path.extname(name)),
      ['.m4a'],
    )
  })

  it("a list's songs download as M4A into audioOutDir, in the list's folder and position; its videos stay", async () => {
    const {engine, scheduler, out} = setup('song-list')
    const music = path.join(out, 'Music')
    const batch = scheduler.schedule({
      url: 'https://fake.test/list-songs',
      profile: video,
      outDir: out,
      audioOutDir: music,
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 2)
    const jobs = engine.jobs().filter(j => j.batchId === batch.id)
    assert.deepEqual(jobs.map(j => [j.url, j.profile.kind]).sort(), [
      ['https://fake.test/e1', 'video'],
      ['https://fake.test/song-e2', 'audio'],
    ])
    const song = jobs.find(j => j.profile.kind === 'audio')!
    const clip = jobs.find(j => j.profile.kind === 'video')!
    assert.equal(path.dirname(song.filepath!), engine.folderFor(music, 'Fake List'))
    assert.equal(path.dirname(clip.filepath!), engine.folderFor(out, 'Fake List'))
    assert.match(path.basename(song.filepath!), /^002-.*\.m4a$/, 'its position in the list, as its videos')
    assert.throws(
      () =>
        scheduler.schedule({url: 'https://fake.test/list-songs', profile: video, outDir: out, audioOutDir: 'Music'}),
      {
        code: 'invalid-request',
      },
    )
  })

  it('a song kept as M4A is still a song after a restore', async () => {
    const first = setup('song-restore')
    first.engine.pause() // checked, nothing downloaded before the "crash"
    const scheduled = first.scheduler.schedule({url: 'https://fake.test/list-songs', profile: video, outDir: first.out})
    // checked (the song is a target now) before the "crash", however slow the machine
    for (let waited = 0; first.scheduler.batch(scheduled.id)?.status !== 'running' && waited < 10_000; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(first.scheduler.batch(scheduled.id)?.status, 'running')
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
    const [restored] = await scheduler.restore()
    await scheduler.whenIdle()
    const done = scheduler.batch(restored!.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 2)
    const song = engine.jobs().find(j => j.url === 'https://fake.test/song-e2')
    assert.deepEqual([song?.profile.kind, song?.profile.container], ['audio', 'm4a'])
  })

  it('a restored batch downloads what was left without checking its items again', async () => {
    const first = setup('restore-pending')
    first.engine.pause() // nothing downloads before the "crash"
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
    const logs: LogEntry[] = []
    engine.on('log', entry => logs.push(entry))
    const checked = countPreflight(engine)
    const [restored] = await scheduler.restore()
    await scheduler.whenIdle()
    const done = scheduler.batch(restored!.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.ok(done.jobs.succeeded > 0)
    assert.equal(checked(), 0)
    assert.ok(logs.some(entry => /restored: \d+ item\(s\) checked before/.test(entry.message)))
  })

  it('a list asked again checks only what is not downloaded yet', async () => {
    const {engine, scheduler, out} = setup('archived-skip-check')
    const firstRun = scheduler.schedule({url: 'https://fake.test/list-r', profile: audio, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(firstRun.id)?.status, 'completed')
    const total = scheduler.batch(firstRun.id)!.preflight.total
    const logs: LogEntry[] = []
    engine.on('log', entry => logs.push(entry))
    const checked = countPreflight(engine)
    const second = scheduler.schedule({url: 'https://fake.test/list-r', profile: audio, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(second.id)!
    assert.equal(done.status, 'completed')
    assert.deepEqual(done.preflight, {total, checked: total, ok: total, unavailable: 0})
    assert.equal(checked(), 0, 'every item was archived: nothing to check over the network')
    assert.ok(logs.some(entry => entry.message === `preflight: ${total} item(s) already downloaded, not checked again`))
  })

  it("retries a closed batch's failures: it reopens, counts them back and closes complete; causes are kept", async () => {
    // no automatic retries: the "flaky" items fail once (network), then download
    const {engine, scheduler, statuses, out} = setup('retry-failed', {}, {maxRetries: 0})
    const entry = (index: number, name: string) => ({
      id: name,
      index,
      url: `https://fake.test/${name}`,
      title: name,
      extractor: 'Fake',
      isLive: false,
    })
    const batch = scheduler.schedule({
      url: 'https://fake.test/list',
      profile: audio,
      outDir: out,
      selection: {
        title: 'Retry list',
        entries: [entry(1, 'flaky-a'), entry(2, 'ok-b'), entry(3, 'flaky-c'), entry(4, 'unavailable-d')],
      },
    })
    await scheduler.whenIdle()
    const first = scheduler.batch(batch.id)!
    assert.equal(first.status, 'completed-with-errors')
    assert.deepEqual(first.jobs, {total: 3, queued: 0, running: 0, succeeded: 1, failed: 2, cancelled: 0})
    assert.deepEqual(first.problems, {failed: {network: 2}, unavailable: {removed: 1}})

    assert.equal(scheduler.retryFailed(batch.id), 2)
    assert.equal(scheduler.batch(batch.id)?.status, 'running')
    await scheduler.whenIdle()
    const after = scheduler.batch(batch.id)!
    assert.equal(after.status, 'completed-with-errors', 'the unavailable item still keeps it from "completed"')
    assert.deepEqual(after.jobs, {total: 3, queued: 0, running: 0, succeeded: 3, failed: 0, cancelled: 0})
    assert.deepEqual(after.problems, {failed: {}, unavailable: {removed: 1}})
    assert.deepEqual(statuses.get(batch.id)?.slice(-3), ['completed-with-errors', 'running', 'completed-with-errors'])
    const items = scheduler.items(batch.id)
    assert.equal(new Set(items.map(item => item.jobId).filter(Boolean)).size, 3, 'items point at their new jobs')
    assert.equal(scheduler.retryFailed(batch.id), 0, 'nothing left to retry')

    // the history knows each file's batch: filter by it, group by it
    const history = await engine.archive.list({batchId: batch.id})
    assert.equal(history.total, 3)
    assert.ok(history.entries.every(entry => entry.batchTitle === 'Retry list'))
    assert.equal((await engine.archive.list({batchId: 'another'})).total, 0)
    const [group] = await engine.archive.groups()
    assert.deepEqual(
      {id: group?.batchId, title: group?.title, count: group?.count},
      {id: batch.id, title: 'Retry list', count: 3},
    )

    // checking one batch's files again finds the one that changed since
    const [changed] = history.entries
    await fs.appendFile(changed!.filepath, 'x')
    const checks = await engine.verifyArchive(undefined, undefined, {batchId: batch.id})
    assert.equal(checks.length, 3)
    assert.deepEqual(
      checks.filter(check => !check.ok).map(check => [check.entry.key, check.problem]),
      [[changed!.key, 'size-changed']],
    )
    const one = await engine.verifyArchive(undefined, undefined, {keys: [history.entries[1]!.key]})
    assert.deepEqual(
      one.map(check => check.ok),
      [true],
    )
  })

  it('retrying one failed download of a batch goes through the batch, which follows it', async () => {
    const {engine, scheduler, out} = setup('retry-one', {}, {maxRetries: 0})
    const batch = scheduler.schedule({
      url: 'https://fake.test/list',
      profile: audio,
      outDir: out,
      selection: {
        title: 'One',
        entries: [
          {id: 'flaky-x', index: 1, url: 'https://fake.test/flaky-x', title: 'x', extractor: 'Fake', isLive: false},
        ],
      },
    })
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'failed')
    const failed = engine.jobs().find(job => job.batchId === batch.id && job.status === 'failed')!
    const retried = scheduler.retryJob(failed.id)
    assert.ok(retried && retried.id !== failed.id)
    await scheduler.whenIdle()
    const after = scheduler.batch(batch.id)!
    assert.equal(after.status, 'completed')
    assert.deepEqual(after.jobs, {total: 1, queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0})
  })
})
