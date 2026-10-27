import type {Executable} from '../binaries/executable.js'
import type {ExtractResult} from '../core/analyze.js'
import type {MediaTags} from '../core/convert.js'
import type {DownloadedInfo} from '../core/download.js'
import type {
  AnalysisResult,
  FormatProfile,
  JobProgress,
  MediaSummary,
  RecordingSummary,
  SlideshowOptions,
} from '../types.js'

/**
 * A site the engine talks to natively, instead of through yt-dlp. A source
 * answers the same three questions yt-dlp does — what is at this url, is each
 * item downloadable, give me the file — and the engine keeps everything else:
 * the ⌊CPUs/2⌋ pool, retries, conversion, integrity checks, naming, archive.
 */
export interface MediaSource {
  /** Also the `extractor` recorded in the archive. */
  readonly name: string
  /**
   * False while the site is blocking this source (a verification page): the
   * engine sends its urls to yt-dlp meanwhile instead of knocking again.
   */
  readonly available: boolean
  handles(url: string): boolean
  /**
   * How many entries a listing at `url` loads unless the caller asks for a
   * number (a whole profile or search can run into thousands). Undefined:
   * not a listing, or no default.
   */
  defaultListSize?(url: string): number | undefined
  analyze(
    url: string,
    opts: {
      readonly signal?: AbortSignal
      readonly maxEntries?: number
      /** Listing progress of a long list: entries read so far, of how many expected. */
      readonly onProgress?: (progress: ListingProgress) => void
      /** Entry ids already had: a source that can, lists only what is newer (an incremental sync). */
      readonly known?: ReadonlySet<string>
      /**
       * Which try of the engine's analysis this is (1-based; see MediaDownloader.analyze):
       * a source may go another way on a later one (Instagram: the user's session first on the third).
       */
      readonly attempt?: number
    },
  ): Promise<AnalysisResult>
  /** Check many items (preflight); results stream through `onResult`. */
  preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {
      readonly signal?: AbortSignal | undefined
      readonly onResult?: ((url: string, result: ExtractResult) => void) | undefined
      /** Which check of the engine's this is (1-based): a source may go another way on a later one. */
      readonly attempt?: number | undefined
    },
  ): Promise<Map<string, ExtractResult>>
  /** Fetch the media for `profile` into `workDir`; the engine converts / extracts / validates it. */
  download(task: SourceDownload): Promise<SourceFile>
  /**
   * A live stream's signed master playlist, for a host's own player (MediaDownloader.livePlayback):
   * built, never fetched. Undefined when the url is not a live channel or it is off the air. Only
   * sources with live streams implement it.
   */
  livePlayback?(
    url: string,
    opts?: {readonly signal?: AbortSignal | undefined; readonly fresh?: boolean | undefined},
  ): Promise<LivePlayback | undefined>
}

/** A live stream as a player opens it: its signed master playlist and what is on the air. */
export type LivePlayback = {
  /** The master playlist (H.264 variants), signed for this viewer; a player fetches it and its variants. */
  readonly url: string
  /** When the signature runs out (ms, less a margin): ask again before it (`fresh`). */
  readonly expiresAt?: number | undefined
  /** The broadcast (`isLive: true`), as an analysis of the channel describes it. */
  readonly media: MediaSummary
}

export type ListingProgress = {readonly listed: number; readonly expected?: number | undefined}

/** `details` of the error a native source raises when the site changed under it: the engine retries with yt-dlp. */
export const SOURCE_FORMAT_CHANGED = 'source:format-changed'
/** `details` when the site demands a verification the source won't solve: yt-dlp takes over too. */
export const SOURCE_BLOCKED = 'source:blocked'

/** Errors after which the same request should go through yt-dlp instead. */
export function needsFallback(details: string | undefined): boolean {
  return details === SOURCE_FORMAT_CHANGED || details === SOURCE_BLOCKED
}

export type SourceDownload = {
  readonly url: string
  readonly profile: FormatProfile
  readonly workDir: string
  readonly signal: AbortSignal
  /**
   * Stop (`MediaDownloader.stop`): a live recording ends and hands over what it recorded, which the
   * engine finalizes as any download (`signal` instead cancels and discards). Sources that only
   * download what already exists ignore it.
   */
  readonly stop?: AbortSignal | undefined
  /** A previous attempt failed: don't trust cached links. */
  readonly fresh: boolean
  /** Whether a downloaded file carries sound (ffprobe), to skip silent encodings. */
  readonly hasAudio: (file: string) => Promise<boolean>
  /** For sources that assemble media themselves (a slideshow video). */
  readonly ffmpeg: Executable
  /** Encoder threads: this job's share of the CPU budget. */
  readonly threads: number
  /**
   * Segments of one HLS download fetched at once (the engine's `fragmentsPerDownload`, default 3;
   * `core/hls` clamps it to ⌊CPUs/2⌋). A source passes it on instead of reading engine settings.
   */
  readonly fragments: number
  /** What a photo post becomes. */
  readonly slideshow: SlideshowOptions
  readonly onInfo: (info: DownloadedInfo) => void
  readonly onProgress: (progress: JobProgress) => void
}

export type SourceFile = {
  /** The finished media — or, with `bundle`, a folder of finished files (a slideshow's images). */
  readonly filepath: string
  /** A folder of files ready as they are: no conversion; each file is checked, the folder moved into place. */
  readonly bundle?: boolean | undefined
  readonly info: DownloadedInfo
  /**
   * Tags the engine writes into the finished file (a stream copy). Left out,
   * a file already in the requested format is kept exactly as downloaded:
   * only validated.
   */
  readonly tags?: MediaTags | undefined
  /** A live recording: how it ended and what it left out (logged by the engine). */
  readonly recording?: RecordingSummary | undefined
}

export type {RecordingSummary}
