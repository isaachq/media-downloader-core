/**
 * A small browser-like HTTP session on Node's built-in fetch: one cookie jar,
 * one consistent set of headers, per-request timeouts. Sites that tie media
 * links to the session that fetched the page (TikTok does) need exactly that.
 */

/** A recent desktop Chrome: what most of the web is tested against. */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type SessionOptions = {
  readonly userAgent?: string | undefined
  readonly acceptLanguage?: string | undefined
  /** Per request. Default 20 s. */
  readonly timeoutMs?: number | undefined
  /** Injected for tests. */
  readonly fetch?: Fetch | undefined
}

export class HttpSession {
  readonly userAgent: string
  readonly #acceptLanguage: string
  readonly #timeoutMs: number
  readonly #fetch: Fetch
  /** host → cookie name → value. */
  readonly #jar = new Map<string, Map<string, string>>()

  constructor(options: SessionOptions = {}) {
    this.userAgent = options.userAgent ?? BROWSER_USER_AGENT
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
    const target = new URL(url)
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Accept-Language': this.#acceptLanguage,
      ...opts.headers,
    }
    const cookie = this.cookieHeader(target.hostname)
    if (cookie) headers['Cookie'] = cookie
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.#timeoutMs)
    const response = await this.#fetch(target.href, {
      headers,
      redirect: opts.redirect ?? 'follow',
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    })
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
