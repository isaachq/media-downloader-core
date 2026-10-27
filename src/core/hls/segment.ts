/**
 * One segment from the network to a checked file on disk, and the AES-128 keys it needs. Usable on
 * its own (a live recorder fetches segments the same way): nothing here knows about the order of
 * segments or the resume state.
 */
import {createDecipheriv, type Decipher} from 'node:crypto'
import * as fs from 'node:fs/promises'
import type {HttpSession} from '../../sources/http.js'
import {fetchMedia} from '../../sources/media-fetch.js'
import {DownloadError} from '../errors.js'
import {HlsError} from './errors.js'
import type {ByteRange, HlsKey, HlsSegmentFormat} from './playlist.js'

export type SegmentFetch = {
  /** For messages ("Twitch segment answered 404"). */
  readonly site: string
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly signal: AbortSignal
  readonly range?: ByteRange | undefined
  readonly stallMs?: number | undefined
  /** Bytes of this file so far (a resumed part included), per chunk. O(1). */
  readonly onBytes?: ((bytes: number) => void) | undefined
}

/**
 * Fetch one segment (or init segment) into `file`, resuming a partial one with Range, through
 * `fetchMedia`: stall watchdog, 401/403 → `expired`, 404/410 → `unavailable`, a short body → `network`.
 * An HTML answer is refused as `corrupt` and its file removed. One request, constant memory.
 */
export async function fetchSegment(
  session: HttpSession,
  uri: string,
  file: string,
  opts: SegmentFetch,
): Promise<{readonly bytes: number}> {
  const fetched = await fetchMedia(session, uri, file, {
    site: opts.site,
    headers: opts.headers,
    signal: opts.signal,
    stallMs: opts.stallMs,
    range: opts.range,
    expected: opts.range?.length,
    onProgress: progress => {
      if (progress.downloadedBytes !== undefined) opts.onBytes?.(progress.downloadedBytes)
    },
  })
  if (fetched.contentType === 'text/html' || fetched.contentType === 'application/xhtml+xml') {
    await fs.rm(file, {force: true})
    throw new HlsError('corrupt', `A ${opts.site} segment answered a web page instead of media.`)
  }
  return {bytes: fetched.bytes}
}

const HEAD = 192
const FMP4_BOXES: ReadonlySet<string> = new Set([
  'moof',
  'styp',
  'sidx',
  'emsg',
  'prft',
  'ftyp',
  'moov',
  'free',
  'mdat',
])

/** Whether the first bytes look like the media they claim to be. O(1). */
export function sniff(head: Uint8Array, format: HlsSegmentFormat | 'init'): boolean {
  if (head.length === 0) return false
  let i = 0
  while (i < head.length && i < 16 && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09))
    i++
  if (head[i] === 0x3c) return false // "<": an HTML or XML page
  const ascii = (at: number) => String.fromCharCode(...head.subarray(at, at + 4))
  switch (format) {
    case 'ts':
      return head[0] === 0x47 && (head.length <= 188 || head[188] === 0x47)
    case 'fmp4':
    case 'init':
      return head.length >= 8 && FMP4_BOXES.has(ascii(4))
    case 'packed-audio':
      return (
        ascii(0).startsWith('ID3') ||
        ascii(0) === 'OggS' ||
        ascii(0) === 'fLaC' ||
        (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)
      )
    case 'unknown':
      return true
  }
}

/**
 * Check a fetched segment before it is accepted, from two small reads (≤ 192 bytes at the start, 32 at
 * the end): not empty, the first bytes are the claimed media (decrypted first when keyed), and an
 * encrypted body is whole blocks with valid PKCS#7 padding (yt-dlp #3810: a short body decrypted as if
 * whole). Throws HlsError('corrupt'). O(1).
 */
export async function verifySegment(
  file: string,
  bytes: number,
  format: HlsSegmentFormat | 'init',
  site: string,
  cipher?: {readonly key: Uint8Array; readonly iv: Uint8Array} | undefined,
): Promise<void> {
  const bad = (why: string) => new HlsError('corrupt', `A ${site} segment is damaged (${why}).`)
  if (bytes <= 0) throw bad('empty')
  if (cipher && bytes % 16 !== 0) throw bad(`${bytes} bytes is not whole AES blocks`)
  const fh = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(Math.min(HEAD, bytes))
    await fh.read(head, 0, head.length, 0)
    let plain: Uint8Array = head
    if (cipher) {
      const d = createDecipheriv('aes-128-cbc', cipher.key, cipher.iv).setAutoPadding(false)
      plain = d.update(head)
      // the tail: the last block decrypted with the one before it (or the IV) as its IV
      const tail = Buffer.alloc(Math.min(32, bytes))
      await fh.read(tail, 0, tail.length, bytes - tail.length)
      const iv = tail.length === 32 ? tail.subarray(0, 16) : cipher.iv
      const last = createDecipheriv('aes-128-cbc', cipher.key, iv)
        .setAutoPadding(false)
        .update(tail.subarray(tail.length - 16))
      const pad = last[15] ?? 0
      if (pad < 1 || pad > 16) throw bad('bad AES padding')
      for (let i = 16 - pad; i < 16; i++) if (last[i] !== pad) throw bad('bad AES padding')
      if (bytes === 16 && pad === 16) throw bad('empty after decryption')
    }
    if (!sniff(plain, format)) throw bad(`not ${format === 'init' ? 'an init segment' : format}`)
  } finally {
    await fh.close()
  }
}

/** The IV of a segment: the key's own, or its media sequence number as a 16-byte big-endian integer. */
export function ivFor(key: HlsKey, sequence: number): Uint8Array {
  if (key.iv) return key.iv
  const iv = new Uint8Array(16)
  let n = sequence
  for (let i = 15; i >= 8 && n > 0; i--) {
    iv[i] = n % 256
    n = Math.floor(n / 256)
  }
  return iv
}

/** A streaming AES-128-CBC decipher (PKCS#7 removed on `final`): O(chunk) memory. */
export const decipherFor = (key: Uint8Array, iv: Uint8Array): Decipher => createDecipheriv('aes-128-cbc', key, iv)

/** Fetch an AES-128 key: exactly 16 bytes. 401/403 → `expired` (the refresh path), 404 → `unavailable`. One request. */
export async function fetchKey(
  session: HttpSession,
  uri: string,
  opts: {
    readonly site: string
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly signal: AbortSignal
  },
): Promise<Uint8Array> {
  const response = await session.get(uri, {headers: opts.headers, signal: opts.signal})
  if (!response.ok) await response.body?.cancel().catch(() => {})
  if (response.status === 401 || response.status === 403) {
    throw new DownloadError('expired', `The ${opts.site} media key was refused (expired or another session).`)
  }
  if (response.status === 404 || response.status === 410) {
    throw new DownloadError('unavailable', `${opts.site} media key not found.`, undefined, undefined, 'removed')
  }
  if (!response.ok) throw new DownloadError('network', `The ${opts.site} media key answered HTTP ${response.status}.`)
  const key = new Uint8Array(await response.arrayBuffer())
  if (key.length !== 16) throw new HlsError('corrupt', `The ${opts.site} media key is ${key.length} bytes, not 16.`)
  return key
}

/**
 * AES-128 keys by uri, an LRU of `max` (default 4): key rotation keeps one or two alive at a time.
 * Concurrent requests for one key share one fetch; a failed fetch is forgotten. O(1) per get.
 */
export class KeyCache {
  readonly #keys = new Map<string, Promise<Uint8Array>>()
  readonly #max: number

  constructor(max = 4) {
    this.#max = Math.max(1, max)
  }

  get(uri: string, load: (uri: string) => Promise<Uint8Array>): Promise<Uint8Array> {
    const hit = this.#keys.get(uri)
    if (hit) {
      this.#keys.delete(uri)
      this.#keys.set(uri, hit)
      return hit
    }
    const loading = load(uri)
    this.#keys.set(uri, loading)
    loading.catch(() => {
      if (this.#keys.get(uri) === loading) this.#keys.delete(uri)
    })
    if (this.#keys.size > this.#max) {
      const oldest = this.#keys.keys().next().value
      if (oldest !== undefined) this.#keys.delete(oldest)
    }
    return loading
  }

  get size(): number {
    return this.#keys.size
  }
}
