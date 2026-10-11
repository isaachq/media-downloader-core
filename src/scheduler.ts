import {EventEmitter} from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {assertHttpUrl} from './core/analyze.js'
import {cancelledError, DownloadError, toJobError} from './core/errors.js'
import {sanitizeFilename} from './core/files.js'
import {profileProblem} from './core/formats.js'
import {newId} from './core/ids.js'
import {isTerminal} from './core/job.js'
import {TaskPool} from './core/pool.js'
import {QueueStore} from './core/queue-store.js'
import type {MediaDownloader} from './downloader.js'
import type {
  BatchCounts,
  BatchId,
  BatchRequest,
  BatchSnapshot,
  BatchStatus,
  JobId,
  JobOutcome,
  JobRequest,
  JobSnapshot,
  PlaylistAnalysis,
  PreflightItem,
  SchedulerEvents,
  SchedulerOptions,
  VideoAnalysis,
} from './types.js'

const TERMINAL: ReadonlySet<BatchStatus> = new Set(['completed', 'completed-with-errors', 'failed', 'cancelled'])

type Batch = {
  readonly id: BatchId
  readonly request: BatchRequest
  status: BatchStatus
  kind: 'video' | 'playlist' | undefined
  title: string | undefined
  items: PreflightItem[]
  /** Outcome of each job of this batch, for O(1) counting. */
  readonly jobs: Map<JobId, JobOutcome>
  running: Set<JobId>
  error: BatchSnapshot['error']
  readonly createdAt: number
  startedAt: number | undefined
  finishedAt: number | undefined
  controller: AbortController | undefined
  snapshot: BatchSnapshot | undefined
}

/**
 * schedule → batch → jobs.
 *
 * Every url submitted becomes a batch. Submitting never blocks and never
 * overloads the machine: batches wait in a FIFO and at most
 * `maxActiveBatches` (default 1) are active, each fanning out into jobs on
 * the engine's ⌊CPUs/2⌋ pool. An active batch:
 *
 *   1. checking — resolves the url and checks every item in parallel
 *      (bounded by the same pool size). The metadata fetched here is handed
 *      to the jobs, so nothing is extracted twice.
 *   2. running  — one job per downloadable item; unavailable items are
 *      closed immediately with their reason and hint.
 *   3. closed   — completed / completed-with-errors / failed / cancelled,
 *      then the next scheduled batch starts.
 */
export class BatchScheduler extends EventEmitter<SchedulerEvents> {
  readonly #engine: MediaDownloader
  readonly #maxActive: number
  readonly #preflight: boolean
  /** Insertion-ordered: iteration = FIFO for the scheduled ones. */
  readonly #batches = new Map<BatchId, Batch>()
  readonly #byJob = new Map<JobId, BatchId>()
  #active = 0
  #disposed = false
  #wasIdle = true
  readonly #store: QueueStore<BatchRequest>
  #idleWaiters: Array<() => void> = []
  readonly #onJob = (job: JobSnapshot) => this.#jobChanged(job)

  constructor(engine: MediaDownloader, options: SchedulerOptions = {}) {
    super()
    this.#engine = engine
    this.#maxActive = Math.max(1, Math.floor(options.maxActiveBatches ?? 1))
    this.#preflight = options.preflight ?? true
    this.#store = new QueueStore(path.join(engine.dataDir, 'schedule.json'), () =>
      [...this.#batches.values()].filter(batch => !TERMINAL.has(batch.status)).map(batch => batch.request),
    )
    engine.on('job', this.#onJob)
  }

  /**
   * Re-schedule the batches that were scheduled or active when the app last
   * closed, and restore the engine's own loose jobs. Items already archived
   * are skipped and partial downloads resume, so nothing is fetched twice.
   */
  async restore(): Promise<BatchSnapshot[]> {
    await this.#engine.restoreQueue(request => request.batchId === undefined)
    const restored: BatchSnapshot[] = []
    for (const request of await this.#store.load()) {
      try {
        restored.push(this.schedule(request))
      } catch (error) {
        this.#engine.log('warn', `Dropped an invalid saved batch: ${toJobError(error).message}`)
      }
    }
    return restored
  }

  /** Queue a url. Returns at once; the batch starts when it's its turn. */
  schedule(request: BatchRequest): BatchSnapshot {
    if (this.#disposed) throw new Error('BatchScheduler has been disposed.')
    const url = assertHttpUrl(request.url)
    const problem = profileProblem(request.profile)
    if (problem) throw new DownloadError('invalid-request', problem)
    if (!path.isAbsolute(request.outDir)) throw new DownloadError('invalid-request', 'outDir must be an absolute path.')

    const batch: Batch = {
      id: newId() as BatchId,
      request: {...request, url, outDir: path.resolve(request.outDir)},
      status: 'scheduled',
      kind: undefined,
      title: undefined,
      items: [],
      jobs: new Map(),
      running: new Set(),
      error: undefined,
      createdAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      controller: undefined,
      snapshot: undefined,
    }
    this.#batches.set(batch.id, batch)
    this.#engine.log('info', `batch scheduled: ${url}`, {batchId: batch.id})
    this.#changed(batch)
    this.#store.touch()
    this.#pump()
    return this.#snapshot(batch)
  }

  batches(): BatchSnapshot[] {
    return Array.from(this.#batches.values(), batch => this.#snapshot(batch))
  }

  batch(id: BatchId): BatchSnapshot | undefined {
    const batch = this.#batches.get(id)
    return batch && this.#snapshot(batch)
  }

  /** Cancel a batch: scheduled → dropped, checking → stopped, running → its jobs cancelled. */
  cancel(id: BatchId): void {
    const batch = this.#batches.get(id)
    if (!batch || TERMINAL.has(batch.status)) return
    if (batch.status === 'scheduled') {
      this.#close(batch, 'cancelled', cancelledError().toJSON())
      return
    }
    batch.controller?.abort()
    for (const jobId of batch.jobs.keys()) this.#engine.cancel(jobId)
  }

  /** Forget closed batches (their jobs stay in the engine until it releases them). */
  clearFinished(): void {
    for (const [id, batch] of this.#batches) {
      if (!TERMINAL.has(batch.status)) continue
      this.#batches.delete(id)
      for (const jobId of batch.jobs.keys()) this.#byJob.delete(jobId)
    }
  }

  /** Resolves when nothing is scheduled, checking or running. */
  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve()
    return new Promise(resolve => this.#idleWaiters.push(resolve))
  }

  /**
   * Save the pending batches for `restore()`, then stop: active batches are
   * cancelled (partial downloads stay for resuming). Call before disposing
   * the engine. The engine itself is not disposed.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    await this.#store.freeze()
    this.#disposed = true
    for (const batch of this.#batches.values()) {
      if (!TERMINAL.has(batch.status)) batch.controller?.abort()
    }
    this.#engine.off('job', this.#onJob)
    this.removeAllListeners()
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  /** Start scheduled batches while there is room. O(batches) per call; called on schedule and on close. */
  #pump(): void {
    if (this.#disposed) return
    for (const batch of this.#batches.values()) {
      if (this.#active >= this.#maxActive) break
      if (batch.status !== 'scheduled') continue
      this.#active++
      void this.#start(batch)
    }
    this.#checkIdle()
  }

  async #start(batch: Batch): Promise<void> {
    batch.controller = new AbortController()
    const {signal} = batch.controller
    batch.startedAt = Date.now()
    this.#setStatus(batch, 'checking')
    try {
      const analysis = await this.#engine.analyze(batch.request.url, {signal})
      if (analysis.kind === 'playlist') await this.#checkPlaylist(batch, analysis, signal)
      else this.#acceptVideo(batch, analysis)
      if (signal.aborted) throw cancelledError()

      const ready = batch.items.filter(item => item.state === 'ok')
      this.#engine.log(
        'info',
        `preflight: ${ready.length}/${batch.items.length} downloadable${batch.items.length - ready.length ? `, ${batch.items.length - ready.length} unavailable` : ''}`,
        {batchId: batch.id},
      )
      if (ready.length === 0) {
        this.#close(batch, 'failed', {code: 'unavailable', message: 'No item of this batch can be downloaded.'})
        return
      }
      this.#setStatus(batch, 'running')
      this.#enqueue(batch, analysis)
    } catch (error) {
      const jobError = toJobError(error)
      this.#close(batch, signal.aborted || jobError.code === 'cancelled' ? 'cancelled' : 'failed', jobError)
    }
  }

  #acceptVideo(batch: Batch, analysis: VideoAnalysis): void {
    batch.kind = 'video'
    batch.title = analysis.media.title
    const choice = analysis.choices.find(c => c.profile.kind === batch.request.profile.kind)
    batch.items = [
      {
        index: 1,
        url: analysis.media.url,
        title: analysis.media.title,
        mediaId: analysis.media.id,
        duration: analysis.media.duration,
        state: choice ? 'ok' : 'unavailable',
        requiresConversion: choice?.requiresConversion,
        error: choice
          ? undefined
          : {code: 'unavailable', hint: 'format-unavailable', message: `No ${batch.request.profile.kind} formats.`},
      },
    ]
    this.#changed(batch)
  }

  /**
   * Check every selected entry with a full extraction, at most ⌊CPUs/2⌋ at
   * once. Each successful check yields cached metadata reused by its job.
   */
  async #checkPlaylist(batch: Batch, analysis: PlaylistAnalysis, signal: AbortSignal): Promise<void> {
    batch.kind = 'playlist'
    batch.title = analysis.title
    const wanted = batch.request.items ? new Set(batch.request.items) : undefined
    const entries = analysis.entries.filter(entry => !wanted || wanted.has(entry.index))
    batch.items = entries.map(entry => ({
      index: entry.index,
      url: entry.url,
      title: entry.title,
      mediaId: entry.id,
      duration: entry.duration,
      state: entry.isLive ? 'unavailable' : this.#preflight ? 'pending' : 'ok',
      error: entry.isLive
        ? {code: 'unavailable', hint: 'not-started', message: 'Live streams are not downloaded.'}
        : undefined,
    }))
    this.#changed(batch)
    if (!this.#preflight) return

    const pool = new TaskPool<number>(this.#engine.concurrency)
    batch.items.forEach((item, position) => {
      if (item.state !== 'pending') return
      pool.add(position, async () => {
        if (signal.aborted) return
        this.#updateItem(batch, position, {state: 'checking'})
        try {
          const result = await this.#engine.analyze(item.url, {signal})
          if (result.kind !== 'video') throw new DownloadError('unavailable', 'Nested playlist inside a playlist item.')
          const choice = result.choices.find(c => c.profile.kind === batch.request.profile.kind)
          this.#infoJson.set(`${batch.id}:${position}`, result.infoJsonPath)
          this.#updateItem(batch, position, {
            state: choice ? 'ok' : 'unavailable',
            title: result.media.title,
            duration: result.media.duration ?? item.duration,
            requiresConversion: choice?.requiresConversion,
            error: choice
              ? undefined
              : {code: 'unavailable', hint: 'format-unavailable', message: `No ${batch.request.profile.kind} formats.`},
          })
        } catch (error) {
          if (signal.aborted) return
          this.#updateItem(batch, position, {state: 'unavailable', error: toJobError(error)})
        }
      })
    })
    await pool.whenIdle()
  }

  /** Preflight metadata per item, handed to the job (`batchId:position` → info json path). */
  readonly #infoJson = new Map<string, string | undefined>()

  #enqueue(batch: Batch, analysis: VideoAnalysis | PlaylistAnalysis): void {
    const {profile, outDir} = batch.request
    const folder =
      batch.kind === 'playlist' ? path.join(outDir, sanitizeFilename(batch.title ?? 'Playlist', 100)) : outDir
    batch.items.forEach((item, position) => {
      if (item.state !== 'ok') return
      const request: JobRequest = {
        url: item.url,
        profile,
        outDir: folder,
        batchId: batch.id,
        title: item.title,
        mediaId: item.mediaId,
        extractor:
          analysis.kind === 'playlist'
            ? analysis.entries.find(e => e.index === item.index)?.extractor
            : analysis.media.extractor,
        duration: item.duration,
        playlist:
          analysis.kind === 'playlist' ? {id: analysis.id, title: analysis.title, index: item.index} : undefined,
        infoJsonPath: analysis.kind === 'video' ? analysis.infoJsonPath : this.#infoJson.get(`${batch.id}:${position}`),
      }
      this.#infoJson.delete(`${batch.id}:${position}`)
      const job = this.#engine.add(request)
      batch.jobs.set(job.id, job.outcome)
      this.#byJob.set(job.id, batch.id)
      batch.items[position] = {...item, jobId: job.id}
    })
    this.#changed(batch)
    this.#maybeClose(batch) // every job may have been skipped (already archived) synchronously
  }

  #jobChanged(job: JobSnapshot): void {
    const batchId = job.batchId ?? this.#byJob.get(job.id)
    const batch = batchId && this.#batches.get(batchId)
    if (!batch || TERMINAL.has(batch.status) || !batch.jobs.has(job.id)) return
    const before = batch.jobs.get(job.id)
    const isRunning = !isTerminal(job.status) && job.status !== 'queued'
    const wasRunning = batch.running.has(job.id)
    if (isRunning) batch.running.add(job.id)
    else batch.running.delete(job.id)
    batch.jobs.set(job.id, job.outcome)
    if (before !== job.outcome || isRunning !== wasRunning) this.#changed(batch)
    if (job.outcome !== 'in-progress') this.#maybeClose(batch)
  }

  #maybeClose(batch: Batch): void {
    if (batch.status !== 'running') return
    let succeeded = 0
    for (const outcome of batch.jobs.values()) {
      if (outcome === 'in-progress') return
      if (outcome === 'success') succeeded++
    }
    const failedItems = batch.items.length - succeeded
    if (batch.controller?.signal.aborted) this.#close(batch, 'cancelled', cancelledError().toJSON())
    else if (failedItems === 0) this.#close(batch, 'completed')
    else if (succeeded > 0) this.#close(batch, 'completed-with-errors')
    else this.#close(batch, 'failed', {code: 'unavailable', message: 'No item of this batch could be downloaded.'})
  }

  #close(batch: Batch, status: BatchStatus, error?: BatchSnapshot['error']): void {
    const wasActive = batch.status !== 'scheduled'
    batch.status = status
    batch.error = error
    batch.finishedAt = Date.now()
    batch.controller = undefined
    // preflight metadata never handed to a job (cancelled / unavailable): delete the cached files
    for (const [key, file] of this.#infoJson) {
      if (!key.startsWith(`${batch.id}:`)) continue
      this.#infoJson.delete(key)
      if (file) void fs.rm(file, {force: true})
    }
    const counts = this.#counts(batch)
    this.#engine.log(
      status === 'failed' ? 'error' : status === 'completed-with-errors' ? 'warn' : 'info',
      `batch closed: ${status} — ${counts.succeeded}/${batch.items.length || counts.total} succeeded${error ? ` [${error.code}] ${error.message}` : ''}`,
      {batchId: batch.id},
    )
    this.#changed(batch)
    if (wasActive) this.#active--
    this.#store.touch()
    this.#pump()
  }

  // ─── state & events ───────────────────────────────────────────────────────

  #setStatus(batch: Batch, status: BatchStatus): void {
    batch.status = status
    this.#engine.log('debug', `batch ${status}`, {batchId: batch.id})
    this.#changed(batch)
  }

  #updateItem(batch: Batch, position: number, patch: Partial<PreflightItem>): void {
    batch.items[position] = {...batch.items[position]!, ...patch}
    this.#changed(batch)
  }

  #counts(batch: Batch): BatchCounts {
    let succeeded = 0
    let failed = 0
    let pending = 0
    for (const outcome of batch.jobs.values()) {
      if (outcome === 'success') succeeded++
      else if (outcome === 'failed') failed++
      else pending++
    }
    const running = batch.running.size
    return {total: batch.jobs.size, queued: pending - running, running, succeeded, failed}
  }

  #snapshot(batch: Batch): BatchSnapshot {
    if (batch.snapshot) return batch.snapshot
    let checked = 0
    let ok = 0
    let unavailable = 0
    for (const item of batch.items) {
      if (item.state === 'ok') ok++
      if (item.state === 'unavailable') unavailable++
      if (item.state === 'ok' || item.state === 'unavailable') checked++
    }
    let position: number | undefined
    if (batch.status === 'scheduled') {
      position = 0
      for (const other of this.#batches.values()) {
        if (other.status === 'scheduled') position++
        if (other === batch) break
      }
    }
    batch.snapshot = Object.freeze({
      id: batch.id,
      url: batch.request.url,
      profile: batch.request.profile,
      outDir: batch.request.outDir,
      status: batch.status,
      kind: batch.kind,
      title: batch.title,
      position,
      preflight: {total: batch.items.length, checked, ok, unavailable},
      items: Object.freeze([...batch.items]),
      jobs: this.#counts(batch),
      error: batch.error,
      createdAt: batch.createdAt,
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
    })
    return batch.snapshot
  }

  #changed(batch: Batch): void {
    batch.snapshot = undefined
    this.emit('batch', this.#snapshot(batch))
    if (TERMINAL.has(batch.status) || batch.status === 'running') {
      // a status change can move the queue positions of the batches behind
      for (const other of this.#batches.values()) {
        if (other !== batch && other.status === 'scheduled') other.snapshot = undefined
      }
    }
    this.#checkIdle()
  }

  #isIdle(): boolean {
    for (const batch of this.#batches.values()) if (!TERMINAL.has(batch.status)) return false
    return true
  }

  /** Resolve waiters and emit 'idle' only on the busy → idle transition. */
  #checkIdle(): void {
    const idle = this.#isIdle()
    const becameIdle = idle && !this.#wasIdle
    this.#wasIdle = idle
    if (!idle) return
    const waiters = this.#idleWaiters
    this.#idleWaiters = []
    for (const resolve of waiters) resolve()
    if (becameIdle) this.emit('idle')
  }
}
