import {EventEmitter} from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {assertHttpUrl} from './core/analyze.js'
import {cancelledError, DownloadError, toJobError} from './core/errors.js'
import {sanitizeFilename} from './core/files.js'
import {profileProblem} from './core/formats.js'
import {newId} from './core/ids.js'
import {isTerminal} from './core/job.js'
import {QueueStore} from './core/queue-store.js'
import type {MediaDownloader} from './downloader.js'
import type {
  BatchCounts,
  BatchId,
  BatchRequest,
  BatchSnapshot,
  BatchStatus,
  JobError,
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

/** Jobs created per event-loop turn while enqueuing a batch. */
const ENQUEUE_SLICE = 250

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))

const TERMINAL: ReadonlySet<BatchStatus> = new Set(['completed', 'completed-with-errors', 'failed', 'cancelled'])

/** Extra fields an item carries internally (never emitted). */
type ItemState = PreflightItem & {readonly extractor?: string | undefined; readonly infoJsonPath?: string | undefined}

type Batch = {
  readonly id: BatchId
  readonly request: BatchRequest
  status: BatchStatus
  kind: 'video' | 'playlist' | undefined
  title: string | undefined
  playlistId: string | undefined
  items: ItemState[]
  /** url → position in `items`, for O(1) preflight result lookup. */
  readonly positions: Map<string, number>
  /** Running totals, updated incrementally: snapshots are O(1), never a scan of `items`. */
  checked: number
  ok: number
  unavailable: number
  readonly jobs: Map<JobId, JobOutcome>
  readonly running: Set<JobId>
  succeeded: number
  failed: number
  /** Metadata files kept so far (bounded by maxCachedMetadata). */
  cached: number
  /** Jobs are still being created: the batch can't close yet. */
  enqueuing: boolean
  error: JobError | undefined
  readonly createdAt: number
  startedAt: number | undefined
  finishedAt: number | undefined
  controller: AbortController | undefined
  snapshot: BatchSnapshot | undefined
  lastEmit: number
  emitTimer: NodeJS.Timeout | undefined
}

/**
 * schedule → batch → jobs — built for heavy workloads: playlists with
 * thousands of items, many batches queued.
 *
 * Every url submitted becomes a batch. Submitting never blocks and never
 * overloads the machine: batches wait in a FIFO and at most
 * `maxActiveBatches` (default 1) are active, each fanning out into jobs on
 * the engine's ⌊CPUs/2⌋ pool. An active batch:
 *
 *   1. checking — the url is resolved, then every item is checked with
 *      chunked extraction (several urls per yt-dlp process, ⌊CPUs/2⌋
 *      processes). The metadata fetched is handed to the jobs, so nothing
 *      is extracted twice.
 *   2. running  — one job per downloadable item; unavailable items are
 *      closed right away with their reason and hint.
 *   3. closed   — completed / completed-with-errors / failed / cancelled,
 *      then the next scheduled batch starts.
 *
 * Cost per event is O(1): batch snapshots carry counters, not items (fetch
 * those with `items()`, follow them with the `item` event), and
 * counter-only updates are throttled per batch.
 */
export class BatchScheduler extends EventEmitter<SchedulerEvents> {
  readonly #engine: MediaDownloader
  readonly #maxActive: number
  readonly #preflight: boolean
  readonly #intervalMs: number
  readonly #maxCached: number
  /** Insertion-ordered: iteration = FIFO for the scheduled ones. */
  readonly #batches = new Map<BatchId, Batch>()
  readonly #byJob = new Map<JobId, BatchId>()
  readonly #store: QueueStore<BatchRequest>
  #active = 0
  /** Batches not yet closed — makes the idle check O(1). */
  #open = 0
  #disposed = false
  #idleWaiters: Array<() => void> = []
  readonly #onJob = (job: JobSnapshot) => this.#jobChanged(job)

  constructor(engine: MediaDownloader, options: SchedulerOptions = {}) {
    super()
    this.#engine = engine
    this.#maxActive = Math.max(1, Math.floor(options.maxActiveBatches ?? 1))
    this.#preflight = options.preflight ?? true
    this.#intervalMs = Math.max(0, options.progressIntervalMs ?? 250)
    this.#maxCached = Math.max(0, Math.floor(options.maxCachedMetadata ?? 500))
    this.#store = new QueueStore(path.join(engine.dataDir, 'schedule.json'), () =>
      [...this.#batches.values()].filter(batch => !TERMINAL.has(batch.status)).map(batch => batch.request),
    )
    engine.on('job', this.#onJob)
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
      playlistId: undefined,
      items: [],
      positions: new Map(),
      checked: 0,
      ok: 0,
      unavailable: 0,
      jobs: new Map(),
      running: new Set(),
      succeeded: 0,
      failed: 0,
      cached: 0,
      enqueuing: false,
      error: undefined,
      createdAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      controller: undefined,
      snapshot: undefined,
      lastEmit: 0,
      emitTimer: undefined,
    }
    this.#batches.set(batch.id, batch)
    this.#open++
    this.#engine.log('info', `batch scheduled: ${url}`, {batchId: batch.id})
    this.#emitBatch(batch, true)
    this.#store.touch()
    this.#pump()
    return this.#snapshot(batch)
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

  batches(): BatchSnapshot[] {
    return Array.from(this.#batches.values(), batch => this.#snapshot(batch))
  }

  batch(id: BatchId): BatchSnapshot | undefined {
    const batch = this.#batches.get(id)
    return batch && this.#snapshot(batch)
  }

  /** Items of a batch, paginated (a UI renders a window of a 5,000-item list, never all of it). */
  items(id: BatchId, opts: {readonly offset?: number; readonly limit?: number} = {}): PreflightItem[] {
    const batch = this.#batches.get(id)
    if (!batch) return []
    const offset = Math.max(0, opts.offset ?? 0)
    const end = opts.limit === undefined ? undefined : offset + Math.max(0, opts.limit)
    return batch.items.slice(offset, end).map(publicItem)
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
    if (this.#open === 0) return Promise.resolve()
    return new Promise(resolve => this.#idleWaiters.push(resolve))
  }

  /**
   * Save the pending batches for `restore()`, then stop: active batches are
   * stopped (partial downloads stay for resuming). Call before disposing the
   * engine. The engine itself is not disposed.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    await this.#store.freeze()
    this.#disposed = true
    for (const batch of this.#batches.values()) {
      if (batch.emitTimer) clearTimeout(batch.emitTimer)
      if (!TERMINAL.has(batch.status)) batch.controller?.abort()
    }
    this.#engine.off('job', this.#onJob)
    this.removeAllListeners()
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  /** Start scheduled batches while there is room. */
  #pump(): void {
    if (this.#disposed) return
    for (const batch of this.#batches.values()) {
      if (this.#active >= this.#maxActive) break
      if (batch.status !== 'scheduled') continue
      this.#active++
      void this.#start(batch)
    }
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

      const unavailable = batch.unavailable ? `, ${batch.unavailable} unavailable` : ''
      this.#engine.log('info', `preflight: ${batch.ok}/${batch.items.length} downloadable${unavailable}`, {
        batchId: batch.id,
      })
      if (batch.ok === 0) {
        this.#close(batch, 'failed', {code: 'unavailable', message: 'No item of this batch can be downloaded.'})
        return
      }
      this.#setStatus(batch, 'running')
      await this.#enqueue(batch, signal)
    } catch (error) {
      const jobError = toJobError(error)
      this.#close(batch, signal.aborted || jobError.code === 'cancelled' ? 'cancelled' : 'failed', jobError)
    }
  }

  #acceptVideo(batch: Batch, analysis: VideoAnalysis): void {
    batch.kind = 'video'
    batch.title = analysis.media.title
    this.#setItems(batch, [
      {
        index: 1,
        url: analysis.media.url,
        title: analysis.media.title,
        mediaId: analysis.media.id,
        duration: analysis.media.duration,
        extractor: analysis.media.extractor,
        state: 'pending',
      },
    ])
    this.#resolveItem(batch, 0, analysis)
  }

  /**
   * Check every selected entry with chunked extraction (engine.preflight):
   * several urls per yt-dlp process, ⌊CPUs/2⌋ processes. Each success can
   * keep its metadata for its job, up to maxCachedMetadata files.
   */
  async #checkPlaylist(batch: Batch, analysis: PlaylistAnalysis, signal: AbortSignal): Promise<void> {
    batch.kind = 'playlist'
    batch.title = analysis.title
    batch.playlistId = analysis.id
    const wanted = batch.request.items ? new Set(batch.request.items) : undefined
    this.#setItems(
      batch,
      analysis.entries
        .filter(entry => !wanted || wanted.has(entry.index))
        .map(entry => ({
          index: entry.index,
          url: entry.url,
          title: entry.title,
          mediaId: entry.id,
          duration: entry.duration,
          extractor: entry.extractor,
          state: 'pending' as const,
        })),
    )
    // live entries are known to be unavailable without asking (Set lookup: O(n) overall)
    const live = new Set(analysis.entries.filter(entry => entry.isLive).map(entry => entry.index))
    batch.items.forEach((item, position) => {
      if (live.has(item.index)) {
        this.#settleItem(batch, position, 'unavailable', {
          error: {code: 'unavailable', hint: 'not-started', message: 'Live streams are not downloaded.'},
        })
      }
    })

    const pending = batch.items.filter(item => item.state === 'pending')
    if (!this.#preflight) {
      for (const item of pending) this.#settleItem(batch, batch.positions.get(item.url)!, 'ok', {})
      return
    }
    await this.#engine.preflight(
      pending.map(item => ({url: item.url, id: item.mediaId})),
      {
        signal,
        keepMetadata: () => batch.cached++ < this.#maxCached,
        onResult: (url, result) => {
          const position = batch.positions.get(url)
          if (position === undefined || signal.aborted) return
          if (result.ok) this.#resolveItem(batch, position, result.analysis)
          else this.#settleItem(batch, position, 'unavailable', {error: result.error})
        },
      },
    )
  }

  /** A checked item: downloadable if the source offers the requested kind of stream. */
  #resolveItem(batch: Batch, position: number, analysis: VideoAnalysis): void {
    const kind = batch.request.profile.kind
    const choice = analysis.choices.find(c => c.profile.kind === kind)
    const facts = {
      title: analysis.media.title,
      duration: analysis.media.duration ?? batch.items[position]?.duration,
      infoJsonPath: analysis.infoJsonPath,
    }
    if (choice) this.#settleItem(batch, position, 'ok', {...facts, requiresConversion: choice.requiresConversion})
    else {
      this.#settleItem(batch, position, 'unavailable', {
        ...facts,
        error: {code: 'unavailable', hint: 'format-unavailable', message: `No ${kind} formats.`},
      })
    }
  }

  /**
   * Turn every downloadable item into a job, in slices of ENQUEUE_SLICE with
   * a yield in between: 5,000 jobs are still O(n) work, but the event loop
   * (and the UI it serves) never blocks for more than a few milliseconds.
   */
  async #enqueue(batch: Batch, signal: AbortSignal): Promise<void> {
    const {profile, outDir} = batch.request
    const folder =
      batch.kind === 'playlist' ? path.join(outDir, sanitizeFilename(batch.title ?? 'Playlist', 100)) : outDir
    batch.enqueuing = true
    for (let position = 0; position < batch.items.length; position++) {
      if (position > 0 && position % ENQUEUE_SLICE === 0) {
        this.#emitBatch(batch, false)
        await yieldToEventLoop()
      }
      if (signal.aborted) break
      const item = batch.items[position]!
      if (item.state !== 'ok') continue
      const request: JobRequest = {
        url: item.url,
        profile,
        outDir: folder,
        batchId: batch.id,
        title: item.title,
        mediaId: item.mediaId,
        extractor: item.extractor,
        duration: item.duration,
        playlist:
          batch.kind === 'playlist'
            ? {id: batch.playlistId ?? batch.id, title: batch.title ?? 'Playlist', index: item.index}
            : undefined,
        infoJsonPath: item.infoJsonPath,
      }
      const job = this.#engine.add(request)
      batch.jobs.set(job.id, job.outcome)
      this.#byJob.set(job.id, batch.id)
      // the job owns the metadata file now (it deletes it when done)
      batch.items[position] = {...item, jobId: job.id, infoJsonPath: undefined}
      this.emit('item', batch.id, publicItem(batch.items[position]!))
    }
    batch.enqueuing = false
    this.#emitBatch(batch, true)
    // jobs of the first slices may all have finished already
    if (batch.status === 'running' && batch.succeeded + batch.failed === batch.jobs.size) this.#finishRun(batch)
  }

  #jobChanged(job: JobSnapshot): void {
    const batchId = job.batchId ?? this.#byJob.get(job.id)
    const batch = batchId && this.#batches.get(batchId)
    if (!batch || TERMINAL.has(batch.status)) return
    const before = batch.jobs.get(job.id)
    if (before === undefined) return
    const isRunning = !isTerminal(job.status) && job.status !== 'queued'
    const wasRunning = batch.running.has(job.id)
    if (isRunning !== wasRunning) {
      if (isRunning) batch.running.add(job.id)
      else batch.running.delete(job.id)
    }
    if (before !== job.outcome) {
      batch.jobs.set(job.id, job.outcome)
      if (job.outcome === 'success') batch.succeeded++
      else if (job.outcome === 'failed') batch.failed++
    }
    if (before !== job.outcome || isRunning !== wasRunning) this.#emitBatch(batch, false)
    if (!batch.enqueuing && batch.status === 'running' && batch.succeeded + batch.failed === batch.jobs.size) {
      this.#finishRun(batch)
    }
  }

  #finishRun(batch: Batch): void {
    if (batch.controller?.signal.aborted) this.#close(batch, 'cancelled', cancelledError().toJSON())
    else if (batch.succeeded === batch.items.length) this.#close(batch, 'completed')
    else if (batch.succeeded > 0) this.#close(batch, 'completed-with-errors')
    else this.#close(batch, 'failed', {code: 'unavailable', message: 'No item of this batch could be downloaded.'})
  }

  #close(batch: Batch, status: BatchStatus, error?: JobError): void {
    const wasActive = batch.status !== 'scheduled'
    batch.status = status
    batch.error = error
    batch.finishedAt = Date.now()
    batch.controller = undefined
    // metadata never handed to a job (cancelled / unavailable items): delete it
    for (const item of batch.items) if (item.infoJsonPath) void fs.rm(item.infoJsonPath, {force: true})
    this.#engine.log(
      status === 'failed' ? 'error' : status === 'completed-with-errors' ? 'warn' : 'info',
      `batch closed: ${status} — ${batch.succeeded}/${batch.items.length || batch.jobs.size} succeeded${error ? ` [${error.code}] ${error.message}` : ''}`,
      {batchId: batch.id},
    )
    this.#emitBatch(batch, true)
    this.#open--
    if (wasActive) this.#active--
    this.#store.touch()
    this.#pump()
    if (this.#open === 0) {
      const waiters = this.#idleWaiters
      this.#idleWaiters = []
      for (const resolve of waiters) resolve()
      this.emit('idle')
    }
  }

  // ─── state & events ───────────────────────────────────────────────────────

  #setItems(batch: Batch, items: ItemState[]): void {
    batch.items = items
    batch.positions.clear()
    for (const [position, item] of items.entries()) batch.positions.set(item.url, position)
    this.#emitBatch(batch, true)
  }

  /** Record a preflight verdict: O(1) — counters move, one `item` event goes out. */
  #settleItem(batch: Batch, position: number, state: 'ok' | 'unavailable', patch: Partial<ItemState>): void {
    const item = batch.items[position]
    if (!item || item.state === 'ok' || item.state === 'unavailable') return
    batch.items[position] = {...item, ...patch, state}
    batch.checked++
    if (state === 'ok') batch.ok++
    else batch.unavailable++
    this.emit('item', batch.id, publicItem(batch.items[position]!))
    this.#emitBatch(batch, false)
  }

  #setStatus(batch: Batch, status: BatchStatus): void {
    batch.status = status
    this.#engine.log('debug', `batch ${status}`, {batchId: batch.id})
    this.#emitBatch(batch, true)
  }

  #counts(batch: Batch): BatchCounts {
    const pending = batch.jobs.size - batch.succeeded - batch.failed
    return {
      total: batch.jobs.size,
      queued: pending - batch.running.size,
      running: batch.running.size,
      succeeded: batch.succeeded,
      failed: batch.failed,
    }
  }

  #snapshot(batch: Batch): BatchSnapshot {
    if (batch.snapshot) return batch.snapshot
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
      preflight: {total: batch.items.length, checked: batch.checked, ok: batch.ok, unavailable: batch.unavailable},
      jobs: this.#counts(batch),
      error: batch.error,
      createdAt: batch.createdAt,
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
    })
    return batch.snapshot
  }

  /** Status changes go out at once; counter-only changes at most every progressIntervalMs. */
  #emitBatch(batch: Batch, force: boolean): void {
    batch.snapshot = undefined
    const wait = this.#intervalMs - (Date.now() - batch.lastEmit)
    if (force || wait <= 0) {
      if (batch.emitTimer) clearTimeout(batch.emitTimer)
      batch.emitTimer = undefined
      batch.lastEmit = Date.now()
      this.emit('batch', this.#snapshot(batch))
      // queue positions of the batches behind may have moved
      if (force && batch.status !== 'scheduled') {
        for (const other of this.#batches.values()) if (other.status === 'scheduled') other.snapshot = undefined
      }
    } else if (!batch.emitTimer) {
      batch.emitTimer = setTimeout(() => {
        batch.emitTimer = undefined
        this.#emitBatch(batch, true)
      }, wait)
      batch.emitTimer.unref()
    }
  }
}

/** Strip internal fields before an item leaves the scheduler. */
function publicItem(item: ItemState): PreflightItem {
  const {extractor: _extractor, infoJsonPath: _infoJsonPath, ...rest} = item
  return rest
}
