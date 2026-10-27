import type {YtDlpPolicy} from './binaries/manager.js'
import type {FileNameStyle} from './core/files.js'
import type {BlueskyOptions} from './sources/bluesky/source.js'
import type {LinkSite} from './sources/detect.js'
import type {DirectOptions} from './sources/direct/source.js'
import type {FacebookOptions} from './sources/facebook/source.js'
import type {InstagramOptions} from './sources/instagram/source.js'
import type {MixPlanSkip} from './sources/mix-plan.js'
import type {SnapchatOptions} from './sources/snapchat/source.js'
import type {MediaSource} from './sources/source.js'
import type {ThreadsOptions} from './sources/threads/source.js'
import type {TikTokOptions} from './sources/tiktok/source.js'
import type {TwitchOptions} from './sources/twitch/source.js'
import type {VkOptions} from './sources/vk/source.js'
import type {XOptions} from './sources/x/source.js'
import type {AttestationOptions, AttestationStrategy} from './youtube/attestation.js'
import type {YouTubeAccess} from './youtube/gate.js'
// Public types. Everything a host application (CLI, Electron, server) needs to
// drive the engine and render its state. User-facing text is always English
// and paired with a stable `code` + `params`, so a UI can localize by code.

// ─── Format profiles ────────────────────────────────────────────────────────
// A profile describes the *result* (container + codecs), never a site-specific
// format id. That is what makes playlists work: every entry exposes different
// formats, but the same profile resolves correctly for each one.

/** How a file is processed locally to reach the requested profile. */
export type ProcessingKind = 'none' | 'remux' | 'transcode' | 'extract'

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
  /** Exact kind of local processing required. */
  readonly processingKind?: ProcessingKind | undefined
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
  /**
   * A photo post (TikTok slideshow) or a carousel: its items and whether it
   * has sound. `videos`: a carousel that has videos too — always a folder of
   * everything as the site serves it, whatever `SlideshowOptions.mode` says.
   * `songNeedsSession`: read without a session, which never carries a photo
   * post's song (Instagram) — it may have one; signing in gets it.
   */
  readonly slideshow?:
    | {
        readonly images: number
        readonly audio: boolean
        readonly videos?: boolean | undefined
        readonly songNeedsSession?: boolean | undefined
      }
    | undefined
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
  /**
   * The listing reached the end of the list. With fewer entries than `total`,
   * the rest are items the site counts but does not list (private, deleted,
   * visible only to their author): asking for more brings nothing.
   */
  readonly complete?: boolean | undefined
  /** An incremental listing stopped where the known entries start: every newer entry is in it. */
  readonly caughtUp?: boolean | undefined
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
  /**
   * The site asks to prove the requester is human ("Sign in to confirm you're
   * not a bot"): it blocked this connection for a while. YouTube jobs wait it
   * out (every YouTube request pauses, 5 → 10 → 20 min) or continue at once
   * with a browser's signed-in session (`setCookiesFromBrowser`).
   */
  | 'blocked'
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
  /** The site asked to confirm this is not a bot (code `blocked`). */
  | 'bot-check'
  /** The browser's cookies couldn't be read (on macOS, Safari's need Full Disk Access). */
  | 'cookies-unreadable'
  /**
   * The file the site serves is broken (it failed validation twice, or the
   * check after its batch): it is not downloaded again — that would only
   * waste time, bandwidth and disk (see `MediaDownloader.damaged`).
   */
  | 'damaged-source'
  /** The post has pictures or text but no video (an X post of photos): nothing to download as video. */
  | 'no-video'
  /** A live stream on the air: it can be downloaded once it ends, as a recording. */
  | 'live-now'
  /** The site offers this video only as a stream (HLS), which the built-in extractor doesn't save (no yt-dlp here). */
  | 'stream-only'

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
  | 'resolution-exceeded'
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

export type ValidationTiming = 'during' | 'after-batch'

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
  /**
   * A live recording (a Twitch channel on the air): it has no end to measure against, so `fraction`,
   * `totalBytes` and `eta` stay undefined; `elapsedSec` and `bytes` say how far it got. Stop it with
   * `MediaDownloader.stop(id)` to keep it, `cancel(id)` to discard it.
   */
  readonly live?: boolean | undefined
  /** Seconds since the recording started (wall clock). */
  readonly elapsedSec?: number | undefined
  /** Bytes recorded so far (the same as `downloadedBytes`). */
  readonly bytes?: number | undefined
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
/** source-fallback: yt-dlp doesn't support the url — the source made for its host tries instead. */
export type AttemptStrategy =
  | 'primary'
  | 'fresh-extraction'
  | 'format-fallback'
  | 'extractor-fallback'
  | 'source-fallback'

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
  /**
   * Downloaded with its integrity check put off until its batch has finished
   * downloading (`validationTiming: 'after-batch'`); cleared once checked.
   */
  readonly validationPending?: boolean | undefined
  readonly error?: JobError | undefined
  readonly createdAt: number
  readonly startedAt?: number | undefined
  readonly finishedAt?: number | undefined
}

export type JobRequest = {
  /** http(s) page url. */
  readonly url: string
  readonly batchId?: BatchId | undefined
  /** The batch's name, recorded with the finished file (its history groups by it). */
  readonly batchTitle?: string | undefined
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
  /** What a photo post becomes (see SlideshowOptions). */
  readonly slideshow?: SlideshowOptions | undefined
  /**
   * Whether the media is a photo post (a TikTok slideshow), as its listing or
   * analysis says (`MediaSummary.slideshow`). A photo post kept as a folder is
   * archived under its own key (`archiveKey`), and this is how the job finds
   * it before downloading: the scheduler always sets it. Left out, the job
   * looks for the folder's key first and then the plain one.
   */
  readonly photoPost?: boolean | undefined
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
  /** Every download ended; the files are being checked (`validationTiming: 'after-batch'`). */
  | 'validating'
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
  /** Jobs that failed (not those cancelled: a cancel removes the item from the batch). */
  readonly failed: number
  /** Jobs the user cancelled: dropped from the batch, which goes on without them. */
  readonly cancelled: number
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
  /** A mix list: independent links of any sites in one batch (see `BatchRequest.mix`). */
  readonly mix?: boolean | undefined
  readonly title?: string | undefined
  /** Position among scheduled batches (1 = next), while scheduled. */
  readonly position?: number | undefined
  readonly preflight: {
    readonly total: number
    readonly checked: number
    readonly ok: number
    readonly unavailable: number
  }
  /**
   * Why items didn't make it, by cause (a FailureHint such as 'removed' or
   * 'private', else an ErrorCode such as 'network'): jobs that failed (or were
   * cancelled), and items the check found unavailable. Absent while nothing failed.
   */
  readonly problems?:
    | {
        readonly failed: Readonly<Record<string, number>>
        readonly unavailable: Readonly<Record<string, number>>
      }
    | undefined
  /** Disk and load forecast, set when the preflight ends. */
  readonly estimate?: BatchEstimate | undefined
  /**
   * While running: progress weighted by size, and the estimated seconds left,
   * measured from this machine's actual throughput (see `WorkMeter`).
   */
  readonly progress?: {readonly fraction: number; readonly etaSeconds?: number | undefined} | undefined
  /** While validating: files checked so far, of how many. */
  readonly validation?: {readonly done: number; readonly total: number} | undefined
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

/**
 * What a photo post (a TikTok slideshow) becomes with a video profile:
 * 'video' — an MP4 showing each image `secondsPerImage`, over its soundtrack;
 * 'images-audio' — a folder with the images and the soundtrack;
 * 'images' — a folder with the images. With an audio profile, only the soundtrack.
 */
export type SlideshowOptions = {
  readonly mode: 'video' | 'images-audio' | 'images'
  /** 1–30. Default 3. */
  readonly secondsPerImage: number
}

export type BatchRequest = {
  readonly url: string
  readonly profile: FormatProfile
  readonly outDir: string
  /** What photo posts become (see SlideshowOptions). Default: an MP4, 3 s per image. */
  readonly slideshow?: SlideshowOptions | undefined
  /**
   * A list's files go straight into `outDir`, named without a position
   * ("title-id"), instead of into a sub-folder named after the list with a
   * numbered prefix — for adding to an existing folder (a sync).
   */
  readonly flat?: boolean | undefined
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
  /**
   * Where single items go, by their `index` in `selection`: their own folder,
   * profile and list position — a batch gathering items of several batches
   * (failed downloads tried again together) keeps each where it belonged.
   */
  readonly targets?: readonly BatchTarget[] | undefined
  /**
   * How hard the batch tries before an item counts as failed. 'fast' (default):
   * each item is checked once before it downloads (its download still retries).
   * 'thorough': an item whose check fails in a way that may pass is checked up to
   * 3 times, each after a longer pause and another way in — slower, but more of the
   * list gets downloaded.
   */
  readonly retries?: 'fast' | 'thorough' | undefined
  /**
   * A mix list (`BatchScheduler.scheduleMix`): independent links of any sites
   * gathered in one batch. Its files go straight into `outDir`, named as single
   * downloads are; the flag travels to the snapshot for the apps to say so.
   */
  readonly mix?: boolean | undefined
}

export type BatchTarget = {
  /** The selection entry's index. */
  readonly index: number
  /** Absolute folder the file goes to (as is: no sub-folder is added). */
  readonly outDir: string
  readonly profile: FormatProfile
  /** Its list and position, for the file name ("NNN - title"). */
  readonly playlist?: PlaylistRef | undefined
  /**
   * The entry is a photo post, made this way (instead of the batch's
   * `slideshow`): a record downloaded again comes back as it was kept
   * (`ArchiveEntry.slideshow`).
   */
  readonly slideshow?: SlideshowOptions | undefined
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

// ─── Mix lists ──────────────────────────────────────────────────────────────
// Links of any sites pasted together → checked together (analyzeMix) → one
// batch (scheduleMix). Nothing new downloads them: the batch is a normal one.

/**
 * Why a link of a mix list is left out. Before any check: 'not-a-link',
 * 'duplicate' (the same link, or — once checked — the same media), 'too-many',
 * 'listing' (a playlist, channel or profile: it has a preview of its own).
 * From the check: 'unsupported' (no extractor reads the site here),
 * 'unavailable' (removed, geo-blocked, not started, no such format…),
 * 'private', 'needs-sign-in', 'damaged' (damaged at the source, see
 * `MediaDownloader.damaged`), 'error' (anything else; it may pass later).
 */
export type MixSkipReason =
  | MixPlanSkip
  | 'listing'
  | 'unsupported'
  | 'unavailable'
  | 'private'
  | 'needs-sign-in'
  | 'damaged'
  | 'error'

export type MixItem = {
  /** 1-based line of the pasted text the link was on. */
  readonly line: number
  /** The link to download: the media's own url when the check gave one, else the link as pasted. */
  readonly url: string
  readonly site: LinkSite
  /**
   * What the check found (title, duration, formats; its metadata is reused by
   * the download). Absent when the site asked to confirm this is not a bot:
   * the link is checked when it downloads, as in any batch.
   */
  readonly analysis?: VideoAnalysis | undefined
  /** Already downloaded with `MixAnalyzeOptions.profile` and still there: the batch skips it at no cost. */
  readonly archived?: boolean | undefined
}

export type MixSkipped = {
  readonly line: number
  /** The link, or the line's text (its first 200 characters) when it holds none. */
  readonly input: string
  readonly site?: LinkSite | undefined
  readonly reason: MixSkipReason
  /** 'duplicate': the line of the link (or media) it repeats. */
  readonly duplicateOf?: number | undefined
  /** What the check answered, for the apps to word by code and hint like any failure. */
  readonly error?: JobError | undefined
}

export type MixSummary = {
  /** Valid plus skipped. */
  readonly total: number
  readonly valid: number
  readonly skipped: number
  /** Valid links by site. */
  readonly bySite: Readonly<Partial<Record<LinkSite, number>>>
  /** Skipped links by reason. */
  readonly byReason: Readonly<Partial<Record<MixSkipReason, number>>>
}

export type MixAnalysis = {
  /** In the order pasted. */
  readonly valid: readonly MixItem[]
  /** In the order pasted. */
  readonly skipped: readonly MixSkipped[]
  readonly summary: MixSummary
}

export type MixProgress = {
  /** Links being checked on the network (after the local filtering). */
  readonly total: number
  readonly checked: number
}

export type MixAnalyzeOptions = {
  readonly signal?: AbortSignal | undefined
  /** The profile it will download in: marks the links already downloaded that way, and leaves out those with no stream of its kind. */
  readonly profile?: FormatProfile | undefined
  /** What photo posts become, for the "already downloaded" mark (their record carries it). Default an MP4. */
  readonly slideshow?: SlideshowOptions | undefined
  /** 'thorough': a check that fails in a way that may pass is tried up to 3 times (see `BatchRequest.retries`). */
  readonly retries?: 'fast' | 'thorough' | undefined
  /** Links taken at most (1–5000). Default 5000. */
  readonly maxLinks?: number | undefined
  /** After each link is checked: O(1), never more often than once per link. */
  readonly onProgress?: ((progress: MixProgress) => void) | undefined
}

/** How a mix list downloads: one batch, every file straight into `outDir`. */
export type MixRequest = {
  readonly profile: FormatProfile
  readonly outDir: string
  /** The batch's name (the apps put the date in it). Default "Mix list". */
  readonly title?: string | undefined
  readonly slideshow?: SlideshowOptions | undefined
  readonly retries?: 'fast' | 'thorough' | undefined
  /**
   * A format of its own for some links, by their url (`MixItem.url`): one song in
   * MP3 among videos, one video capped at 720p. The rest download in `profile`.
   * Same batch, same folder (each such link is a `BatchTarget`).
   */
  readonly formats?: Readonly<Record<string, FormatProfile>> | undefined
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
   * 'required' (default): yt-dlp, ffmpeg and ffprobe must all be there.
   * 'optional': a host without yt-dlp (a phone): links are read by the
   * built-in extractors only; where one would hand a link to yt-dlp, its own
   * reason comes back (hint 'retry-later' unless it has one), and anything
   * else that needs yt-dlp fails with 'binary-missing'.
   */
  readonly ytDlp?: YtDlpPolicy | undefined
  /**
   * Simultaneous jobs. Clamped to [1, ⌊logical CPUs / 2⌋] so the machine
   * stays responsive. Defaults to the maximum.
   */
  readonly concurrency?: number | undefined
  /**
   * Share of the logical processors the pool may use: 0.5 (default, ⌊CPUs/2⌋)
   * up to 0.6 (⌊CPUs × 0.6⌋), leaving the rest for the user. Live with `setMaxCpuShare`.
   */
  readonly maxCpuShare?: number | undefined
  /**
   * Parallel fragments inside one download (HLS/DASH sites): yt-dlp's --concurrent-fragments, and the
   * segments the native HLS downloader fetches at once (clamped to ⌊CPUs/2⌋). Network-bound. Default 3.
   */
  readonly fragmentsPerDownload?: number | undefined
  /** Default 'full'. */
  readonly validation?: ValidationLevel | undefined
  /**
   * When batch jobs are checked: 'during' (default) — each file before it is
   * finished; 'after-batch' — files are finished as they download and the
   * whole batch is checked once every download has ended (downloads run
   * back to back, the CPU-heavy checks come after). A file found broken is
   * marked damaged at the source and never downloaded again. Jobs outside a
   * batch are always checked during. Live with `setValidationTiming`.
   */
  readonly validationTiming?: ValidationTiming | undefined
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
   * Instagram through the built-in extractor (post pages and the web client's
   * API, paced; no yt-dlp): posts, reels, carousels, whole profiles, stories
   * and highlights. Stories and highlights need the user's signed-in session:
   * the browser cookies (`setCookiesFromBrowser`) or `cookiesFile`, unless the
   * host passes `cookies` itself. `false` hands Instagram urls to yt-dlp.
   */
  readonly instagram?: false | InstagramOptions | undefined
  /**
   * Facebook through the built-in extractor (video pages, paced; no yt-dlp):
   * videos, reels, posts with a video, a profile's or page's videos, stories
   * (signed-in session, as for Instagram). `false` hands Facebook urls to yt-dlp.
   */
  readonly facebook?: false | FacebookOptions | undefined
  /**
   * X (Twitter) videos through the built-in extractor (the public data X's
   * embedded posts read; anonymous, no yt-dlp): a post's video or GIF, a post
   * with several videos as a playlist, t.co short links. Profiles are not
   * read. `false` hands X urls to yt-dlp.
   */
  readonly x?: false | XOptions | undefined
  /**
   * VK video through the built-in extractor (VK's own video endpoint, paced;
   * anonymous, no yt-dlp): videos, clips, videos opened over a wall post,
   * embeds, vk.cc short links, albums and an owner's videos. `false` hands VK
   * urls to yt-dlp.
   */
  readonly vk?: false | VkOptions | undefined
  /**
   * Snapchat through the built-in extractor (the public web pages' own data,
   * paced; anonymous, no yt-dlp): spotlights, a public profile's live story,
   * highlights and spotlights (what its page embeds), one highlight, one story
   * snap, short links. Private accounts are shown in the app only. `false`
   * hands Snapchat urls to yt-dlp (which reads spotlights).
   */
  readonly snapchat?: false | SnapchatOptions | undefined
  /**
   * Threads through the built-in extractor (the web pages' own data and the
   * web client's listing query, paced; anonymous, or with the browser's
   * threads.com session for private accounts it follows): posts (video,
   * photo, carousel) and public profiles. yt-dlp has no Threads extractor:
   * `false` hands Threads urls to its generic extractor, which reads none.
   */
  readonly threads?: false | ThreadsOptions | undefined
  /**
   * Bluesky through the built-in extractor (the public AppView, anonymous;
   * every file the author's original blob from their own PDS, paced per
   * host): posts (pictures, galleries, video, quotes with media) and public
   * profiles. `false` hands Bluesky urls to yt-dlp's Bluesky extractor,
   * which reads posts only (no galleries, no profiles).
   */
  readonly bluesky?: false | BlueskyOptions | undefined
  /**
   * Twitch through the built-in extractor (plain GraphQL queries on
   * gql.twitch.tv, anonymous): clips (each a signed progressive MP4), a
   * channel's clips (`/<channel>/clips?range=…`), VODs (archives, highlights,
   * uploads: HLS, downloaded by the core) and a channel's videos
   * (`/<channel>/videos?filter=…&sort=…`). A channel on the air (its link,
   * `twitch.tv/<channel>`) is recorded by the core's live recorder until
   * `stop` (kept) or `cancel` (discarded), ads left out, 12 h at most
   * (`twitch.live`); a VOD still recording fails as `live-now`. Nothing live
   * is ever handed to yt-dlp. `false` hands every Twitch url to yt-dlp, live
   * ones included.
   */
  readonly twitch?: false | TwitchOptions | undefined
  /**
   * Links straight to a media file (`…/clip.mp4`, `…/song.mp3`) on any other
   * site, read natively (one ranged request, then the file): extractor "Web".
   * `false` hands them to yt-dlp.
   */
  readonly direct?: false | DirectOptions | undefined
  /**
   * YouTube when it asks to confirm this is not a bot. Requests go a second
   * apart; a bot check climbs a ladder only as far as needed: PO tokens from
   * `attestation` (educational — see the README, "YouTube: attestation"),
   * then a hold for the user (`askUser`: sign in with `setYouTubeAccount`, or
   * `waitOutYouTube`), else pauses that grow 5 → 60 min.
   */
  readonly youtube?:
    | {
        /** The pace (for tests). */
        readonly pacing?:
          | {
              readonly spacingMs?: number | undefined
              readonly jitterMs?: number | undefined
              readonly backoffMs?: number | undefined
              readonly maxBackoffMs?: number | undefined
            }
          | undefined
        /** Ways to pass YouTube's attestation, best first (the desktop app: its own hidden Chromium). */
        readonly attestation?: readonly AttestationStrategy[] | undefined
        readonly attestationOptions?: AttestationOptions | undefined
        /** Waits before the retries with tokens; their count is the retries. Default 15 s, 90 s, 5 min. */
        readonly attestedDelaysMs?: readonly number[] | undefined
        /**
         * The host can ask the user: after the retries with tokens, YouTube
         * requests are held (not failed) until it calls `setYouTubeAccount` or
         * `waitOutYouTube`. Listen to the 'youtube' event.
         */
        readonly askUser?: boolean | undefined
        /**
         * 'after-refusal' (default): PO tokens only once YouTube has refused
         * this connection. 'always': from the first request (a health check, or
         * a connection YouTube is known to refuse).
         */
        readonly tokens?: 'after-refusal' | 'always' | undefined
      }
    | undefined
  /**
   * More sites read natively, supplied by the host (e.g. a `PlayerPageSource`
   * per site the user configured). Asked after the built-in ones.
   */
  readonly sources?: readonly MediaSource[] | undefined
  /**
   * For an http(s) url yt-dlp doesn't support ("Unsupported URL"): a native
   * source made for that url's host (e.g. a `PlayerPageSource` for it), tried
   * instead of failing. No site is named anywhere — any host may be tried.
   * Once it reads something there, it reads that host's urls from then on.
   * Return undefined to leave the url unsupported.
   */
  readonly unsupportedUrlSource?: ((url: URL) => MediaSource | undefined) | undefined
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
  /** How YouTube is reached changed: a bot check paused it, tokens came on, it is held for the user… */
  youtube: [access: YouTubeAccess]
}
