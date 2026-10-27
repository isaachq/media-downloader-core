import {EventEmitter} from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {assertHttpUrl, isYouTubeMix, MAX_REQUESTED_ITEMS, MIX_DEFAULT_ITEMS} from './core/analyze.js'
import {estimateBytes, jobTier, matchingChoice, peakBytes} from './core/cost.js'
import {cancelledError, DownloadError, toJobError} from './core/errors.js'
import {WorkMeter} from './core/eta.js'
import {freeSpace} from './core/files.js'
import {profileKey, profileProblem} from './core/formats.js'
import {newId} from './core/ids.js'
import {isTerminal} from './core/job.js'
import {isListingLink, SONG_IN_VIDEOS as SONG} from './core/mix.js'
import {QueueStore} from './core/queue-store.js'
import {ANALYZE_ATTEMPTS, type MediaDownloader} from './downloader.js'
import {planMix} from './sources/mix-plan.js'
import {isTikTokProfile} from './sources/tiktok/links.js'
import {slideshowOptions} from './sources/tiktok/slideshow.js'
import {TIKTOK_PROFILE_DEFAULT_ITEMS} from './sources/tiktok/source.js'
import type {
  BatchCounts,
  BatchEstimate,
  BatchId,
  BatchRequest,
  BatchSelection,
  BatchSnapshot,
  BatchStatus,
  BatchTarget,
  FormatProfile,
  JobError,
  JobId,
  JobOutcome,
  JobRequest,
  JobSnapshot,
  MediaSummary,
  MixAnalysis,
  MixRequest,
  PlaylistAnalysis,
  PlaylistEntry,
  PreflightItem,
  SchedulerEvents,
  SchedulerOptions,
  SlideshowOptions,
  VideoAnalysis,
} from './types.js'
import {formatBytes} from './util/units.js'

/** Jobs created per event-loop turn while enqueuing a batch. */

const ENQUEUE_SLICE = 250

/** Items checked against the archive concurrently while forecasting. */
const FORECAST_SLICE = 200

/**
 * Free bytes of the destination and work folders, and whether both live on
 * the same volume (same device id) — then their needs add up.
 */
async function volumes(outDir: string, workDir: string): Promise<[number | undefined, number | undefined, boolean]> {
  const [outFree, workFree] = await Promise.all([freeSpace(outDir), freeSpace(workDir)])
  const [outStat, workStat] = await Promise.all([
    fs.stat(outDir).catch(() => undefined),
    fs.stat(workDir).catch(() => undefined),
  ])
  return [outFree, workFree, outStat !== undefined && workStat !== undefined && outStat.dev === workStat.dev]
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve))

const TERMINAL: ReadonlySet<BatchStatus> = new Set(['completed', 'completed-with-errors', 'failed', 'cancelled'])

/**
 * Whether what a media becomes depends on `SlideshowOptions.mode`: a photo
 * post or a carousel of pictures does; a video, or a carousel with videos
 * (always a folder of everything), does not. O(1).
 */
const madeByMode = (media: Pick<MediaSummary, 'slideshow'>): boolean =>
  media.slideshow !== undefined && media.slideshow.videos !== true

/** Extra fields an item carries internally (never emitted). */
type ItemState = PreflightItem & {
  readonly extractor?: string | undefined
  readonly infoJsonPath?: string | undefined
  /** A photo post (from the listing or the check): its archive key carries the slideshow mode. */
  readonly photoPost?: boolean | undefined
}

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
  /** Jobs the user cancelled: out of the batch, which goes on (and can still complete) without them. */
  readonly cancelledJobs: Set<JobId>
  /** Why each failed job failed (its hint, else its code) — kept per job so a retry can take it back. */
  readonly failedCause: Map<JobId, string>
  /** Failed jobs and unavailable items by cause: running totals, O(1) per change. */
  readonly failedBy: Map<string, number>
  readonly unavailableBy: Map<string, number>
  /** Metadata files kept so far (bounded by maxCachedMetadata). */
  cached: number
  /** Jobs are still being created: the batch can't close yet. */
  enqueuing: boolean
  estimate: BatchEstimate | undefined
  error: JobError | undefined
  readonly createdAt: number
  startedAt: number | undefined
  finishedAt: number | undefined
  controller: AbortController | undefined
  snapshot: BatchSnapshot | undefined
  /** Weighted progress and time left of the running jobs (set when they are enqueued). */
  meter: WorkMeter | undefined
  /** The check after the downloads (`validationTiming: 'after-batch'`), while it runs. */
  checking: {done: number; total: number} | undefined
  /** Single items' own folder / profile / list position, by index (a batch gathering items of several). */
  /** Grows when a check keeps a song of a batch of videos as M4A (#resolveItem); saved with the request. */
  readonly targets: Map<number, BatchTarget>
  /** Brought back by restore(): its items were checked before the app closed, so they are not checked again. */
  readonly restored: boolean
  /** A mix list's checks, by url, until its items take them (scheduleMix): not checked twice. */
  known: Map<string, VideoAnalysis> | undefined
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
  readonly #diskCheck: 'block' | 'warn' | 'off'
  readonly #longMinutes: number
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
    this.#diskCheck = options.diskCheck ?? 'block'
    this.#longMinutes = engine.longVideoMinutes
    this.#store = new QueueStore(path.join(engine.dataDir, 'schedule.json'), () =>
      [...this.#batches.values()]
        .filter(batch => !TERMINAL.has(batch.status))
        // the targets as they are now (songs kept as M4A included): O(targets) per save
        .map(batch =>
          batch.targets.size > 0 ? {...batch.request, targets: [...batch.targets.values()]} : batch.request,
        ),
    )
    engine.on('job', this.#onJob)
  }

  /** Queue a url. Returns at once; the batch starts when it's its turn. */
  schedule(request: BatchRequest): BatchSnapshot {
    return this.#add(request, false)
  }

  /**
   * Queue a mix list — links of any sites pasted together — as one batch, which
   * runs, reports, retries and resumes like any other. From `analyzeMix()`: its
   * valid links, whose checks the batch takes as they are (nothing is checked
   * twice; a link the site would not check then is checked as it downloads).
   * From a text or a list of links: each link once, lists left out, and the
   * batch checks them itself — those that can't be downloaded show in it as
   * unavailable, with their reason. Every file goes straight into `outDir`,
   * named as a single download is. Returns at once; throws when no link is
   * left. O(n): one pass, a Set and a Map.
   */
  scheduleMix(mix: MixAnalysis | string | readonly string[], request: MixRequest): BatchSnapshot {
    const links: ReadonlyArray<{
      readonly url: string
      readonly analysis?: VideoAnalysis | undefined
      readonly format?: FormatProfile | undefined
    }> =
      typeof mix === 'string' || Array.isArray(mix)
        ? planMix(mix).links.filter(link => !isListingLink(link.url, this.#engine))
        : (mix as MixAnalysis).valid
    const entries: PlaylistEntry[] = []
    const known = new Map<string, VideoAnalysis>()
    const urls = new Set<string>()
    // a link's format of its own from the check (a song in a list of videos), by url
    const checkedFormats = new Map<string, FormatProfile>()
    for (const link of links) {
      // two links the check found to be one media url: the batch keeps its items by url
      if (urls.has(link.url)) continue
      urls.add(link.url)
      const media = link.analysis?.media
      entries.push({
        ...(media ?? {id: '', title: link.url, extractor: 'Generic', isLive: false}),
        url: link.url,
        index: entries.length + 1,
      })
      if (link.analysis) known.set(link.url, link.analysis)
      if (link.format) checkedFormats.set(link.url, link.format)
    }
    if (entries.length === 0) throw new DownloadError('invalid-request', 'No link of this mix list can be downloaded.')
    // a link with a format or a folder of its own (one song in MP3 among videos): a target of the same batch. O(n)
    const targets: BatchTarget[] = []
    for (const entry of entries) {
      const own = request.formats?.[entry.url] ?? checkedFormats.get(entry.url)
      const profile = own && profileKey(own) !== profileKey(request.profile) ? own : undefined
      // a song the check kept as M4A goes to the songs' folder unless the link has a folder of its own
      const song = !request.formats?.[entry.url] && checkedFormats.has(entry.url) ? request.audioOutDir : undefined
      const folder = request.outDirs?.[entry.url] ?? song
      if (folder !== undefined && !path.isAbsolute(folder)) {
        throw new DownloadError('invalid-request', 'outDirs and audioOutDir must be absolute paths.')
      }
      const outDir = folder !== undefined && folder !== request.outDir ? folder : undefined
      if (profile || outDir) {
        targets.push({index: entry.index, outDir: outDir ?? request.outDir, profile: profile ?? request.profile})
      }
    }
    return this.#add(
      {
        url: entries[0]!.url,
        profile: request.profile,
        outDir: request.outDir,
        selection: {title: request.title ?? 'Mix list', entries},
        ...(targets.length > 0 && {targets}),
        flat: true,
        mix: true,
        ...(request.slideshow !== undefined && {slideshow: request.slideshow}),
        ...(request.retries !== undefined && {retries: request.retries}),
        ...(request.audioOutDir !== undefined && {audioOutDir: request.audioOutDir}),
      },
      false,
      known.size > 0 ? known : undefined,
    )
  }

  #add(request: BatchRequest, restored: boolean, known?: Map<string, VideoAnalysis>): BatchSnapshot {
    if (this.#disposed) throw new Error('BatchScheduler has been disposed.')
    const url = assertHttpUrl(request.url)
    const problem = profileProblem(request.profile)
    if (problem) throw new DownloadError('invalid-request', problem)
    if (!path.isAbsolute(request.outDir)) throw new DownloadError('invalid-request', 'outDir must be an absolute path.')
    const selectionProblem = request.selection && selectionIssue(request.selection)
    if (selectionProblem) throw new DownloadError('invalid-request', selectionProblem)
    if (request.analysis && request.analysis.kind !== 'video') {
      throw new DownloadError('invalid-request', 'analysis must be the analysis of a single video.')
    }
    const {maxItems} = request
    if (request.audioOutDir !== undefined && !path.isAbsolute(request.audioOutDir)) {
      throw new DownloadError('invalid-request', 'audioOutDir must be an absolute path.')
    }
    if (maxItems !== undefined && !(Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= MAX_REQUESTED_ITEMS)) {
      throw new DownloadError('invalid-request', `maxItems must be an integer from 1 to ${MAX_REQUESTED_ITEMS}.`)
    }
    const targets = new Map<number, BatchTarget>()
    for (const target of request.targets ?? []) {
      const issue =
        !Number.isInteger(target?.index) ||
        (target.outDir !== undefined && (typeof target.outDir !== 'string' || !path.isAbsolute(target.outDir)))
          ? 'Every target needs an entry index, and an absolute outDir when it names one.'
          : profileProblem(target.profile)
      if (issue) throw new DownloadError('invalid-request', issue)
      targets.set(target.index, {
        ...target,
        ...(target.outDir !== undefined && {outDir: path.resolve(target.outDir)}),
        ...(target.slideshow !== undefined && {slideshow: slideshowOptions(target.slideshow)}),
      })
    }

    const batch: Batch = {
      id: newId() as BatchId,
      request: {
        ...request,
        url,
        outDir: path.resolve(request.outDir),
        ...(request.slideshow !== undefined && {slideshow: slideshowOptions(request.slideshow)}),
        maxItems:
          maxItems ??
          (isYouTubeMix(url)
            ? MIX_DEFAULT_ITEMS
            : (this.#engine.defaultListSize(url) ?? (isTikTokProfile(url) ? TIKTOK_PROFILE_DEFAULT_ITEMS : undefined))),
      },
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
      cancelledJobs: new Set(),
      failedCause: new Map(),
      failedBy: new Map(),
      unavailableBy: new Map(),
      cached: 0,
      enqueuing: false,
      estimate: undefined,
      meter: undefined,
      checking: undefined,
      targets,
      restored,
      known,
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
   * Their items were checked before the app closed and are not checked
   * again (840 TikTok posts at the site's pace is ~28 minutes before the
   * first download): each item is read when it downloads.
   */
  async restore(): Promise<BatchSnapshot[]> {
    await this.#engine.restoreQueue(request => request.batchId === undefined)
    const restored: BatchSnapshot[] = []
    for (const request of await this.#store.load()) {
      try {
        restored.push(this.#add(request, true))
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

  /**
   * Download a batch's failed (and cancelled) jobs again. A closed batch
   * reopens: it runs, counts and closes like the first time, so its status,
   * totals, causes and time left stay true. Returns how many were retried.
   */
  retryFailed(id: BatchId): number {
    const batch = this.#batches.get(id)
    if (!batch || batch.failed === 0 || batch.status === 'scheduled' || batch.status === 'checking') return 0
    // damaged at the source: trying again would only fail the same way
    const failed = [...batch.jobs]
      .filter(
        ([jobId, outcome]) =>
          outcome === 'failed' && !batch.cancelledJobs.has(jobId) && batch.failedCause.get(jobId) !== 'damaged-source',
      )
      .map(([jobId]) => jobId)
    return this.#retry(batch, failed).length
  }

  /** Retry one job; a job of a batch is retried through its batch, so the batch follows it. */
  retryJob(jobId: JobId): JobSnapshot | undefined {
    const batchId = this.#byJob.get(jobId)
    const batch = batchId ? this.#batches.get(batchId) : undefined
    if (batch?.jobs.get(jobId) !== 'failed') return this.#engine.retry(jobId)
    return this.#retry(batch!, [jobId])[0]
  }

  /** The new jobs, one per job that could be retried. */
  #retry(batch: Batch, jobIds: readonly JobId[]): JobSnapshot[] {
    // while its files are being checked a batch takes nothing new: try again once it has closed
    if (batch.status === 'validating') return []
    const reopen = TERMINAL.has(batch.status)
    const retried: JobSnapshot[] = []
    // item of each job, found once: O(items) per call, not per job
    const itemOf = new Map<JobId, number>()
    batch.items.forEach((item, position) => {
      if (item.jobId) itemOf.set(item.jobId, position)
    })
    for (const oldId of jobIds) {
      const job = this.#engine.retry(oldId)
      if (!job) continue
      retried.push(job)
      batch.jobs.delete(oldId)
      this.#byJob.delete(oldId)
      // a cancelled item comes back into the batch; a failed one is no longer a failure
      if (!batch.cancelledJobs.delete(oldId)) {
        batch.failed--
        const cause = batch.failedCause.get(oldId)
        batch.failedCause.delete(oldId)
        if (cause) bump(batch.failedBy, cause, -1)
      }
      batch.jobs.set(job.id, job.outcome)
      this.#byJob.set(job.id, batch.id)
      const position = itemOf.get(oldId)
      if (position !== undefined) {
        const item = batch.items[position]!
        batch.items[position] = {...item, jobId: job.id}
        batch.meter?.add(job.id, item.estimatedBytes)
        this.emit('item', batch.id, publicItem(batch.items[position]!))
      }
    }
    if (retried.length === 0) return retried
    if (reopen) {
      this.#engine.log('info', `batch reopened: retrying ${retried.length} failed item(s)`, {batchId: batch.id})
      batch.status = 'running'
      batch.error = undefined
      batch.finishedAt = undefined
      batch.controller = new AbortController()
      batch.meter ??= new WorkMeter()
      this.#open++
      this.#active++
      this.#store.touch()
    }
    this.#emitBatch(batch, true)
    return retried
  }

  /**
   * Cancel a batch: scheduled → dropped, checking → stopped, running → its
   * jobs cancelled, validating → the check stops (files stay as they are).
   * Cancelling one job instead (`engine.cancel`) only drops that item.
   */
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
      const {maxItems, selection, analysis: known} = batch.request
      const analysis = selection
        ? fromSelection(batch.request.url, selection)
        : (known ??
          (await this.#engine.analyze(batch.request.url, {
            signal,
            waitForSite: true,
            ...(maxItems && {maxEntries: maxItems}),
          })))
      if (maxItems && analysis.kind === 'playlist' && analysis.entries.length >= maxItems) {
        this.#engine.log('info', `list capped at its first ${maxItems} items`, {batchId: batch.id})
      }
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
      if (!(await this.#forecast(batch))) return
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
        photoPost: madeByMode(analysis.media),
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
          photoPost: madeByMode(entry),
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

    // a mix list checked before it was scheduled: its checks are taken as they are
    const known = batch.known
    batch.known = undefined
    if (known) {
      batch.items.forEach((item, position) => {
        const analysis = known.get(item.url)
        if (analysis && item.state === 'pending') this.#resolveItem(batch, position, analysis)
      })
    }

    const pending = batch.items.filter(item => item.state === 'pending')
    if (!this.#preflight || batch.restored) {
      for (const item of pending) this.#settleItem(batch, batch.positions.get(item.url)!, 'ok', {})
      if (batch.restored && pending.length > 0) {
        this.#engine.log('info', `restored: ${pending.length} item(s) checked before, read as they download`, {
          batchId: batch.id,
        })
      }
      return
    }
    // an item already downloaded needs no network check (the forecast then counts it as archived)
    const unknown = await this.#notArchived(batch, pending, signal)
    // nothing left to ask (all archived, or all checked by a mix list's analysis): no network at all
    if (unknown.length === 0) return
    let deferred = 0
    await this.#engine.preflight(
      unknown.map(item => ({url: item.url, id: item.mediaId})),
      {
        signal,
        attempts: batch.request.retries === 'thorough' ? ANALYZE_ATTEMPTS : 1,
        keepMetadata: () => batch.cached++ < this.#maxCached,
        onResult: (url, result) => {
          const position = batch.positions.get(url)
          if (position === undefined || signal.aborted) return
          if (result.ok) this.#resolveItem(batch, position, result.analysis)
          // a bot check blocks for a while, not for good: the item downloads, and is checked then (paced)
          else if (result.error.code === 'blocked') {
            deferred++
            this.#settleItem(batch, position, 'ok', {})
          } else this.#settleItem(batch, position, 'unavailable', {error: result.error})
        },
      },
    )
    if (deferred) {
      this.#engine.log(
        'warn',
        `preflight: ${deferred} item(s) not checked — the site asks to confirm this is not a bot; they are checked as they download`,
        {batchId: batch.id},
      )
    }
  }

  /**
   * The items not archived yet; archived ones are settled ok without a network
   * check. O(n): one archive lookup (an O(1) index hit and a stat) per item
   * with an id, FORECAST_SLICE at a time.
   */
  async #notArchived(batch: Batch, pending: readonly ItemState[], signal: AbortSignal): Promise<ItemState[]> {
    const unknown: ItemState[] = []
    let archived = 0
    for (let start = 0; start < pending.length && !signal.aborted; start += FORECAST_SLICE) {
      const slice = pending.slice(start, start + FORECAST_SLICE)
      const done = await Promise.all(
        slice.map(item =>
          item.extractor && item.mediaId
            ? this.#engine.isArchived(
                item.extractor,
                item.mediaId,
                this.#profileOf(batch, item.index),
                this.#slideshowKeyOf(batch, item),
              )
            : false,
        ),
      )
      slice.forEach((item, offset) => {
        if (!done[offset]) {
          unknown.push(item)
          return
        }
        archived++
        this.#settleItem(batch, batch.positions.get(item.url)!, 'ok', {})
      })
    }
    if (archived > 0) {
      this.#engine.log('info', `preflight: ${archived} item(s) already downloaded, not checked again`, {
        batchId: batch.id,
      })
    }
    return unknown
  }

  /** The profile an item downloads in: its target's, else the batch's. */
  #profileOf(batch: Batch, index: number): FormatProfile {
    return batch.targets.get(index)?.profile ?? batch.request.profile
  }

  /** What an item's photo post is made into: its target's, else the batch's (an MP4 by default). O(1). */
  #slideshowOf(batch: Batch, index: number): SlideshowOptions | undefined {
    return batch.targets.get(index)?.slideshow ?? batch.request.slideshow
  }

  /** Whether an item is a photo post: its listing or check says so, or its target was kept as one. O(1). */
  #isPhotoPost(batch: Batch, item: ItemState): boolean {
    return item.photoPost === true || batch.targets.get(item.index)?.slideshow !== undefined
  }

  /**
   * The slideshow mode an item's archive key carries — only a photo post's,
   * so the lookups here and the job's (and its record) agree. O(1).
   */
  #slideshowKeyOf(batch: Batch, item: ItemState): SlideshowOptions['mode'] | undefined {
    return this.#isPhotoPost(batch, item) ? this.#slideshowOf(batch, item.index)?.mode : undefined
  }

  /**
   * Where a song kept as M4A goes: its own target's folder, else the batch's
   * `audioOutDir` (in the list's folder and position for a list), else nothing
   * (the batch's own folder and position). O(1).
   */
  #songPlace(batch: Batch, index: number): Pick<BatchTarget, 'outDir' | 'playlist'> {
    const own = batch.targets.get(index)
    if (own?.outDir !== undefined) return {outDir: own.outDir, playlist: own.playlist}
    const songs = batch.request.audioOutDir
    if (songs === undefined) return {}
    if (batch.kind !== 'playlist' || batch.request.flat === true) return {outDir: path.resolve(songs)}
    const title = batch.title ?? 'Playlist'
    return {
      outDir: this.#engine.folderFor(path.resolve(songs), title),
      playlist: {id: batch.playlistId ?? batch.id, title, index},
    }
  }

  /** A checked item: downloadable if the source offers the requested kind of stream; sized and classified. */
  #resolveItem(batch: Batch, position: number, analysis: VideoAnalysis): void {
    const index = batch.items[position]?.index ?? 0
    let profile = this.#profileOf(batch, index)
    let choice =
      matchingChoice(profile, analysis.choices) ?? analysis.choices.find(c => c.profile.kind === profile.kind)
    // no picture at all (a SoundCloud track) in a batch of videos: kept as M4A, not unavailable
    const song =
      !choice && profile.kind === 'video' ? analysis.choices.find(c => c.profile.kind === 'audio') : undefined
    if (song) {
      profile = SONG
      choice = matchingChoice(SONG, analysis.choices) ?? song
      batch.targets.set(index, {...batch.targets.get(index), ...this.#songPlace(batch, index), index, profile: SONG})
      this.#store.touch()
    }
    const duration = analysis.media.duration ?? batch.items[position]?.duration
    const requiresConversion = choice?.requiresConversion ?? false
    // what the check found is what the job and the archive go by (an entry's own may be a guess)
    const facts = {
      title: analysis.media.title,
      duration,
      infoJsonPath: analysis.infoJsonPath,
      photoPost: madeByMode(analysis.media),
      ...(analysis.media.extractor && {extractor: analysis.media.extractor}),
      ...(analysis.media.id && {mediaId: analysis.media.id}),
    }
    if (!choice) {
      this.#settleItem(batch, position, 'unavailable', {
        ...facts,
        error: {code: 'unavailable', hint: 'format-unavailable', message: `No ${profile.kind} formats.`},
      })
      return
    }
    this.#settleItem(batch, position, 'ok', {
      ...facts,
      requiresConversion,
      estimatedBytes: estimateBytes(profile, analysis.choices, duration),
      tier: jobTier({profile, duration, requiresConversion, processingKind: choice?.processingKind}, this.#longMinutes),
    })
  }

  /**
   * Disk and load forecast once every item is checked: archived items cost
   * nothing; the rest need their final size at the destination plus, at
   * peak, the temporary copies of the jobs running at once on the work
   * volume. O(n) over the items, one stat per item for the archive check.
   */
  async #forecast(batch: Batch): Promise<boolean> {
    const {outDir} = batch.request
    let bytes = 0
    let unknown = 0
    let archived = 0
    let long = 0
    let heavy = 0
    let largestPeak = 0
    let candidates = 0
    let damaged = 0
    for (let start = 0; start < batch.items.length; start += FORECAST_SLICE) {
      const slice = batch.items.slice(start, start + FORECAST_SLICE)
      // damaged at the source first: such an item is never downloaded, archived or not
      const broken = await Promise.all(
        slice.map(item =>
          item.state === 'ok'
            ? this.#engine.isDamaged({url: item.url, extractor: item.extractor, mediaId: item.mediaId})
            : undefined,
        ),
      )
      const done = await Promise.all(
        slice.map((item, offset) =>
          item.state === 'ok' && !broken[offset] && item.extractor && item.mediaId
            ? this.#engine.isArchived(
                item.extractor,
                item.mediaId,
                this.#profileOf(batch, item.index),
                this.#slideshowKeyOf(batch, item),
              )
            : false,
        ),
      )
      slice.forEach((item, offset) => {
        if (item.state !== 'ok') return
        const known = broken[offset]
        if (known) {
          damaged++
          batch.ok--
          batch.unavailable++
          bump(batch.unavailableBy, 'damaged-source', 1)
          batch.items[start + offset] = {
            ...item,
            state: 'unavailable',
            error: {
              code: 'unavailable',
              hint: 'damaged-source',
              message: `Damaged at the source — not downloaded again: ${known.reason}`,
            },
          }
          this.emit('item', batch.id, publicItem(batch.items[start + offset]!))
          return
        }
        if (done[offset]) {
          archived++
          batch.items[start + offset] = {...item, archived: true}
          return
        }
        candidates++
        if (item.tier === 'long') long++
        if (item.tier === 'heavy') heavy++
        if (item.estimatedBytes === undefined) unknown++
        else {
          bytes += item.estimatedBytes
          largestPeak = Math.max(largestPeak, peakBytes(item.estimatedBytes, item.requiresConversion ?? false))
        }
      })
    }

    if (damaged) {
      this.#engine.log('warn', `${damaged} item(s) damaged at the source: not downloaded again`, {batchId: batch.id})
      if (batch.ok === 0) {
        this.#close(batch, 'failed', {
          code: 'unavailable',
          hint: 'damaged-source',
          message: 'Every item of this batch is unavailable or damaged at the source.',
        })
        return false
      }
    }
    // temporary space: the largest job's peak times the jobs that can run at once
    const temp = largestPeak * Math.min(candidates, this.#engine.concurrency)
    const [outFree, workFree, sameVolume] = await volumes(outDir, this.#engine.workDir)
    const requiredBytes = sameVolume ? bytes + temp : Math.max(bytes, temp)
    const shortOut = outFree !== undefined && outFree < (sameVolume ? bytes + temp : bytes)
    const shortWork = !sameVolume && workFree !== undefined && workFree < temp
    batch.estimate = {bytes, requiredBytes, freeBytes: outFree, unknown, archived, long, heavy}
    this.#emitBatch(batch, true)

    const gb = (n: number) => formatBytes(n) || '0 B' // SI units, the same the UIs show
    this.#engine.log(
      'info',
      `forecast: ${gb(bytes)} of new files, ${gb(requiredBytes)} needed at peak, ${outFree === undefined ? '?' : gb(outFree)} free · ${long} long, ${heavy} heavy, ${archived} already downloaded`,
      {batchId: batch.id},
    )
    if (!(shortOut || shortWork) || this.#diskCheck === 'off') return true
    const dir = shortOut ? outDir : this.#engine.workDir
    const free = (shortOut ? outFree : workFree) ?? 0
    const message = `Not enough disk space: the batch needs ${gb(requiredBytes)} and ${dir} has ${gb(free)} free.`
    if (this.#diskCheck === 'warn') {
      this.#engine.log('warn', message, {batchId: batch.id, code: 'disk-full'})
      return true
    }
    this.#close(batch, 'failed', {code: 'disk-full', message, params: {dir, requiredBytes, freeBytes: free}})
    return false
  }

  /**
   * Turn every downloadable item into a job, in slices of ENQUEUE_SLICE with
   * a yield in between: 5,000 jobs are still O(n) work, but the event loop
   * (and the UI it serves) never blocks for more than a few milliseconds.
   */
  async #enqueue(batch: Batch, signal: AbortSignal): Promise<void> {
    const {profile, outDir} = batch.request
    const flat = batch.request.flat === true
    const folder =
      batch.kind === 'playlist' && !flat ? this.#engine.folderFor(outDir, batch.title ?? 'Playlist') : outDir
    batch.enqueuing = true
    batch.meter = new WorkMeter()
    for (let position = 0; position < batch.items.length; position++) {
      if (position > 0 && position % ENQUEUE_SLICE === 0) {
        this.#emitBatch(batch, false)
        await yieldToEventLoop()
      }
      if (signal.aborted) break
      const item = batch.items[position]!
      if (item.state !== 'ok') continue
      const target = batch.targets.get(item.index)
      const request: JobRequest = {
        url: item.url,
        profile: target?.profile ?? profile,
        outDir: target?.outDir ?? folder,
        batchId: batch.id,
        batchTitle: batch.title,
        title: item.title,
        mediaId: item.mediaId,
        extractor: item.extractor,
        duration: item.duration,
        estimatedBytes: item.estimatedBytes,
        requiresConversion: item.requiresConversion,
        // a flat batch names files without a position: they join a folder that has its own order
        playlist:
          target?.outDir !== undefined
            ? target.playlist
            : batch.kind === 'playlist' && !flat
              ? {id: batch.playlistId ?? batch.id, title: batch.title ?? 'Playlist', index: item.index}
              : undefined,
        infoJsonPath: item.infoJsonPath,
        slideshow: this.#slideshowOf(batch, item.index),
        photoPost: this.#isPhotoPost(batch, item),
      }
      const job = this.#engine.add(request)
      batch.meter.add(job.id, item.estimatedBytes)
      batch.jobs.set(job.id, job.outcome)
      this.#byJob.set(job.id, batch.id)
      // the job owns the metadata file now (it deletes it when done)
      batch.items[position] = {...item, jobId: job.id, infoJsonPath: undefined}
      this.emit('item', batch.id, publicItem(batch.items[position]!))
    }
    batch.enqueuing = false
    this.#emitBatch(batch, true)
    // jobs of the first slices may all have finished already
    if (batch.status === 'running' && this.#ended(batch) === batch.jobs.size) void this.#finishRun(batch)
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
    let progressed = false
    if (isRunning && job.progress.fraction !== undefined) {
      batch.meter?.progress(job.id, job.progress.fraction)
      progressed = true
    }
    if (before !== job.outcome) {
      batch.jobs.set(job.id, job.outcome)
      // a file found broken by the check after the downloads: its success becomes a failure
      if (before === 'success') batch.succeeded--
      if (job.outcome === 'success') batch.succeeded++
      else if (job.status === 'cancelled') {
        // cancelled by the user: the item leaves the batch, which goes on without it
        batch.cancelledJobs.add(job.id)
      } else if (job.outcome === 'failed') {
        batch.failed++
        const cause = job.error?.hint ?? job.error?.code ?? 'unknown'
        batch.failedCause.set(job.id, cause)
        bump(batch.failedBy, cause, 1)
      }
      // already-downloaded and cancelled jobs took no real time: keep them out of the throughput
      if (job.outcome !== 'in-progress')
        batch.meter?.finish(job.id, job.status !== 'skipped' && job.status !== 'cancelled')
    }
    // throttled by #emitBatch: progress moves the ETA at most every progressIntervalMs
    if (before !== job.outcome || isRunning !== wasRunning || progressed) this.#emitBatch(batch, false)
    if (!batch.enqueuing && batch.status === 'running' && this.#ended(batch) === batch.jobs.size) {
      void this.#finishRun(batch)
    }
  }

  /** Jobs of the batch that ended, whichever way. */
  #ended(batch: Batch): number {
    return batch.succeeded + batch.failed + batch.cancelledJobs.size
  }

  /**
   * Every download ended: with `validationTiming: 'after-batch'`, check the
   * files first (status 'validating'), then close by how it went. Items the
   * user cancelled don't count against the batch: the rest all done → completed.
   */
  async #finishRun(batch: Batch): Promise<void> {
    const pending = this.#engine.pendingChecks(batch.jobs.keys())
    if (pending.length > 0 && !batch.controller?.signal.aborted) {
      batch.checking = {done: 0, total: pending.length}
      this.#setStatus(batch, 'validating')
      this.#engine.log('info', `downloads done — checking ${pending.length} file(s) now`, {batchId: batch.id})
      try {
        const found = await this.#engine.checkLater(pending, {
          signal: batch.controller?.signal,
          onProgress: (done, total) => {
            batch.checking = {done, total}
            this.#emitBatch(batch, false)
          },
        })
        this.#engine.log(
          found.damaged || found.failed ? 'warn' : 'info',
          `checked ${found.checked} file(s) after the downloads: ${found.ok} ok, ${found.damaged} damaged at the source, ${found.failed} failed`,
          {batchId: batch.id},
        )
      } catch (error) {
        if (!batch.controller?.signal.aborted) {
          this.#engine.log('error', `the check after the downloads stopped: ${toJobError(error).message}`, {
            batchId: batch.id,
          })
        }
      }
      batch.checking = undefined
      // cancelled while checking: what wasn't checked stays unchecked, and says so
      this.#engine.dropPendingChecks(pending)
      if (batch.status !== 'validating') return // closed meanwhile
    }
    const cancelled = batch.cancelledJobs.size
    if (batch.controller?.signal.aborted) this.#close(batch, 'cancelled', cancelledError().toJSON())
    else if (batch.succeeded === 0 && batch.failed === 0 && cancelled > 0)
      this.#close(batch, 'cancelled', cancelledError().toJSON())
    else if (batch.succeeded + cancelled === batch.items.length) this.#close(batch, 'completed')
    else if (batch.succeeded > 0) this.#close(batch, 'completed-with-errors')
    else this.#close(batch, 'failed', {code: 'unavailable', message: 'No item of this batch could be downloaded.'})
  }

  #close(batch: Batch, status: BatchStatus, error?: JobError): void {
    const wasActive = batch.status !== 'scheduled'
    batch.status = status
    batch.error = error
    batch.finishedAt = Date.now()
    batch.controller = undefined
    // metadata never handed to a job (cancelled / unavailable items, a mix list cancelled before it started): delete it
    for (const item of batch.items) if (item.infoJsonPath) void fs.rm(item.infoJsonPath, {force: true})
    for (const analysis of batch.known?.values() ?? [])
      if (analysis.infoJsonPath) void fs.rm(analysis.infoJsonPath, {force: true})
    batch.known = undefined
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
    else {
      batch.unavailable++
      bump(batch.unavailableBy, patch.error?.hint ?? patch.error?.code ?? 'unknown', 1)
    }
    this.emit('item', batch.id, publicItem(batch.items[position]!))
    this.#emitBatch(batch, false)
  }

  #setStatus(batch: Batch, status: BatchStatus): void {
    batch.status = status
    this.#engine.log('debug', `batch ${status}`, {batchId: batch.id})
    this.#emitBatch(batch, true)
  }

  #counts(batch: Batch): BatchCounts {
    const pending = batch.jobs.size - this.#ended(batch)
    return {
      total: batch.jobs.size,
      queued: Math.max(0, pending - batch.running.size),
      running: batch.running.size,
      succeeded: batch.succeeded,
      failed: batch.failed,
      cancelled: batch.cancelledJobs.size,
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
      maxItems: batch.request.maxItems,
      status: batch.status,
      kind: batch.kind,
      mix: batch.request.mix,
      title: batch.title,
      position,
      preflight: {total: batch.items.length, checked: batch.checked, ok: batch.ok, unavailable: batch.unavailable},
      problems:
        batch.failedBy.size || batch.unavailableBy.size
          ? {failed: Object.fromEntries(batch.failedBy), unavailable: Object.fromEntries(batch.unavailableBy)}
          : undefined,
      estimate: batch.estimate,
      jobs: this.#counts(batch),
      error: batch.error,
      createdAt: batch.createdAt,
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
      progress: batch.status === 'running' ? batch.meter?.estimate() : undefined,
      validation: batch.status === 'validating' ? batch.checking : undefined,
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
/** Add `delta` to a counter, dropping it at zero. */
function bump(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta
  if (next > 0) counts.set(key, next)
  else counts.delete(key)
}

function publicItem(item: ItemState): PreflightItem {
  const {extractor: _extractor, infoJsonPath: _infoJsonPath, ...rest} = item
  return rest
}

/** Why a preview selection can't be scheduled, or undefined. O(entries). */
function selectionIssue(selection: BatchSelection): string | undefined {
  const {entries} = selection
  if (!Array.isArray(entries) || entries.length === 0) return 'selection.entries must not be empty.'
  if (entries.length > MAX_REQUESTED_ITEMS) return `selection.entries holds at most ${MAX_REQUESTED_ITEMS} items.`
  for (const entry of entries) {
    if (typeof entry?.url !== 'string' || !/^https?:\/\//.test(entry.url))
      return 'Every selected entry needs an http(s) url.'
  }
  return undefined
}

/** A preview selection as the playlist analysis the preflight expects, without asking yt-dlp again. */
function fromSelection(url: string, selection: BatchSelection): PlaylistAnalysis {
  return {
    kind: 'playlist',
    id: '',
    url,
    title: selection.title,
    extractor: selection.entries[0]?.extractor ?? 'Generic',
    entries: selection.entries,
    choices: [],
  }
}
