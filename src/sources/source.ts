import type {Executable} from '../binaries/executable.js'
import type {ExtractResult} from '../core/analyze.js'
import type {MediaTags} from '../core/convert.js'
import type {DownloadedInfo} from '../core/download.js'
import type {AnalysisResult, FormatProfile, JobProgress, SlideshowOptions} from '../types.js'

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
    },
  ): Promise<AnalysisResult>
  /** Check many items (preflight); results stream through `onResult`. */
  preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {
      readonly signal?: AbortSignal | undefined
      readonly onResult?: ((url: string, result: ExtractResult) => void) | undefined
    },
  ): Promise<Map<string, ExtractResult>>
  /** Fetch the media for `profile` into `workDir`; the engine converts / extracts / validates it. */
  download(task: SourceDownload): Promise<SourceFile>
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
  /** A previous attempt failed: don't trust cached links. */
  readonly fresh: boolean
  /** Whether a downloaded file carries sound (ffprobe), to skip silent encodings. */
  readonly hasAudio: (file: string) => Promise<boolean>
  /** For sources that assemble media themselves (a slideshow video). */
  readonly ffmpeg: Executable
  /** Encoder threads: this job's share of the CPU budget. */
  readonly threads: number
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
}
