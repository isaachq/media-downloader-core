import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {AnalysisResult, MediaSummary, PlaylistAnalysis, PlaylistEntry, VideoAnalysis} from '../types.js'
import {toArgv} from './argv.js'
import {cancelledError, classifyYtDlpError, DownloadError} from './errors.js'
import {shortHash} from './files.js'
import {genericChoices, planChoices, type RawFormat} from './formats.js'
import {run} from './process.js'

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
  readonly ytDlp: string
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
    ['--playlist-end', String(opts.maxEntries ?? 5000)],
  ])
  const argv = [...options, ...opts.commonArgs, '--', url]
  const result = await run(opts.ytDlp, argv, {signal: opts.signal, env: opts.env})
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
  const choices = planChoices(info.formats ?? [])
  return {kind: 'video', media, choices, infoJsonPath} satisfies VideoAnalysis
}
