import type {CookieRecord} from '../core/cookies.js'
import type {HttpSession} from './http.js'

/**
 * The user's signed-in session for a site, as the host hands it to a native
 * source: the site's cookies (a browser's, or an in-app sign-in's) — and,
 * optionally, the user agent that earned them, since sites tie a session to
 * the client it was given to. Without one the source keeps its own agent.
 */
export type SessionCookies = ReadonlyArray<CookieRecord>
export type SiteSession = SessionCookies | {readonly cookies: SessionCookies; readonly userAgent?: string | undefined}
/** Asked for when a source starts talking to the site, and again when what it gave is old. */
export type SessionProvider = () => Promise<SiteSession | undefined>

/** Cookies the host hands over are asked for again after this long (a browser may have signed out). */
export const COOKIES_FRESH_MS = 6 * 60 * 60_000

/**
 * The host's session for one site, loaded into a source's HttpSession: once,
 * then again every COOKIES_FRESH_MS. Concurrent callers share one load. None
 * is not remembered: the user may sign in or pick a browser later, and asking
 * again is cheap (the host caches its jar). A host that fails to read it
 * leaves the session as it is.
 */
export class HostSession {
  readonly #site: string
  readonly #provider: SessionProvider | undefined
  readonly #session: HttpSession
  readonly #log: (level: 'info' | 'warn', message: string) => void
  readonly #now: () => number
  #at: number | undefined
  #loading: Promise<void> | undefined

  constructor(options: {
    readonly site: string
    readonly provider: SessionProvider | undefined
    readonly session: HttpSession
    readonly log: (level: 'info' | 'warn', message: string) => void
    readonly now?: (() => number) | undefined
  }) {
    this.#site = options.site
    this.#provider = options.provider
    this.#session = options.session
    this.#log = options.log
    this.#now = options.now ?? Date.now
  }

  /** Use this session from now on (one the host obtained). */
  adopt(given: SiteSession): void {
    const cookies = 'cookies' in given ? given.cookies : given
    const userAgent = 'cookies' in given ? given.userAgent : undefined
    this.#session.adopt({
      userAgent: userAgent || this.#session.userAgent,
      cookies: cookies.map(c => ({name: c.name, value: c.value, domain: c.domain})),
    })
    this.#at = this.#now()
  }

  /** Load the host's session if it was never loaded or is old. */
  async load(): Promise<void> {
    if (!this.#provider) return
    if (this.#at !== undefined && this.#now() - this.#at < COOKIES_FRESH_MS) return
    this.#loading ??= this.#provider()
      .then(
        given => {
          if (given) this.adopt(given)
        },
        error => this.#log('warn', `${this.#site}: the session cookies could not be read: ${String(error)}`),
      )
      .finally(() => {
        this.#loading = undefined
      })
    await this.#loading
  }

  /** Ask the host again next time (what it gave stopped working). */
  forget(): void {
    this.#at = undefined
  }
}
