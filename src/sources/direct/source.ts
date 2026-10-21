import * as path from 'node:path'
import type {ExtractResult} from '../../core/analyze.js'
import {DownloadError} from '../../core/errors.js'
import {shortHash} from '../../core/files.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, VideoAnalysis} from '../../types.js'
import {type Fetch, HttpSession} from '../http.js'
import {fetchMedia} from '../media-fetch.js'
import type {MediaSource, SourceDownload, SourceFile} from '../source.js'

/**
 * A link straight to a media file (`…/clip.mp4`, `…/song.mp3`) on any site:
 * the file itself, no page to read. Shown as "Web" — the archive's extractor
 * too. Any host whose link ends in a media extension; the sites with their
 * own source (TikTok, Instagram, Facebook) are handled before this one.
 */
export type DirectOptions = {
  readonly fetch?: Fetch | undefined
}

export const DIRECT_NAME = 'Web'

/** Extensions a direct link may end in (its path, before any query): a video or an audio file. */
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv'] as const
const AUDIO_EXT = ['m4a', 'mp3', 'opus', 'ogg', 'oga', 'flac', 'wav', 'aac'] as const
const EXT = new RegExp(`\\.(${[...VIDEO_EXT, ...AUDIO_EXT].join('|')})$`, 'i')

/** The file a link names: its last path segment, decoded. Undefined when the link is not a direct media link. O(L). */
export function directFile(url: string): {readonly name: string; readonly ext: string} | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const last = parsed.pathname.split('/').filter(Boolean).at(-1) ?? ''
  let name: string
  try {
    name = decodeURIComponent(last)
  } catch {
    name = last
  }
  const ext = EXT.exec(name)?.[1]?.toLowerCase()
  return ext ? {name, ext} : undefined
}

const isAudioExt = (ext: string): boolean => (AUDIO_EXT as readonly string[]).includes(ext)

export class DirectFileSource implements MediaSource {
  readonly name = DIRECT_NAME
  readonly available = true
  readonly #session: HttpSession

  constructor(options: DirectOptions = {}) {
    this.#session = new HttpSession({fetch: options.fetch})
  }

  handles(url: string): boolean {
    return directFile(url) !== undefined
  }

  /**
   * One small request (the first byte) says whether the file is there, its
   * type and its size. An answer that is a web page is not a media file.
   */
  async analyze(url: string, opts: {readonly signal?: AbortSignal} = {}): Promise<AnalysisResult> {
    const file = directFile(url)
    if (!file)
      throw new DownloadError('invalid-request', 'Not a link to a media file.', undefined, undefined, 'unsupported-url')
    let response: Response
    try {
      response = await this.#session.get(url, {headers: {Range: 'bytes=0-0'}, signal: opts.signal, timeoutMs: 20_000})
    } catch (error) {
      if (opts.signal?.aborted) throw error
      throw new DownloadError(
        'network',
        `The file could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await response.body?.cancel().catch(() => {})
    if (response.status === 404 || response.status === 410) {
      throw new DownloadError('unavailable', 'The file is not there any more.', undefined, undefined, 'removed')
    }
    if (response.status === 401 || response.status === 403) {
      throw new DownloadError(
        'unavailable',
        'The site does not give this file out.',
        undefined,
        undefined,
        'needs-sign-in',
      )
    }
    if (!response.ok) throw new DownloadError('network', `The site answered HTTP ${response.status}.`)
    const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (type.startsWith('text/html')) {
      throw new DownloadError(
        'unavailable',
        'The link opens a web page, not a media file.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    const audio = type.startsWith('audio/') || (!type.startsWith('video/') && isAudioExt(file.ext))
    const size = sizeOf(response)
    const title = file.name.replace(EXT, '') || file.name
    const analysis: VideoAnalysis = {
      kind: 'video',
      media: {id: shortHash(url), url, title, extractor: DIRECT_NAME, isLive: false},
      // a file is as it is: converted to the format asked; an audio file only to audio
      choices: genericChoices()
        .filter(choice => !audio || choice.profile.kind === 'audio')
        .map(choice => (size === undefined ? choice : {...choice, estimatedBytes: size})),
    }
    return analysis
  }

  async preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {
      readonly signal?: AbortSignal | undefined
      readonly onResult?: ((url: string, result: ExtractResult) => void) | undefined
    },
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    for (const {url} of items) {
      let result: ExtractResult
      try {
        const analysis = await this.analyze(url, opts.signal ? {signal: opts.signal} : {})
        result = {ok: true, analysis: analysis as VideoAnalysis}
      } catch (error) {
        result = {
          ok: false,
          error: (error instanceof DownloadError ? error : new DownloadError('network', String(error))).toJSON(),
        }
      }
      results.set(url, result)
      opts.onResult?.(url, result)
    }
    return results
  }

  /** The file, streamed to the work folder (resumed on a retry); the engine converts and checks it. */
  async download(task: SourceDownload): Promise<SourceFile> {
    const file = directFile(task.url)
    if (!file) throw new DownloadError('invalid-request', 'Not a link to a media file.')
    const target = path.join(task.workDir, `media.${file.ext}`)
    const title = file.name.replace(EXT, '') || file.name
    const fetched = await fetchMedia(this.#session, task.url, target, {
      site: DIRECT_NAME,
      signal: task.signal,
      onProgress: task.onProgress,
    })
    const info = {
      id: shortHash(task.url),
      title,
      extractor: DIRECT_NAME,
      filesize: fetched.bytes,
      ...(fetched.lastModified !== undefined && {publishedAt: fetched.lastModified}),
    }
    task.onInfo(info)
    return {filepath: target, info}
  }
}

/** The whole file's size from a ranged answer (`Content-Range: bytes 0-0/<size>`) or a plain one. */
function sizeOf(response: Response): number | undefined {
  const range = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')?.[1]
  if (range) return Number(range)
  if (response.status === 206) return undefined
  const length = Number(response.headers.get('content-length'))
  return Number.isFinite(length) && length > 0 ? length : undefined
}
