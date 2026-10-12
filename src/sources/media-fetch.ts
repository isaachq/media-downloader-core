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
 */
export async function fetchMedia(
  session: HttpSession,
  url: string,
  file: string,
  opts: MediaFetch,
): Promise<FetchedMedia> {
  const stallMs = opts.stallMs ?? STALL_MS
  const have = (await fs.stat(file).catch(() => undefined))?.size ?? 0
  const stall = new AbortController()
  let stallTimer = setTimeout(() => stall.abort(), stallMs)
  const signal = AbortSignal.any([opts.signal, stall.signal])
  try {
    const response = await session.get(url, {
      headers: {...opts.headers, ...(have > 0 && {Range: `bytes=${have}-`})},
      signal,
      timeoutMs: 24 * 60 * 60_000, // the stall watchdog guards the transfer instead
    })
    if (response.status === 403 || response.status === 401) {
      throw new DownloadError('expired', `The ${opts.site} media link was refused (expired or another session).`)
    }
    if (response.status === 404 || response.status === 410) {
      throw new DownloadError('unavailable', `${opts.site} media not found.`, undefined, undefined, 'removed')
    }
    if (response.status === 416 && have > 0) {
      // the partial file is already whole (or longer than the file now is): start over
      await fs.rm(file, {force: true})
      throw new DownloadError('network', `${opts.site} refused to resume the download.`)
    }
    if (!response.ok || !response.body) {
      throw new DownloadError('network', `${opts.site} media answered HTTP ${response.status}.`)
    }
    const resumed = response.status === 206 && have > 0
    const length = Number(response.headers.get('content-length')) || undefined
    const total = length !== undefined ? length + (resumed ? have : 0) : opts.expected
    const modified = Date.parse(response.headers.get('last-modified') ?? '')
    let done = resumed ? have : 0
    const started = Date.now()
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        done += chunk.length
        clearTimeout(stallTimer)
        stallTimer = setTimeout(() => stall.abort(), stallMs)
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
    await streams.pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      meter,
      (await fs.open(file, resumed ? 'a' : 'w')).createWriteStream(),
      {signal},
    )
    if (total !== undefined && done !== total) {
      throw new DownloadError('network', `Incomplete ${opts.site} download: ${done} of ${total} bytes.`)
    }
    return {
      bytes: done,
      lastModified: Number.isFinite(modified) ? Math.floor(modified / 1000) : undefined,
      contentType: response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() || undefined,
    }
  } catch (error) {
    if (stall.signal.aborted && !opts.signal.aborted) {
      throw new DownloadError('network', `No data from ${opts.site} for ${stallMs / 1000} s.`)
    }
    throw error
  } finally {
    clearTimeout(stallTimer)
  }
}
