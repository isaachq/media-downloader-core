import * as fs from 'node:fs/promises'
import {Readable, Transform} from 'node:stream'
import * as streams from 'node:stream/promises'
import type {ReadableStream as WebReadableStream} from 'node:stream/web'
import {DownloadError} from '../core/errors.js'
import type {JobProgress} from '../types.js'
import type {HttpSession} from './http.js'

/** No byte for this long: the transfer is stuck. */
export const STALL_MS = 60_000

export type MediaFetch = {
  /** Shown in error messages ("TikTok media answered…"). */
  readonly site: string
  /** Extra request headers (a Referer: media CDNs often require one). */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** Size announced by the site, used while the server doesn't tell. */
  readonly expected?: number | undefined
  readonly signal: AbortSignal
  readonly onProgress: (progress: JobProgress) => void
  readonly stallMs?: number | undefined
  /**
   * Only these bytes of the url (an HLS BYTERANGE segment): asked as `bytes=offset+have-end`, a 206
   * required (a 200 would be the whole file). The partial file holds the range's bytes only.
   */
  readonly range?: {readonly offset: number; readonly length: number} | undefined
}

export type FetchedMedia = {
  readonly bytes: number
  /** The server's Last-Modified, unix seconds — when the file was put online. */
  readonly lastModified?: number | undefined
  /** Its media type ("audio/mpeg", "image/jpeg"…), without parameters. */
  readonly contentType?: string | undefined
}

/**
 * Stream one media url to disk through `session` (its cookies and user agent),
 * resuming a partial file with a Range request. Constant memory: chunks go
 * straight from the socket to the file. A transfer with no new bytes for
 * `stallMs` is aborted; a short body is an error, never a finished file.
 *
 * The caller's signal is linked by one listener, removed when the call ends (not `AbortSignal.any`,
 * whose Android polyfill leaves a listener on the caller's signal per call: an HLS download makes
 * thousands of calls on one job signal). O(1) per call.
 */
export async function fetchMedia(
  session: HttpSession,
  url: string,
  file: string,
  opts: MediaFetch,
): Promise<FetchedMedia> {
  const stallMs = opts.stallMs ?? STALL_MS
  const range = opts.range
  let have = (await fs.stat(file).catch(() => undefined))?.size ?? 0
  if (range && have > range.length) {
    await fs.rm(file, {force: true})
    have = 0
  }
  if (range && have === range.length && have > 0) return {bytes: have}
  opts.signal.throwIfAborted()
  const linked = new AbortController()
  const onAbort = () => linked.abort(opts.signal.reason)
  opts.signal.addEventListener('abort', onAbort, {once: true})
  let stalled = false
  const onStall = () => {
    stalled = true
    linked.abort()
  }
  let stallTimer = setTimeout(onStall, stallMs)
  const signal = linked.signal
  const rangeHeader = range
    ? `bytes=${range.offset + have}-${range.offset + range.length - 1}`
    : have > 0
      ? `bytes=${have}-`
      : undefined
  try {
    const response = await session.get(url, {
      headers: {...opts.headers, ...(rangeHeader && {Range: rangeHeader})},
      signal,
      // no request timer: the stall watchdog guards the transfer instead (a 24-hour AbortSignal.timeout
      // per call held ~2 KB each for a day: 36 MB over an 18,000-segment HLS download)
      timeoutMs: Number.POSITIVE_INFINITY,
    })
    if (response.status === 403 || response.status === 401) {
      throw new DownloadError('expired', `The ${opts.site} media link was refused (expired or another session).`)
    }
    if (response.status === 404 || response.status === 410) {
      throw new DownloadError('unavailable', `${opts.site} media not found.`, undefined, undefined, 'removed')
    }
    if (response.status === 416 && (have > 0 || range)) {
      // the partial file is already whole (or longer than the file now is): start over
      await fs.rm(file, {force: true})
      throw new DownloadError('network', `${opts.site} refused to resume the download.`)
    }
    if (!response.ok || !response.body) {
      throw new DownloadError('network', `${opts.site} media answered HTTP ${response.status}.`)
    }
    if (range && response.status !== 206) {
      await response.body.cancel().catch(() => {})
      throw new DownloadError('network', `${opts.site} ignored the byte range (HTTP ${response.status}).`)
    }
    const resumed = response.status === 206 && have > 0
    const length = Number(response.headers.get('content-length')) || undefined
    const total = range ? range.length : length !== undefined ? length + (resumed ? have : 0) : opts.expected
    const modified = Date.parse(response.headers.get('last-modified') ?? '')
    let done = resumed ? have : 0
    const started = Date.now()
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        done += chunk.length
        clearTimeout(stallTimer)
        stallTimer = setTimeout(onStall, stallMs)
        const seconds = (Date.now() - started) / 1000
        const speed = seconds > 0 ? (done - (resumed ? have : 0)) / seconds : undefined
        opts.onProgress({
          fraction: total ? Math.min(1, done / total) : undefined,
          downloadedBytes: done,
          totalBytes: total,
          speed,
          eta: speed && total ? Math.max(0, (total - done) / speed) : undefined,
        })
        callback(null, chunk)
      },
    })
    // the file is opened before the body becomes a stream: a connection that drops while the open is
    // awaited would otherwise error a stream nothing listens to yet (an uncaught error, the process gone)
    const output = (await fs.open(file, resumed ? 'a' : 'w')).createWriteStream()
    await streams.pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), meter, output, {signal})
    if (total !== undefined && done !== total) {
      throw new DownloadError('network', `Incomplete ${opts.site} download: ${done} of ${total} bytes.`)
    }
    return {
      bytes: done,
      lastModified: Number.isFinite(modified) ? Math.floor(modified / 1000) : undefined,
      contentType: response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || undefined,
    }
  } catch (error) {
    if (stalled && !opts.signal.aborted) {
      throw new DownloadError('network', `No data from ${opts.site} for ${stallMs / 1000} s.`)
    }
    throw error
  } finally {
    clearTimeout(stallTimer)
    opts.signal.removeEventListener('abort', onAbort)
  }
}
