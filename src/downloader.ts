import {EventEmitter} from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {type Diagnosis, diagnose, type SetupResult, setup} from './binaries/doctor.js'
import {
  type AvailableBinaries,
  BinaryManager,
  defaultJsRuntime,
  type InstallOptions,
  type ResolvedBinaries,
  type UpdateResult,
} from './binaries/manager.js'
import {analyze, assertHttpUrl, type ExtractResult, extractMany, isYouTubeUrl} from './core/analyze.js'
import {type ArchiveEntry, archiveKey, DownloadArchive} from './core/archive.js'
import {ensureContainer, extractAudio, type MediaTags, writeTags} from './core/convert.js'
import {BrowserCookies, type CookieRecord, exportBrowserCookies, jarCopy, parseNetscape} from './core/cookies.js'
import {jobTier, peakBytes, TIER_WEIGHT} from './core/cost.js'
import {type DamagedEntry, type DamagedLookup, DamagedRegistry, isSourceDamage} from './core/damaged.js'
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
import {clampConcurrency, cpuCount, cpuShare, maxConcurrency, TaskPool} from './core/pool.js'
import {utf8Env} from './core/process.js'
import {PendingJournal} from './core/queue-store.js'
import {TraceLog} from './core/trace-log.js'
import {ffprobe, ProbeError, summarizeProbe, validateBundle, validateFile} from './core/validate.js'
import {FacebookSource} from './sources/facebook/source.js'
import {InstagramSource} from './sources/instagram/source.js'
import {type ListingProgress, type MediaSource, needsFallback} from './sources/source.js'
import {DEFAULT_SLIDESHOW, slideshowOptions} from './sources/tiktok/slideshow.js'
import {TikTokSource} from './sources/tiktok/source.js'
import type {
  AnalysisResult,
  AttemptStrategy,
  DownloaderEvents,
  DownloaderOptions,
  FormatProfile,
  JobError,
  JobId,
  JobRequest,
  JobSnapshot,
  LogEntry,
  LogLevel,
  PlaylistAnalysis,
  StepName,
  TerminalStatus,
  TraceId,
  ValidationIssueCode,
  ValidationLevel,
  ValidationReport,
  ValidationTiming,
  VideoAnalysis,
} from './types.js'
import {type AttestationStatus, PoTokenService} from './youtube/attestation.js'
import {PoTokenBroker} from './youtube/broker.js'
import {type Refusal, type YouTubeAccess, YouTubeGate} from './youtube/gate.js'
import {installPlugin} from './youtube/plugin.js'

/** yt-dlp's own polite pace for YouTube checks (its "sleep" preset): a pause between requests. */
const YOUTUBE_POLITE_ARGS = ['--sleep-requests', '0.75'] as const

/** YouTube requests wait (a bot-check pause, or a hold for the user): what a check says instead of asking now. */
const youtubeWaiting = (): DownloadError =>
  new DownloadError(
    'blocked',
    'YouTube asks to confirm this is not a bot: YouTube requests are waiting, try again later.',
    undefined,
    undefined,
    'bot-check',
  )

type Settings = {
  validation: ValidationLevel
  validationTiming: ValidationTiming
  /** Share of the logical processors the pool may use (0.5–0.6). */
  cpuShare: number
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

/** What the check put off until after a batch found (see `checkLater`). */
export type LaterCheck = {
  readonly checked: number
  readonly ok: number
  /** Broken at the source: kept, marked, never downloaded again. */
  readonly damaged: number
  /** Failed for another reason (codecs, container): removed, to be downloaded again. */
  readonly failed: number
}

/** The error of a media known to be damaged at the source. */
function damagedError(entry: Pick<DamagedEntry, 'reason'>): DownloadError {
  return new DownloadError(
    'unavailable',
    `Damaged at the source — not downloaded again: ${entry.reason}`,
    undefined,
    undefined,
    'damaged-source',
  )
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
  /** Media found damaged at the source: never downloaded again (until removed from it). */
  readonly damaged: DamagedRegistry
  readonly #settings: Settings
  readonly #pool: TaskPool<JobId>
  readonly #hashes = new HashPool()
  /** Sites handled natively instead of by yt-dlp. */
  readonly #sources: readonly MediaSource[]
  /** Makes a source for the host of a url yt-dlp doesn't support (options.unsupportedUrlSource). */
  readonly #unsupportedUrlSource: ((url: URL) => MediaSource | undefined) | undefined
  /** Sources made that way which read something: by host (no `www.`), asked after #sources. */
  readonly #learned = new Map<string, MediaSource>()
  /** `ytDlp: 'optional'` and none found (known once the tools are resolved): nothing to fall back to. */
  #ytDlpMissing = false
  readonly #queue: PendingJournal<JobRequest>
  readonly #jobs = new Map<JobId, Job>()
  /** Terminal jobs in finishing order, for releasing the oldest ones. */
  readonly #finished = new Set<JobId>()
  /**
   * Finished jobs released from #jobs while their check after the batch is
   * still to come: kept here until it runs, so a batch longer than
   * retainFinishedJobs still has every file checked.
   */
  readonly #awaitingCheck = new Map<JobId, Job>()
  readonly #analyses = new Set<AbortController>()
  /** Folder holding tools, archive, queue state and logs. */
  readonly dataDir: string
  readonly #workRoot: string
  readonly #cacheDir: string
  readonly #env: NodeJS.ProcessEnv
  /** Arguments every yt-dlp run gets (JS runtime, rate limit); cookies and YouTube's own are added per run. */
  readonly #baseArgs: readonly string[]
  /** A cookies.txt the host passed: every site. */
  readonly #cookiesFile: string | undefined
  /** A browser's cookies, read once into a jar — not by every run (one Keychain prompt, not one per process). */
  readonly #browserCookies: BrowserCookies
  /** The signed-in YouTube session the user agreed to: YouTube runs only. */
  #accountJar: string | undefined
  /** PO tokens, when the host supplied attestation strategies, and the broker the yt-dlp plugin asks. */
  readonly #attestation: PoTokenService | undefined
  #broker: PoTokenBroker | undefined
  #plugins: Promise<string> | undefined
  /**
   * YouTube's gate: attempts start a second apart, and a bot check ("Sign in
   * to confirm you're not a bot" — YouTube blocked this connection for a
   * while) climbs one ladder for every YouTube request at once — PO tokens
   * (when the host can mint them), a hold for the user (sign in or wait),
   * growing pauses — instead of each job hammering it on its own.
   */
  readonly #youtube: YouTubeGate
  readonly #trace: TraceLog | undefined
  /** Identifies this engine instance (one app launch / CLI run) in every log entry. */
  readonly sessionId: TraceId = newId()
  #disposing = false

  /** Upper bound of `concurrency` on this machine: ⌊logical CPUs / 2⌋, or ⌊CPUs × share⌋ (share 0.5–0.6). */
  static maxConcurrency(share?: number): number {
    return maxConcurrency(cpuCount(), share)
  }

  static cpuCount(): number {
    return cpuCount()
  }

  constructor(options: DownloaderOptions) {
    super()
    if (!path.isAbsolute(options.dataDir)) throw new TypeError('dataDir must be an absolute path.')
    this.#settings = {
      validation: options.validation ?? 'full',
      validationTiming: options.validationTiming === 'after-batch' ? 'after-batch' : 'during',
      cpuShare: cpuShare(options.maxCpuShare),
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
    const log = (level: 'info' | 'warn', message: string) => this.#log(level, message)
    this.#sources = [
      ...(options.tiktok === false ? [] : [new TikTokSource({log, ...options.tiktok})]),
      // Instagram and Facebook take the user's signed-in session from the browser cookies the engine
      // reads for yt-dlp (one read for everything), unless the host hands them its own
      ...(options.instagram === false
        ? []
        : [
            new InstagramSource({
              log,
              cookies: () => this.#siteCookies(['instagram.com']),
              ...options.instagram,
            }),
          ]),
      ...(options.facebook === false
        ? []
        : [new FacebookSource({log, cookies: () => this.#siteCookies(['facebook.com']), ...options.facebook})]),
      ...(options.sources ?? []),
    ]
    this.#unsupportedUrlSource = options.unsupportedUrlSource
    this.binaries = new BinaryManager(options.dataDir, options.binaries, undefined, {ytDlp: options.ytDlp})
    this.archive = new DownloadArchive(path.join(options.dataDir, 'archive.jsonl'))
    this.damaged = new DamagedRegistry(path.join(options.dataDir, 'damaged.json'))
    this.#queue = new PendingJournal(path.join(options.dataDir, 'pending.jsonl'), () => this.#pendingEntries())
    this.dataDir = options.dataDir
    this.#workRoot = path.join(options.dataDir, 'work')
    this.#cacheDir = path.join(options.dataDir, 'cache')
    this.#trace =
      options.traceLog === false
        ? undefined
        : new TraceLog(path.join(options.dataDir, 'logs'), options.traceRetentionDays ?? 14)
    this.#pool = new TaskPool<JobId>(clampConcurrency(options.concurrency, cpuCount(), this.#settings.cpuShare), () =>
      this.emit('idle'),
    )

    const auto = options.jsRuntime === undefined ? defaultJsRuntime() : undefined
    const jsRuntime = options.jsRuntime === false ? undefined : (options.jsRuntime ?? auto?.runtime)
    this.#env = utf8Env(auto?.env)
    this.#baseArgs = [
      // only this runtime: yt-dlp prefers deno when it finds one installed, whatever --js-runtimes adds
      ...(jsRuntime ? ['--no-js-runtimes', '--js-runtimes', `${jsRuntime.name}:${jsRuntime.path}`] : []),
      ...(options.rateLimit ? ['--limit-rate', options.rateLimit] : []),
    ]
    this.#cookiesFile = options.cookiesFile
    this.#browserCookies = new BrowserCookies(path.join(options.dataDir, 'cookies', 'browser.txt'))
    this.#browserCookies.browser = options.cookiesFromBrowser || undefined
    const strategies = options.youtube?.attestation ?? []
    this.#attestation = strategies.length
      ? new PoTokenService(strategies, options.youtube?.attestationOptions)
      : undefined
    this.#youtube = new YouTubeGate({
      pacing: options.youtube?.pacing,
      attestation: this.#attestation !== undefined,
      canHold: options.youtube?.askUser === true,
      startAttested: options.youtube?.tokens === 'always',
      attestedDelaysMs: options.youtube?.attestedDelaysMs,
      onChange: access => this.#youtubeChanged(access),
    })
  }

  /**
   * Read cookies from this browser from now on ('chrome', 'safari',
   * 'firefox'…: its signed-in session), or from none. They are read once (one
   * Keychain prompt on macOS), not by every yt-dlp run. YouTube requests
   * paused by a bot check resume at once — a signed-in session is what gets past it.
   */
  setCookiesFromBrowser(browser: string | undefined): void {
    const next = browser?.trim() || undefined
    if (next !== undefined && !/^[\w.+:-]+$/.test(next)) throw new TypeError(`Not a browser name: ${browser}`)
    this.#browserCookies.browser = next
    if (next) {
      this.#youtube.resume()
      this.#log('info', `cookies from ${next} from now on; YouTube requests resume`)
    }
  }

  /** How YouTube is reached now: the ladder's rung, its pause, whether tokens are on. */
  get youtube(): YouTubeAccess {
    return this.#youtube.access
  }

  /** When YouTube requests may start again after a bot check (ms since epoch), or undefined when they aren't paused. */
  get youtubePausedUntil(): number | undefined {
    return this.#youtube.access.pausedUntil
  }

  /**
   * The user agreed to sign in: YouTube runs use this signed-in session (a
   * Netscape cookies.txt, YouTube only) and held requests go on. Tokens, when
   * on, are minted afresh for it (a guest's tokens on an account look odd).
   */
  setYouTubeAccount(cookiesFile: string): void {
    if (!path.isAbsolute(cookiesFile)) throw new TypeError('cookiesFile must be an absolute path.')
    this.#accountJar = cookiesFile
    this.#attestation?.reset()
    this.#youtube.enterAccount()
    this.#log('info', 'YouTube: signed-in session from now on; YouTube requests resume')
  }

  /** Back to the guest session (the user signed out). */
  clearYouTubeAccount(): void {
    if (this.#accountJar === undefined) return
    this.#accountJar = undefined
    this.#attestation?.reset()
    this.#youtube.leaveAccount()
    this.#log('info', 'YouTube: signed out; guest session from now on')
  }

  /** The user chose not to sign in: YouTube requests held for them try again after a long pause. */
  waitOutYouTube(): void {
    this.#youtube.waitItOut()
  }

  /** PO token health, for a report: which way of attestation works, what failed. */
  get attestation(): AttestationStatus | undefined {
    return this.#attestation?.status()
  }

  #youtubeChanged(access: YouTubeAccess): void {
    if (access.level === 'held')
      this.#log(
        'warn',
        'YouTube still asks to confirm this is not a bot after the retries with PO tokens: YouTube requests stop until you sign in or choose to wait',
      )
    this.emit('youtube', access)
  }

  /** YouTube asked for a bot check: one rung up the ladder (or join the pause already running). */
  #youtubeRefused(): Refusal {
    const before = this.#youtube.access
    const refusal = this.#youtube.refused()
    const after = this.#youtube.access
    if (before.level !== after.level || before.refusals !== after.refusals) {
      const wait = refusal.waitMs === undefined ? 'until you decide' : `${Math.ceil(refusal.waitMs / 60_000)} min`
      this.#log(
        'warn',
        `YouTube asks to confirm this is not a bot: YouTube requests wait ${wait}${after.tokens ? ', then go on with PO tokens' : ''}`,
      )
    }
    return refusal
  }

  /**
   * Arguments and environment for one yt-dlp run on `url`. Cookies: the
   * signed-in YouTube session for YouTube, else a browser's (read once), else
   * the host's file — each as this run's own copy in `dir`. YouTube with tokens
   * on: the PO token plugin and where it asks.
   */
  async #runSetup(
    url: string,
    dir: string,
    bins: ResolvedBinaries,
    signal?: AbortSignal,
  ): Promise<{args: string[]; env: NodeJS.ProcessEnv}> {
    const youtube = isYouTubeUrl(url)
    const args = [...this.#baseArgs]
    let env = this.#env
    const jar =
      (youtube ? this.#accountJar : undefined) ??
      (await this.#browserCookies.jar((browser, dest) =>
        exportBrowserCookies({ytDlp: bins.ytDlp.exe, env: this.#env, browser, dest, signal}),
      )) ??
      this.#cookiesFile
    if (jar) args.push('--cookies', await jarCopy(jar, dir))
    if (youtube && this.#attestation && this.#youtube.access.tokens) {
      this.#broker ??= new PoTokenBroker(this.#attestation)
      this.#plugins ??= installPlugin(path.join(this.dataDir, 'yt-dlp-plugins'))
      // only our plugin: one the user installed for yt-dlp elsewhere is not part of this run
      args.push(
        '--no-plugin-dirs',
        '--plugin-dirs',
        await this.#plugins,
        // the default clients, and mweb: the one tokens are made for. One `youtube:` argument for
        // everything — yt-dlp keeps only the last of several
        '--extractor-args',
        'youtube:player_client=default,mweb',
      )
      env = {...env, ...(await this.#broker.env())}
    }
    return {args, env}
  }

  /**
   * The user's cookies for `domains`, for a native source that talks to the
   * site over plain HTTP: the browser's (read once, the same jar yt-dlp gets),
   * else the host's cookies file. Undefined when there is neither.
   */
  async #siteCookies(domains: readonly string[]): Promise<readonly CookieRecord[] | undefined> {
    const ytDlp = (await this.#tools().catch(() => undefined))?.ytDlp
    const jar =
      (ytDlp
        ? await this.#browserCookies
            .jar((browser, dest) => exportBrowserCookies({ytDlp: ytDlp.exe, env: this.#env, browser, dest}))
            .catch(error => {
              this.#log('warn', `browser cookies could not be read: ${toJobError(error).message}`)
              return undefined
            })
        : undefined) ?? this.#cookiesFile
    if (!jar) return undefined
    const text = await fs.readFile(jar, 'utf8').catch(() => undefined)
    if (text === undefined) return undefined
    const cookies = parseNetscape(text, domains)
    return cookies.length > 0 ? cookies : undefined
  }

  /** `#runSetup` in a scratch folder of its own, removed after `task`. */
  async #withRun<T>(
    url: string,
    bins: ResolvedBinaries,
    signal: AbortSignal | undefined,
    task: (setup: {args: string[]; env: NodeJS.ProcessEnv}) => Promise<T>,
  ): Promise<T> {
    const dir = path.join(this.#cacheDir, 'runs', newId())
    try {
      return await task(await this.#runSetup(url, dir, bins, signal))
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  get concurrency(): number {
    return this.#pool.limit
  }

  /** Change simultaneous jobs at runtime; returns the applied value (clamped to the CPU share's ceiling). */
  setConcurrency(requested: number): number {
    const value = clampConcurrency(requested, cpuCount(), this.#settings.cpuShare)
    this.#pool.setLimit(value)
    return value
  }

  /** The CPU share in effect (0.5–0.6). */
  get maxCpuShare(): number {
    return this.#settings.cpuShare
  }

  /** The most jobs `setConcurrency` accepts now (⌊CPUs × share⌋). */
  get concurrencyCeiling(): number {
    return maxConcurrency(cpuCount(), this.#settings.cpuShare)
  }

  /**
   * Let the pool use up to this share of the logical processors (0.5–0.6) from
   * now on. A lower share lowers the concurrency at once if it is above the new
   * ceiling (running jobs finish; no new one starts until there is room).
   * Returns the share applied.
   */
  setMaxCpuShare(share: number): number {
    this.#settings.cpuShare = cpuShare(share)
    const ceiling = this.concurrencyCeiling
    if (this.#pool.limit > ceiling) this.#pool.setLimit(ceiling)
    return this.#settings.cpuShare
  }

  get validation(): ValidationLevel {
    return this.#settings.validation
  }

  setValidation(level: ValidationLevel): void {
    this.#settings.validation = level
  }

  get validationTiming(): ValidationTiming {
    return this.#settings.validationTiming
  }

  /** Applies to jobs that start from now on. */
  setValidationTiming(timing: ValidationTiming): void {
    this.#settings.validationTiming = timing === 'after-batch' ? 'after-batch' : 'during'
  }

  /** Whether a media is known damaged at the source (by media id, or by url). */
  async isDamaged(lookup: DamagedLookup): Promise<DamagedEntry | undefined> {
    return this.damaged.find(lookup)
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

  /**
   * The tools a job or a check needs: all three, or — with `ytDlp: 'optional'`
   * — ffmpeg and ffprobe, and yt-dlp when there is one (`withYtDlp` where it runs).
   */
  async #tools(): Promise<AvailableBinaries> {
    const bins = await this.binaries.available()
    this.#ytDlpMissing = !bins.ytDlp
    return bins
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
      /** Entry ids already had: a native source lists only what is newer (see MediaSource.analyze). */
      known?: ReadonlySet<string>
    } = {},
  ): Promise<AnalysisResult> {
    this.#assertOpen()
    // tracked so dispose() can stop it; linked to the caller's signal
    const analysis = new AbortController()
    const forward = () => analysis.abort()
    // a signal aborted already never fires 'abort': a cancel that came first must count too
    if (opts.signal?.aborted) analysis.abort()
    else opts.signal?.addEventListener('abort', forward, {once: true})
    this.#analyses.add(analysis)
    /** Why the native source handed the link to yt-dlp: said instead of yt-dlp's "Unsupported URL", when it can't either. */
    let sourceError: DownloadError | undefined
    try {
      // a host where yt-dlp is optional: whether there is one decides who reads the link
      if (this.binaries.ytDlpOptional) await this.#tools()
      const source = this.#sourceFor(url)
      if (source) {
        try {
          return await source.analyze(url, {
            signal: analysis.signal,
            ...(opts.maxEntries !== undefined && {maxEntries: opts.maxEntries}),
            ...(opts.onProgress && {onProgress: opts.onProgress}),
            ...(opts.known && {known: opts.known}),
          })
        } catch (error) {
          if (!(error instanceof DownloadError) || !needsFallback(error.details)) throw error
          if (this.#ytDlpMissing) throw sourceFailure(error.toJSON())
          sourceError = error
          this.#log('warn', `${error.message} — reading ${url} with yt-dlp instead`)
        }
      }
      const bins = withYtDlp(await this.#tools())
      const youtube = isYouTubeUrl(url)
      if (youtube) {
        // a link pasted while YouTube requests wait (a pause, or a hold for the user) says so at once
        if (this.#youtube.blocked) throw youtubeWaiting()
        await this.#youtube.turn(analysis.signal)
      }
      try {
        const result = await this.#withRun(url, bins, analysis.signal, run =>
          analyze(url, {
            ytDlp: bins.ytDlp.exe,
            env: run.env,
            cacheDir: this.#cacheDir,
            commonArgs: run.args,
            signal: analysis.signal,
            maxEntries: opts.maxEntries,
          }),
        )
        if (youtube) this.#youtube.succeeded()
        return result
      } catch (error) {
        // a link pasted while YouTube bot-checks this connection: the pause starts here too
        if (error instanceof DownloadError && error.code === 'blocked' && isYouTubeUrl(url)) this.#youtubeRefused()
        // the site's own source could not read it and yt-dlp doesn't know the link: the source's reason
        if (sourceError && isUnsupported(error)) {
          throw new DownloadError('unavailable', sourceError.message, sourceError.details, undefined, 'retry-later')
        }
        // a site yt-dlp doesn't know: the source made for its host may read it
        const fallback = isUnsupported(error) ? this.#fallbackFor(url) : undefined
        if (!fallback) throw error
        let result: AnalysisResult
        try {
          result = await fallback.source.analyze(url, {
            signal: analysis.signal,
            ...(opts.maxEntries !== undefined && {maxEntries: opts.maxEntries}),
            ...(opts.onProgress && {onProgress: opts.onProgress}),
            ...(opts.known && {known: opts.known}),
          })
        } catch (fallbackError) {
          if (analysis.signal.aborted) throw cancelledError()
          this.#log(
            'info',
            `${url}: unsupported by yt-dlp and by ${fallback.source.name} (${toJobError(fallbackError).message})`,
          )
          throw error
        }
        // nothing there (no video page, no videos listed): still the site yt-dlp doesn't know
        if (result.kind === 'playlist' && result.entries.length === 0) throw error
        this.#learn(fallback)
        return result
      }
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
    const tools = await this.#tools()
    const analysis = new AbortController()
    const forward = () => analysis.abort()
    // a signal aborted already never fires 'abort': a cancel that came first must count too
    if (opts.signal?.aborted) analysis.abort()
    else opts.signal?.addEventListener('abort', forward, {once: true})
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
                if (tools.ytDlp) {
                  handBack.push(byUrl.get(url)!)
                  return
                }
                // no yt-dlp to hand it to: the source's reason
                result = {ok: false, error: sourceFailure(result.error).toJSON()}
              }
              results.set(url, result)
              opts.onResult?.(url, result)
            },
          })
        }),
      )

      // a chunk of urls through one yt-dlp process. YouTube chunks go through YouTube's gate
      // and ask politely (yt-dlp's own "sleep" pace between requests): a burst of checks is what
      // gets a connection bot-checked. Once it is, the rest aren't asked now — the downloads,
      // paced, check them later
      const blockedNow: JobError = {
        code: 'blocked',
        hint: 'bot-check',
        message: 'YouTube asks to confirm this is not a bot: not checked now, checked when it downloads.',
      }
      // items yt-dlp doesn't support, for the source made for their host: by source
      const elsewhere = new Map<MediaSource, {readonly host: string; readonly items: Array<(typeof items)[number]>}>()
      const runChunk = async (chunk: ReadonlyArray<(typeof items)[number]>) => {
        if (analysis.signal.aborted) return
        if (!tools.ytDlp) {
          // no yt-dlp: the source made for a url's host, when there is one, else the reason
          const missing = noYtDlp().toJSON()
          for (const item of chunk) {
            const fallback = this.#fallbackFor(item.url)
            if (fallback) {
              const list = elsewhere.get(fallback.source)
              if (list) list.items.push(item)
              else elsewhere.set(fallback.source, {host: fallback.host, items: [item]})
              continue
            }
            const result: ExtractResult = {ok: false, error: missing}
            results.set(item.url, result)
            opts.onResult?.(item.url, result)
          }
          return
        }
        const bins = withYtDlp(tools)
        // chunks are all YouTube or none (see below): one url tells
        const youtube = isYouTubeUrl(chunk[0]!.url)
        if (youtube && this.#youtube.blocked) {
          for (const item of chunk) {
            const result: ExtractResult = {ok: false, error: blockedNow}
            results.set(item.url, result)
            opts.onResult?.(item.url, result)
          }
          return
        }
        if (youtube) await this.#youtube.turn(analysis.signal)
        const byUrl = new Map(chunk.map(item => [item.url, item]))
        /** Urls yt-dlp doesn't support whose host has a source to try: not reported yet. */
        const unsupported = new Set<string>()
        const chunkResults = await this.#withRun(chunk[0]!.url, bins, analysis.signal, run =>
          extractMany(chunk, {
            ytDlp: bins.ytDlp.exe,
            env: run.env,
            cacheDir: this.#cacheDir,
            commonArgs: youtube ? [...run.args, ...YOUTUBE_POLITE_ARGS] : run.args,
            signal: analysis.signal,
            onResult: (url, result) => {
              const fallback =
                !result.ok && result.error.hint === 'unsupported-url' ? this.#fallbackFor(url) : undefined
              if (fallback) {
                unsupported.add(url)
                const list = elsewhere.get(fallback.source)
                if (list) list.items.push(byUrl.get(url)!)
                else elsewhere.set(fallback.source, {host: fallback.host, items: [byUrl.get(url)!]})
                return
              }
              opts.onResult?.(url, result)
            },
            keepMetadata: opts.keepMetadata,
          }),
        )
        let blocked = false
        for (const [url, result] of chunkResults) {
          if (unsupported.has(url)) continue
          results.set(url, result)
          if (!result.ok && result.error.code === 'blocked') blocked = true
        }
        if (youtube && blocked) this.#youtubeRefused()
        else if (youtube && chunkResults.size > 0) this.#youtube.succeeded()
      }

      const workers = this.concurrency
      const pool = new TaskPool<number>(workers)
      let key = 0
      // small batches: one url per process for full parallelism; large ones: ≤ 8 per process.
      // YouTube and other sites never share a chunk: YouTube's pace, cookies and tokens are its own. O(n)
      const enqueue = (list: ReadonlyArray<(typeof items)[number]>) => {
        for (const group of [list.filter(i => isYouTubeUrl(i.url)), list.filter(i => !isYouTubeUrl(i.url))]) {
          const size = Math.min(8, Math.max(1, Math.ceil(group.length / (workers * 2))))
          for (let start = 0; start < group.length; start += size) {
            const chunk = group.slice(start, start + size)
            pool.add(key++, () => runChunk(chunk))
          }
        }
      }
      enqueue(generic)
      await Promise.all([pool.whenIdle(), native])
      if (handBack.length) {
        this.#log(
          'warn',
          `${handBack.length} item(s) handed to yt-dlp: the built-in extractor is blocked or out of date`,
        )
        enqueue(handBack)
        await pool.whenIdle()
      }
      // checked by the source made for their host instead; what it can't read fails with its reason
      await Promise.all(
        [...elsewhere].map(async ([source, {host, items: own}]) => {
          let read = false
          await source.preflight(own, {
            signal: analysis.signal,
            onResult: (url, result) => {
              read ||= result.ok
              results.set(url, result)
              opts.onResult?.(url, result)
            },
          })
          if (read) this.#learn({host, source})
        }),
      )
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
    const source = this.#sources.find(source => source.handles(url)) ?? this.#learnedFor(url)
    return source?.defaultListSize?.(url)
  }

  /** The native source for a url, if any: a configured one, else one learned for its host. O(sources). */
  #sourceFor(url: string): MediaSource | undefined {
    // without yt-dlp there is no one to step aside for: a source that would is asked all the same
    const ready = (source: MediaSource) => source.available || this.#ytDlpMissing
    const source = this.#sources.find(source => ready(source) && source.handles(url)) ?? this.#learnedFor(url)
    return source && ready(source) ? source : undefined
  }

  #learnedFor(url: string): MediaSource | undefined {
    if (this.#learned.size === 0) return undefined
    const host = hostOf(url)
    return host === undefined ? undefined : this.#learned.get(host)
  }

  /**
   * The source to try for a url yt-dlp doesn't support: the one already made for its host, or
   * a new one from options.unsupportedUrlSource. None for YouTube, for hosts a configured source
   * claims, or without that option.
   */
  #fallbackFor(url: string): {readonly host: string; readonly source: MediaSource} | undefined {
    if (!this.#unsupportedUrlSource || isYouTubeUrl(url)) return undefined
    const host = hostOf(url)
    if (host === undefined || this.#sources.some(source => source.handles(url))) return undefined
    const known = this.#learned.get(host)
    if (known) return {host, source: known}
    const source = this.#unsupportedUrlSource(new URL(url))
    return source?.handles(url) ? {host, source} : undefined
  }

  /** From now on the source reads its host's urls (it read one yt-dlp doesn't support). */
  #learn({host, source}: {readonly host: string; readonly source: MediaSource}): void {
    if (this.#learned.get(host) === source) return
    this.#learned.set(host, source)
    this.#log('info', `${host}: not a site yt-dlp supports — read as ${source.name} from now on`)
  }

  /** Whether a file has an audio stream. */
  /**
   * Whether a file a native source downloaded has an audio stream. A file
   * ffprobe can't read at all (e.g. "moov atom not found") came down whole
   * and is broken: a validation failure, so a second one in a row marks it
   * damaged at the source instead of retrying it again and again.
   */
  async #hasAudio(bins: AvailableBinaries, file: string, signal: AbortSignal): Promise<boolean> {
    try {
      return summarizeProbe(await ffprobe(bins.ffprobe.exe, file, signal)).audio !== undefined
    } catch (error) {
      if (!(error instanceof ProbeError)) throw error
      throw new DownloadError('validation', `The file failed validation: ${error.message}`, undefined, {
        issues: 'probe-failed',
      })
    }
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

  /** What a job was asked to do (its folder, profile, list position…); undefined once it is released. */
  request(id: JobId): JobRequest | undefined {
    const job = this.#jobs.get(id)
    return job ? {...job.request, infoJsonPath: undefined} : undefined
  }

  /** Jobs of these that still wait for their check (finished with `validationTiming: 'after-batch'`). */
  pendingChecks(ids: Iterable<JobId>): JobId[] {
    const pending: JobId[] = []
    for (const id of ids) if (this.#withCheck(id)?.validationPending) pending.push(id)
    return pending
  }

  /**
   * Give up the checks still waiting (their batch was cancelled while it
   * checked): the files stay finished, unchecked ("none" in their records, as
   * they already are), and stop saying they wait.
   */
  dropPendingChecks(ids: Iterable<JobId>): void {
    for (const id of ids) {
      const job = this.#withCheck(id)
      this.#awaitingCheck.delete(id)
      if (!job?.validationPending) continue
      job.validationPending = false
      job.endStep('validate', 'skipped')
      this.emit('job', job.snapshot())
    }
  }

  /**
   * The integrity check put off until after a batch, for its finished files:
   * a few at a time (the pool's limit), each with its share of the CPU. A
   * file broken at the source is marked damaged (it stays where it is, its
   * record says so, and it is never downloaded again); one that fails for
   * another reason is removed with its record, so it can be downloaded again.
   * Either way the job turns failed (an event goes out). Passing files get
   * the level they passed in their record.
   */
  async checkLater(
    ids: readonly JobId[],
    opts: {readonly signal?: AbortSignal | undefined; readonly onProgress?: (done: number, total: number) => void} = {},
  ): Promise<LaterCheck> {
    const jobs = ids
      .map(id => this.#withCheck(id))
      .filter((job): job is Job => job?.validationPending === true && job.filepath !== undefined)
    const result = {checked: 0, ok: 0, damaged: 0, failed: 0}
    if (jobs.length === 0) return result
    const bins = await this.#tools()
    const level = this.#settings.validation === 'none' ? 'quick' : this.#settings.validation
    // biggest first, and the CPU budget shared by size: the largest file (the longest check) is not
    // left on one thread while small ones finish early — each worker keeps its share for its next file
    const size = (job: Job) => job.validation?.sizeBytes ?? job.request.estimatedBytes ?? 0
    const order = [...jobs].sort((a, b) => size(b) - size(a))
    const parallel = Math.max(1, Math.min(this.#pool.limit, order.length))
    const shares = cpuShares(this.#pool.limit, order.slice(0, parallel).map(size))
    let next = 0
    const worker = async (threads: number) => {
      for (let i = next++; i < order.length; i = next++) {
        opts.signal?.throwIfAborted()
        await this.#checkOne(order[i]!, bins, level, threads, opts.signal, result)
        this.#awaitingCheck.delete(order[i]!.id)
        result.checked++
        opts.onProgress?.(result.checked, jobs.length)
      }
    }
    await Promise.all(shares.map(worker))
    return result
  }

  /** A job, or one released already whose check after the batch is still to come. */
  #withCheck(id: JobId): Job | undefined {
    return this.#jobs.get(id) ?? this.#awaitingCheck.get(id)
  }

  async #checkOne(
    job: Job,
    bins: AvailableBinaries,
    level: ValidationLevel,
    threads: number,
    signal: AbortSignal | undefined,
    result: {ok: number; damaged: number; failed: number},
  ): Promise<void> {
    const file = job.filepath!
    const {request} = job
    const profile = request.profile
    const expectAudio = profile.kind === 'audio' || job.validation?.audio !== undefined
    const report: ValidationReport = await validateFile({
      ffmpeg: bins.ffmpeg.exe,
      ffprobe: bins.ffprobe.exe,
      file,
      rules: rulesFor(profile),
      level,
      expectedDuration: request.duration ?? job.validation?.duration,
      expectAudio,
      threads,
      signal: signal ?? new AbortController().signal,
    })
    const extractor = request.extractor
    const mediaId = job.mediaId ?? request.mediaId
    const key = extractor && mediaId ? archiveKey(extractor, mediaId, profile) : undefined
    const kept = {...report, sha256: job.validation?.sha256}
    if (report.ok) {
      if (key) await this.archive.update(key, {validation: level})
      job.checkedLater(kept)
      result.ok++
      this.#log('debug', `checked after its batch: ok (${level})`, job)
      this.emit('job', job.snapshot())
      return
    }
    const issues = report.issues.map(issue => issue.code)
    const reason = report.issues.map(issue => issue.message).join(' ')
    if (isSourceDamage(issues)) {
      await this.damaged.add({url: request.url, title: job.title ?? request.title, extractor, mediaId, reason, issues})
      if (key) await this.archive.update(key, {validation: level, damaged: reason})
      job.checkedLater(kept, damagedError({reason}).toJSON())
      result.damaged++
      this.#log(
        'error',
        `checked after its batch: broken at the source (${reason}) — marked damaged, kept at ${file}`,
        job,
        {
          code: 'unavailable',
        },
      )
    } else {
      if (key) await this.archive.remove(key)
      await fs.rm(file, {force: true})
      job.checkedLater(kept, new DownloadError('validation', `The file failed validation: ${reason}`).toJSON())
      result.failed++
      this.#log(
        'error',
        `checked after its batch: failed (${reason}) — file removed, it can be downloaded again`,
        job,
        {
          code: 'validation',
        },
      )
    }
    this.emit('job', job.snapshot())
    this.emit('failed', job.snapshot())
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
    this.#attestation?.close()
    await Promise.allSettled([
      this.#broker?.close(),
      this.archive.close(),
      this.#hashes.close(),
      this.#trace?.close(),
      fs.rm(this.#cacheDir, {recursive: true, force: true}),
    ])
    for (const job of this.#jobs.values()) job.release()
    for (const job of this.#awaitingCheck.values()) job.release()
    this.#jobs.clear()
    this.#finished.clear()
    this.#awaitingCheck.clear()
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
    /** The source made for the url's host, once yt-dlp said it doesn't support the url. */
    let sourceFallback: {readonly host: string; readonly source: MediaSource} | undefined
    const youtube = isYouTubeUrl(request.url)
    /** YouTube refusals while its ladder still climbs: they don't use up this job's retries. */
    let free = 0
    /** Attempts whose file failed validation as broken at the source: two in a row and it is damaged there. */
    let broken = 0

    try {
      const bins = await this.#tools()
      const known = await this.damaged.find({url: request.url, extractor: request.extractor, mediaId: request.mediaId})
      if (known) {
        this.#log('warn', `damaged at the source (${known.reason}) — not downloaded again`, job)
        throw damagedError(known)
      }
      if (await this.#skipIfArchived(job, request.extractor, request.mediaId)) return

      for (;;) {
        // YouTube attempts start a second apart, and wait out a bot-check pause (or a hold for the user)
        if (youtube) await this.#youtube.turn(signal)
        const attempt = job.beginAttempt(strategy)
        this.#emit(job, true)
        try {
          await this.#ensureDiskSpace(request)
          await this.#attempt(job, bins, profile, workDir, infoJsonPath, strategy, signal, sourceFallback?.source)
          job.endAttempt(undefined)
          if (sourceFallback) this.#learn(sourceFallback)
          if (youtube) this.#youtube.succeeded()
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
          const counted = attempt - free
          // a corrupt partial may cause anything but a network hiccup: start clean
          if (failure.code !== 'network') await fs.rm(workDir, {recursive: true, force: true})

          // the file came down whole and is broken: once more from scratch to be sure, then it is the source
          const issues = failure.code === 'validation' ? issueCodes(failure.params?.['issues']) : []
          if (isSourceDamage(issues) && ++broken >= 2) {
            const reason = failure.message.replace(/^The file failed validation: /, '')
            await this.damaged.add({
              url: request.url,
              title: job.title ?? request.title,
              extractor: request.extractor,
              mediaId: job.mediaId ?? request.mediaId,
              reason,
              issues,
            })
            job.endAttempt(jobError)
            this.#log(
              'error',
              `attempt ${attempt}/${job.maxAttempts}: the file is broken at the source (${reason}) — marked damaged, not downloaded again`,
              job,
              {code: 'unavailable'},
            )
            throw damagedError({reason})
          }
          // next attempt extracts fresh metadata — cached media urls may have expired
          if (infoJsonPath && strategy !== 'extractor-fallback') strategy = 'fresh-extraction'
          infoJsonPath = undefined

          // a native source that can't read the site any more, and no yt-dlp to read it: the source's reason
          if (needsFallback(failure.details) && !bins.ytDlp) {
            job.endAttempt(jobError)
            this.#log('error', `attempt ${attempt}/${job.maxAttempts}: ${failure.message} (no yt-dlp here)`, job, {
              code: failure.code,
            })
            throw sourceFailure(jobError)
          }
          // a native source that can't read the site any more: same request through yt-dlp
          if (needsFallback(failure.details) && strategy !== 'extractor-fallback' && counted < job.maxAttempts) {
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

          // a site yt-dlp doesn't know (e.g. queued before a restart): the source made for its host
          const fallback =
            isUnsupported(failure) && !sourceFallback && strategy !== 'extractor-fallback'
              ? this.#fallbackFor(request.url)
              : undefined
          if (fallback && counted < job.maxAttempts) {
            job.endAttempt(jobError, 0)
            this.#log(
              'warn',
              `attempt ${attempt}/${job.maxAttempts}: ${failure.message} — trying ${fallback.source.name}`,
              job,
              {
                code: failure.code,
              },
            )
            sourceFallback = fallback
            strategy = 'source-fallback'
            continue
          }

          // alternative before giving up: the requested resolution doesn't exist → best available
          const relaxed =
            failure.hint === 'format-unavailable' && strategy !== 'format-fallback' ? relaxProfile(profile) : undefined
          if (relaxed && counted < job.maxAttempts) {
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

          // YouTube's bot check: this job (and every YouTube request) climbs the ladder — tokens, a hold
          // for the user, pauses — and tries again; while it climbs, the attempt is not one of the retries
          if (failure.code === 'blocked' && youtube) {
            const refusal = this.#youtubeRefused()
            if (refusal.free || counted < job.maxAttempts) {
              if (refusal.free) free++
              job.endAttempt(jobError, refusal.waitMs)
              const when =
                refusal.waitMs === undefined
                  ? 'waiting for you to sign in or choose to wait'
                  : `trying again in ${Math.ceil(refusal.waitMs / 60_000)} min`
              this.#log('warn', `attempt ${attempt}: YouTube asks to confirm this is not a bot — ${when}`, job, {
                code: failure.code,
                ...(refusal.waitMs !== undefined && {retryInMs: refusal.waitMs}),
              })
              this.#update(job, {status: 'queued', progress: {}}, true)
              continue
            }
          }

          if (!isRetryable(failure.code) || counted >= job.maxAttempts) {
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
          const wait = retryDelay(counted, this.#settings.retryDelayMaxMs)
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
    bins: AvailableBinaries,
    profile: FormatProfile,
    workDir: string,
    infoJsonPath: string | undefined,
    strategy: AttemptStrategy,
    signal: AbortSignal,
    /** The source made for the url's host, yt-dlp having said it doesn't support the url. */
    fallback?: MediaSource,
  ): Promise<void> {
    const {request} = job
    await fs.mkdir(workDir, {recursive: true})
    // native source unless an earlier attempt already fell back to yt-dlp
    const source = fallback ?? (strategy === 'extractor-fallback' ? undefined : this.#sourceFor(request.url))
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
      : await this.#runSetup(request.url, path.join(workDir, 'run'), withYtDlp(bins), signal).then(run =>
          runYtDlp({
            ytDlp: withYtDlp(bins).ytDlp.exe,
            ffmpeg: bins.ffmpeg.exe,
            env: run.env,
            url: request.url,
            infoJsonPath,
            profile,
            workDir,
            fragments: this.#settings.fragmentsPerDownload,
            commonArgs: run.args,
            embedMetadata: this.#settings.embedMetadata,
            embedThumbnail: this.#settings.embedThumbnail,
            extraArgs: this.#settings.extraYtDlpArgs,
            stallTimeoutMs: this.#settings.stallTimeoutMs,
            signal,
            onInfo,
            onProgress: progress => this.#update(job, {status: 'downloading', progress}),
            onPostprocess: () => this.#update(job, {status: 'processing', progress: {}}, true),
          }),
        )
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

    // ── validate (or, for a batch checked after its downloads, only a probe of what came down)
    const later =
      this.#settings.validationTiming === 'after-batch' &&
      request.batchId !== undefined &&
      !bundle &&
      this.#settings.validation !== 'none'
    this.#step(job, 'validate')
    this.#update(job, {status: 'validating', progress: {fraction: 0}}, true)
    let report = bundle
      ? await validateBundle({ffprobe: bins.ffprobe.exe, dir: file, level: this.#settings.validation, signal})
      : await validateFile({
          ffmpeg: bins.ffmpeg.exe,
          ffprobe: bins.ffprobe.exe,
          file,
          rules: rulesFor(profile),
          level: later ? 'none' : this.#settings.validation,
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
    if (later) {
      job.validationPending = true
      job.putOff('validate')
      this.#emit(job, true)
    } else this.#stepDone(job, 'validate', this.#settings.validation === 'none' ? 'skipped' : 'success')

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
        // checked after the batch: 'none' until then
        validation: later ? 'none' : this.#settings.validation,
        batchId: request.batchId,
        // a playlist's name; a one-video batch is named after its video
        batchTitle: request.batchId ? (request.batchTitle ?? request.playlist?.title ?? mediaTitle) : undefined,
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
   *
   * Time Complexity: O(1) amortized per finished job eviction.
   * Space Complexity: O(1) auxiliary space.
   */
  #releaseOldFinished(): void {
    while (this.#finished.size > this.#settings.retainFinishedJobs) {
      const oldest = this.#finished.values().next().value as JobId
      this.#finished.delete(oldest)
      const job = this.#jobs.get(oldest)
      if (job?.validationPending) this.#awaitingCheck.set(oldest, job)
      else job?.release()
      this.#jobs.delete(oldest)
    }
  }

  /**
   * Drops a job from memory and releases all held timers/controllers.
   *
   * Time Complexity: O(1).
   * Space Complexity: O(1).
   */
  #forget(id: JobId): void {
    const job = this.#jobs.get(id)
    job?.release()
    this.#jobs.delete(id)
    this.#finished.delete(id)
  }

  /**
   * Status changes go out at once; progress at most every `progressIntervalMs` per job.
   *
   * Time Complexity: O(1) per emission check.
   * Space Complexity: O(1) auxiliary space.
   */
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
      job.emitTimer.unref()
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

/**
 * `budget` threads shared by weight (largest remainder): every share at least
 * one, together exactly `budget` (or one each when there are more weights).
 */
export function cpuShares(budget: number, weights: readonly number[]): number[] {
  const n = weights.length
  if (n === 0) return []
  if (budget <= n) return weights.map(() => 1)
  const spare = budget - n // one each first, the rest by weight
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0)
  const exact = weights.map(weight => (total > 0 ? (spare * Math.max(0, weight)) / total : spare / n))
  const shares = exact.map(value => 1 + Math.floor(value))
  let left = budget - shares.reduce((sum, share) => sum + share, 0)
  const byRemainder = exact
    .map((value, index) => [value - Math.floor(value), index] as const)
    .sort((a, b) => b[0] - a[0])
  for (const [, index] of byRemainder) {
    if (left <= 0) break
    shares[index]!++
    left--
  }
  return shares
}

/** The validation issue codes a validation error carried (its `issues` param, comma separated). */
function issueCodes(value: unknown): ValidationIssueCode[] {
  return typeof value === 'string' ? (value.split(',').filter(Boolean) as ValidationIssueCode[]) : []
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

/**
 * The tools with yt-dlp, for a step that runs it. A host without yt-dlp
 * (`ytDlp: 'optional'`) gets a clear 'binary-missing', not a failed spawn.
 */
function withYtDlp(bins: AvailableBinaries): ResolvedBinaries {
  if (!bins.ytDlp) throw noYtDlp()
  return {...bins, ytDlp: bins.ytDlp}
}

const noYtDlp = (): DownloadError =>
  new DownloadError(
    'binary-missing',
    'yt-dlp is not available here: only the built-in extractors (TikTok, Instagram, Facebook…) read links.',
    undefined,
    {tool: 'yt-dlp'},
  )

/**
 * A native source's failure that would have gone to yt-dlp, on a host
 * without it: the source's own reason, to come back to later.
 */
function sourceFailure(error: JobError): DownloadError {
  return new DownloadError('unavailable', error.message, error.details, error.params, error.hint ?? 'retry-later')
}

/** yt-dlp's "Unsupported URL" (no extractor, not even its generic one, reads the page). */
function isUnsupported(error: unknown): boolean {
  return error instanceof DownloadError && error.hint === 'unsupported-url'
}

/** An http(s) url's host without `www.`; undefined for anything else. */
function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.hostname.toLowerCase().replace(/^www\./, '') || undefined
  } catch {
    return undefined
  }
}
