/**
 * A small browser-like HTTP session on Node's built-in fetch: one cookie jar,
 * one consistent set of headers, per-request timeouts. Sites that tie media
 * links to the session that fetched the page (TikTok does) need exactly that.
 */
import * as http from 'node:http'
import * as https from 'node:https'
import {Readable} from 'node:stream'
import * as zlib from 'node:zlib'

/** A recent desktop Chrome: what most of the web is tested against. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The headers a desktop Chrome sends when a page loads in an iframe on another
 * site: how an embed is meant to be read. Instagram (since October 2026) walls
 * its embed unless the Sec-Fetch-* trio says it is a page load.
 */
export const IFRAME_NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Upgrade-Insecure-Requests': '1',
}

/** A top-level page load (a link typed or opened): what a site serves a visitor's first page to. */
export const DOCUMENT_NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
  ...IFRAME_NAVIGATION_HEADERS,
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
}

const MAX_REDIRECTS = 10

/**
 * A failed request with its reason in the message: Node's fetch says only
 * "fetch failed" and keeps why in `cause` (ENOTFOUND, ECONNRESET, a TLS
 * error…), which is what a failure report needs. Aborts and timeouts pass
 * through as they are.
 */
export function withCause(error: unknown): unknown {
  if (!(error instanceof Error) || error.name === 'AbortError' || error.name === 'TimeoutError') return error
  const cause = (error as Error & {cause?: unknown}).cause
  if (!(cause instanceof Error) && (typeof cause !== 'object' || cause === null)) return error
  const {code, hostname, message} = cause as {code?: unknown; hostname?: unknown; message?: unknown}
  const reason = [typeof code === 'string' ? code : undefined, typeof hostname === 'string' ? hostname : undefined]
    .filter(Boolean)
    .join(' ')
  const why = reason || (typeof message === 'string' ? message : '')
  if (!why || error.message.includes(why)) return error
  return Object.assign(new TypeError(`${error.message} (${why})`, {cause}), {name: error.name})
}

/**
 * A fetch that sends the headers it is given, as given: Node's built-in fetch
 * (undici) always sends `Sec-Fetch-Mode: cors`, whatever the caller sets, and
 * some sites wall exactly that on pages a browser navigates to. GET and POST
 * over node:http(s), gzip / deflate / brotli bodies, redirects followed (or
 * returned with `redirect: 'manual'`), the signal honoured.
 */
export const navigationFetch: Fetch = async (input, init = {}) => {
  const method = (init.method ?? 'GET').toUpperCase()
  const signal = init.signal ?? undefined
  const headers: Record<string, string> = {'accept-encoding': 'gzip, deflate, br'}
  for (const [name, value] of new Headers(init.headers).entries()) headers[name] = value
  let url = new URL(input)
  for (let hop = 0; ; hop++) {
    signal?.throwIfAborted()
    const target = url
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (target.protocol === 'https:' ? https : http).request(
        target,
        {method, headers, ...(signal && {signal})},
        resolve,
      )
      request.on('error', error => reject(signal?.aborted ? signal.reason : error))
      request.end(method === 'POST' && typeof init.body === 'string' ? init.body : undefined)
    })
    const status = response.statusCode ?? 0
    const location = response.headers.location
    if (status >= 300 && status < 400 && location && (init.redirect ?? 'follow') === 'follow') {
      response.resume()
      if (hop >= MAX_REDIRECTS) throw new TypeError(`Too many redirects from ${input}`)
      url = new URL(location, url)
      continue
    }
    const out = new Headers()
    for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
      out.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!)
    }
    const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
    const decoder =
      encoding === 'gzip'
        ? zlib.createGunzip()
        : encoding === 'deflate'
          ? zlib.createInflate()
          : encoding === 'br'
            ? zlib.createBrotliDecompress()
            : undefined
    // a decoded body: its length and encoding no longer describe it
    if (decoder) {
      out.delete('content-encoding')
      out.delete('content-length')
      response.on('error', error => decoder.destroy(error))
    }
    const body = decoder ? response.pipe(decoder) : response
    const empty = status === 204 || status === 304 || method === 'HEAD'
    if (empty) response.resume()
    const result = new Response(empty ? null : (Readable.toWeb(body) as ReadableStream<Uint8Array>), {
      status,
      statusText: response.statusMessage ?? '',
      headers: out,
    })
    Object.defineProperty(result, 'url', {value: url.href})
    return result
  }
}

export type SessionOptions = {
  readonly userAgent?: string | undefined
  readonly acceptLanguage?: string | undefined
  /** Per request. Default 20 s. */
  readonly timeoutMs?: number | undefined
  /** Injected for tests. */
  readonly fetch?: Fetch | undefined
}

export class HttpSession {
  #userAgent: string
  readonly #acceptLanguage: string
  readonly #timeoutMs: number
  readonly #fetch: Fetch
  /** host → cookie name → value. */
  readonly #jar = new Map<string, Map<string, string>>()

  constructor(options: SessionOptions = {}) {
    this.#userAgent = options.userAgent ?? BROWSER_USER_AGENT
    this.#acceptLanguage = options.acceptLanguage ?? 'en-US,en;q=0.9'
    this.#timeoutMs = options.timeoutMs ?? 20_000
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
  }

  async get(
    url: string,
    opts: {
      readonly headers?: Readonly<Record<string, string>> | undefined
      readonly signal?: AbortSignal | undefined
      readonly redirect?: 'follow' | 'manual' | 'error' | undefined
      readonly timeoutMs?: number | undefined
    } = {},
  ): Promise<Response> {
    return this.request(url, opts)
  }

  /** Any method; a POST carries `body` (a form or JSON string: set Content-Type in `headers`). */
  async request(
    url: string,
    opts: {
      readonly method?: 'GET' | 'POST' | undefined
      readonly body?: string | undefined
      readonly headers?: Readonly<Record<string, string>> | undefined
      readonly signal?: AbortSignal | undefined
      readonly redirect?: 'follow' | 'manual' | 'error' | undefined
      readonly timeoutMs?: number | undefined
    } = {},
  ): Promise<Response> {
    const target = new URL(url)
    const headers: Record<string, string> = {
      'User-Agent': this.#userAgent,
      'Accept-Language': this.#acceptLanguage,
      ...opts.headers,
    }
    const cookie = this.cookieHeader(target.hostname)
    if (cookie) headers['Cookie'] = cookie
    // Infinity: no timer at all (the caller guards the transfer, as fetchMedia's stall watchdog does): an
    // AbortSignal.timeout lives until it fires, so a long one per request is memory held per request
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs
    const timeout = Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined
    let response: Response
    try {
      response = await this.#fetch(target.href, {
        method: opts.method ?? 'GET',
        ...(opts.method === 'POST' && {body: opts.body ?? ''}),
        headers,
        redirect: opts.redirect ?? 'follow',
        signal: opts.signal && timeout ? AbortSignal.any([opts.signal, timeout]) : (opts.signal ?? timeout ?? null),
      })
    } catch (error) {
      throw withCause(error)
    }
    this.#store(target.hostname, response.headers)
    return response
  }

  /** Cookies that apply to `host`: its own and those of its parent domains. */
  cookieHeader(host: string): string {
    const pairs: string[] = []
    for (let domain = host; domain.includes('.'); domain = domain.slice(domain.indexOf('.') + 1)) {
      for (const [name, value] of this.#jar.get(domain) ?? []) pairs.push(`${name}=${value}`)
    }
    return pairs.join('; ')
  }

  /** One cookie as it applies to `host` (its own or a parent domain's), or undefined. */
  cookie(host: string, name: string): string | undefined {
    for (let domain = host; domain.includes('.'); domain = domain.slice(domain.indexOf('.') + 1)) {
      const value = this.#jar.get(domain)?.get(name)
      if (value !== undefined) return value
    }
    return undefined
  }

  get userAgent(): string {
    return this.#userAgent
  }

  /**
   * Continue as the browser that just loaded a page: its cookies and user agent
   * (sites tie their session cookies to the client that earned them).
   */
  adopt(session: {
    readonly userAgent: string
    readonly cookies: ReadonlyArray<{readonly name: string; readonly value: string; readonly domain: string}>
  }): void {
    this.#userAgent = session.userAgent
    for (const {name, value, domain} of session.cookies) {
      const host = domain.replace(/^\./, '').toLowerCase()
      const cookies = this.#jar.get(host) ?? new Map<string, string>()
      cookies.set(name, value)
      this.#jar.set(host, cookies)
    }
  }

  /** Forget every cookie (a fresh identity after the site starts refusing this one). */
  reset(): void {
    this.#jar.clear()
  }

  #store(host: string, headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      // Domain=.tiktok.com makes the cookie valid for every subdomain (the media CDN too)
      const domainAttr = attributes.map(a => a.trim()).find(a => /^domain=/i.test(a))
      const domain = domainAttr ? domainAttr.slice(7).replace(/^\./, '').toLowerCase() : host
      const expired = attributes.some(a => /^\s*max-age=0\s*$/i.test(a))
      const cookies = this.#jar.get(domain) ?? new Map<string, string>()
      if (expired) cookies.delete(name)
      else cookies.set(name, value)
      this.#jar.set(domain, cookies)
    }
  }
}
