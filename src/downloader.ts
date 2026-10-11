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
import {analyze, assertHttpUrl} from './core/analyze.js'
import {type ArchiveEntry, archiveKey, DownloadArchive} from './core/archive.js'
import {ensureContainer} from './core/convert.js'
import {type DownloadedInfo, runYtDlp} from './core/download.js'
import {cancelledError, DownloadError, isRetryable, toJobError} from './core/errors.js'
import {freeSpace, isInside, moveIntoPlace, sanitizeFilename, shortHash} from './core/files.js'
import {profileKey, profileProblem, rulesFor} from './core/formats.js'
import {HashPool} from './core/hash-pool.js'
import {newId} from './core/ids.js'
import {Job, type JobPatch} from './core/job.js'
import {clampConcurrency, cpuCount, maxConcurrency, TaskPool} from './core/pool.js'
import {utf8Env} from './core/process.js'
import {QueueStore} from './core/queue-store.js'
import {TraceLog} from './core/trace-log.js'
import {validateFile} from './core/validate.js'
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
  readonly #queue: QueueStore<JobRequest>
  readonly #jobs = new Map<JobId, Job>()
  /** Terminal jobs in finishing order, for releasing the oldest ones. */
  readonly #finished: JobId[] = []
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
      extraYtDlpArgs: options.extraYtDlpArgs ?? [],
    }
    this.binaries = new BinaryManager(options.dataDir, options.binaries)
    this.archive = new DownloadArchive(path.join(options.dataDir, 'archive.jsonl'))
    this.#queue = new QueueStore(path.join(options.dataDir, 'queue.json'), () => this.#pendingRequests())
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
  async analyze(url: string, opts: {signal?: AbortSignal; maxEntries?: number} = {}): Promise<AnalysisResult> {
    this.#assertOpen()
    const bins = await this.binaries.resolve()
    // tracked so dispose() can stop it; linked to the caller's signal
    const analysis = new AbortController()
    const forward = () => analysis.abort()
    opts.signal?.addEventListener('abort', forward, {once: true})
    this.#analyses.add(analysis)
    try {
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

  // ─── Queue ────────────────────────────────────────────────────────────────

  /**
   * Queue one download. The request is validated here because in an Electron
   * app it usually crosses the IPC boundary from the renderer.
   */
  add(request: JobRequest): JobSnapshot {
    this.#assertOpen()
    const job = new Job(newId() as JobId, this.#sanitize(request), this.#settings.maxRetries + 1)
    this.#jobs.set(job.id, job)
    this.#log('info', `queued ${job.request.url} as ${profileKey(job.request.profile)}`, job)
    this.#pool.add(job.id, () => this.#run(job))
    this.#emit(job, true)
    this.#queue.touch()
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
    const folder = path.join(outDir, sanitizeFilename(analysis.title, 100))
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
    this.#finished.length = 0
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
  ): Promise<ArchiveCheck[]> {
    const entries = await this.archive.entries()
    const results: ArchiveCheck[] = []
    for (const entry of entries) {
      if (signal?.aborted) throw cancelledError()
      const stat = await fs.stat(entry.filepath).catch(() => undefined)
      if (!stat) results.push({entry, ok: false, problem: 'missing'})
      else if (stat.size !== entry.sizeBytes) results.push({entry, ok: false, problem: 'size-changed'})
      else if (entry.sha256 && (await this.#hashes.sha256(entry.filepath, signal)) !== entry.sha256) {
        results.push({entry, ok: false, problem: 'checksum-mismatch'})
      } else results.push({entry, ok: true})
      onProgress?.(results.length, entries.length)
    }
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
    this.#finished.length = 0
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
    let infoJsonPath = request.infoJsonPath
    let profile = request.profile
    let strategy: AttemptStrategy = 'primary'

    try {
      const bins = await this.binaries.resolve()
      if (await this.#skipIfArchived(job, request.extractor, request.mediaId)) return

      for (;;) {
        const attempt = job.beginAttempt(strategy)
        this.#emit(job, true)
        try {
          await this.#ensureDiskSpace(request.outDir)
          await this.#attempt(job, bins, profile, workDir, infoJsonPath, signal)
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
          if (infoJsonPath) strategy = 'fresh-extraction'
          infoJsonPath = undefined

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
    signal: AbortSignal,
  ): Promise<void> {
    const {request} = job
    await fs.mkdir(workDir, {recursive: true})

    // ── download (+ yt-dlp post-processing: merge / extract audio / metadata)
    this.#step(job, 'download')
    this.#update(job, {status: 'downloading', progress: {}}, true)
    let info: DownloadedInfo = {}
    const downloaded = await runYtDlp({
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
      onInfo: next => {
        info = next
        this.#update(job, {title: next.title ?? undefined, mediaId: next.id ?? undefined})
      },
      onProgress: progress => this.#update(job, {status: 'downloading', progress}),
      onPostprocess: () => this.#update(job, {status: 'processing', progress: {}}, true),
    })
    info = {...info, ...downloaded.info}
    this.#stepDone(job, 'download', 'success')

    // ── convert (video only, and only when the codecs don't already match)
    const expectAudio = profile.kind === 'audio' || (Boolean(info.acodec) && info.acodec !== 'none')
    let file = downloaded.filepath
    if (profile.kind === 'video') {
      this.#step(job, 'convert')
      file = await ensureContainer({
        ffmpeg: bins.ffmpeg.exe,
        ffprobe: bins.ffprobe.exe,
        input: file,
        container: profile.container,
        expectAudio,
        threads: this.#cpuShare(),
        signal,
        onStart: () => this.#update(job, {status: 'converting', progress: {fraction: 0}}, true),
        onProgress: fraction => this.#update(job, {status: 'converting', progress: {fraction}}),
      })
      this.#stepDone(job, 'convert', file === downloaded.filepath ? 'skipped' : 'success')
    } else {
      this.#stepDone(job, 'convert', 'skipped') // yt-dlp already produced the audio format
    }

    // ── validate
    this.#step(job, 'validate')
    this.#update(job, {status: 'validating', progress: {fraction: 0}}, true)
    let report = await validateFile({
      ffmpeg: bins.ffmpeg.exe,
      ffprobe: bins.ffprobe.exe,
      file,
      rules: rulesFor(profile),
      level: this.#settings.validation,
      expectedDuration: info.duration ?? request.duration,
      expectAudio,
      threads: this.#cpuShare(),
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
    const stem = `${sanitizeFilename(mediaTitle, 150)}${mediaId ? ` [${sanitizeFilename(mediaId, 40)}]` : ''}`
    const prefix = request.playlist ? `${String(request.playlist.index).padStart(3, '0')} - ` : ''
    const finalPath = await moveIntoPlace(file, path.join(request.outDir, `${prefix}${stem}${path.extname(file)}`))
    await fs.rm(workDir, {recursive: true, force: true})

    if (this.#settings.checksums) report = {...report, sha256: await this.#hashes.sha256(finalPath, signal)}
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

  async #skipIfArchived(job: Job, extractor: string | undefined, mediaId: string | undefined): Promise<boolean> {
    if (!this.#settings.useArchive || !extractor || !mediaId) return false
    const entry = await this.archive.find(archiveKey(extractor, mediaId, job.request.profile))
    if (!entry) return false
    this.#finish(job, 'skipped', {filepath: entry.filepath})
    return true
  }

  async #ensureDiskSpace(outDir: string): Promise<void> {
    const min = this.#settings.minFreeSpaceBytes
    if (min === 0) return
    for (const dir of [this.#workRoot, outDir]) {
      const free = await freeSpace(dir)
      if (free !== undefined && free < min) {
        throw new DownloadError('disk-full', `Not enough free space in ${dir}.`, undefined, {
          dir,
          freeBytes: free,
          requiredBytes: min,
        })
      }
    }
  }

  /**
   * Threads for one ffmpeg decode/encode. The CPU budget is the pool limit
   * (⌊CPUs/2⌋), split among the jobs running right now: a lone job validates
   * fast, a full pool never oversubscribes.
   */
  #cpuShare(): number {
    return Math.max(1, Math.floor(this.#pool.limit / Math.max(1, this.#pool.active)))
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
    return {...request, url, outDir: path.resolve(request.outDir), infoJsonPath}
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
    this.#finished.push(job.id)
    this.#releaseOldFinished()
    this.#queue.touch()
  }

  /** Keep memory flat over long sessions: forget the oldest finished jobs beyond the limit. */
  #releaseOldFinished(): void {
    const excess = this.#finished.length - this.#settings.retainFinishedJobs
    if (excess <= 0) return
    for (const id of this.#finished.splice(0, excess)) this.#jobs.delete(id)
  }

  #forget(id: JobId): void {
    this.#jobs.delete(id)
    const index = this.#finished.indexOf(id)
    if (index !== -1) this.#finished.splice(index, 1)
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

  #pendingRequests(): JobRequest[] {
    const pending: JobRequest[] = []
    for (const job of this.#jobs.values()) {
      if (!job.terminal) pending.push({...job.request, infoJsonPath: undefined})
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
