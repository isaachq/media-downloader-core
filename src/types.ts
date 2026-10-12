import type {FileNameStyle} from './core/files.js'
import type {MediaSource} from './sources/source.js'
import type {TikTokOptions} from './sources/tiktok/source.js'
// Public types. Everything a host application (CLI, Electron, server) needs to
// drive the engine and render its state. User-facing text is always English
// and paired with a stable `code` + `params`, so a UI can localize by code.

// ─── Format profiles ────────────────────────────────────────────────────────
// A profile describes the *result* (container + codecs), never a site-specific
// format id. That is what makes playlists work: every entry exposes different
// formats, but the same profile resolves correctly for each one.

/** mp4 = H.264 + AAC (plays everywhere) · webm = VP9/AV1 + Opus · mkv = best streams, any codec. */
export type VideoContainer = 'mp4' | 'webm' | 'mkv'
/** m4a (AAC) and opus are stream-copied when the source already uses that codec. */
export type AudioContainer = 'm4a' | 'mp3' | 'opus' | 'flac' | 'wav'

export type VideoProfile = {
  readonly kind: 'video'
  readonly container: VideoContainer
  /** Highest vertical resolution to accept (e.g. 1080). Omit for the best available. */
  readonly maxHeight?: number | undefined
}

export type AudioProfile = {
  readonly kind: 'audio'
  readonly container: AudioContainer
  /**
   * Quality of lossy encodes (mp3, or AAC/Opus when the source codec differs):
   * a VBR level '0' (best) … '10', or a bitrate such as '192K'. Default '0'.
   */
  readonly quality?: string | undefined
}

export type FormatProfile = VideoProfile | AudioProfile

// ─── Analysis ───────────────────────────────────────────────────────────────

export type FormatChoice = {
  readonly profile: FormatProfile
  /** English label; UIs can build their own from `profile`. */
  readonly label: string
  /** Rough size in bytes, when the site reports it. */
  readonly estimatedBytes?: number | undefined
  /**
   * The source lacks the codecs this profile needs, so the file will be
   * converted locally after downloading (slower, uses CPU).
   */
  readonly requiresConversion: boolean
}

export type MediaSummary = {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly uploader?: string | undefined
  /** Seconds. */
  readonly duration?: number | undefined
  readonly thumbnail?: string | undefined
  /** When it was published, unix seconds (when the listing tells). */
  readonly publishedAt?: number | undefined
  /** yt-dlp extractor key, e.g. "Youtube". */
  readonly extractor: string
  readonly isLive: boolean
}

export type VideoAnalysis = {
  readonly kind: 'video'
  readonly media: MediaSummary
  readonly choices: readonly FormatChoice[]
  /** Cached yt-dlp metadata; lets the download skip re-extraction. Owned by the engine. */
  readonly infoJsonPath?: string | undefined
}

export type PlaylistEntry = MediaSummary & {
  /** 1-based position inside the playlist. */
  readonly index: number
}

export type PlaylistAnalysis = {
  readonly kind: 'playlist'
  readonly id: string
  readonly url: string
  readonly title: string
  readonly uploader?: string | undefined
  readonly extractor: string
  readonly entries: readonly PlaylistEntry[]
  /** Generic profiles — per-entry formats are only known at download time. */
  readonly choices: readonly FormatChoice[]
  /** Set when the url points at one video inside a playlist (youtube watch?v=…&list=…). */
  readonly singleVideoUrl?: string | undefined
  /**
   * How many items the list holds in all, when the site tells (a TikTok
   * profile's video count). More than `entries.length` means the listing was
   * capped and can be continued.
   */
  readonly total?: number | undefined
}

export type AnalysisResult = VideoAnalysis | PlaylistAnalysis

// ─── Errors & validation ────────────────────────────────────────────────────

export type ErrorCode =
  | 'cancelled'
  /** Connection problems, timeouts, HTTP 5xx / 429. Retried. */
  | 'network'
  /** Media urls expired or the server answered 403. Retried with a fresh extraction. */
  | 'expired'
  /** Private, removed, geo-blocked, members-only, age-restricted… Not retried. */
  | 'unavailable'
  | 'disk-full'
  /** The file failed integrity validation. Retried from scratch. */
  | 'validation'
  | 'conversion'
  | 'binary-missing'
  | 'invalid-request'
  | 'unknown'

export type MessageParams = Readonly<Record<string, string | number>>

/**
 * What a user can do about a failure that retrying won't fix — shown next to
 * the error so a job can be closed with an actionable reason.
 */
export type FailureHint =
  | 'needs-sign-in'
  | 'private'
  | 'removed'
  | 'geo-blocked'
  | 'members-only'
  | 'not-started'
  | 'unsupported-url'
  | 'format-unavailable'
  | 'retry-later'

export type JobError = {
  readonly code: ErrorCode
  readonly hint?: FailureHint | undefined
  /** English, for logs; localize by `code`. */
  readonly message: string
  readonly params?: MessageParams | undefined
  /** Last relevant stderr lines, for a "details" view. */
  readonly details?: string | undefined
}

export type ValidationIssueCode =
  | 'file-missing'
  | 'file-empty'
  | 'probe-failed'
  | 'unexpected-container'
  | 'missing-video'
  | 'missing-audio'
  | 'unexpected-video'
  | 'unexpected-video-codec'
  | 'unexpected-audio-codec'
  | 'unknown-duration'
  | 'duration-mismatch'
  | 'decode-failed'
  | 'decode-errors'
  | 'incomplete-decode'

export type ValidationIssue = {
  readonly code: ValidationIssueCode
  readonly message: string
  readonly params?: MessageParams | undefined
}

/** none = trust yt-dlp · quick = probe + read every packet · full = decode every frame (default). */
export type ValidationLevel = 'none' | 'quick' | 'full'

export type StreamInfo = {
  readonly codec: string
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly fps?: number | undefined
  readonly channels?: number | undefined
  readonly sampleRate?: number | undefined
  readonly bitrate?: number | undefined
}

export type ValidationReport = {
  readonly level: ValidationLevel
  readonly ok: boolean
  /** ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  readonly container: string
  readonly sizeBytes: number
  /** Seconds, as declared by the container. */
  readonly duration?: number | undefined
  /** Seconds that actually decoded (full) or demuxed (quick). */
  readonly decodedDuration?: number | undefined
  readonly expectedDuration?: number | undefined
  readonly video?: StreamInfo | undefined
  readonly audio?: StreamInfo | undefined
  /** Hex SHA-256 of the final file, when checksums are enabled. */
  readonly sha256?: string | undefined
  readonly issues: readonly ValidationIssue[]
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

/** 32-character base62 id ([A-Za-z0-9]) — grep it in the trace logs to replay a flow. */
export type TraceId = string

declare const jobIdBrand: unique symbol
/** Opaque job identifier (a TraceId). */
export type JobId = TraceId & {readonly [jobIdBrand]: true}

export type JobStatus =
  | 'queued'
  | 'downloading'
  /** yt-dlp post-processing: merging video + audio, extracting audio, writing metadata. */
  | 'processing'
  /** Local codec conversion, when the source lacked the target codecs. */
  | 'converting'
  | 'validating'
  | 'finalizing'
  | 'completed'
  /** Already in the download archive and still on disk. */
  | 'skipped'
  | 'failed'
  | 'cancelled'

export type TerminalStatus = Extract<JobStatus, 'completed' | 'skipped' | 'failed' | 'cancelled'>

export type JobProgress = {
  /** 0…1 within the current status. undefined = indeterminate. */
  readonly fraction?: number | undefined
  readonly downloadedBytes?: number | undefined
  readonly totalBytes?: number | undefined
  /** Bytes per second. */
  readonly speed?: number | undefined
  /** Seconds. */
  readonly eta?: number | undefined
  /** 1-based file being downloaded (video and audio are separate parts). */
  readonly part?: number | undefined
  readonly totalParts?: number | undefined
  readonly fragmentIndex?: number | undefined
  readonly fragmentCount?: number | undefined
}

/**
 * Resource class of a job, from its duration, resolution and conversion
 * needs: normal (weight 1) · long (1.5 → ⌊N/3⌋ at once) · heavy (2 → ⌊N/4⌋).
 */
export type JobTier = 'normal' | 'long' | 'heavy'

/** The sub-tasks every job runs, in order. */
export type StepName = 'download' | 'convert' | 'validate' | 'finalize'
export type StepState = 'pending' | 'in-progress' | 'success' | 'failed' | 'skipped'

export type JobStep = {
  /** Unique per step per attempt. */
  readonly id: TraceId
  readonly name: StepName
  readonly state: StepState
  readonly startedAt?: number | undefined
  readonly finishedAt?: number | undefined
  readonly error?: JobError | undefined
}

/** One try at running the job's steps. */
/** How an attempt tried: as requested, with fresh metadata, or with a relaxed format. */
/** extractor-fallback: a native source (TikTok) could not read the post — yt-dlp tries instead. */
export type AttemptStrategy = 'primary' | 'fresh-extraction' | 'format-fallback' | 'extractor-fallback'

export type AttemptRecord = {
  readonly id: TraceId
  readonly strategy: AttemptStrategy
  /** 1-based. */
  readonly attempt: number
  readonly startedAt: number
  readonly finishedAt?: number | undefined
  /** Step where this attempt failed. */
  readonly failedStep?: StepName | undefined
  /** Last status and progress reached before the failure — where the attempt stopped. */
  readonly lastStatus?: JobStatus | undefined
  readonly lastProgress?: JobProgress | undefined
  readonly error?: JobError | undefined
  /** Wait before the next attempt, when one follows. */
  readonly retryInMs?: number | undefined
}

/** Coarse result for dashboards: anything that isn't a success is a failure (cancellations included). */
export type JobOutcome = 'in-progress' | 'success' | 'failed'

export type PlaylistRef = {
  readonly id: string
  readonly title: string
  readonly index: number
}

/** Immutable view of a job, emitted on every change. */
export type JobSnapshot = {
  readonly id: JobId
  /** The batch this job belongs to, when created by the scheduler. */
  readonly batchId?: BatchId | undefined
  readonly url: string
  readonly profile: FormatProfile
  readonly status: JobStatus
  readonly title?: string | undefined
  readonly mediaId?: string | undefined
  readonly playlist?: PlaylistRef | undefined
  readonly outcome: JobOutcome
  readonly tier: JobTier
  /** Capacity units held while running (see JobTier). */
  readonly weight: number
  /** Expected size of the final file, when known. */
  readonly estimatedBytes?: number | undefined
  readonly progress: JobProgress
  /** Sub-task states of the current (or last) attempt. */
  readonly steps: readonly JobStep[]
  /** Every attempt so far, with the step and error that ended it. */
  readonly attempts: readonly AttemptRecord[]
  /** 1-based; increases on every retry. */
  readonly attempt: number
  /** 1 + maxRetries. */
  readonly maxAttempts: number
  /** Final location — set once completed or skipped. */
  readonly filepath?: string | undefined
  readonly validation?: ValidationReport | undefined
  readonly error?: JobError | undefined
  readonly createdAt: number
  readonly startedAt?: number | undefined
  readonly finishedAt?: number | undefined
}

export type JobRequest = {
  /** http(s) page url. */
  readonly url: string
  readonly batchId?: BatchId | undefined
  readonly profile: FormatProfile
  /** Absolute destination folder. Playlist jobs get a sub-folder named after the playlist. */
  readonly outDir: string
  readonly title?: string | undefined
  readonly mediaId?: string | undefined
  readonly extractor?: string | undefined
  /** Expected duration in seconds, cross-checked by validation (and used to size the job). */
  readonly duration?: number | undefined
  /** Expected final size; drives the disk-space check before the job starts. */
  readonly estimatedBytes?: number | undefined
  /** The profile's codecs aren't offered: the file will be converted locally (heavier). */
  readonly requiresConversion?: boolean | undefined
  readonly playlist?: PlaylistRef | undefined
  /** From analyze(); ignored unless it lives in the engine's cache folder. */
  readonly infoJsonPath?: string | undefined
}

// ─── Batches (scheduler) ────────────────────────────────────────────────────
// schedule → batch → jobs: every url submitted becomes a batch, batches run
// one after another (by default), and each batch fans out into jobs that run
// on the ⌊CPUs/2⌋ pool. Submitting never blocks: a batch just waits its turn.

declare const batchIdBrand: unique symbol
export type BatchId = TraceId & {readonly [batchIdBrand]: true}

export type BatchStatus =
  /** Waiting for the batches ahead of it. */
  | 'scheduled'
  /** Preflight: resolving the url and checking every item is downloadable. */
  | 'checking'
  | 'running'
  | 'completed'
  /** Finished, some items succeeded and some didn't. */
  | 'completed-with-errors'
  /** Finished with no successful item. */
  | 'failed'
  | 'cancelled'

export type PreflightState = 'pending' | 'checking' | 'ok' | 'unavailable'

export type PreflightItem = {
  /** 1-based position (playlist index; 1 for a single video). */
  readonly index: number
  readonly url: string
  readonly title?: string | undefined
  readonly mediaId?: string | undefined
  readonly duration?: number | undefined
  readonly state: PreflightState
  /** Set when the requested profile needs a local conversion for this item. */
  readonly requiresConversion?: boolean | undefined
  /** Expected final size (site figure, or duration × typical bitrate). */
  readonly estimatedBytes?: number | undefined
  readonly tier?: JobTier | undefined
  /** Already in the download archive: it will be skipped, costs no disk. */
  readonly archived?: boolean | undefined
  readonly error?: JobError | undefined
  readonly jobId?: JobId | undefined
}

export type BatchCounts = {
  readonly total: number
  readonly queued: number
  readonly running: number
  readonly succeeded: number
  readonly failed: number
}

export type BatchSnapshot = {
  readonly id: BatchId
  readonly url: string
  readonly profile: FormatProfile
  readonly outDir: string
  readonly status: BatchStatus
  /** The entry cap in effect (see `BatchRequest.maxItems`); undefined = the 5000 default. */
  readonly maxItems?: number | undefined
  readonly kind?: 'video' | 'playlist' | undefined
  readonly title?: string | undefined
  /** Position among scheduled batches (1 = next), while scheduled. */
  readonly position?: number | undefined
  readonly preflight: {
    readonly total: number
    readonly checked: number
    readonly ok: number
    readonly unavailable: number
  }
  /** Disk and load forecast, set when the preflight ends. */
  readonly estimate?: BatchEstimate | undefined
  /**
   * While running: progress weighted by size, and the estimated seconds left,
   * measured from this machine's actual throughput (see `WorkMeter`).
   */
  readonly progress?: {readonly fraction: number; readonly etaSeconds?: number | undefined} | undefined
  /** Items are not part of the snapshot (a 5,000-item batch would make every event huge): use `scheduler.items()` and the `item` event. */
  readonly jobs: BatchCounts
  readonly error?: JobError | undefined
  readonly createdAt: number
  readonly startedAt?: number | undefined
  readonly finishedAt?: number | undefined
}

export type BatchEstimate = {
  /** Bytes the new files will occupy (archived items excluded). */
  readonly bytes: number
  /** Free bytes plus what the batch needs at its peak (final files + temporary copies). */
  readonly requiredBytes: number
  readonly freeBytes?: number | undefined
  /** Items whose size couldn't be estimated (no size, no duration). */
  readonly unknown: number
  readonly archived: number
  readonly long: number
  readonly heavy: number
}

export type BatchRequest = {
  readonly url: string
  readonly profile: FormatProfile
  readonly outDir: string
  /** Playlist items to take (1-based). */
  readonly items?: readonly number[] | undefined
  /**
   * Take at most this many playlist entries (1–5000), listed by the extractor
   * itself so the rest is never fetched. Default: 50 for a YouTube Mix (an
   * endless, auto-generated radio — `isYouTubeMix()`), 500 for a TikTok
   * profile, 5000 for anything else.
   */
  readonly maxItems?: number | undefined
  /**
   * Entries picked from a preview (`analyze()`): the batch downloads exactly
   * these and does not list the url again — faster, and stable for lists that
   * change between calls such as a YouTube Mix. Overrides `items`/`maxItems`.
   */
  readonly selection?: BatchSelection | undefined
  /**
   * The url's analysis when the caller already has it (e.g. from a preview):
   * the batch starts from it instead of asking yt-dlp again (~2 s saved per
   * video). Stale media links are refreshed by the jobs as usual.
   */
  readonly analysis?: VideoAnalysis | undefined
}

export type BatchSelection = {
  readonly title: string
  readonly entries: readonly PlaylistEntry[]
}

export type SchedulerOptions = {
  /** Batches processed at the same time. Default 1: one batch saturates the ⌊CPUs/2⌋ pool already. */
  readonly maxActiveBatches?: number | undefined
  /** Check every item before downloading. Default true. */
  readonly preflight?: boolean | undefined
  /** Minimum interval between counter-only `batch` events of one batch (ms). Default 250. */
  readonly progressIntervalMs?: number | undefined
  /**
   * Preflight metadata kept on disk for reuse by the jobs (~150 KiB each).
   * Items beyond this are still checked, then extracted again when their
   * job starts. Default 500.
   */
  readonly maxCachedMetadata?: number | undefined
  /**
   * After the preflight, compare the batch's estimated disk needs with the
   * free space: 'block' (default) fails the batch before downloading
   * anything, 'warn' logs and continues, 'off' skips the check.
   */
  readonly diskCheck?: 'block' | 'warn' | 'off' | undefined
}

export type SchedulerEvents = {
  /** Status changes immediately; counter-only changes at most every `progressIntervalMs` per batch. */
  batch: [snapshot: BatchSnapshot]
  /** One preflight item changed (checked, unavailable, became a job). */
  item: [batchId: BatchId, item: PreflightItem]
  /** Nothing scheduled, checking or running. */
  idle: []
}

// ─── Options ────────────────────────────────────────────────────────────────

/** A program: a path, or a command with fixed leading args (e.g. `{command: 'python3', args: ['-m', 'yt_dlp']}`). */
export type ExecutableSpec = string | {readonly command: string; readonly args?: readonly string[] | undefined}

export type BinaryPaths = {
  readonly ytDlp?: ExecutableSpec | undefined
  readonly ffmpeg?: ExecutableSpec | undefined
  readonly ffprobe?: ExecutableSpec | undefined
}

/**
 * JavaScript runtime yt-dlp uses to solve YouTube's player challenges.
 * Default: the Node.js running this library (in Electron, the app binary
 * itself in ELECTRON_RUN_AS_NODE mode), so nothing extra must be installed.
 */
export type JsRuntime = {
  readonly name: 'node' | 'deno' | 'bun' | 'quickjs'
  readonly path: string
}

export type DownloaderOptions = {
  /**
   * Where the archive, queue state, temp files and the auto-updated yt-dlp
   * live. In Electron: `app.getPath('userData')`.
   */
  readonly dataDir: string
  /**
   * Simultaneous jobs. Clamped to [1, ⌊logical CPUs / 2⌋] so the machine
   * stays responsive. Defaults to the maximum.
   */
  readonly concurrency?: number | undefined
  /** Parallel fragments inside one download (HLS/DASH sites). Network-bound. Default 3. */
  readonly fragmentsPerDownload?: number | undefined
  /** Default 'full'. */
  readonly validation?: ValidationLevel | undefined
  /**
   * 'portable' (default): file and folder names with ASCII letters, digits and
   * hyphens only, as car stereos, TVs and FAT32 USB sticks need. 'original':
   * the title as is, made safe for macOS and Windows.
   */
  readonly fileNames?: FileNameStyle | undefined
  /**
   * TikTok through the built-in extractor (pages + public listing, paced; no
   * yt-dlp). `false` hands TikTok urls to yt-dlp like any other site.
   */
  readonly tiktok?: false | TikTokOptions | undefined
  /**
   * More sites read natively, supplied by the host (e.g. a `PlayerPageSource`
   * per site the user configured). Asked after the built-in ones.
   */
  readonly sources?: readonly MediaSource[] | undefined
  /** Store a SHA-256 of every finished file in the archive. Default true. */
  readonly checksums?: boolean | undefined
  /** Skip media already downloaded with the same profile. Default true. */
  readonly useArchive?: boolean | undefined
  /** Retries for transient failures (network, expired urls, failed validation, stalls). Default 3. */
  readonly maxRetries?: number | undefined
  /** Ceiling of the wait between attempts (exponential 2 s → 4 s → 8 s…). Default 15 000 ms. */
  readonly retryDelayMaxMs?: number | undefined
  /** Abort an attempt whose download shows no activity for this long, then retry. Default 120 000 ms. */
  readonly stallTimeoutMs?: number | undefined
  /** Explicit binaries, e.g. those shipped in Electron's resources folder. */
  readonly binaries?: BinaryPaths | undefined
  /** Default: auto (current Node.js / Electron). `false` disables it. */
  readonly jsRuntime?: JsRuntime | false | undefined
  /** Write title/artist/date tags into the file. Default true. */
  readonly embedMetadata?: boolean | undefined
  /** Embed the thumbnail as cover art. Default false. */
  readonly embedThumbnail?: boolean | undefined
  /** Read cookies from a browser ('chrome', 'safari', 'firefox', …) for private / age-restricted media. */
  readonly cookiesFromBrowser?: string | undefined
  /** Netscape cookies.txt path. */
  readonly cookiesFile?: string | undefined
  /** Bandwidth cap per download, yt-dlp syntax: '5M', '500K'. */
  readonly rateLimit?: string | undefined
  /** Extra raw yt-dlp arguments, appended last. */
  readonly extraYtDlpArgs?: readonly string[] | undefined
  /** Minimum interval between progress events of one job (ms). Default 250. */
  readonly progressIntervalMs?: number | undefined
  /** Refuse to start a job below this much free space (bytes). Default 512 MiB. */
  readonly minFreeSpaceBytes?: number | undefined
  /** Write every log entry (debug included) to `<dataDir>/logs/trace-YYYY-MM-DD.jsonl`. Default true. */
  readonly traceLog?: boolean | undefined
  /** Days of trace files to keep. Default 14. */
  readonly traceRetentionDays?: number | undefined
  /**
   * Cached metadata older than this is ignored and extracted again: media
   * urls in it expire (YouTube's after ~6 h). Default 3 h.
   */
  readonly metadataMaxAgeMs?: number | undefined
  /** Videos at least this long are 'long' (N/3) or 'heavy' (N/4) jobs. Default 30. */
  readonly longVideoMinutes?: number | undefined
  /** Finished jobs kept in memory; older ones are released. Default 1000. */
  readonly retainFinishedJobs?: number | undefined
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Structured log line: render `message`, or build your own from the fields. */
export type LogEntry = {
  readonly level: LogLevel
  readonly message: string
  readonly time: number
  /** One per MediaDownloader instance (app launch / CLI run). */
  readonly sessionId: TraceId
  readonly batchId?: BatchId | undefined
  readonly jobId?: JobId | undefined
  readonly attemptId?: TraceId | undefined
  readonly stepId?: TraceId | undefined
  readonly attempt?: number | undefined
  readonly maxAttempts?: number | undefined
  readonly step?: StepName | undefined
  readonly code?: ErrorCode | undefined
  readonly retryInMs?: number | undefined
}

export type DownloaderEvents = {
  /** Any change of a job: status, progress, result. Progress is throttled per job. */
  job: [snapshot: JobSnapshot]
  /** Completed or skipped. */
  completed: [snapshot: JobSnapshot]
  failed: [snapshot: JobSnapshot]
  /** Nothing queued (or the queue is paused) and nothing running. */
  idle: []
  log: [entry: LogEntry]
}
