import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {type Executable, invoke} from '../binaries/executable.js'
import type {AnalysisResult, JobError, MediaSummary, PlaylistAnalysis, PlaylistEntry, VideoAnalysis} from '../types.js'
import {toArgv} from './argv.js'
import {cancelledError, classifyYtDlpError, DownloadError} from './errors.js'
import {shortHash} from './files.js'
import {genericChoices, planChoices, type RawFormat} from './formats.js'

type RawInfo = {
  readonly _type?: 'video' | 'playlist' | 'multi_video' | 'url' | 'url_transparent'
  readonly id?: string
  readonly title?: string
  readonly fulltitle?: string
  readonly url?: string
  readonly webpage_url?: string
  readonly original_url?: string
  readonly uploader?: string
  readonly channel?: string
  readonly playlist_uploader?: string
  readonly duration?: number | null
  readonly thumbnail?: string
  readonly thumbnails?: ReadonlyArray<{readonly url: string}>
  readonly extractor_key?: string
  readonly ie_key?: string
  readonly live_status?: string
  readonly is_live?: boolean
  readonly formats?: readonly RawFormat[]
  readonly entries?: ReadonlyArray<RawInfo | null>
}

export type AnalyzeOptions = {
  readonly ytDlp: Executable
  readonly env: NodeJS.ProcessEnv
  /** Where a single video's metadata is cached for the download step. */
  readonly cacheDir: string
  /** Cookie / runtime / network arguments shared with downloads. */
  readonly commonArgs: readonly string[]
  readonly signal?: AbortSignal | undefined
  /** Stop listing after this many entries (mixes and channels can be endless). Default 5000. */
  readonly maxEntries?: number | undefined
}

const MAX_NESTING = 2

/** Only http(s) urls reach yt-dlp — anything else could be read as an option or a local path. */
export function assertHttpUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new DownloadError('invalid-request', 'Not a valid url.', undefined, {url: value})
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError('invalid-request', 'Only http and https urls are supported.', undefined, {url: value})
  }
  return url.href
}

function summarize(info: RawInfo, fallbackUrl: string): MediaSummary {
  return {
    id: info.id ?? shortHash(fallbackUrl),
    url: info.webpage_url ?? info.url ?? info.original_url ?? fallbackUrl,
    title: info.title ?? info.fulltitle ?? info.id ?? 'Untitled',
    uploader: info.uploader ?? info.channel,
    duration: info.duration ?? undefined,
    thumbnail: info.thumbnail ?? info.thumbnails?.at(-1)?.url,
    extractor: info.extractor_key ?? info.ie_key ?? 'Generic',
    isLive: info.is_live === true || info.live_status === 'is_live',
  }
}

async function dumpJson(url: string, opts: AnalyzeOptions): Promise<{info: RawInfo; raw: string}> {
  const options = toArgv([
    ['--dump-single-json'],
    ['--flat-playlist'],
    ['--yes-playlist'],
    ['--no-warnings'],
    ['--playlist-end', String(opts.maxEntries ?? MAX_LISTED_ITEMS)],
  ])
  const argv = [...options, ...opts.commonArgs, '--', url]
  const result = await invoke(opts.ytDlp, argv, {signal: opts.signal, env: opts.env})
  if (result.aborted) throw cancelledError()
  if (result.outputLimitExceeded) throw new DownloadError('unknown', 'The metadata returned by the site is too large.')
  if (result.code !== 0) throw classifyYtDlpError(result.stderr, result.code)
  try {
    return {info: JSON.parse(result.stdout) as RawInfo, raw: result.stdout}
  } catch {
    throw new DownloadError('unknown', 'yt-dlp returned unreadable metadata.')
  }
}

/** youtube.com/watch?v=X&list=Y → the single-video url, so a UI can offer "just this video". */
function singleVideoUrl(url: string): string | undefined {
  const u = new URL(url)
  const v = u.searchParams.get('v')
  if (v && u.searchParams.has('list') && /(^|\.)youtube\.com$/.test(u.hostname)) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`
  }
  return undefined
}

/** Entries taken from a YouTube Mix unless the caller says otherwise. */
export const MIX_DEFAULT_ITEMS = 50
/** Default bound of a listing: channels and mixes can be practically endless. */
export const MAX_LISTED_ITEMS = 5000
/** Most items a caller may ask for explicitly (a whole TikTok profile can hold tens of thousands). */
export const MAX_REQUESTED_ITEMS = 50_000

/** youtube.com (www, m, music), youtu.be and youtube-nocookie.com urls. */
export function isYouTubeUrl(url: string): boolean {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * A YouTube Mix ("list=RD…"): a radio YouTube generates on the fly from one
 * video. yt-dlp keeps paginating it into the thousands, so batches cap it.
 */
export function isYouTubeMix(url: string): boolean {
  try {
    const u = new URL(url)
    return /(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname) && /^RD/.test(u.searchParams.get('list') ?? '')
  } catch {
    return false
  }
}

/**
 * A YouTube link to a list rather than a video: a playlist, a channel (any
 * tab). A video link inside a list (watch?v=…&list=…) is a video; youtu.be
 * always is. O(length).
 */
export function isYouTubeListing(url: string): boolean {
  try {
    const u = new URL(url)
    if (!/(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(u.hostname) || u.searchParams.has('v')) return false
    return (
      u.pathname === '/playlist' ||
      (u.pathname === '/watch' && u.searchParams.has('list')) ||
      /^\/(@[^/]+|channel\/|c\/|user\/)/.test(u.pathname)
    )
  } catch {
    return false
  }
}

/** Channel urls list their tabs (Videos, Shorts, Live) as nested playlists. */
const isNestedPlaylist = (entry: RawInfo) =>
  entry._type === 'playlist' || (entry._type === 'url' && /Tab$/.test(entry.ie_key ?? ''))

const isHttp = (url: string) => url.startsWith('https://') || url.startsWith('http://')

/**
 * Inspect a url. One yt-dlp call answers both questions: `--flat-playlist`
 * lists playlist entries without extracting each one (seconds instead of
 * minutes for long lists) and still returns full formats for a single video.
 */
export async function analyze(rawUrl: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
  return analyzeUrl(assertHttpUrl(rawUrl), opts, 0)
}

async function analyzeUrl(url: string, opts: AnalyzeOptions, depth: number): Promise<AnalysisResult> {
  const {info, raw} = await dumpJson(url, opts)

  if (info._type === 'playlist' || info._type === 'multi_video') {
    const entries: PlaylistEntry[] = []
    for (const entry of info.entries ?? []) {
      if (!entry) continue // deleted / private items appear as null
      const entryUrl = entry.url ?? entry.webpage_url ?? ''
      if (isNestedPlaylist(entry) && depth < MAX_NESTING && isHttp(entryUrl)) {
        const nested = await analyzeUrl(entryUrl, opts, depth + 1)
        const items = nested.kind === 'playlist' ? nested.entries : [nested.media]
        for (const item of items) entries.push({...item, index: entries.length + 1})
        if (nested.kind === 'video' && nested.infoJsonPath) await fs.rm(nested.infoJsonPath, {force: true})
        continue
      }
      const summary = summarize(entry, url)
      if (isHttp(summary.url)) entries.push({...summary, index: entries.length + 1})
    }
    const playlist: PlaylistAnalysis = {
      kind: 'playlist',
      id: info.id ?? shortHash(url),
      url,
      title: info.title ?? 'Playlist',
      uploader: info.playlist_uploader ?? info.uploader ?? info.channel,
      extractor: info.extractor_key ?? 'Generic',
      entries,
      choices: genericChoices(),
      singleVideoUrl: singleVideoUrl(url),
    }
    return playlist
  }

  await fs.mkdir(opts.cacheDir, {recursive: true})
  const infoJsonPath = path.join(opts.cacheDir, `info-${shortHash(url)}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, raw)
  const media = summarize(info, url)
  const choices = planChoices(info.formats ?? [], info.duration ?? undefined)
  return {kind: 'video', media, choices, infoJsonPath} satisfies VideoAnalysis
}

export type ExtractResult =
  | {readonly ok: true; readonly analysis: VideoAnalysis}
  | {readonly ok: false; readonly error: JobError}

export type ExtractManyOptions = AnalyzeOptions & {
  /** Called as soon as each url resolves — results stream in while the chunk runs. */
  readonly onResult?: ((url: string, result: ExtractResult) => void) | undefined
  /** Whether to keep the metadata of this url on disk for its download (default: yes). */
  readonly keepMetadata?: ((url: string) => boolean) | undefined
}

const ERROR_LINE = /^ERROR:\s*\[[^\]]+\]\s*([^\s:]+):\s*(.*)$/
const UNSUPPORTED_LINE = /^ERROR:\s*Unsupported URL:\s*(\S+)/i

/**
 * Extract many single videos with ONE yt-dlp process (`-j`: one JSON line
 * per url). Python's start-up is paid once per chunk instead of once per url
 * — measured 7.7 s vs 14.1 s for 6 YouTube urls. `--ignore-errors` keeps going
 * past failures; every success and every error is matched back to its url
 * (by original_url / id), and each JSON line is written to disk as is.
 */
export async function extractMany(
  items: ReadonlyArray<{readonly url: string; readonly id?: string | undefined}>,
  opts: ExtractManyOptions,
): Promise<Map<string, ExtractResult>> {
  const results = new Map<string, ExtractResult>()
  const byUrl = new Map(items.map(item => [item.url, item]))
  const byId = new Map(items.filter(item => item.id).map(item => [item.id!, item.url]))
  const settle = (url: string, result: ExtractResult) => {
    if (results.has(url)) return
    results.set(url, result)
    opts.onResult?.(url, result)
  }
  await fs.mkdir(opts.cacheDir, {recursive: true})
  const writes: Promise<void>[] = []

  const argv = [
    ...toArgv([['--dump-json'], ['--no-playlist'], ['--ignore-errors'], ['--no-warnings']]),
    ...opts.commonArgs,
    '--',
    ...items.map(item => item.url),
  ]
  const run = await invoke(opts.ytDlp, argv, {
    signal: opts.signal,
    env: opts.env,
    collectStdout: false,
    stderrTail: 256 * 1024,
    onStdoutLine: line => {
      let info: RawInfo & {readonly original_url?: string}
      try {
        info = JSON.parse(line) as RawInfo & {readonly original_url?: string}
      } catch {
        return
      }
      const url =
        [info.original_url, info.webpage_url].find(u => u !== undefined && byUrl.has(u)) ??
        (info.id ? byId.get(info.id) : undefined)
      if (!url) return
      const keep = opts.keepMetadata?.(url) ?? true
      const infoJsonPath = keep ? path.join(opts.cacheDir, `info-${shortHash(url)}-${Date.now()}.json`) : undefined
      // the metadata cache only saves the download an extraction: a write that fails (a shutdown
      // removing the cache mid-run) leaves the job to extract again, and must not fail the
      // chunk — nor reject unobserved when the run itself ends in an error before the writes are awaited
      if (infoJsonPath) writes.push(fs.writeFile(infoJsonPath, line).catch(() => {}))
      settle(url, {
        ok: true,
        analysis: {
          kind: 'video',
          media: summarize(info, url),
          choices: planChoices(info.formats ?? [], info.duration ?? undefined),
          infoJsonPath,
        },
      })
    },
  })
  await Promise.all(writes)

  if (run.aborted) {
    for (const item of items) settle(item.url, {ok: false, error: cancelledError().toJSON()})
    return results
  }

  // failures: "ERROR: [extractor] <id>: <message>" — matched by id, else in order
  const unmatchedErrors: JobError[] = []
  for (const line of run.stderr.split('\n')) {
    // "ERROR: Unsupported URL: <url>" names the url itself, not an id
    const unsupported = UNSUPPORTED_LINE.exec(line.trim())?.[1]
    if (unsupported && byUrl.has(unsupported) && !results.has(unsupported)) {
      settle(unsupported, {ok: false, error: classifyYtDlpError(line, 1).toJSON()})
      continue
    }
    const match = ERROR_LINE.exec(line.trim())
    if (!match) continue
    const error = classifyYtDlpError(line, 1).toJSON()
    const url = byId.get(match[1]!)
    if (url && !results.has(url)) settle(url, {ok: false, error})
    else unmatchedErrors.push(error)
  }
  const unresolved = items.filter(item => !results.has(item.url))
  const fallback =
    run.code !== 0 && unresolved.length > 0 ? classifyYtDlpError(run.stderr, run.code).toJSON() : undefined
  unresolved.forEach((item, i) => {
    const error = unmatchedErrors.length === unresolved.length ? unmatchedErrors[i]! : fallback
    settle(item.url, {ok: false, error: error ?? {code: 'unknown', message: 'yt-dlp returned nothing for this url.'}})
  })
  return results
}
