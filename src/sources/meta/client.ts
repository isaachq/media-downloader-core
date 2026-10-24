import type {BrowserAssist} from '../browser.js'
import {DOCUMENT_NAVIGATION_HEADERS, type Fetch, HttpSession, navigationFetch} from '../http.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import {HostSession, type SessionCookies, type SessionProvider, type SiteSession} from '../session.js'
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
export type {SessionCookies, SessionProvider, SiteSession}

/** Where a site sends a visitor it won't show a page to: its login or checkpoint page. */
const WALL_PAGE = /^\/(?:login|checkpoint|accounts\/login)(?:\.php)?(?:[/?#]|$)/

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
  readonly cookies?: SessionProvider | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
  readonly now?: (() => number) | undefined
}

/** Reads of a page / API answer the site refused, retried after the shared cool-down. */
export const READ_ATTEMPTS = 3
/** After a verification page, the site's urls go to yt-dlp for this long (a circuit breaker). */
export const BLOCKED_MS = 10 * 60_000

/** What a login wall or a checkpoint page carries, on either site. */
const WALL = /\/accounts\/login|\/login\.php|\/checkpoint\/|\/challenge\/|checkpoint_required|login_form/

/**
 * A 403 on a page or the API: the site won't serve this client as it is (no
 * signed-in session, or this connection is not welcome) — waiting doesn't
 * change that. A wall, as a verification page is: the browser tries once,
 * else the source steps aside and yt-dlp reads the link at once, instead of
 * cool-downs of 30 s and more for nothing.
 */
const forbidden = (site: string): MetaError =>
  new MetaError('challenge', `${site} refused this (HTTP 403) — a signed-in session may be needed.`)

/** A 4xx other than 401 / 403 / 404 / 410 / 429: the request itself is not accepted any more. */
const unexpected = (status: number): boolean => status >= 400 && status < 500 && status !== 429

/**
 * The site no longer accepts the request this module builds (400, 405…): no
 * wait makes it accept it. As a changed page is: yt-dlp reads the link now.
 */
const rejected = (site: string, status: number): MetaError =>
  new MetaError(
    'format-changed',
    `${site} no longer accepts this request (HTTP ${status}) — without a signed-in session it may not show this list.`,
  )

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
  readonly #host: HostSession
  readonly #log: (level: 'info' | 'warn', message: string) => void
  readonly #now: () => number
  #blockedUntil = 0
  /**
   * Share-link hops as a page load (Sec-Fetch-* navigate, sent as given):
   * Facebook answers /share/r/… with a 400 to a Chrome that says `cors`, the
   * only mode Node's fetch sends. Cookieless, like the visitor who opened it.
   */
  readonly #hops: HttpSession

  constructor(options: MetaClientOptions) {
    this.site = options.site
    this.origin = options.origin.replace(/\/$/, '')
    this.host = new URL(this.origin).hostname
    this.session = new HttpSession({fetch: options.fetch})
    this.#hops = new HttpSession({fetch: options.fetch ?? navigationFetch})
    this.pacer = new Pacer(options.pacing, options.site)
    this.#sessionCookie = options.sessionCookie
    this.#browser = options.browser
    this.#log = options.log ?? (() => {})
    this.#now = options.now ?? Date.now
    this.#host = new HostSession({
      site: this.site,
      provider: options.cookies,
      session: this.session,
      log: this.#log,
      now: this.#now,
    })
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

  /** Use these cookies (and the agent that earned them, when given) from now on: a session the host obtained. */
  adoptCookies(session: SiteSession): void {
    this.#host.adopt(session)
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

  /** Load the host's cookies if they were never loaded or are old (see HostSession). */
  async loadCookies(): Promise<void> {
    await this.#host.load()
  }

  /** Forget the host's cookies (they stopped working): asked for again next time. */
  forgetCookies(): void {
    this.#host.forget()
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
   * 401 login, 403 a wall (as a verification page), another 4xx a changed request (yt-dlp takes the
   * link), 429 / 5xx refused — the pacer backs off); what the JSON
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

  /**
   * Follow one redirect hop of a short link; undefined when it doesn't
   * redirect. First as a page load (anonymous); then with the site's session
   * when that led nowhere useful: no redirect, or one to the login /
   * checkpoint page (a link only a signed-in visitor may open). One request
   * in the common case, at most 2.
   */
  async redirectOf(url: string, signal?: AbortSignal): Promise<string | undefined> {
    const location = async (session: HttpSession, headers?: Readonly<Record<string, string>>) =>
      this.pacer.run(async () => {
        const response = await session.get(url, {redirect: 'manual', headers, signal})
        void response.body?.cancel()
        const target = response.headers.get('location')
        return target ? new URL(target, url).href : undefined
      }, signal)
    const asPage = await location(this.#hops, DOCUMENT_NAVIGATION_HEADERS)
    if (asPage && !WALL_PAGE.test(new URL(asPage).pathname)) return asPage
    return (await location(this.session)) ?? asPage
  }

  /**
   * A refusal (429 / 5xx / empty answer) is retried after the shared cool-down.
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
      if (response.status === 403) throw forbidden(this.site)
      if (unexpected(response.status)) throw rejected(this.site, response.status)
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
      if (response.status === 403) throw forbidden(this.site)
      if (unexpected(response.status)) throw rejected(this.site, response.status)
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
