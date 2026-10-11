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

export type JobError = {
  readonly code: ErrorCode
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

declare const jobIdBrand: unique symbol
/** Opaque job identifier. */
export type JobId = string & {readonly [jobIdBrand]: true}

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

export type PlaylistRef = {
  readonly id: string
  readonly title: string
  readonly index: number
}

/** Immutable view of a job, emitted on every change. */
export type JobSnapshot = {
  readonly id: JobId
  readonly url: string
  readonly profile: FormatProfile
  readonly status: JobStatus
  readonly title?: string | undefined
  readonly mediaId?: string | undefined
  readonly playlist?: PlaylistRef | undefined
  readonly progress: JobProgress
  /** 1-based; increases on every retry. */
  readonly attempt: number
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
  readonly profile: FormatProfile
  /** Absolute destination folder. Playlist jobs get a sub-folder named after the playlist. */
  readonly outDir: string
  readonly title?: string | undefined
  readonly mediaId?: string | undefined
  readonly extractor?: string | undefined
  /** Expected duration in seconds, cross-checked by validation. */
  readonly duration?: number | undefined
  readonly playlist?: PlaylistRef | undefined
  /** From analyze(); ignored unless it lives in the engine's cache folder. */
  readonly infoJsonPath?: string | undefined
}

// ─── Options ────────────────────────────────────────────────────────────────

export type BinaryPaths = {
  readonly ytDlp?: string | undefined
  readonly ffmpeg?: string | undefined
  readonly ffprobe?: string | undefined
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
  /** Store a SHA-256 of every finished file in the archive. Default true. */
  readonly checksums?: boolean | undefined
  /** Skip media already downloaded with the same profile. Default true. */
  readonly useArchive?: boolean | undefined
  /** Retries for transient failures (network, expired urls, failed validation). Default 3. */
  readonly maxRetries?: number | undefined
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
  /** Finished jobs kept in memory; older ones are released. Default 1000. */
  readonly retainFinishedJobs?: number | undefined
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type DownloaderEvents = {
  /** Any change of a job: status, progress, result. Progress is throttled per job. */
  job: [snapshot: JobSnapshot]
  /** Completed or skipped. */
  completed: [snapshot: JobSnapshot]
  failed: [snapshot: JobSnapshot]
  /** Nothing queued (or the queue is paused) and nothing running. */
  idle: []
  log: [level: LogLevel, message: string]
}
