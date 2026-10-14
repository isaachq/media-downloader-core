import * as path from 'node:path'
import {binaryPath, type Executable, invoke} from '../binaries/executable.js'
import type {FormatProfile, JobProgress} from '../types.js'
import {type OptionList, toArgv} from './argv.js'
import {cancelledError, classifyYtDlpError, DownloadError} from './errors.js'
import {profileOptions} from './formats.js'

// Machine-readable stdout lines. `%(field|null)j` emits valid JSON even when
// a field is missing (a plain `%(field)j` prints a bare NA).
const PROGRESS = '__MDC_PROGRESS__'
const POSTPROCESS = '__MDC_POST__'
const INFO = '__MDC_INFO__'
const DONE = '__MDC_DONE__'

const PROGRESS_TEMPLATE =
  `download:${PROGRESS}{"status":%(progress.status|null)j,"downloaded":%(progress.downloaded_bytes|null)j,` +
  `"total":%(progress.total_bytes|null)j,"estimate":%(progress.total_bytes_estimate|null)j,` +
  `"speed":%(progress.speed|null)j,"eta":%(progress.eta|null)j,"fragment":%(progress.fragment_index|null)j,` +
  `"fragments":%(progress.fragment_count|null)j,"file":%(progress.filename|null)j}`

const POSTPROCESS_TEMPLATE = `postprocess:${POSTPROCESS}{"status":%(progress.status|null)j,"name":%(progress.postprocessor|null)j}`

// the "video" stage runs after format selection, before downloading
const INFO_TEMPLATE =
  `video:${INFO}{"id":%(id|null)j,"title":%(title|null)j,"duration":%(duration|null)j,` +
  `"extractor":%(extractor_key|null)j,"formatId":%(format_id|null)j,"vcodec":%(vcodec|null)j,` +
  `"acodec":%(acodec|null)j,"filesize":%(filesize,filesize_approx|null)j,` +
  `"publishedAt":%(timestamp,release_timestamp|null)j,"uploadDate":%(upload_date,release_date|null)j,` +
  `"partSizes":%(requested_formats.:.filesize|null)j,"partSizesApprox":%(requested_formats.:.filesize_approx|null)j}`

const DONE_TEMPLATE = `after_move:${DONE}{"filepath":%(filepath|null)j}`

/** Seconds between progress lines: plenty for a UI, a fraction of the default output volume. */
const PROGRESS_DELTA = '0.25'

export type DownloadedInfo = {
  readonly id?: string | null
  readonly title?: string | null
  readonly duration?: number | null
  readonly extractor?: string | null
  readonly formatId?: string | null
  readonly vcodec?: string | null
  readonly acodec?: string | null
  readonly filesize?: number | null
  readonly partSizes?: ReadonlyArray<number | null> | null
  readonly partSizesApprox?: ReadonlyArray<number | null> | null
  /** When the media was published, unix seconds (the finished file gets it as its date). */
  readonly publishedAt?: number | null
  /** yt-dlp's YYYYMMDD, for sites that give a day but no time. */
  readonly uploadDate?: string | null
}

type RawProgress = {
  readonly status?: string | null
  readonly downloaded?: number | null
  readonly total?: number | null
  readonly estimate?: number | null
  readonly speed?: number | null
  readonly eta?: number | null
  readonly fragment?: number | null
  readonly fragments?: number | null
  readonly file?: string | null
}

export type YtDlpRunOptions = {
  readonly ytDlp: Executable
  readonly ffmpeg: Executable
  readonly env: NodeJS.ProcessEnv
  /** Page url; ignored for extraction when `infoJsonPath` is given. */
  readonly url: string
  readonly infoJsonPath?: string | undefined
  readonly profile: FormatProfile
  /** The job's private folder — yt-dlp never writes into the user's folder. */
  readonly workDir: string
  readonly fragments: number
  readonly commonArgs: readonly string[]
  readonly embedMetadata: boolean
  readonly embedThumbnail: boolean
  readonly extraArgs: readonly string[]
  /** Abort the attempt after this long without output while downloading. 0 = never. */
  readonly stallTimeoutMs?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly onInfo?: ((info: DownloadedInfo) => void) | undefined
  readonly onProgress?: ((progress: JobProgress) => void) | undefined
  readonly onPostprocess?: ((name: string) => void) | undefined
}

export function buildYtDlpArgs(opts: YtDlpRunOptions): string[] {
  const ffmpegLocation = binaryPath(opts.ffmpeg)
  const options: OptionList = [
    ...profileOptions(opts.profile),
    ['--no-playlist'],
    ['--quiet'],
    ['--no-warnings'],
    ['--newline'],
    ['--progress'],
    ['--progress-delta', PROGRESS_DELTA],
    ['--progress-template', PROGRESS_TEMPLATE],
    ['--progress-template', POSTPROCESS_TEMPLATE],
    ['--print', INFO_TEMPLATE],
    ['--print', DONE_TEMPLATE],
    ['--no-simulate'],
    ['--concurrent-fragments', String(Math.max(1, opts.fragments))],
    ['--retries', '10'],
    ['--fragment-retries', '10'],
    ['--retry-sleep', 'exp=1:20'],
    ['--continue'],
    ['--no-mtime'],
    // names valid on both macOS and Windows, so a backup can move between them
    ['--windows-filenames'],
    ['--encoding', 'utf-8'],
    ['--paths', `home:${opts.workDir}`],
    ['--paths', `temp:${path.join(opts.workDir, 'parts')}`],
    ['--output', '%(title).150B [%(id)s].%(ext)s'],
    // without a real path (PATH name, wrapped command) yt-dlp finds ffmpeg itself
    ffmpegLocation !== undefined && ['--ffmpeg-location', ffmpegLocation],
    opts.embedMetadata && ['--embed-metadata'],
    opts.embedThumbnail && ['--embed-thumbnail'],
    opts.embedThumbnail && ['--convert-thumbnails', 'jpg'],
  ]
  // the source goes last, after "--", so it can never be parsed as an option
  const source = opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : ['--', opts.url]
  return [...toArgv(options), ...opts.commonArgs, ...opts.extraArgs, ...source]
}

type PartState = {downloaded: number; total: number | undefined}

/**
 * Turns per-file progress into one job-level fraction. yt-dlp downloads
 * video and audio as separate files one after the other; weighting by bytes
 * keeps the bar moving forward instead of jumping back to 0 for the audio.
 */
/**
 * Turns per-file progress into one job-level fraction. yt-dlp downloads
 * video and audio as separate files one after the other; weighting by bytes
 * keeps the bar moving forward instead of jumping back to 0 for the audio.
 */
export class ProgressTracker {
  readonly #parts = new Map<string, PartState>()
  readonly #partIndices = new Map<string, number>()
  readonly #order: string[] = []
  #estimates: Array<number | undefined> = []

  /**
   * Sets byte estimates for each part from metadata.
   *
   * Time Complexity: O(C) where C is part count (typically 1-3).
   * Space Complexity: O(C) storage.
   */
  setEstimates(info: DownloadedInfo): void {
    const exact = info.partSizes ?? []
    const approx = info.partSizesApprox ?? []
    const count = Math.max(exact.length, approx.length, info.formatId?.split('+').length ?? 1)
    this.#estimates = Array.from({length: count}, (_, i) => exact[i] ?? approx[i] ?? undefined)
    if (count === 1 && this.#estimates[0] === undefined) this.#estimates[0] = info.filesize ?? undefined
  }

  get totalParts(): number {
    return Math.max(1, this.#estimates.length, this.#order.length)
  }

  /**
   * Processes a raw progress event from yt-dlp.
   *
   * Time Complexity: O(P) where P <= 3 is the small fixed parts count. Part index lookup is O(1).
   * Space Complexity: O(1) job progress object allocation.
   */
  update(raw: RawProgress): JobProgress {
    const key = raw.file ?? '?'
    let part = this.#parts.get(key)
    if (!part) {
      part = {downloaded: 0, total: undefined}
      this.#parts.set(key, part)
      this.#order.push(key)
      this.#partIndices.set(key, this.#order.length)
    }
    part.downloaded = raw.downloaded ?? part.downloaded
    part.total = raw.total ?? raw.estimate ?? part.total

    let downloaded = 0
    let total = 0
    let known = true
    for (let i = 0; i < this.totalParts; i++) {
      const name = this.#order[i]
      const state = name === undefined ? undefined : this.#parts.get(name)
      const size = state?.total ?? this.#estimates[i]
      if (!size) known = false
      total += size ?? 0
      downloaded += state?.downloaded ?? 0
    }

    const partFraction = part.total ? part.downloaded / part.total : undefined
    return {
      fraction: known && total > 0 ? Math.min(1, downloaded / total) : partFraction,
      downloadedBytes: downloaded,
      totalBytes: known && total > 0 ? total : undefined,
      speed: raw.speed ?? undefined,
      eta: raw.eta ?? undefined,
      part: this.#partIndices.get(key) ?? 1,
      totalParts: this.totalParts,
      fragmentIndex: raw.fragment ?? undefined,
      fragmentCount: raw.fragments ?? undefined,
    }
  }
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/**
 * Kills an attempt that stops making progress. Re-armed by every line yt-dlp
 * prints; one timer per download, so the cost is O(1) per line.
 */
class StallWatchdog {
  readonly #controller = new AbortController()
  readonly #onParentAbort = () => this.#controller.abort()
  #timer: NodeJS.Timeout | undefined
  stalled = false

  constructor(
    private readonly timeoutMs: number,
    private readonly parent?: AbortSignal | undefined,
  ) {
    // a signal aborted already never fires 'abort' again: a cancel that came first must count too
    if (parent?.aborted) this.#controller.abort()
    else parent?.addEventListener('abort', this.#onParentAbort, {once: true})
    this.feed()
  }

  /** Aborts on a stall or when the caller aborts. */
  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /**
   * Re-arms the stall timer on each line of output.
   *
   * Time Complexity: O(1).
   * Space Complexity: O(1).
   */
  feed(): void {
    if (this.timeoutMs <= 0) return
    if (this.#timer) this.#timer.refresh()
    else {
      this.#timer = setTimeout(() => {
        this.stalled = true
        this.#controller.abort()
      }, this.timeoutMs)
      this.#timer.unref()
    }
  }

  /** Stop watching (post-processing can be legitimately silent for minutes). */
  pause(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  dispose(): void {
    this.pause()
    this.parent?.removeEventListener('abort', this.#onParentAbort)
  }
}

export async function runYtDlp(opts: YtDlpRunOptions): Promise<{filepath: string; info: DownloadedInfo}> {
  const tracker = new ProgressTracker()
  const watchdog = new StallWatchdog(opts.stallTimeoutMs ?? 0, opts.signal)
  let info: DownloadedInfo = {}
  let filepath: string | undefined
  let postprocessing = false

  const result = await invoke(opts.ytDlp, buildYtDlpArgs(opts), {
    signal: watchdog.signal,
    env: opts.env,
    collectStdout: false, // everything we need arrives line by line
    onStdoutLine: line => {
      if (!postprocessing) watchdog.feed()
      if (line.startsWith(PROGRESS)) {
        const raw = parseJson<RawProgress>(line.slice(PROGRESS.length))
        if (raw && raw.status !== 'finished') opts.onProgress?.(tracker.update(raw))
      } else if (line.startsWith(POSTPROCESS)) {
        const raw = parseJson<{status?: string; name?: string}>(line.slice(POSTPROCESS.length))
        if (raw?.status === 'started' && raw.name && raw.name !== 'MoveFiles') {
          postprocessing = true
          watchdog.pause()
          opts.onPostprocess?.(raw.name)
        }
      } else if (line.startsWith(INFO)) {
        info = parseJson<DownloadedInfo>(line.slice(INFO.length)) ?? {}
        tracker.setEstimates(info)
        opts.onInfo?.(info)
      } else if (line.startsWith(DONE)) {
        filepath = parseJson<{filepath?: string | null}>(line.slice(DONE.length))?.filepath ?? undefined
      }
    },
  }).finally(() => watchdog.dispose())

  if (watchdog.stalled) {
    const seconds = Math.round((opts.stallTimeoutMs ?? 0) / 1000)
    throw new DownloadError('network', `No download activity for ${seconds}s — stalled.`, undefined, {seconds})
  }
  if (result.aborted) throw cancelledError()
  if (result.code !== 0) throw classifyYtDlpError(result.stderr, result.code)
  if (!filepath)
    throw new DownloadError('unknown', 'yt-dlp finished without producing a file.', result.stderr.slice(-2000))
  return {filepath: path.resolve(opts.workDir, filepath), info}
}
