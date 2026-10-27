import {randomBytes} from 'node:crypto'

/**
 * The live player's proxy (`mdc-live:`): Twitch's playlists refuse a `file://` page (no CORS for
 * it), so the renderer's hls.js asks this scheme and the main process fetches upstream.
 *
 *   mdc-live://<sid>/master.m3u8  the signed master, each variant rewritten to /v/<i>.m3u8
 *   mdc-live://<sid>/v/<i>.m3u8   a variant, each segment rewritten to /s/<base64url(upstream)>
 *   mdc-live://<sid>/s/<b64>      a segment, streamed through (only from allowed hosts)
 *
 * Signed urls never reach the renderer, and it cannot use the scheme as an open proxy: a segment
 * is fetched only from an allowed host (Twitch's CDN, `*.ttvnw.net`, over https). A variant Twitch
 * refuses (401 / 403 / 410: its signature ran out) is signed again once for all the requests that
 * hit it at the same time, at most 3 times in a row, then 502 (the player shows Try again).
 *
 * Cost: per playlist reload O(lines) to rewrite (~15 for a live window); per segment one upstream
 * request, O(1) work, its body streamed (O(chunk) memory, never buffered whole); 1 playback read
 * per open and one per re-sign.
 */

/** A live stream's signed master, as the engine gives it (`MediaDownloader.livePlayback`). */
export type Playback = (
  url: string,
  opts?: {readonly fresh?: boolean | undefined},
) => Promise<{readonly url: string} | undefined>

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export type LiveProxyOptions = {
  readonly playback: Playback
  readonly fetch: Fetch
  /** Players open at once; the oldest closes past it. Default 4. */
  readonly maxSessions?: number | undefined
  /** Hosts segments may come from. Default: https and `*.ttvnw.net`. */
  readonly allowSegment?: ((url: URL) => boolean) | undefined
}

export const SCHEME = 'mdc-live'
const MAX_RESIGNS = 3
const REFUSED = new Set([401, 403, 410])
const PLAYLIST_HEADERS = {
  'content-type': 'application/vnd.apple.mpegurl',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
}
/** Headers of a segment worth passing on to the player. */
const SEGMENT_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'] as const

const twitchCdn = (url: URL) => url.protocol === 'https:' && url.hostname.endsWith('.ttvnw.net')

type Variant = {readonly name: string; uri: string}
type Session = {
  readonly url: string
  variants: Variant[]
  /** A re-sign in progress: every refused request waits for this one. */
  resigning?: Promise<void> | undefined
  /** Re-signs since the last variant that loaded. */
  refusals: number
}

const encode = (url: string) => Buffer.from(url).toString('base64url')
const decode = (text: string) => Buffer.from(text, 'base64url').toString()

/** A variant's name: Twitch's `VIDEO="720p60"`, else its position. O(1). */
function variantName(streamInf: string | undefined, index: number): string {
  return /VIDEO="([^"]+)"/.exec(streamInf ?? '')?.[1] ?? String(index)
}

/** The master's variants, each uri resolved against the master's url. O(lines). */
export function readMaster(text: string, base: string): Variant[] {
  const variants: Variant[] = []
  let streamInf: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-STREAM-INF')) streamInf = line
    else if (line && !line.startsWith('#')) {
      variants.push({name: variantName(streamInf, variants.length), uri: new URL(line, base).href})
      streamInf = undefined
    }
  }
  return variants
}

/** The master with its variants pointing at this session. O(lines). */
export function rewriteMaster(text: string, sid: string): string {
  let index = 0
  return text
    .split('\n')
    .map(raw => {
      const line = raw.trim()
      return line && !line.startsWith('#') ? `${SCHEME}://${sid}/v/${index++}.m3u8` : raw
    })
    .join('\n')
}

/** A variant with its segments (and init map) pointing at this session; Twitch's prefetch hints dropped. O(lines). */
export function rewriteMedia(text: string, base: string, sid: string): string {
  const proxied = (uri: string) => `${SCHEME}://${sid}/s/${encode(new URL(uri, base).href)}`
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    // hls.js ignores them, and they would hand the renderer signed urls
    if (line.startsWith('#EXT-X-TWITCH-PREFETCH')) continue
    if (line.startsWith('#EXT-X-MAP:'))
      out.push(raw.replace(/URI="([^"]+)"/, (_, uri: string) => `URI="${proxied(uri)}"`))
    else if (line && !line.startsWith('#')) out.push(proxied(line))
    else out.push(raw)
  }
  return out.join('\n')
}

export class LiveProxy {
  readonly #playback: Playback
  readonly #fetch: Fetch
  readonly #max: number
  readonly #allow: (url: URL) => boolean
  /** Insertion order is age: the first is the oldest. */
  readonly #sessions = new Map<string, Session>()

  constructor(options: LiveProxyOptions) {
    this.#playback = options.playback
    this.#fetch = options.fetch
    this.#max = options.maxSessions ?? 4
    this.#allow = options.allowSegment ?? twitchCdn
  }

  /** A player session for a live channel link: its `src` for hls.js. Undefined when it is not on the air. */
  async open(url: string): Promise<{readonly sid: string; readonly src: string} | undefined> {
    const playback = await this.#playback(url)
    if (!playback) return undefined
    const sid = randomBytes(16).toString('hex')
    this.#sessions.set(sid, {url, variants: [], refusals: 0})
    for (const old of this.#sessions.keys()) {
      if (this.#sessions.size <= this.#max) break
      this.#sessions.delete(old)
    }
    return {sid, src: `${SCHEME}://${sid}/master.m3u8`}
  }

  close(sid: string): void {
    this.#sessions.delete(sid)
  }

  get size(): number {
    return this.#sessions.size
  }

  /** The scheme's handler (`protocol.handle(SCHEME, request => proxy.handle(request))`). */
  async handle(request: Request): Promise<Response> {
    let target: URL
    try {
      target = new URL(request.url)
    } catch {
      return status(400)
    }
    const session = this.#sessions.get(target.hostname)
    if (!session) return status(404)
    const sid = target.hostname
    const path = target.pathname
    try {
      if (path === '/master.m3u8') return await this.#master(session, sid)
      const variant = /^\/v\/(\d+)\.m3u8$/.exec(path)
      if (variant) return await this.#variant(session, sid, Number(variant[1]))
      const segment = /^\/s\/([\w-]+)$/.exec(path)
      if (segment) return await this.#segment(request, decode(segment[1]!))
      return status(404)
    } catch (error) {
      if (request.signal.aborted) return status(499)
      return status(502, error instanceof Error ? error.message : String(error))
    }
  }

  async #master(session: Session, sid: string): Promise<Response> {
    const text = await this.#readMaster(session, false)
    if (text === undefined) return status(404, 'not on the air')
    return new Response(rewriteMaster(text, sid), {headers: PLAYLIST_HEADERS})
  }

  /** Reads a signed master (anew when `fresh`) and keeps its variants. Undefined when off the air. */
  async #readMaster(session: Session, fresh: boolean): Promise<string | undefined> {
    const playback = await this.#playback(session.url, {fresh})
    if (!playback) return undefined
    const answer = await this.#fetch(playback.url)
    if (!answer.ok) throw new Error(`master: HTTP ${answer.status}`)
    const text = await answer.text()
    session.variants = readMaster(text, playback.url)
    return text
  }

  async #variant(session: Session, sid: string, index: number): Promise<Response> {
    for (;;) {
      const variant = session.variants[index]
      if (!variant) return status(404)
      const answer = await this.#fetch(variant.uri)
      if (answer.ok) {
        session.refusals = 0
        return new Response(rewriteMedia(await answer.text(), variant.uri, sid), {headers: PLAYLIST_HEADERS})
      }
      if (!REFUSED.has(answer.status)) return status(502, `variant: HTTP ${answer.status}`)
      await answer.body?.cancel()
      // a re-sign under way serves every request refused meanwhile; a new one counts
      if (!session.resigning && session.refusals++ >= MAX_RESIGNS)
        return status(502, 'Twitch keeps refusing the stream')
      await this.#resign(session, variant.name)
    }
  }

  /** Signs the session again, once for every request refused meanwhile; the variant is found again by name. */
  #resign(session: Session, name: string): Promise<void> {
    session.resigning ??= (async () => {
      try {
        const before = session.variants
        if ((await this.#readMaster(session, true)) === undefined) throw new Error('the stream ended')
        // the new master may list its variants in another order: each index keeps its name
        const byName = new Map(session.variants.map(variant => [variant.name, variant.uri]))
        session.variants = before.map(variant => ({name: variant.name, uri: byName.get(variant.name) ?? variant.uri}))
        if (!byName.has(name)) throw new Error(`the ${name} variant is gone`)
      } finally {
        session.resigning = undefined
      }
    })()
    return session.resigning
  }

  async #segment(request: Request, upstream: string): Promise<Response> {
    let url: URL
    try {
      url = new URL(upstream)
    } catch {
      return status(400)
    }
    if (!this.#allow(url)) return status(403, 'not a Twitch media host')
    const range = request.headers.get('range')
    const answer = await this.#fetch(url.href, {
      signal: request.signal,
      ...(range && {headers: {range}}),
    })
    const headers: Record<string, string> = {'access-control-allow-origin': '*'}
    for (const name of SEGMENT_HEADERS) {
      const value = answer.headers.get(name)
      if (value) headers[name] = value
    }
    // streamed through as it arrives: a closed player aborts the upstream transfer (the signal)
    return new Response(answer.body, {status: answer.status, headers})
  }
}

function status(code: number, text = ''): Response {
  return new Response(text, {status: code, headers: {'access-control-allow-origin': '*'}})
}
