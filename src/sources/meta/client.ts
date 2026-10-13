import type {CookieRecord} from '../../core/cookies.js'
import type {BrowserAssist} from '../browser.js'
import {type Fetch, HttpSession} from '../http.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import {MetaError} from './errors.js'

/**
 * How a native source talks to a Meta site (Instagram, Facebook): one HTTP
 * session with the site's cookies, one shared Pacer, reads retried after the
 * shared cool-down, a real browser for pages that only open in one, a
 * circuit breaker while the site blocks this source, and — new for these
 * sites — a signed-in session supplied by the host (cookies), since both
 * keep stories and most listings for signed-in sessions only.
 *
 * Exactly TikTokSource's plumbing, lifted out so the two sources share it
 * instead of each carrying its own copy.
 */
export type SessionCookies = ReadonlyArray<CookieRecord>

export type MetaClientOptions = {
  /** Shown in messages ("Instagram answered…"). */
  readonly site: string
  readonly origin: string
  /** The cookie that marks a signed-in session (Instagram: sessionid; Facebook: c_user). */
  readonly sessionCookie: string
  readonly pacing?: PacerOptions | undefined
  readonly fetch?: Fetch | undefined
  readonly browser?: BrowserAssist | undefined
  /**
   * The user's cookies for the site (a browser's, read by the host), asked
   * for when a request needs a signed-in session and again when they are old.
   * Undefined: no session; the request fails with 'login-required'.
   */
  readonly cookies?: (() => Promise<SessionCookies | undefined>) | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
  readonly now?: (() => number) | undefined
}

/** Reads of a page / API answer the site refused, retried after the shared cool-down. */
export const READ_ATTEMPTS = 3
/** After a verification page, the site's urls go to yt-dlp for this long (a circuit breaker). */
export const BLOCKED_MS = 10 * 60_000
/** Cookies the host hands over are asked for again after this long (a browser may have signed out). */
const COOKIES_FRESH_MS = 6 * 60 * 60_000

/** What a login wall or a checkpoint page carries, on either site. */
const WALL = /\/accounts\/login|\/login\.php|\/checkpoint\/|\/challenge\/|checkpoint_required|login_form/

function assertNotWalled(html: string, site: string): void {
  if (WALL.test(html)) throw new MetaError('challenge', `${site} showed the browser a login or verification page.`)
}

export type PageRead = {
  readonly html: string
  /** Where the request ended up (a login wall is a redirect). */
  readonly url: string
  readonly status: number
}

export class MetaClient {
  readonly site: string
  readonly origin: string
  readonly host: string
  readonly session: HttpSession
  readonly pacer: Pacer
  readonly #sessionCookie: string
  readonly #browser: BrowserAssist | undefined
  /** One browser page at a time: each is a full page load. */
  readonly #browserTurns = new Pacer({concurrency: 1, spacingMs: 0, jitterMs: 0})
  readonly #cookies: (() => Promise<SessionCookies | undefined>) | undefined
  readonly #log: (level: 'info' | 'warn', message: string) => void
  readonly #now: () => number
  #blockedUntil = 0
  #cookiesAt: number | undefined
  #loading: Promise<void> | undefined

  constructor(options: MetaClientOptions) {
    this.site = options.site
    this.origin = options.origin.replace(/\/$/, '')
    this.host = new URL(this.origin).hostname
    this.session = new HttpSession({fetch: options.fetch})
    this.pacer = new Pacer(options.pacing)
    this.#sessionCookie = options.sessionCookie
    this.#browser = options.browser
    this.#cookies = options.cookies
    this.#log = options.log ?? (() => {})
    this.#now = options.now ?? Date.now
  }

  /** False while the site is blocking this source: its urls go to yt-dlp meanwhile. */
  get available(): boolean {
    return this.#now() >= this.#blockedUntil
  }

  get hasBrowser(): boolean {
    return this.#browser !== undefined
  }

  /** The session carries the site's sign-in cookie. */
  get signedIn(): boolean {
    return this.session.cookie(this.host, this.#sessionCookie) !== undefined
  }

  /** A cookie of the site as the session has it now (a CSRF token to echo in a header). */
  cookie(name: string): string | undefined {
    return this.session.cookie(this.host, name)
  }

  /** Use these cookies from now on (a signed-in session the host obtained). */
  adoptCookies(cookies: SessionCookies): void {
    this.session.adopt({
      userAgent: this.session.userAgent,
      cookies: cookies.map(c => ({name: c.name, value: c.value, domain: c.domain})),
    })
    this.#cookiesAt = this.#now()
  }

  /**
   * Make sure the session is signed in, loading the host's cookies when they
   * were never loaded or are old. Throws 'login-required' when there is none:
   * the caller's request only works signed in.
   */
  async requireSession(what: string): Promise<void> {
    await this.loadCookies()
    if (!this.signedIn) {
      throw new MetaError(
        'login-required',
        `${this.site} shows ${what} to signed-in accounts only: use a browser's signed-in session (cookies).`,
      )
    }
  }

  /**
   * Load the host's cookies if they were never loaded or are old. Concurrent
   * callers share one load. None is not remembered: the user may sign in or
   * pick a browser later, and asking again is cheap (the host caches its jar).
   * A host that fails to read them leaves the session as it is.
   */
  async loadCookies(): Promise<void> {
    if (!this.#cookies) return
    if (this.#cookiesAt !== undefined && this.#now() - this.#cookiesAt < COOKIES_FRESH_MS) return
    this.#loading ??= this.#cookies()
      .then(
        cookies => {
          if (cookies) this.adoptCookies(cookies)
        },
        error => this.#log('warn', `${this.site}: the session cookies could not be read: ${String(error)}`),
      )
      .finally(() => {
        this.#loading = undefined
      })
    await this.#loading
  }

  /** Forget the host's cookies (they stopped working): asked for again next time. */
  forgetCookies(): void {
    this.#cookiesAt = undefined
    this.session.reset()
  }

  /**
   * A page, read by `read` (which throws MetaError for what it finds wrong).
   * A refusal is retried after the shared cool-down; a verification page goes
   * through the browser once, whose session is then adopted — or, without a
   * browser, the source steps aside for BLOCKED_MS and yt-dlp takes over.
   */
  async page<T>(
    url: string,
    read: (page: PageRead) => T,
    opts: {readonly signal?: AbortSignal | undefined; readonly headers?: Readonly<Record<string, string>>} = {},
  ): Promise<T> {
    try {
      return await this.retrying(() => this.#pageOnce(url, read, opts), opts.signal)
    } catch (error) {
      if (!(error instanceof MetaError) || error.problem !== 'challenge' || !this.#browser) throw error
      return this.inBrowser(url, page => read({html: page.html, url, status: 200}), opts.signal)
    }
  }

  /**
   * An API answer as JSON. Status codes are told apart here (404 removed,
   * 401 login, 429 / 403 / 5xx refused — the pacer backs off); what the JSON
   * says is for `read`. With `recoverAt`, a verification answer makes the
   * browser load that page once, so its session serves the next try.
   */
  async json<T>(
    url: string,
    read: (json: unknown, status: number) => T,
    opts: {
      readonly signal?: AbortSignal | undefined
      readonly method?: 'GET' | 'POST' | undefined
      readonly headers?: Readonly<Record<string, string>> | undefined
      readonly body?: string | undefined
      /** A page the browser can open to earn the cookies the API wants. */
      readonly recoverAt?: string | undefined
    } = {},
  ): Promise<T> {
    try {
      return await this.retrying(() => this.#jsonOnce(url, read, opts), opts.signal)
    } catch (error) {
      if (!(error instanceof MetaError) || error.problem !== 'challenge' || !this.#browser || !opts.recoverAt)
        throw error
      // the browser's page must be a real one: a captcha or login wall there too means stepping aside
      await this.inBrowser(opts.recoverAt, page => assertNotWalled(page.html, this.site), opts.signal)
      try {
        return await this.#jsonOnce(url, read, opts)
      } catch (again) {
        if (again instanceof MetaError && again.problem === 'challenge') this.stepAside(again.message)
        throw again
      }
    }
  }

  /** Follow one redirect hop of a short link; undefined when it doesn't redirect. */
  async redirectOf(url: string, signal?: AbortSignal): Promise<string | undefined> {
    const response = await this.pacer.run(() => this.session.get(url, {redirect: 'manual', signal}), signal)
    const target = response.headers.get('location')
    return target ? new URL(target, url).href : undefined
  }

  /**
   * A refusal (403 / 429 / empty answer) is retried after the shared cool-down.
   * A verification page is not: solving it is out of scope, so the source steps
   * aside for BLOCKED_MS and the engine uses yt-dlp meanwhile.
   */
  async retrying<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read()
      } catch (error) {
        if (error instanceof MetaError && error.problem === 'challenge') {
          // with a browser at hand the caller tries it before stepping aside
          if (!this.#browser) this.stepAside(error.message)
          throw error
        }
        if (signal?.aborted || !(error instanceof MetaError) || !error.transient || attempt >= READ_ATTEMPTS)
          throw error
      }
    }
  }

  /** Hand the site to yt-dlp for BLOCKED_MS. */
  stepAside(why: string): void {
    this.#blockedUntil = this.#now() + BLOCKED_MS
    this.#log('warn', `${this.site}: ${why} — using yt-dlp for ${BLOCKED_MS / 60_000} min`)
  }

  /**
   * The page as a real browser gets it: the site's check runs there by
   * itself. Its session is adopted, so the next requests go on over plain
   * HTTP. A captcha or login wall the browser hits too stays a challenge, and
   * the source steps aside.
   */
  async inBrowser<T>(url: string, read: (page: {readonly html: string}) => T, signal?: AbortSignal): Promise<T> {
    let page: Awaited<ReturnType<BrowserAssist>>
    let result: T
    try {
      page = await this.#browserTurns.run(() => this.#browser!(url, signal), signal)
      result = read(page)
    } catch (error) {
      if (error instanceof MetaError && error.transient) this.stepAside('even the browser got a verification page')
      throw error
    }
    this.session.adopt(page)
    this.#log('info', `${this.site}: ${url} needed a browser (verification page) — continuing with its session`)
    this.#blockedUntil = 0
    // the refusal that sent us here no longer applies: no cool-down before the next request
    this.pacer.resume()
    return result
  }

  async #pageOnce<T>(
    url: string,
    read: (page: PageRead) => T,
    opts: {readonly signal?: AbortSignal | undefined; readonly headers?: Readonly<Record<string, string>>},
  ): Promise<T> {
    return this.pacer.run(async () => {
      const response = await this.session.get(url, {
        headers: {Accept: 'text/html,application/xhtml+xml', ...opts.headers},
        signal: opts.signal,
      })
      if (response.status === 404 || response.status === 410) {
        throw new MetaError('removed', `${this.site} answered ${response.status}.`)
      }
      if (!response.ok) {
        this.pacer.refused()
        throw new MetaError('refused', `${this.site} answered HTTP ${response.status}.`)
      }
      try {
        const result = read({html: await response.text(), url: response.url || url, status: response.status})
        this.pacer.succeeded()
        return result
      } catch (error) {
        if (error instanceof MetaError && error.transient) this.pacer.refused()
        throw error
      }
    }, opts.signal)
  }

  async #jsonOnce<T>(
    url: string,
    read: (json: unknown, status: number) => T,
    opts: {
      readonly signal?: AbortSignal | undefined
      readonly method?: 'GET' | 'POST' | undefined
      readonly headers?: Readonly<Record<string, string>> | undefined
      readonly body?: string | undefined
    },
  ): Promise<T> {
    return this.pacer.run(async () => {
      const response = await this.session.request(url, {
        method: opts.method ?? 'GET',
        body: opts.body,
        headers: {Accept: 'application/json', Referer: `${this.origin}/`, ...opts.headers},
        signal: opts.signal,
      })
      const body = await response.text()
      if (response.status === 404 || response.status === 410) {
        throw new MetaError('removed', `${this.site} answered ${response.status}.`)
      }
      if (response.status === 401) {
        throw new MetaError('login-required', `${this.site} asks to sign in for this.`)
      }
      if (!response.ok || !body) {
        this.pacer.refused()
        throw new MetaError('refused', `${this.site} answered HTTP ${response.status}${body ? '' : ' with no data'}.`)
      }
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch {
        // HTML where JSON was expected: a login page or a checkpoint
        if (WALL.test(body))
          throw new MetaError('challenge', `${this.site} answered with a login or verification page.`)
        throw new MetaError('format-changed', `${this.site} answered something that is not JSON.`)
      }
      try {
        const result = read(json, response.status)
        this.pacer.succeeded()
        return result
      } catch (error) {
        if (error instanceof MetaError && error.transient) this.pacer.refused()
        throw error
      }
    }, opts.signal)
  }
}
