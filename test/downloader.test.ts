// Orchestration tests with fake binaries: no network, no ffmpeg needed.
// The fake yt-dlp speaks the same machine-readable protocol as the real one.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {ID_PATTERN} from '../src/core/ids.js'
import {MediaDownloader, retryDelay} from '../src/downloader.js'
import type {JobSnapshot, JobStatus, LogEntry, StepName} from '../src/types.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

let root = ''
let bins: FakeBinaries

/** Every engine a test creates is disposed after the file, so no timer or write outlives it. */
const engines: MediaDownloader[] = []

async function makeDownloader(sub: string, extra: Partial<ConstructorParameters<typeof MediaDownloader>[0]> = {}) {
  const engine = new MediaDownloader({
    dataDir: path.join(root, sub),
    binaries: bins,
    validation: 'none',
    checksums: true,
    maxRetries: 1,
    retryDelayMaxMs: 50,
    progressIntervalMs: 0,
    ...extra,
  })
  engines.push(engine)
  return engine
}

const audio = {kind: 'audio', container: 'm4a'} as const

// shared by every suite below: fake binaries in a temp folder
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-dl-'))
  bins = await writeFakes(path.join(root, 'bin'))
})

after(async () => {
  await Promise.all(engines.map(engine => engine.dispose()))
  await fs.rm(root, {recursive: true, force: true})
})

describe('MediaDownloader orchestration', () => {
  it('never runs more than the configured jobs at once and completes all of them', async () => {
    const dl = await makeDownloader('concurrency', {concurrency: 2})
    const active = new Set<string>()
    let peak = 0
    const busy: JobStatus[] = ['downloading', 'processing', 'converting', 'validating', 'finalizing']
    dl.on('job', s => {
      if (busy.includes(s.status)) active.add(s.id)
      else active.delete(s.id)
      peak = Math.max(peak, active.size)
    })
    const outDir = path.join(root, 'out-concurrency')
    for (let i = 0; i < 6; i++)
      dl.add({url: `https://fake/slow${i}`, profile: audio, outDir, mediaId: `slow${i}`, extractor: 'Fake'})
    await dl.whenIdle()
    // 2 requested, but never above ⌊CPUs/2⌋ (a 3-CPU CI runner allows only 1)
    assert.equal(dl.concurrency, Math.min(2, MediaDownloader.maxConcurrency()))
    assert.equal(peak, dl.concurrency)
    const jobs = dl.jobs()
    assert.equal(jobs.filter(j => j.status === 'completed').length, 6)
    assert.equal((await fs.readdir(outDir)).length, 6)
    assert.ok(jobs.every(j => j.validation?.sha256?.length === 64))
  })

  it('clamps concurrency to half the CPUs', async () => {
    const dl = await makeDownloader('clamp', {concurrency: 10_000})
    assert.equal(dl.concurrency, MediaDownloader.maxConcurrency())
    assert.equal(dl.setConcurrency(0), 1)
  })

  it('skips media already in the archive', async () => {
    const dl = await makeDownloader('archive')
    const outDir = path.join(root, 'out-archive')
    const req = {url: 'https://fake/a1', profile: audio, outDir, mediaId: 'a1', extractor: 'Fake'}
    dl.add(req)
    await dl.whenIdle()
    const second = dl.add(req)
    await dl.whenIdle()
    assert.equal(dl.job(second.id)?.status, 'skipped')
    // a different profile is a different file
    const mp3 = dl.add({...req, profile: {kind: 'audio', container: 'mp3'}})
    await dl.whenIdle()
    assert.notEqual(dl.job(mp3.id)?.status, 'skipped')
  })

  it('retries transient errors and gives up immediately on unavailable media', async () => {
    const dl = await makeDownloader('retry')
    const outDir = path.join(root, 'out-retry')
    const flaky = dl.add({url: 'https://fake/flaky1', profile: audio, outDir})
    const gone = dl.add({url: 'https://fake/unavailable1', profile: audio, outDir})
    await dl.whenIdle()
    const f = dl.job(flaky.id)!
    const g = dl.job(gone.id)!
    assert.equal(f.status, 'completed')
    assert.equal(f.attempt, 2)
    assert.equal(g.status, 'failed')
    assert.equal(g.error?.code, 'unavailable')
    assert.equal(g.attempt, 1)
  })

  it('cancels queued and running jobs', async () => {
    const dl = await makeDownloader('cancel', {concurrency: 1})
    const outDir = path.join(root, 'out-cancel')
    const running = dl.add({url: 'https://fake/slowc1', profile: audio, outDir})
    const queued = dl.add({url: 'https://fake/slowc2', profile: audio, outDir})
    await new Promise<void>(resolve => {
      const onJob = (s: JobSnapshot) => {
        if (s.id === running.id && s.status === 'downloading') {
          dl.off('job', onJob)
          resolve()
        }
      }
      dl.on('job', onJob)
    })
    dl.cancel(queued.id)
    dl.cancel(running.id)
    await dl.whenIdle()
    assert.equal(dl.job(running.id)?.status, 'cancelled')
    assert.equal(dl.job(queued.id)?.status, 'cancelled')
    assert.deepEqual(await fs.readdir(outDir).catch(() => []), [])
  })

  it('saves pending jobs on dispose and restores them on the next launch', async () => {
    const dl = await makeDownloader('restore', {concurrency: 1})
    const outDir = path.join(root, 'out-restore')
    dl.pause()
    for (const n of [1, 2, 3]) dl.add({url: `https://fake/r${n}`, profile: audio, outDir, title: `r${n}`})
    await dl.dispose()

    const next = await makeDownloader('restore', {concurrency: 1})
    const restored = await next.restoreQueue()
    assert.deepEqual(
      restored.map(j => j.title),
      ['r1', 'r2', 'r3'],
    )
    await next.whenIdle()
    assert.equal(next.jobs().filter(j => j.status === 'completed').length, 3)
  })

  it('puts playlist items in a numbered sub-folder', async () => {
    const dl = await makeDownloader('playlist')
    const outDir = path.join(root, 'out-playlist')
    const entry = (index: number) => ({
      id: `p${index}`,
      url: `https://fake/p${index}`,
      title: `Song ${index}`,
      extractor: 'Fake',
      isLive: false,
      index,
    })
    dl.addPlaylist(
      {
        kind: 'playlist',
        id: 'PL1',
        url: 'https://fake/list',
        title: 'My: Mix?',
        extractor: 'Fake',
        entries: [1, 2, 3].map(entry),
        choices: [],
      },
      audio,
      outDir,
      {indexes: [1, 3]},
    )
    await dl.whenIdle()
    // portable by default: ASCII letters, digits and hyphens — what car stereos and USB sticks read
    const files = (await fs.readdir(path.join(outDir, 'My-Mix'))).sort()
    assert.deepEqual(files, ['001-Title-p1-p1.m4a', '003-Title-p3-p3.m4a'])
  })
  it("keeps titles as they are with fileNames: 'original'", async () => {
    const dl = await makeDownloader('playlist-original', {fileNames: 'original'})
    const outDir = path.join(root, 'out-playlist-original')
    const entry = (index: number) => ({
      id: `p${index}`,
      url: `https://fake/p${index}`,
      title: `Song ${index}`,
      extractor: 'Fake',
      isLive: false,
      index,
    })
    dl.addPlaylist(
      {
        kind: 'playlist',
        id: 'PL1',
        url: 'https://fake/list',
        title: 'My: Mix?',
        extractor: 'Fake',
        entries: [1, 2, 3].map(entry),
        choices: [],
      },
      audio,
      outDir,
      {indexes: [1, 3]},
    )
    await dl.whenIdle()
    const files = (await fs.readdir(path.join(outDir, 'My_ Mix_'))).sort()
    assert.deepEqual(files, ['001 - Title p1 [p1].m4a', '003 - Title p3 [p3].m4a'])
  })
  const stepStates = (job: JobSnapshot) =>
    Object.fromEntries(job.steps.map(step => [step.name, step.state])) as Record<StepName, string>

  it('tracks every sub-task of a successful job', async () => {
    const dl = await makeDownloader('steps')
    const job = dl.add({url: 'https://fake/s1', profile: audio, outDir: path.join(root, 'out-steps')})
    await dl.whenIdle()
    const done = dl.job(job.id)!
    assert.equal(done.outcome, 'success')
    // audio: yt-dlp produced the format (no convert); validation 'none' in this suite
    assert.deepEqual(stepStates(done), {
      download: 'success',
      convert: 'skipped',
      validate: 'skipped',
      finalize: 'success',
    })
    assert.equal(done.attempts.length, 1)
    assert.equal(done.attempts[0]?.error, undefined)
  })

  it('records each failed attempt, logs the retry and the step that failed', async () => {
    const dl = await makeDownloader('attempts')
    const logs: LogEntry[] = []
    dl.on('log', entry => logs.push(entry))
    const outDir = path.join(root, 'out-attempts')
    const flaky = dl.add({url: 'https://fake/flaky2', profile: audio, outDir})
    const gone = dl.add({url: 'https://fake/unavailable2', profile: audio, outDir})
    await dl.whenIdle()

    const f = dl.job(flaky.id)!
    assert.equal(f.outcome, 'success')
    assert.equal(f.maxAttempts, 2)
    assert.equal(f.attempts.length, 2)
    assert.equal(f.attempts[0]?.failedStep, 'download')
    assert.equal(f.attempts[0]?.error?.code, 'network')
    assert.ok((f.attempts[0]?.retryInMs ?? -1) >= 0)
    const retryLog = logs.find(l => l.jobId === flaky.id && l.level === 'warn')
    assert.match(retryLog?.message ?? '', /attempt 1\/2 failed at download \[network\].*retrying in/)
    assert.ok(logs.some(l => l.jobId === flaky.id && l.level === 'info' && /succeeded on attempt 2\/2/.test(l.message)))

    const g = dl.job(gone.id)!
    assert.equal(g.outcome, 'failed')
    assert.equal(stepStates(g).download, 'failed')
    assert.equal(stepStates(g).finalize, 'pending')
    assert.equal(g.attempts.length, 1, 'unavailable media is not retried')
    assert.ok(logs.some(l => l.jobId === gone.id && l.level === 'error' && l.code === 'unavailable'))
  })

  it('kills a stalled download and retries it', async () => {
    const dl = await makeDownloader('stall', {stallTimeoutMs: 300})
    const job = dl.add({url: 'https://fake/hang1', profile: audio, outDir: path.join(root, 'out-stall')})
    await dl.whenIdle()
    const done = dl.job(job.id)!
    assert.equal(done.outcome, 'failed')
    assert.equal(done.attempts.length, 2)
    assert.ok(done.attempts.every(a => a.error?.code === 'network' && /stalled/.test(a.error.message)))
  })
})

describe('trace ids and logs', () => {
  it('stamps every log with its ids and lets one id replay a whole flow from the trace file', async () => {
    const dl = await makeDownloader('trace')
    const outDir = path.join(root, 'out-trace')
    const job = dl.add({url: 'https://fake/flaky3', profile: audio, outDir})
    await dl.whenIdle()
    const done = dl.job(job.id)!
    const sessionId = dl.sessionId
    await dl.dispose() // flushes the trace file

    for (const id of [sessionId, done.id, ...done.attempts.map(a => a.id), ...done.steps.map(s => s.id)]) {
      assert.match(id, ID_PATTERN)
    }
    assert.equal(new Set(done.attempts.map(a => a.id)).size, 2, 'each attempt has its own id')

    // the failed attempt remembers where it stopped
    const first = done.attempts[0]!
    assert.equal(first.failedStep, 'download')
    assert.equal(first.lastStatus, 'downloading')

    const traceDir = path.join(root, 'trace', 'logs')
    const lines = (
      await Promise.all((await fs.readdir(traceDir)).map(f => fs.readFile(path.join(traceDir, f), 'utf8')))
    )
      .join('')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as LogEntry)
    assert.ok(lines.every(entry => entry.sessionId === sessionId))

    const jobFlow = lines.filter(entry => entry.jobId === done.id)
    assert.match(jobFlow[0]!.message, /^queued /)
    assert.match(jobFlow.at(-1)!.message, /^finished: completed/)

    const firstAttempt = lines.filter(entry => entry.attemptId === first.id)
    assert.ok(firstAttempt.length > 0)
    assert.ok(firstAttempt.every(entry => entry.attempt === 1))
    assert.ok(firstAttempt.some(entry => entry.level === 'warn' && /retrying in/.test(entry.message)))
  })
})

describe('retryDelay', () => {
  it('grows exponentially and never exceeds the 15 s cap', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      for (let sample = 0; sample < 50; sample++) {
        const wait = retryDelay(attempt, 15_000)
        const base = Math.min(15_000, 2000 * 2 ** (attempt - 1))
        assert.ok(wait <= 15_000 && wait >= base * 0.8, `attempt ${attempt}: ${wait}`)
      }
    }
  })
})
