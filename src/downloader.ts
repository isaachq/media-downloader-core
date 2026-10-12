import {EventEmitter} from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {type Diagnosis, diagnose, type SetupResult, setup} from './binaries/doctor.js'
import {
  BinaryManager,
  defaultJsRuntime,
  type InstallOptions,
  type ResolvedBinaries,
  type UpdateResult,
} from './binaries/manager.js'
import {analyze, assertHttpUrl, type ExtractResult, extractMany} from './core/analyze.js'
import {type ArchiveEntry, archiveKey, DownloadArchive} from './core/archive.js'
import {ensureContainer, extractAudio, type MediaTags, writeTags} from './core/convert.js'
import {jobTier, peakBytes, TIER_WEIGHT} from './core/cost.js'
import {type DownloadedInfo, runYtDlp} from './core/download.js'
import {cancelledError, DownloadError, isRetryable, toJobError} from './core/errors.js'
import {
  type FileNameStyle,
  folderName,
  freeSpace,
  isInside,
  mediaFileStem,
  moveIntoPlace,
  publishedSeconds,
  shortHash,
  stampPublished,
} from './core/files.js'
import {profileKey, profileProblem, rulesFor} from './core/formats.js'
import {HashPool} from './core/hash-pool.js'
import {newId} from './core/ids.js'
import {Job, type JobPatch} from './core/job.js'
import {clampConcurrency, cpuCount, maxConcurrency, TaskPool} from './core/pool.js'
import {utf8Env} from './core/process.js'
import {PendingJournal} from './core/queue-store.js'
import {TraceLog} from './core/trace-log.js'
import {ffprobe, summarizeProbe, validateBundle, validateFile} from './core/validate.js'
import {type ListingProgress, type MediaSource, needsFallback} from './sources/source.js'
import {DEFAULT_SLIDESHOW, slideshowOptions} from './sources/tiktok/slideshow.js'
import {TikTokSource} from './sources/tiktok/source.js'
import type {
  AnalysisResult,
  AttemptStrategy,
  DownloaderEvents,
  DownloaderOptions,
  FormatProfile,
  JobId,
  JobRequest,
  JobSnapshot,
  LogEntry,
  LogLevel,
  PlaylistAnalysis,
  StepName,
  TerminalStatus,
  TraceId,
  ValidationLevel,
  VideoAnalysis,
} from './types.js'

type Settings = {
  validation: ValidationLevel
  fileNames: FileNameStyle
  readonly fragmentsPerDownload: number
  readonly checksums: boolean
  readonly useArchive: boolean
  readonly maxRetries: number
  readonly retryDelayMaxMs: number
  readonly stallTimeoutMs: number
  readonly embedMetadata: boolean
  readonly embedThumbnail: boolean
  readonly progressIntervalMs: number
  readonly minFreeSpaceBytes: number
  readonly retainFinishedJobs: number
  readonly metadataMaxAgeMs: number
  readonly longVideoMinutes: number
  readonly extraYtDlpArgs: readonly string[]
}

export type ArchiveCheck = {
  readonly entry: ArchiveEntry
  readonly ok: boolean
  readonly problem?: 'missing' | 'size-changed' | 'checksum-mismatch' | undefined
}

/**
 * The download engine.
 *
 * Concurrency model: one JavaScript thread orchestrates; the work happens in
 * child processes (yt-dlp downloads, ffmpeg converts/validates) that run in
 * parallel on separate cores, plus a small worker-thread pool for SHA-256.
 * At most ⌊CPUs/2⌋ jobs run at once, and each job runs download → convert →
 * validate → move inside its pool slot, so the limit covers the whole
 * pipeline. Nothing in this class blocks the event loop.
 *
 * Usage (Electron main process, CLI, server):
 *
 *   await using dl = new MediaDownloader({dataDir})
 *   dl.on('job', snapshot => render(snapshot))
 *   const result = await dl.analyze(url)
 *   if (result.kind === 'video') dl.addVideo(result, result.choices[0]!.profile, outDir)
 *   await dl.whenIdle()
 */
export class MediaDownloader extends EventEmitter<DownloaderEvents> implements AsyncDisposable {
  readonly binaries: BinaryManager
  readonly archive: DownloadArchive
  readonly #settings: Settings
  readonly #pool: TaskPool<JobId>
  readonly #hashes = new HashPool()
  /** Sites handled natively instead of by yt-dlp. */
  readonly #sources: readonly MediaSource[]
  readonly #queue: PendingJournal<JobRequest>
  readonly #jobs = new Map<JobId, Job>()
  /** Terminal jobs in finishing order, for releasing the oldest ones. */
  readonly #finished = new Set<JobId>()
  readonly #analyses = new Set<AbortController>()
  /** Folder holding tools, archive, queue state and logs. */
  readonly dataDir: string
  readonly #workRoot: string
  readonly #cacheDir: string
  readonly #env: NodeJS.ProcessEnv
  readonly #commonArgs: readonly string[]
  readonly #trace: TraceLog | undefined
  /** Identifies this engine instance (one app launch / CLI run) in every log entry. */
  readonly sessionId: TraceId = newId()
  #disposing = false

  /** Upper bound of `concurrency` on this machine: ⌊logical CPUs / 2⌋. */
  static maxConcurrency(): number {
    return maxConcurrency()
  }

  static cpuCount(): number {
    return cpuCount()
  }

  constructor(options: DownloaderOptions) {
    super()
    if (!path.isAbsolute(options.dataDir)) throw new TypeError('dataDir must be an absolute path.')
    this.#settings = {
      validation: options.validation ?? 'full',
      fileNames: options.fileNames ?? 'portable',
      fragmentsPerDownload: Math.max(1, Math.floor(options.fragmentsPerDownload ?? 3)),
      checksums: options.checksums ?? true,
      useArchive: options.useArchive ?? true,
      maxRetries: Math.max(0, Math.floor(options.maxRetries ?? 3)),
      retryDelayMaxMs: Math.max(0, options.retryDelayMaxMs ?? 15_000),
      stallTimeoutMs: Math.max(0, options.stallTimeoutMs ?? 120_000),
      embedMetadata: options.embedMetadata ?? true,
      embedThumbnail: options.embedThumbnail ?? false,
      progressIntervalMs: Math.max(0, options.progressIntervalMs ?? 250),
      minFreeSpaceBytes: Math.max(0, options.minFreeSpaceBytes ?? 512 * 1024 * 1024),
      retainFinishedJobs: Math.max(0, Math.floor(options.retainFinishedJobs ?? 1000)),
      metadataMaxAgeMs: Math.max(0, options.metadataMaxAgeMs ?? 3 * 60 * 60 * 1000),
      longVideoMinutes: Math.max(1, options.longVideoMinutes ?? 30),
      extraYtDlpArgs: options.extraYtDlpArgs ?? [],
    }
    this.#sources = [
      ...(options.tiktok === false
        ? []
        : [new TikTokSource({log: (level, message) => this.#log(level, message), ...options.tiktok})]),
      ...(options.sources ?? []),
    ]
    this.binaries = new BinaryManager(options.dataDir, options.binaries)
    this.archive = new DownloadArchive(path.join(options.dataDir, 'archive.jsonl'))
    this.#queue = new PendingJournal(path.join(options.dataDir, 'pending.jsonl'), () => this.#pendingEntries())
    this.dataDir = options.dataDir
    this.#workRoot = path.join(options.dataDir, 'work')
    this.#cacheDir = path.join(options.dataDir, 'cache')
    this.#trace =
      options.traceLog === false
        ? undefined
        : new TraceLog(path.join(options.dataDir, 'logs'), options.traceRetentionDays ?? 14)
    this.#pool = new TaskPool<JobId>(clampConcurrency(options.concurrency), () => this.emit('idle'))

    const auto = options.jsRuntime === undefined ? defaultJsRuntime() : undefined
    const jsRuntime = options.jsRuntime === false ? undefined : (options.jsRuntime ?? auto?.runtime)
    this.#env = utf8Env(auto?.env)
    this.#commonArgs = [
      ...(jsRuntime ? ['--js-runtimes', `${jsRuntime.name}:${jsRuntime.path}`] : []),
      ...(options.cookiesFromBrowser ? ['--cookies-from-browser', options.cookiesFromBrowser] : []),
      ...(options.cookiesFile ? ['--cookies', options.cookiesFile] : []),
      ...(options.rateLimit ? ['--limit-rate', options.rateLimit] : []),
    ]
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  get concurrency(): number {
    return this.#pool.limit
  }

  /** Change simultaneous jobs at runtime; returns the applied value (clamped to ⌊CPUs/2⌋). */
  setConcurrency(requested: number): number {
    const value = clampConcurrency(requested)
    this.#pool.setLimit(value)
    return value
  }

  get validation(): ValidationLevel {
    return this.#settings.validation
  }

  setValidation(level: ValidationLevel): void {
    this.#settings.validation = level
  }

  /** Applies to files finished from now on. */
  setFileNames(style: FileNameStyle): void {
    this.#settings.fileNames = style
  }

  /** The folder a playlist / profile titled `title` is saved into, under the current naming style. */
  folderFor(outDir: string, title: string): string {
    return path.join(outDir, folderName(title, this.#settings.fileNames))
  }

  // ─── Binaries ─────────────────────────────────────────────────────────────

  resolveBinaries(): Promise<ResolvedBinaries> {
    return this.binaries.resolve()
  }

  /** Install a newer yt-dlp if one exists (checksum-verified). Call on startup. */
  async updateYtDlp(opts: InstallOptions = {}): Promise<UpdateResult> {
    const outcome = await this.binaries.updateYtDlp(opts)
    if (outcome.updated) this.#log('info', `yt-dlp updated to ${outcome.version}.`)
    return outcome
  }

  /** Folder where jobs download and convert before the validated file is moved out. */
  get workDir(): string {
    return this.#workRoot
  }

  /** Threshold (minutes) above which videos are 'long' / 'heavy' jobs. */
  get longVideoMinutes(): number {
    return this.#settings.longVideoMinutes
  }

  /** Whether this media was already downloaded with this profile (and the file is still there). */
  async isArchived(extractor: string, mediaId: string, profile: FormatProfile): Promise<boolean> {
    return (await this.archive.find(archiveKey(extractor, mediaId, profile))) !== undefined
  }

  /** Check tools, codecs, data folder and free space without changing anything. */
  diagnose(): Promise<Diagnosis> {
    return diagnose(this.binaries, this.dataDir)
  }

  /** Install whatever is missing, outdated or incapable (everything with `force`), then re-check. */
  setup(opts: InstallOptions & {readonly force?: boolean | undefined} = {}): Promise<SetupResult> {
    return setup(this.binaries, this.dataDir, opts)
  }

  // ─── Analysis ─────────────────────────────────────────────────────────────

  /** A single video → concrete format choices. A playlist → entries + generic profiles. */
  async analyze(
    url: string,
    opts: {
      signal?: AbortSignal
      maxEntries?: number
      /** Listing progress of long lists read by a native source (TikTok profiles). */
      onProgress?: (progress: ListingProgress) => void
    } = {},
  ): Promise<AnalysisResult> {
    this.#assertOpen()
    // tracked so dispose() can stop it; linked to the caller's signal
    const analysis = new AbortController()
    const forward = () => analysis.abort()
    opts.signal?.addEventListener('abort', forward, {once: true})
    this.#analyses.add(analysis)
    try {
      const source = this.#sourceFor(url)
      if (source) {
        try {
          return await source.analyze(url, {
            signal: analysis.signal,
            ...(opts.maxEntries !== undefined && {maxEntries: opts.maxEntries}),
            ...(opts.onProgress && {onProgress: opts.onProgress}),
          })
        } catch (error) {
          if (!(error instanceof DownloadError) || !needsFallback(error.details)) throw error
          this.#log('warn', `${source.name}: ${error.message} — reading ${url} with yt-dlp instead`)
        }
      }
      const bins = await this.binaries.resolve()
      return await analyze(url, {
        ytDlp: bins.ytDlp.exe,
        env: this.#env,
        cacheDir: this.#cacheDir,
        commonArgs: this.#commonArgs,
        signal: analysis.signal,
        maxEntries: opts.maxEntries,
      })
    } finally {
      this.#analyses.delete(analysis)
      opts.signal?.removeEventListener('abort', forward)
    }
  }

  /**
   * Check many single-video urls at once: chunks of up to 8 urls per yt-dlp
   * process (start-up paid once per chunk), chunks run ⌊CPUs/2⌋ at a time.
   * Results stream through `onResult`; successes carry metadata cached for
   * the download (when `keepMetadata` allows) so it isn't extracted twice.
   */
  async preflight(
    items: ReadonlyArray<{readonly url: string; readonly id?: string | undefined}>,
    opts: {
      readonly signal?: AbortSignal | undefined
      readonly onResult?: ((url: string, result: ExtractResult) => void) | undefined
      readonly keepMetadata?: ((url: string) => boolean) | undefined
    } = {},
  ): Promise<Map<string, ExtractResult>> {
    this.#assertOpen()
    const bins = await this.binaries.resolve()
    const analysis = new AbortController()
    const forward = () => analysis.abort()
    opts.signal?.addEventListener('abort', forward, {once: true})
    this.#analyses.add(analysis)
    const results = new Map<string, ExtractResult>()
    try {
      // natively handled items go to their source (paced by it); the rest to yt-dlp — in parallel
      const bySource = new Map<MediaSource, Array<(typeof items)[number]>>()
      const generic: Array<(typeof items)[number]> = []
      for (const item of items) {
        const source = this.#sourceFor(item.url)
        if (!source) generic.push(item)
        else bySource.set(source, [...(bySource.get(source) ?? []), item])
      }
      // items a native source can't read right now (blocked / changed) are re-checked by yt-dlp
      const handBack: Array<(typeof items)[number]> = []
      const native = Promise.all(
        [...bySource].map(async ([source, own]) => {
          const byUrl = new Map(own.map(item => [item.url, item]))
          await source.preflight(own, {
            signal: analysis.signal,
            onResult: (url, result) => {
              if (!result.ok && needsFallback(result.error.details)) {
                handBack.push(byUrl.get(url)!)
                return
              }
              results.set(url, result)
              opts.onResult?.(url, result)
            },
          })
        }),
      )

      const workers = this.concurrency
      // small batches: one url per process for full parallelism; large ones: ≤ 8 per process
      const size = Math.min(8, Math.max(1, Math.ceil(generic.length / (workers * 2))))
      const pool = new TaskPool<number>(workers)
      for (let start = 0; start < generic.length; start += size) {
        const chunk = generic.slice(start, start + size)
        pool.add(start, async () => {
          if (analysis.signal.aborted) return
          const chunkResults = await extractMany(chunk, {
            ytDlp: bins.ytDlp.exe,
            env: this.#env,
            cacheDir: this.#cacheDir,
            commonArgs: this.#commonArgs,
            signal: analysis.signal,
            onResult: opts.onResult,
            keepMetadata: opts.keepMetadata,
          })
          for (const [url, result] of chunkResults) results.set(url, result)
        })
      }
      await Promise.all([pool.whenIdle(), native])
      if (handBack.length) {
        this.#log(
          'warn',
          `${handBack.length} item(s) handed to yt-dlp: the built-in extractor is blocked or out of date`,
        )
        const step = Math.min(8, Math.max(1, Math.ceil(handBack.length / (workers * 2))))
        for (let start = 0; start < handBack.length; start += step) {
          const chunk = handBack.slice(start, start + step)
          pool.add(-1 - start, async () => {
            if (analysis.signal.aborted) return
            const chunkResults = await extractMany(chunk, {
              ytDlp: bins.ytDlp.exe,
              env: this.#env,
              cacheDir: this.#cacheDir,
              commonArgs: this.#commonArgs,
              signal: analysis.signal,
              onResult: opts.onResult,
              keepMetadata: opts.keepMetadata,
            })
            for (const [url, result] of chunkResults) results.set(url, result)
          })
        }
        await pool.whenIdle()
      }
      return results
    } finally {
      this.#analyses.delete(analysis)
      opts.signal?.removeEventListener('abort', forward)
    }
  }

  /**
   * How many entries a listing at `url` loads by default, when its native
   * source has a default (500 for TikTok profiles and player-page listings).
   */
  defaultListSize(url: string): number | undefined {
    return this.#sources.find(source => source.handles(url))?.defaultListSize?.(url)
  }

  /** The native source for a url, if any. O(sources). */
  #sourceFor(url: string): MediaSource | undefined {
    return this.#sources.find(source => source.available && source.handles(url))
  }

  /** Whether a file has an audio stream. */
  async #hasAudio(bins: ResolvedBinaries, file: string, signal: AbortSignal): Promise<boolean> {
    return summarizeProbe(await ffprobe(bins.ffprobe.exe, file, signal)).audio !== undefined
  }

  // ─── Queue ────────────────────────────────────────────────────────────────

  /**
   * Queue one download. The request is validated here because in an Electron
   * app it usually crosses the IPC boundary from the renderer.
   */
  add(request: JobRequest): JobSnapshot {
    this.#assertOpen()
    const sanitized = this.#sanitize(request)
    const tier = jobTier(sanitized, this.#settings.longVideoMinutes)
    const job = new Job(newId() as JobId, sanitized, this.#settings.maxRetries + 1, tier, TIER_WEIGHT[tier])
    this.#jobs.set(job.id, job)
    this.#log('info', `queued ${job.request.url} as ${profileKey(job.request.profile)}`, job)
    this.#pool.add(job.id, () => this.#run(job), job.weight)
    this.#emit(job, true)
    // the metadata path is session-scoped (cache is wiped on dispose): never persisted
    this.#queue.put(job.id, {...job.request, infoJsonPath: undefined})
    return job.snapshot()
  }

  addVideo(analysis: VideoAnalysis, profile: FormatProfile, outDir: string): JobSnapshot {
    const {media} = analysis
    return this.add({
      url: media.url,
      profile,
      outDir,
      title: media.title,
      mediaId: media.id,
      extractor: media.extractor,
      duration: media.duration,
      infoJsonPath: analysis.infoJsonPath,
    })
  }

  /**
   * Queue a playlist into `outDir/<playlist title>/NNN - <title> [id].ext`.
   * `indexes` (1-based) restricts it to some entries. Live streams are skipped.
   */
  addPlaylist(
    analysis: PlaylistAnalysis,
    profile: FormatProfile,
    outDir: string,
    opts: {indexes?: readonly number[]} = {},
  ): JobSnapshot[] {
    const wanted = opts.indexes ? new Set(opts.indexes) : undefined
    const folder = this.folderFor(outDir, analysis.title)
    const snapshots: JobSnapshot[] = []
    for (const entry of analysis.entries) {
      if (entry.isLive || (wanted && !wanted.has(entry.index))) continue
      snapshots.push(
        this.add({
          url: entry.url,
          profile,
          outDir: folder,
          title: entry.title,
          mediaId: entry.id,
          extractor: entry.extractor,
          duration: entry.duration,
          playlist: {id: analysis.id, title: analysis.title, index: entry.index},
        }),
      )
    }
    return snapshots
  }

  /**
   * Re-queue whatever was pending when the app last closed (or crashed).
   * Partial files resume. `filter` lets a scheduler keep the jobs it restores itself.
   */
  async restoreQueue(filter: (request: JobRequest) => boolean = () => true): Promise<JobSnapshot[]> {
    const restored: JobSnapshot[] = []
    for (const request of await this.#queue.load()) {
      if (!filter(request)) continue
      try {
        restored.push(this.add({...request, infoJsonPath: undefined}))
      } catch (error) {
        this.#log('warn', `Dropped an invalid saved job: ${toJobError(error).message}`)
      }
    }
    // drop the replayed lines: only the re-added jobs (new ids) stay in the journal
    await this.#queue.compact()
    return restored
  }

  jobs(): JobSnapshot[] {
    return Array.from(this.#jobs.values(), job => job.snapshot())
  }

  job(id: JobId): JobSnapshot | undefined {
    return this.#jobs.get(id)?.snapshot()
  }

  get stats(): {readonly running: number; readonly queued: number; readonly total: number} {
    return {running: this.#pool.active, queued: this.#pool.pending, total: this.#jobs.size}
  }

  cancel(id: JobId): void {
    const job = this.#jobs.get(id)
    if (!job || job.terminal) return
    if (this.#pool.remove(id)) this.#finish(job, 'cancelled', {error: cancelledError().toJSON()})
    else job.controller?.abort()
  }

  cancelAll(): void {
    for (const id of this.#jobs.keys()) this.cancel(id)
  }

  /** Re-queue a failed or cancelled job as a new job. */
  retry(id: JobId): JobSnapshot | undefined {
    const job = this.#jobs.get(id)
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return undefined
    this.#forget(id)
    return this.add({...job.request, infoJsonPath: undefined})
  }

  /** Move a queued job to the front of the line. */
  prioritize(id: JobId): boolean {
    return this.#pool.prioritize(id)
  }

  /** Release every finished job (completed / skipped / failed / cancelled). */
  clearFinished(): void {
    for (const id of this.#finished) this.#jobs.delete(id)
    this.#finished.clear()
  }

  /** Stop starting new jobs; running ones continue. */
  pause(): void {
    this.#pool.pause()
  }

  resume(): void {
    this.#pool.resume()
  }

  get paused(): boolean {
    return this.#pool.paused
  }

  whenIdle(): Promise<void> {
    return this.#pool.whenIdle()
  }

  /**
   * Re-hash every archived file and compare with the SHA-256 recorded at
   * download time — finds files deleted, truncated or altered since.
   */
  async verifyArchive(
    onProgress?: ((done: number, total: number) => void) | undefined,
    signal?: AbortSignal | undefined,
    /** Only these records (by key), or only the files of one batch. Default: everything. */
    only?: {readonly keys?: readonly string[] | undefined; readonly batchId?: string | undefined} | undefined,
  ): Promise<ArchiveCheck[]> {
    let entries = await this.archive.entries()
    if (only?.keys) {
      const keys = new Set(only.keys)
      entries = entries.filter(entry => keys.has(entry.key))
    }
    if (only?.batchId !== undefined) entries = entries.filter(entry => entry.batchId === only.batchId)
    const results: ArchiveCheck[] = new Array(entries.length)
    let done = 0
    let next = 0
    // a few files in flight: stats overlap, hashing is bounded by the hash pool's workers
    const worker = async () => {
      for (let i = next++; i < entries.length; i = next++) {
        if (signal?.aborted) throw cancelledError()
        const entry = entries[i]!
        const stat = await fs.stat(entry.filepath).catch(() => undefined)
        if (!stat) results[i] = {entry, ok: false, problem: 'missing'}
        else if (stat.isDirectory())
          results[i] = {entry, ok: true} // a slideshow's folder: its files were checked when made
        else if (stat.size !== entry.sizeBytes) results[i] = {entry, ok: false, problem: 'size-changed'}
        else if (entry.sha256 && (await this.#hashes.sha256(entry.filepath, signal)) !== entry.sha256) {
          results[i] = {entry, ok: false, problem: 'checksum-mismatch'}
        } else results[i] = {entry, ok: true}
        onProgress?.(++done, entries.length)
      }
    }
    await Promise.all(Array.from({length: Math.min(4, entries.length)}, worker))
    return results
  }

  /**
   * Shut down: save the pending queue, stop every process, keep partial
   * downloads for the next launch, release workers, files and listeners.
   * Call from `app.on('before-quit')`, or use `await using`.
   */
  async dispose(): Promise<void> {
    if (this.#disposing) return
    this.#disposing = true
    this.#pool.pause()
    // saved before cancelling, so jobs stopped by the shutdown stay queued for restoreQueue()
    await this.#queue.freeze()
    for (const analysis of this.#analyses) analysis.abort()
    for (const job of this.#jobs.values()) job.controller?.abort()
    await this.#pool.whenIdle()
    this.#log('debug', 'engine disposed')
    // cleanup is best effort: one failing step (e.g. an unreadable folder) must not skip the others
    await Promise.allSettled([
      this.archive.close(),
      this.#hashes.close(),
      this.#trace?.close(),
      fs.rm(this.#cacheDir, {recursive: true, force: true}),
    ])
    for (const job of this.#jobs.values()) job.release()
    this.#jobs.clear()
    this.#finished.clear()
    this.removeAllListeners()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  // ─── Job pipeline ─────────────────────────────────────────────────────────

  async #run(job: Job): Promise<void> {
    job.controller = new AbortController()
    job.startedAt = Date.now()
    const {signal} = job.controller
    const {request} = job
    // deterministic per url + profile: a retry or an app restart resumes the .part files
    const workDir = path.join(this.#workRoot, shortHash(`${request.url}|${profileKey(request.profile)}`))
    let infoJsonPath = await this.#freshMetadata(job)
    let profile = request.profile
    let strategy: AttemptStrategy = 'primary'

    try {
      const bins = await this.binaries.resolve()
      if (await this.#skipIfArchived(job, request.extractor, request.mediaId)) return

      for (;;) {
        const attempt = job.beginAttempt(strategy)
        this.#emit(job, true)
        try {
          await this.#ensureDiskSpace(request)
          await this.#attempt(job, bins, profile, workDir, infoJsonPath, strategy, signal)
          job.endAttempt(undefined)
          if (attempt > 1) this.#log('info', `succeeded on attempt ${attempt}/${job.maxAttempts}`, job)
          this.#finish(job, 'completed', {})
          return
        } catch (error) {
          if (signal.aborted) throw cancelledError()
          const failure =
            error instanceof DownloadError ? error : new DownloadError('unknown', toJobError(error).message)
          const jobError = failure.toJSON()
          job.failCurrentStep(jobError)
          const step = job.currentStep
          // a corrupt partial may cause anything but a network hiccup: start clean
          if (failure.code !== 'network') await fs.rm(workDir, {recursive: true, force: true})
          // next attempt extracts fresh metadata — cached media urls may have expired
          if (infoJsonPath && strategy !== 'extractor-fallback') strategy = 'fresh-extraction'
          infoJsonPath = undefined

          // a native source that can't read the site any more: same request through yt-dlp
          if (needsFallback(failure.details) && strategy !== 'extractor-fallback' && attempt < job.maxAttempts) {
            job.endAttempt(jobError, 0)
            this.#log(
              'warn',
              `attempt ${attempt}/${job.maxAttempts}: built-in extractor failed (${failure.message}) — trying yt-dlp`,
              job,
              {code: failure.code},
            )
            strategy = 'extractor-fallback'
            continue
          }

          // alternative before giving up: the requested resolution doesn't exist → best available
          const relaxed =
            failure.hint === 'format-unavailable' && strategy !== 'format-fallback' ? relaxProfile(profile) : undefined
          if (relaxed && attempt < job.maxAttempts) {
            job.endAttempt(jobError, 0)
            this.#log(
              'warn',
              `attempt ${attempt}/${job.maxAttempts}: format not available — trying ${profileKey(relaxed)} instead`,
              job,
              {code: failure.code},
            )
            profile = relaxed
            strategy = 'format-fallback'
            continue
          }

          if (!isRetryable(failure.code) || attempt >= job.maxAttempts) {
            job.endAttempt(jobError)
            const why = isRetryable(failure.code) ? 'no retries left' : 'not retryable'
            this.#log(
              'error',
              `attempt ${attempt}/${job.maxAttempts} failed at ${step ?? 'start'} [${failure.code}] (${why}): ${failure.message}`,
              job,
              {code: failure.code},
            )
            throw failure
          }
          const wait = retryDelay(attempt, this.#settings.retryDelayMaxMs)
          job.endAttempt(jobError, wait)
          this.#log(
            'warn',
            `attempt ${attempt}/${job.maxAttempts} failed at ${step ?? 'start'} [${failure.code}]: ${failure.message} — retrying in ${(wait / 1000).toFixed(1)}s`,
            job,
            {code: failure.code, retryInMs: wait},
          )
          this.#update(job, {status: 'queued', progress: {}}, true)
          await sleep(wait, undefined, {signal})
        }
      }
    } catch (error) {
      const jobError = toJobError(error)
      if (signal.aborted || jobError.code === 'cancelled') {
        job.failCurrentStep(cancelledError().toJSON())
        this.#finish(job, 'cancelled', {error: cancelledError().toJSON()})
        // a user cancel discards the partial download; a shutdown keeps it to resume later
        if (!this.#disposing) await fs.rm(workDir, {recursive: true, force: true})
      } else {
        this.#finish(job, 'failed', {error: jobError})
      }
    } finally {
      if (request.infoJsonPath) await fs.rm(request.infoJsonPath, {force: true})
    }
  }

  /** One attempt: download → convert → validate → finalize, each tracked as a step. */
  async #attempt(
    job: Job,
    bins: ResolvedBinaries,
    profile: FormatProfile,
    workDir: string,
    infoJsonPath: string | undefined,
    strategy: AttemptStrategy,
    signal: AbortSignal,
  ): Promise<void> {
    const {request} = job
    await fs.mkdir(workDir, {recursive: true})
    // native source unless an earlier attempt already fell back to yt-dlp
    const source = strategy === 'extractor-fallback' ? undefined : this.#sourceFor(request.url)
    let tags: MediaTags | undefined

    // ── download (+ yt-dlp post-processing: merge / extract audio / metadata)
    this.#step(job, 'download')
    this.#update(job, {status: 'downloading', progress: {}}, true)
    let info: DownloadedInfo = {}
    const onInfo = (next: DownloadedInfo) => {
      info = next
      this.#update(job, {title: next.title ?? undefined, mediaId: next.id ?? undefined})
    }
    const downloaded = source
      ? await source.download({
          url: request.url,
          profile,
          workDir,
          signal,
          fresh: strategy === 'fresh-extraction' || job.attempt > 1,
          hasAudio: file => this.#hasAudio(bins, file, signal),
          ffmpeg: bins.ffmpeg.exe,
          threads: this.#cpuShare(job),
          slideshow: request.slideshow ?? DEFAULT_SLIDESHOW,
          onInfo,
          onProgress: progress => this.#update(job, {status: 'downloading', progress}),
        })
      : await runYtDlp({
          ytDlp: bins.ytDlp.exe,
          ffmpeg: bins.ffmpeg.exe,
          env: this.#env,
          url: request.url,
          infoJsonPath,
          profile,
          workDir,
          fragments: this.#settings.fragmentsPerDownload,
          commonArgs: this.#commonArgs,
          embedMetadata: this.#settings.embedMetadata,
          embedThumbnail: this.#settings.embedThumbnail,
          extraArgs: this.#settings.extraYtDlpArgs,
          stallTimeoutMs: this.#settings.stallTimeoutMs,
          signal,
          onInfo,
          onProgress: progress => this.#update(job, {status: 'downloading', progress}),
          onPostprocess: () => this.#update(job, {status: 'processing', progress: {}}, true),
        })
    info = {...info, ...downloaded.info}
    if (source && 'tags' in downloaded && downloaded.tags && this.#settings.embedMetadata) tags = downloaded.tags
    this.#stepDone(job, 'download', 'success')

    // ── convert (video only, and only when the codecs don't already match)
    const expectAudio = profile.kind === 'audio' || (Boolean(info.acodec) && info.acodec !== 'none')
    let file = downloaded.filepath
    const bundle = 'bundle' in downloaded && downloaded.bundle === true
    if (bundle) {
      this.#step(job, 'convert')
      this.#stepDone(job, 'convert', 'skipped') // a folder of images is kept as it is
    } else if (profile.kind === 'video') {
      this.#step(job, 'convert')
      file = await ensureContainer({
        ffmpeg: bins.ffmpeg.exe,
        ffprobe: bins.ffprobe.exe,
        input: file,
        container: profile.container,
        expectAudio,
        threads: this.#cpuShare(job),
        signal,
        onStart: () => this.#update(job, {status: 'converting', progress: {fraction: 0}}, true),
        onProgress: fraction => this.#update(job, {status: 'converting', progress: {fraction}}),
      })
      // native sources hand over the file untagged: tags go in with a stream copy
      if (tags) file = await writeTags({ffmpeg: bins.ffmpeg.exe, input: file, tags, signal})
      this.#stepDone(job, 'convert', file === downloaded.filepath ? 'skipped' : 'success')
    } else if (source) {
      // native sources deliver video: the soundtrack is extracted (and tagged) here
      this.#step(job, 'convert')
      this.#update(job, {status: 'converting', progress: {fraction: 0}}, true)
      file = await extractAudio({
        ffmpeg: bins.ffmpeg.exe,
        ffprobe: bins.ffprobe.exe,
        input: file,
        container: profile.container,
        tags,
        threads: this.#cpuShare(job),
        signal,
        onProgress: fraction => this.#update(job, {status: 'converting', progress: {fraction}}),
      })
      this.#stepDone(job, 'convert', 'success')
    } else {
      this.#stepDone(job, 'convert', 'skipped') // yt-dlp already produced the audio format
    }

    // ── validate
    this.#step(job, 'validate')
    this.#update(job, {status: 'validating', progress: {fraction: 0}}, true)
    let report = bundle
      ? await validateBundle({ffprobe: bins.ffprobe.exe, dir: file, level: this.#settings.validation, signal})
      : await validateFile({
          ffmpeg: bins.ffmpeg.exe,
          ffprobe: bins.ffprobe.exe,
          file,
          rules: rulesFor(profile),
          level: this.#settings.validation,
          expectedDuration: info.duration ?? request.duration,
          expectAudio,
          threads: this.#cpuShare(job),
          signal,
          onProgress: fraction => this.#update(job, {status: 'validating', progress: {fraction}}),
        })
    job.validation = report
    if (!report.ok) {
      throw new DownloadError(
        'validation',
        `The file failed validation: ${report.issues.map(i => i.message).join(' ')}`,
        undefined,
        {issues: report.issues.map(i => i.code).join(',')},
      )
    }
    this.#stepDone(job, 'validate', this.#settings.validation === 'none' ? 'skipped' : 'success')

    // ── finalize: move into place, checksum, archive
    this.#step(job, 'finalize')
    this.#update(job, {status: 'finalizing', progress: {}}, true)
    const mediaTitle = info.title ?? request.title ?? 'media'
    const mediaId = info.id ?? request.mediaId
    const stem = mediaFileStem(this.#settings.fileNames, {
      title: mediaTitle,
      id: mediaId,
      index: request.playlist?.index,
    })
    const finalPath = await moveIntoPlace(file, path.join(request.outDir, `${stem}${path.extname(file)}`))
    await fs.rm(workDir, {recursive: true, force: true})
    const published = publishedSeconds(info)
    if (published !== undefined) {
      // a date the volume won't take (some network shares) is not worth failing the job
      await stampPublished(finalPath, published).catch(error =>
        this.#log('debug', `could not set the publication date on the file: ${String(error)}`, job),
      )
    }

    // a folder has no single checksum: its files were each checked above
    if (this.#settings.checksums && !bundle) report = {...report, sha256: await this.#hashes.sha256(finalPath, signal)}
    job.validation = report
    job.filepath = finalPath

    const extractor = info.extractor ?? request.extractor
    if (extractor && mediaId) {
      await this.archive.add({
        // archived under the requested profile, so re-adding the same request skips it
        key: archiveKey(extractor, mediaId, request.profile),
        extractor,
        mediaId,
        profile: profileKey(request.profile),
        title: mediaTitle,
        url: request.url,
        filepath: finalPath,
        sizeBytes: report.sizeBytes,
        sha256: report.sha256,
        duration: report.duration ?? request.duration,
        validation: this.#settings.validation,
        batchId: request.batchId,
        // a playlist's name; a one-video batch is named after its video
        batchTitle: request.batchId ? (request.playlist?.title ?? mediaTitle) : undefined,
      })
    }
    this.#stepDone(job, 'finalize', 'success')
  }

  #step(job: Job, name: StepName): void {
    job.startStep(name)
    this.#log('debug', `${name} started`, job)
  }

  #stepDone(job: Job, name: StepName, state: 'success' | 'skipped'): void {
    job.endStep(name, state)
    this.#emit(job, true)
  }

  /** Emit a log entry carrying every id of its context, and append it to the trace file. */
  #log(level: LogLevel, message: string, job?: Job, extra: Omit<Partial<LogEntry>, 'sessionId'> = {}): void {
    const base = {level, message, time: Date.now(), sessionId: this.sessionId}
    const entry: LogEntry = job
      ? {
          ...base,
          batchId: job.request.batchId,
          jobId: job.id,
          attemptId: job.attemptId,
          stepId: job.stepId,
          attempt: job.attempt || undefined,
          maxAttempts: job.maxAttempts,
          step: job.currentStep,
          ...extra,
        }
      : {...base, ...extra}
    this.#trace?.write(entry)
    this.emit('log', entry)
  }

  /** Append to this engine's log stream and trace file (used by the scheduler; open to hosts). */
  log(
    level: LogLevel,
    message: string,
    context: Omit<Partial<LogEntry>, 'level' | 'message' | 'time' | 'sessionId'> = {},
  ): void {
    this.#log(level, message, undefined, context)
  }

  /** The cached metadata of a job, unless it's gone or older than metadataMaxAgeMs (its media urls would have expired). */
  async #freshMetadata(job: Job): Promise<string | undefined> {
    const file = job.request.infoJsonPath
    if (!file) return undefined
    const stat = await fs.stat(file).catch(() => undefined)
    if (stat && Date.now() - stat.mtimeMs <= this.#settings.metadataMaxAgeMs) return file
    if (stat) this.#log('debug', 'cached metadata is stale — extracting fresh', job)
    return undefined
  }

  async #skipIfArchived(job: Job, extractor: string | undefined, mediaId: string | undefined): Promise<boolean> {
    if (!this.#settings.useArchive || !extractor || !mediaId) return false
    const entry = await this.archive.find(archiveKey(extractor, mediaId, job.request.profile))
    if (!entry) return false
    this.#finish(job, 'skipped', {filepath: entry.filepath})
    return true
  }

  /**
   * Room for this job before it starts: its peak on the work volume (parts +
   * merged file, + a copy when converting) and its final size at the
   * destination — never less than minFreeSpaceBytes.
   */
  async #ensureDiskSpace(request: JobRequest): Promise<void> {
    const min = this.#settings.minFreeSpaceBytes
    const estimate = request.estimatedBytes ?? 0
    const needs: ReadonlyArray<readonly [string, number]> = [
      [this.#workRoot, min + peakBytes(estimate, request.requiresConversion ?? false)],
      [request.outDir, min + estimate],
    ]
    for (const [dir, required] of needs) {
      if (required === 0) continue
      const free = await freeSpace(dir)
      if (free !== undefined && free < required) {
        throw new DownloadError('disk-full', `Not enough free space in ${dir}.`, undefined, {
          dir,
          freeBytes: free,
          requiredBytes: required,
        })
      }
    }
  }

  /**
   * Threads for one ffmpeg decode/encode. The CPU budget is the pool limit
   * (⌊CPUs/2⌋), split among the jobs running right now: a lone job validates
   * fast, a full pool never oversubscribes.
   */
  #cpuShare(job: Job): number {
    // a job's share of the ⌊CPUs/2⌋ budget is proportional to its weight
    const used = Math.max(this.#pool.used, job.weight)
    return Math.max(1, Math.floor((this.#pool.limit * job.weight) / used))
  }

  #sanitize(request: JobRequest): JobRequest {
    const url = assertHttpUrl(request.url)
    const problem = profileProblem(request.profile)
    if (problem) throw new DownloadError('invalid-request', problem)
    if (typeof request.outDir !== 'string' || !path.isAbsolute(request.outDir)) {
      throw new DownloadError('invalid-request', 'outDir must be an absolute path.')
    }
    // only metadata this engine wrote may be loaded back into yt-dlp
    const infoJsonPath =
      request.infoJsonPath && isInside(this.#cacheDir, request.infoJsonPath) ? request.infoJsonPath : undefined
    return {
      ...request,
      url,
      outDir: path.resolve(request.outDir),
      infoJsonPath,
      ...(request.slideshow !== undefined && {slideshow: slideshowOptions(request.slideshow)}),
    }
  }

  #assertOpen(): void {
    if (this.#disposing) throw new Error('MediaDownloader has been disposed.')
  }

  // ─── State & events ───────────────────────────────────────────────────────

  #update(job: Job, patch: JobPatch, force = false): void {
    if (job.terminal) return
    const before = job.status
    const statusChanged = job.patch(patch)
    if (statusChanged) this.#log('debug', `status ${before} → ${job.status}`, job)
    this.#emit(job, force || statusChanged)
  }

  #finish(job: Job, status: TerminalStatus, result: Parameters<Job['finish']>[1]): void {
    job.finish(status, result)
    const detail = job.error ? ` [${job.error.code}] ${job.error.message}` : job.filepath ? ` → ${job.filepath}` : ''
    this.#log(status === 'failed' ? 'error' : 'info', `finished: ${status}${detail}`, job)
    const snapshot = job.snapshot()
    this.emit('job', snapshot)
    if (status === 'completed' || status === 'skipped') this.emit('completed', snapshot)
    else if (status === 'failed') this.emit('failed', snapshot)
    this.#finished.add(job.id)
    this.#releaseOldFinished()
    this.#queue.delete(job.id)
  }

  /**
   * Keep memory flat over long sessions: forget the oldest finished jobs
   * beyond the limit. The Set is insertion-ordered, so the oldest is its
   * first value: O(1) per finished job.
   */
  #releaseOldFinished(): void {
    while (this.#finished.size > this.#settings.retainFinishedJobs) {
      const oldest = this.#finished.values().next().value as JobId
      this.#finished.delete(oldest)
      this.#jobs.delete(oldest)
    }
  }

  #forget(id: JobId): void {
    this.#jobs.delete(id)
    this.#finished.delete(id)
  }

  /** Status changes go out at once; progress at most every `progressIntervalMs` per job. */
  #emit(job: Job, force: boolean): void {
    const wait = this.#settings.progressIntervalMs - (Date.now() - job.lastEmit)
    if (force || wait <= 0) {
      if (job.emitTimer) clearTimeout(job.emitTimer)
      job.emitTimer = undefined
      job.lastEmit = Date.now()
      this.emit('job', job.snapshot())
    } else if (!job.emitTimer) {
      job.emitTimer = setTimeout(() => {
        job.emitTimer = undefined
        if (!job.terminal) this.#emit(job, true)
      }, wait)
    }
  }

  #pendingEntries(): Array<readonly [string, JobRequest]> {
    const pending: Array<readonly [string, JobRequest]> = []
    for (const job of this.#jobs.values()) {
      if (!job.terminal) pending.push([job.id, {...job.request, infoJsonPath: undefined}])
    }
    return pending
  }
}

/** A looser profile to try when the requested one has no matching format: drop the resolution cap. */
export function relaxProfile(profile: FormatProfile): FormatProfile | undefined {
  if (profile.kind === 'video' && profile.maxHeight !== undefined) return {kind: 'video', container: profile.container}
  return undefined
}

/**
 * Wait before retry n: 2 s, 4 s, 8 s… capped at `max` (15 s by default), with
 * up to 20% jitter downwards so jobs failing together (e.g. a 429) don't
 * retry in lockstep — the cap is never exceeded.
 */
export function retryDelay(attempt: number, max: number): number {
  const base = Math.min(max, 2000 * 2 ** (attempt - 1))
  return Math.round(base * (0.8 + Math.random() * 0.2))
}
