import {randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {analyze, assertHttpUrl} from './core/analyze.js'
import {type ArchiveEntry, archiveKey, DownloadArchive} from './core/archive.js'
import {BinaryManager, defaultJsRuntime, type ResolvedBinaries, type UpdateResult} from './core/binaries.js'
import {ensureContainer} from './core/convert.js'
import {type DownloadedInfo, runYtDlp} from './core/download.js'
import {cancelledError, DownloadError, isRetryable, toJobError} from './core/errors.js'
import {freeSpace, isInside, moveIntoPlace, sanitizeFilename, shortHash} from './core/files.js'
import {profileKey, profileProblem, rulesFor} from './core/formats.js'
import {HashPool} from './core/hash-pool.js'
import {Job, type JobPatch} from './core/job.js'
import {clampConcurrency, cpuCount, maxConcurrency, TaskPool} from './core/pool.js'
import {utf8Env} from './core/process.js'
import {QueueStore} from './core/queue-store.js'
import {validateFile} from './core/validate.js'
import type {
  AnalysisResult,
  DownloaderEvents,
  DownloaderOptions,
  FormatProfile,
  JobId,
  JobRequest,
  JobSnapshot,
  PlaylistAnalysis,
  TerminalStatus,
  ValidationLevel,
  VideoAnalysis,
} from './types.js'

type Settings = {
  validation: ValidationLevel
  readonly fragmentsPerDownload: number
  readonly checksums: boolean
  readonly useArchive: boolean
  readonly maxRetries: number
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

const MAX_BACKOFF_MS = 30_000

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
  readonly #queue: QueueStore
  readonly #jobs = new Map<JobId, Job>()
  /** Terminal jobs in finishing order, for releasing the oldest ones. */
  readonly #finished: JobId[] = []
  readonly #analyses = new Set<AbortController>()
  readonly #workRoot: string
  readonly #cacheDir: string
  readonly #env: NodeJS.ProcessEnv
  readonly #commonArgs: readonly string[]
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
    this.#workRoot = path.join(options.dataDir, 'work')
    this.#cacheDir = path.join(options.dataDir, 'cache')
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
  async updateYtDlp(signal?: AbortSignal): Promise<UpdateResult> {
    const outcome = await this.binaries.updateYtDlp(signal)
    if (outcome.updated) this.emit('log', 'info', `yt-dlp updated to ${outcome.version}.`)
    return outcome
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
        ytDlp: bins.ytDlp,
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
    const job = new Job(randomUUID() as JobId, this.#sanitize(request))
    this.#jobs.set(job.id, job)
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

  /** Re-queue whatever was pending when the app last closed (or crashed). Partial files resume. */
  async restoreQueue(): Promise<JobSnapshot[]> {
    const restored: JobSnapshot[] = []
    for (const request of await this.#queue.load()) {
      try {
        restored.push(this.add({...request, infoJsonPath: undefined}))
      } catch (error) {
        this.emit('log', 'warn', `Dropped an invalid saved job: ${toJobError(error).message}`)
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
    await Promise.all([
      this.archive.close(),
      this.#hashes.close(),
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

    try {
      const bins = await this.binaries.resolve()
      if (await this.#skipIfArchived(job, request.extractor, request.mediaId)) return

      for (let attempt = 1; ; attempt++) {
        job.attempt = attempt
        try {
          await this.#ensureDiskSpace(request.outDir)
          await this.#attempt(job, bins, workDir, infoJsonPath, signal)
          return
        } catch (error) {
          if (signal.aborted) throw cancelledError()
          const failure =
            error instanceof DownloadError ? error : new DownloadError('unknown', toJobError(error).message)
          // a corrupt partial may cause anything but a network hiccup: start clean
          if (failure.code !== 'network') await fs.rm(workDir, {recursive: true, force: true})
          infoJsonPath = undefined // cached media urls may have expired: extract fresh
          if (!isRetryable(failure.code) || attempt > this.#settings.maxRetries) throw failure
          this.emit(
            'log',
            'warn',
            `Retrying "${job.title ?? request.url}" (attempt ${attempt + 1}): ${failure.message}`,
          )
          this.#update(job, {status: 'queued', progress: {}}, true)
          await sleep(backoff(attempt), undefined, {signal})
        }
      }
    } catch (error) {
      const jobError = toJobError(error)
      if (signal.aborted || jobError.code === 'cancelled') {
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

  async #attempt(
    job: Job,
    bins: ResolvedBinaries,
    workDir: string,
    infoJsonPath: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const {request} = job
    const {profile} = request
    await fs.mkdir(workDir, {recursive: true})
    this.#update(job, {status: 'downloading', progress: {}}, true)

    let info: DownloadedInfo = {}
    const downloaded = await runYtDlp({
      ytDlp: bins.ytDlp,
      ffmpeg: bins.ffmpeg,
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
      signal,
      onInfo: next => {
        info = next
        this.#update(job, {title: next.title ?? undefined, mediaId: next.id ?? undefined})
      },
      onProgress: progress => this.#update(job, {status: 'downloading', progress}),
      onPostprocess: () => this.#update(job, {status: 'processing', progress: {}}, true),
    })
    info = {...info, ...downloaded.info}

    const expectAudio = profile.kind === 'audio' || (Boolean(info.acodec) && info.acodec !== 'none')
    let file = downloaded.filepath
    if (profile.kind === 'video') {
      file = await ensureContainer({
        ffmpeg: bins.ffmpeg,
        ffprobe: bins.ffprobe,
        input: file,
        container: profile.container,
        expectAudio,
        threads: this.#cpuShare(),
        signal,
        onStart: () => this.#update(job, {status: 'converting', progress: {fraction: 0}}, true),
        onProgress: fraction => this.#update(job, {status: 'converting', progress: {fraction}}),
      })
    }

    this.#update(job, {status: 'validating', progress: {fraction: 0}}, true)
    let report = await validateFile({
      ffmpeg: bins.ffmpeg,
      ffprobe: bins.ffprobe,
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

    this.#update(job, {status: 'finalizing', progress: {}}, true)
    const mediaTitle = info.title ?? request.title ?? 'media'
    const mediaId = info.id ?? request.mediaId
    const stem = `${sanitizeFilename(mediaTitle, 150)}${mediaId ? ` [${sanitizeFilename(mediaId, 40)}]` : ''}`
    const prefix = request.playlist ? `${String(request.playlist.index).padStart(3, '0')} - ` : ''
    const finalPath = await moveIntoPlace(file, path.join(request.outDir, `${prefix}${stem}${path.extname(file)}`))
    await fs.rm(workDir, {recursive: true, force: true})

    if (this.#settings.checksums) report = {...report, sha256: await this.#hashes.sha256(finalPath, signal)}

    const extractor = info.extractor ?? request.extractor
    if (extractor && mediaId) {
      await this.archive.add({
        key: archiveKey(extractor, mediaId, profile),
        extractor,
        mediaId,
        profile: profileKey(profile),
        title: mediaTitle,
        url: request.url,
        filepath: finalPath,
        sizeBytes: report.sizeBytes,
        sha256: report.sha256,
        duration: report.duration ?? request.duration,
      })
    }
    this.#finish(job, 'completed', {filepath: finalPath, validation: report})
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
    const statusChanged = job.patch(patch)
    this.#emit(job, force || statusChanged)
  }

  #finish(job: Job, status: TerminalStatus, result: Parameters<Job['finish']>[1]): void {
    job.finish(status, result)
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

/** Exponential backoff with ±25% jitter, so jobs hitting a 429 together don't retry in lockstep. */
function backoff(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt)
  return Math.round(base * (0.75 + Math.random() * 0.5))
}
