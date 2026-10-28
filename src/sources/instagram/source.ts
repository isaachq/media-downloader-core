import {setTimeout as sleep} from 'node:timers/promises'
import type {ExtractResult} from '../../core/analyze.js'
import {DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import type {BrowserAssist} from '../browser.js'
import {
  DOCUMENT_NAVIGATION_HEADERS,
  type Fetch,
  HttpSession,
  IFRAME_NAVIGATION_HEADERS,
  navigationFetch,
} from '../http.js'
import {
  ANONYMOUS_ATTEMPTS,
  betweenAttemptsMs,
  SESSION_ATTEMPTS,
  SESSION_EXHAUSTED_SECONDS,
  variantFor,
} from '../internal/adaptive-retry.js'
import {MetaClient, type PageRead, type SessionProvider} from '../meta/client.js'
import {downloadPost} from '../meta/download.js'
import {MetaError, type MetaProblem, toDownloadError} from '../meta/errors.js'
import {type CursorPage, walkCursor} from '../meta/listing.js'
import {choicesOf, type MetaPost, shapeOf, summaryOf, videosOf} from '../meta/post.js'
import type {Pacer, PacerOptions} from '../pacer.js'
import {COOLING_DOWN} from '../pacer.js'
import {followShortLink, resolved, unresolvedMessage} from '../redirects.js'
import type {ListingProgress, MediaSource, SourceDownload, SourceFile} from '../source.js'
import {
  codeToPk,
  type InstagramAccount,
  PUBLIC_ORIGIN,
  readEmbedPage,
  readLoggedOutPostQuery,
  readMediaInfo,
  readOembed,
  readPostPage,
  readPostQuery,
  readProfileInfo,
  readReelsMedia,
  readTimelinePage,
  readWebInfoQuery,
} from './data.js'
import {
  API_GRAPHQL,
  API_ORIGIN,
  APP_ID,
  APP_USER_AGENT,
  ASBD_ID,
  DEFAULT_QUERIES,
  EMBED_PATH,
  GRAPHQL,
  type InstagramQueries,
  LOGGED_OUT_POST_QUERY,
  MEDIA_INFO,
  OEMBED,
  PAGE_SIZE,
  PROFILE_INFO,
  REELS_MEDIA,
  USER_FEED,
  WEB_INFO_QUERIES,
} from './endpoints.js'
import {highlightUrl, type InstagramLink, parseInstagramLink, postUrl, profileUrl, storiesUrl} from './links.js'
import {linkExpiry, QueryBook, RouteHealth} from './routes.js'

export type InstagramOptions = {
  /** Profiles list at most this many posts unless asked otherwise. Default 500. */
  readonly maxProfileItems?: number | undefined
  /** Pace of requests to instagram.com (pages, API, listing). Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** Tests: serve "Instagram" from another origin. */
  readonly origin?: string | undefined
  /** Tests: serve the app API (i.instagram.com) from another origin. Default: `origin` when that is set. */
  readonly apiOrigin?: string | undefined
  readonly fetch?: Fetch | undefined
  /** A real browser (the host app's) for pages Instagram only serves after its own check has run. */
  readonly browser?: BrowserAssist | undefined
  /**
   * The user's Instagram cookies (a browser's signed-in session), asked for
   * when something needs one — stories, highlights, private accounts the user
   * follows — and again when they are old. The engine passes the browser
   * cookies it already reads for yt-dlp.
   */
  readonly cookies?: SessionProvider | undefined
  /** The web client's query ids, should Instagram rotate them before a release does. */
  readonly queries?: Partial<InstagramQueries> | undefined
  /** Where the source reports what it did (the engine's log). */
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
  /** Tests: the pause between Instagram's own tries. Default 300–800 ms. */
  readonly retryPauseMs?: number | undefined
}

export const INSTAGRAM_PROFILE_DEFAULT_ITEMS = 500
/** Media links expire within hours; posts read longer ago than this are read again before downloading. */
const POST_FRESH_MS = 10 * 60_000
const CACHE_LIMIT = 5000
/** A profile listing is reused (or continued) for this long. */
const LISTING_FRESH_MS = 15 * 60_000
/** Stories change by the hour: a listing is reused for this long. */
const STORIES_FRESH_MS = 5 * 60_000
/** Profiles are listed this many posts at a time, each chunk kept as soon as it is in. */
export const PROFILE_CHUNK = 500
/** One try per anonymous route, not much patience: the web client's query follows. */
const ANONYMOUS_TIMEOUT_MS = 15_000
/** The least a caller is told to wait once every try of a post is spent and none was final. */
const SPENT_SECONDS = 60
/** What the user reads when every route to a public post got Instagram's wall. */
export const GATED_MESSAGE =
  'Instagram shows this post to signed-in accounts only (it is limited to some audiences): sign in to Instagram to download it.'
const SESSION_NEEDED =
  'Instagram did not return this post without a signed-in session. Sign in to Instagram and try again.'
const SESSION_EXPIRED =
  'Instagram no longer accepts the signed-in session (it expired or was signed out). Sign in to Instagram again.'

/** A read post, good until its media links expire (the CDN's `oe`, less a margin) or POST_FRESH_MS without one. */
type Cached = {readonly post: MetaPost; readonly at: number; readonly until: number}
/** Media links are not reused this close to the CDN's own expiry. */
const EXPIRY_MARGIN_MS = 10 * 60_000
/** Share links → what they lead to (never changes): kept this many. */
const SHARE_LIMIT = 2000

/** The anonymous routes, cheapest first: the default order among routes that have done as well. */
const ROUTES = ['embed', 'web info', 'post page', 'logged-out query', 'app API'] as const
type Route = (typeof ROUTES)[number]

function isAnonymousRoute(name: string): name is Route {
  for (const route of ROUTES) if (route === name) return true
  return false
}
type KeptListing = {posts: MetaPost[]; cursor: string | undefined; complete: boolean; at: number}

/**
 * Instagram, natively: post pages and the web client's own API over plain
 * HTTP, media straight from the CDN. Whole profiles, posts, reels, carousels,
 * stories and highlights. No signatures, no challenge solving — when
 * Instagram asks to slow down, every request backs off together (Pacer);
 * what Instagram keeps for signed-in accounts is read with the user's own
 * session when the host supplies one, and reported as such when it doesn't.
 */
export class InstagramSource implements MediaSource {
  readonly name = 'Instagram'
  readonly #client: MetaClient
  readonly #maxProfileItems: number
  readonly #queries: InstagramQueries
  /** Posts seen in listings and pages, by id (insertion order = age: oldest evicted first). */
  readonly #posts = new Map<string, Cached>()
  /** shortcode → id, for urls that name the code. */
  readonly #byCode = new Map<string, string>()
  /** user name (lower case) → account, read once per session. */
  readonly #accounts = new Map<string, InstagramAccount>()
  /** account id → what its listing gave, reused for LISTING_FRESH_MS. */
  readonly #listings = new Map<string, KeptListing>()
  /** reel id (user id, highlight:<id>) → its stories. */
  readonly #stories = new Map<string, {posts: MetaPost[]; title?: string | undefined; at: number}>()
  readonly #log: (level: 'info' | 'warn', message: string) => void
  /** The anonymous routes' own session: never the user's cookies, only what those routes hand out. */
  readonly #anonymous: HttpSession
  readonly #apiOrigin: string
  /** How each anonymous route (and query id) has been answering on this network. */
  readonly #health = new RouteHealth()
  /** Pause between a post's own tries. Tests set 0. */
  readonly #retryPauseMs: number | undefined
  /** The query ids and token Instagram's own post page names now. */
  readonly #book = new QueryBook()
  /** The `web_info` query ids, a host's own first. */
  readonly #webInfoIds: readonly string[]
  /** Posts being read now, by numeric id: a second read of the same post waits for the first. */
  readonly #reading = new Map<string, Promise<MetaPost>>()
  /** Share link → where it leads (insertion order: oldest dropped first). */
  readonly #shares = new Map<string, Exclude<InstagramLink, {kind: 'short'}>>()

  constructor(options: InstagramOptions = {}) {
    this.#client = new MetaClient({
      site: 'Instagram',
      origin: options.origin ?? PUBLIC_ORIGIN,
      sessionCookie: 'sessionid',
      pacing: options.pacing,
      fetch: options.fetch,
      browser: options.browser,
      cookies: options.cookies,
      log: options.log,
    })
    this.#maxProfileItems = Math.max(1, options.maxProfileItems ?? INSTAGRAM_PROFILE_DEFAULT_ITEMS)
    this.#queries = {...DEFAULT_QUERIES, ...options.queries}
    this.#log = options.log ?? (() => {})
    this.#retryPauseMs = options.retryPauseMs
    // its own transport: the embed is walled unless asked for as a page load, which Node's fetch can't say
    this.#anonymous = new HttpSession({fetch: options.fetch ?? navigationFetch, timeoutMs: ANONYMOUS_TIMEOUT_MS})
    this.#apiOrigin = (options.apiOrigin ?? options.origin ?? API_ORIGIN).replace(/\/$/, '')
    const own = options.queries?.webInfo
    this.#webInfoIds = own ? [own, ...WEB_INFO_QUERIES.filter(id => id !== own)] : WEB_INFO_QUERIES
  }

  get available(): boolean {
    return this.#client.available
  }

  handles(url: string): boolean {
    return parseInstagramLink(url, this.#client.host) !== undefined
  }

  defaultListSize(url: string): number | undefined {
    return parseInstagramLink(url, this.#client.host)?.kind === 'profile' ? this.#maxProfileItems : undefined
  }

  async analyze(
    url: string,
    opts: {
      signal?: AbortSignal
      maxEntries?: number
      onProgress?: (progress: ListingProgress) => void
      known?: ReadonlySet<string>
      attempt?: number
    } = {},
  ): Promise<AnalysisResult> {
    try {
      const link = await this.#resolve(url, opts.signal)
      switch (link.kind) {
        case 'post':
          return this.#videoAnalysis(await this.#readPost(link.code, opts.signal, false, opts.attempt))
        case 'profile':
          return await this.#profile(link.user, opts.maxEntries, opts.signal, opts.onProgress, opts.known)
        case 'stories': {
          const account = await this.#account(link.user, opts.signal)
          const stories = await this.#reel(account.id, opts.signal)
          if (link.id) return this.#videoAnalysis(storyItem(stories.posts, link.id))
          return this.#storiesAnalysis(
            `stories:${account.id}`,
            storiesUrl(PUBLIC_ORIGIN, account.user),
            `Instagram @${account.user} stories`,
            account.name ?? account.user,
            stories.posts,
            opts.maxEntries,
          )
        }
        case 'highlight': {
          const reel = await this.#reel(`highlight:${link.id}`, opts.signal)
          const owner = reel.posts[0]
          return this.#storiesAnalysis(
            `highlight:${link.id}`,
            highlightUrl(PUBLIC_ORIGIN, link.id),
            `Instagram highlight ${reel.title ?? link.id}${owner ? ` · @${owner.author}` : ''}`,
            owner?.authorName ?? owner?.author,
            reel.posts,
            opts.maxEntries,
          )
        }
      }
    } catch (error) {
      throw toDownloadError(error, this.name)
    }
  }

  async preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {
      signal?: AbortSignal | undefined
      onResult?: ((url: string, result: ExtractResult) => void) | undefined
      attempt?: number | undefined
    },
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    // items from a listing are already known: no request at all. Others are paced.
    await Promise.all(
      items.map(async ({url}) => {
        const result = await this.#check(url, opts.signal, opts.attempt)
        results.set(url, result)
        opts.onResult?.(url, result)
      }),
    )
    return results
  }

  async download(task: SourceDownload): Promise<SourceFile> {
    let post: MetaPost | undefined
    try {
      const link = await this.#resolve(task.url, task.signal)
      post = await this.#postFor(link, task.signal, task.fresh)
      if (shapeOf(post) === 'empty') throw new MetaError('format-changed', 'This post has no media to download.')
      return await downloadPost({
        client: this.#client,
        post,
        task,
        site: this.name,
        referer: `${this.#client.origin}/`,
      })
    } catch (error) {
      // the links may be stale: the next attempt reads the post again
      if (post) this.#posts.delete(post.id)
      throw toDownloadError(error, this.name)
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  /** Share links are redirects (a hop or a few): landing anywhere else means the post is gone. */
  async #resolve(url: string, signal?: AbortSignal): Promise<Exclude<InstagramLink, {kind: 'short'}>> {
    const link = parseInstagramLink(url, this.#client.host)
    if (!link) {
      throw new DownloadError(
        'invalid-request',
        'Not an Instagram post, profile, stories or highlight url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    if (link.kind !== 'short') return link
    // a share link leads where it led: asked once (its redirect only, never the page)
    const known = this.#shares.get(link.url)
    if (known) return known
    const followed = await followShortLink(
      link.url,
      url => this.#client.redirectOf(url, signal),
      url => resolved(parseInstagramLink(url, this.#client.host)),
    )
    if (followed.ok) {
      this.#shares.set(link.url, followed.link)
      if (this.#shares.size > SHARE_LIMIT) this.#shares.delete(this.#shares.keys().next().value!)
      return followed.link
    }
    if (followed.reason === 'dead-end' && /\/accounts\/login/.test(followed.resolvedUrl))
      throw new MetaError('login-required', 'Instagram shows where this share link leads to signed-in sessions only.')
    throw new MetaError('removed', unresolvedMessage(followed.reason))
  }

  /** The post a url points at, from memory when recent enough to download, else read again. */
  async #postFor(
    link: Exclude<InstagramLink, {kind: 'short'}>,
    signal: AbortSignal,
    fresh: boolean,
  ): Promise<MetaPost> {
    if (link.kind === 'post') return this.#readPost(link.code, signal, fresh)
    if (link.kind === 'stories' && link.id) {
      const account = await this.#account(link.user, signal)
      const cached = this.#posts.get(link.id)
      if (!fresh && cached && this.#isFresh(cached)) return cached.post
      return storyItem((await this.#reel(account.id, signal, true)).posts, link.id)
    }
    throw new DownloadError('invalid-request', 'A profile or a set of stories is not a single post.')
  }

  // ─── posts ───────────────────────────────────────────────────────────────

  /**
   * One post by shortcode. Five anonymous tries first, one door each (a
   * different door and Accept-Language per try; the first success is the
   * post). Then one visitor read, then the user's session up to three times.
   * Stories, highlights and profile listings do not come through here.
   *
   * Time Complexity: O(1) requests, capped at 5 anonymous + 1 oEmbed + 1 visitor + 3 session.
   */
  async #readPost(code: string, signal?: AbortSignal, fresh = false, attempt = 1): Promise<MetaPost> {
    const id = this.#byCode.get(code)
    const cached = id ? this.#posts.get(id) : undefined
    if (!fresh && cached && this.#isFresh(cached) && shapeOf(cached.post) !== 'empty') {
      if (!cached.post.songNeedsSession) return cached.post
      // read before the user signed in: with a session now, its song is one request away
      const post = await this.#withSong(cached.post, signal)
      if (post !== cached.post) this.#remember(post)
      return post
    }
    const key = canonicalKey(code)
    const pending = this.#reading.get(key)
    if (pending && !fresh) return pending
    const read = this.#readPostOnce(code, signal, attempt).finally(() => this.#reading.delete(key))
    this.#reading.set(key, read)
    return read
  }

  /**
   * Anonymous variants first, then one visitor read, then the session.
   * `attempt` from the engine's own loop is not a sixth strategy: this read
   * finishes the five-plus-three policy itself and returns an error that
   * loop does not retry. A public post never starts on the user's cookies.
   */
  async #readPostOnce(code: string, signal: AbortSignal | undefined, _attempt: number): Promise<MetaPost> {
    const found = await this.#anonymousAttempts(code, signal)
    const post = found.post ?? (await this.#afterAnonymous(code, signal, found.walled))
    const withSong = await this.#withSong(post, signal)
    this.#remember(withSong)
    return withSong
  }

  /**
   * Up to five anonymous tries, one door each: the first door of this try's
   * order not yet asked and not resting, with this try's Accept-Language. A
   * door that already refused stays cooled, so a wall is not asked five times.
   * The first post ends the phase. O(1) requests: at most one per try.
   */
  async #anonymousAttempts(
    code: string,
    signal?: AbortSignal,
  ): Promise<{readonly post?: MetaPost; readonly walled: boolean}> {
    const url = postUrl(this.#client.origin, code)
    const base = this.#health.order(ROUTES, route => route)
    const tried = new Set<string>()
    let walled = false
    for (let attempt = 1; attempt <= ANONYMOUS_ATTEMPTS; attempt++) {
      const variant = variantFor(url, attempt, base)
      const anonymous = await this.#readAnonymously(code, signal, variant.routeOrder, variant.headers, tried, 1)
      walled ||= anonymous.walled
      if (anonymous.post) return {post: anonymous.post, walled}
      if (signal?.aborted || anonymous.asked === 0 || attempt === ANONYMOUS_ATTEMPTS) break
      if (!this.#anotherDoor(tried)) break
      await this.#pause(signal)
    }
    return {walled}
  }

  /** A door not yet asked in this phase and not resting. O(1), five doors. */
  #anotherDoor(tried: ReadonlySet<string>): boolean {
    for (const route of ROUTES) if (!tried.has(route) && this.#health.coolingDownMs(route) === 0) return true
    return false
  }

  /**
   * The anonymous variants did not read it. oEmbed separates gone from gated.
   * A gated post skips the visitor query. Otherwise one visitor read, then
   * the session phase. O(1) requests.
   */
  async #afterAnonymous(code: string, signal: AbortSignal | undefined, walled: boolean): Promise<MetaPost> {
    this.#log(
      'info',
      `Instagram: ${code} not readable anonymously — asking the web client, then the session if it is needed`,
    )
    const probe = await this.#probe(code, signal)
    if (probe === 'gone') throw new MetaError('removed', 'This Instagram post no longer exists, or is private.')
    /** The visitor read was refused, not walled: what a caller without a session is told. */
    let spent: DownloadError | undefined
    if (probe !== 'gated') {
      try {
        return await this.#readSigned(code, signal)
      } catch (error) {
        if (signal?.aborted || isFinal(error)) throw error
        // the visitor read would wait out a cool-down longer than this paste: the session phase
        // decides (sign in, or the five minutes), instead of reporting the cool-down itself
        if (error instanceof DownloadError && error.details === COOLING_DOWN) {
          if (!walled) throw error
        } else if (error instanceof MetaError && error.problem === 'format-changed') {
          // a changed page, and nothing was walled, is the page: yt-dlp can take the link
          if (!walled) throw error
        } else if (!(error instanceof MetaError && WALL_PROBLEMS.has(error.problem))) {
          // a network error: this policy's tries are spent, so it says when to come back
          // itself (the engine's loop would start the five doors again, three times over)
          throw this.#spent(error)
        } else if (error.problem === 'refused') {
          // a refusal (429 / 5xx) is not a sign-in matter: the session may still get through, but
          // without one the answer is when to come back, not "sign in"
          spent = this.#spent(error)
        }
      }
    }
    return this.#sessionAttempts(code, signal, probe === 'gated', spent)
  }

  /**
   * The error that ends this post's read when its last try failed for a
   * reason that may pass later: "try again in about N", dated by the pacer's
   * own cool-down when it has one, a minute otherwise. `COOLING_DOWN` keeps
   * the engine's analysis loop from starting the five doors again. O(1).
   */
  #spent(error: unknown): DownloadError {
    const cooling = Math.ceil(this.#client.pacer.coolingDownMs / 1000)
    const seconds = Math.max(SPENT_SECONDS, cooling)
    const when = seconds < 90 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`
    const why = error instanceof Error ? error.message : String(error)
    return new DownloadError(
      'network',
      `Instagram did not return this post (${why}). Try again in about ${when}.`,
      COOLING_DOWN,
      {retryAfterSeconds: seconds},
      'retry-later',
    )
  }

  /**
   * The user's session, only after the anonymous tries. No cookies: say so,
   * and do not invent failed requests. With cookies: three single reads.
   * A challenge stops the three (it will not change on the next one); a 401
   * is the session itself, expired or signed out: "sign in again" at once,
   * not a wait; a cool-down the pacer already dated is that date. When the
   * three are spent, the caller is told to come back in five minutes, and
   * the engine's own retry loop does not start the five again.
   */
  async #sessionAttempts(
    code: string,
    signal: AbortSignal | undefined,
    gated: boolean,
    spent?: DownloadError,
  ): Promise<MetaPost> {
    await this.#client.loadCookies()
    if (!this.#client.signedIn) {
      if (spent) throw spent
      throw new MetaError('login-required', gated ? GATED_MESSAGE : SESSION_NEEDED)
    }
    for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt++) {
      try {
        this.#log('info', `Instagram: ${code}: reading it with the session (try ${attempt} of ${SESSION_ATTEMPTS})`)
        return await this.#readWithSession(code, signal)
      } catch (error) {
        if (signal?.aborted || isFinal(error)) throw error
        if (error instanceof DownloadError && error.details === COOLING_DOWN) throw error
        if (error instanceof MetaError && error.problem === 'login-required') {
          throw new MetaError('login-required', SESSION_EXPIRED)
        }
        if (error instanceof MetaError && error.problem === 'challenge') break
        this.#log(
          'info',
          `Instagram: ${code}: the session did not read it (${error instanceof Error ? error.message : String(error)})`,
        )
        if (attempt < SESSION_ATTEMPTS) await this.#pause(signal)
      }
    }
    this.#log('warn', `Instagram: ${code}: the session did not read it after ${SESSION_ATTEMPTS} tries`)
    throw new DownloadError(
      'network',
      'Instagram still did not return this post with the signed-in session. Try again in about 5 minutes.',
      COOLING_DOWN,
      {retryAfterSeconds: SESSION_EXHAUSTED_SECONDS},
      'retry-later',
    )
  }

  /** The pause between two tries of the same post. Tests set it to 0. */
  async #pause(signal?: AbortSignal): Promise<void> {
    const ms = this.#retryPauseMs ?? betweenAttemptsMs()
    if (ms <= 0) return
    await sleep(ms, undefined, signal ? {signal} : undefined)
  }

  /**
   * A photo post without its song: the app API with the user's session has
   * it (one request); without a session the post says the song needs one.
   * Videos and posts that have their song are returned as they are.
   */
  async #withSong(post: MetaPost, signal?: AbortSignal): Promise<MetaPost> {
    if (post.music || shapeOf(post) === 'empty' || videosOf(post).length > 0 || !post.code) return post
    await this.#client.loadCookies()
    if (!this.#client.signedIn) return post.songNeedsSession ? post : {...post, songNeedsSession: true}
    const {songNeedsSession: _, ...known} = post
    try {
      const signed = await this.#readWithSession(post.code, signal)
      return signed.music ? {...known, music: signed.music} : known
    } catch (error) {
      if (signal?.aborted) throw error
      // a challenge or a wall for a song: the post goes without it — never a verification for a song
      this.#log(
        'info',
        `Instagram: ${post.code}: its song could not be read with the session (${String(error)}) — delivered without its song`,
      )
      return known
    }
  }

  /**
   * The app API as the signed-in web client asks it: the whole v1 item, song
   * included. One request (`once`): the session phase counts its own three
   * tries. Quiet: a verification answer is the caller's (no browser, the
   * site keeps its source for the other links).
   */
  #readWithSession(code: string, signal?: AbortSignal): Promise<MetaPost> {
    const page = postUrl(this.#client.origin, code)
    return this.#client.json(`${this.#client.origin}${MEDIA_INFO(codeToPk(code))}`, readMediaInfo, {
      signal,
      headers: this.#apiHeaders(page),
      quiet: true,
      once: true,
    })
  }

  /**
   * oEmbed, without a session: 'gone' on a 404, 'gated' when Instagram limits
   * the post to some audiences (a 400 naming `gating_type`: signed-in
   * accounts only), 'there' on an answer, undefined when it says nothing. O(1).
   */
  async #probe(code: string, signal?: AbortSignal): Promise<'gone' | 'gated' | 'there' | undefined> {
    try {
      const query = new URLSearchParams({url: postUrl(PUBLIC_ORIGIN, code)})
      const response = await this.#client.pacer.run(
        () =>
          this.#anonymous.get(`${this.#client.origin}${OEMBED}?${query}`, {
            headers: {Accept: 'application/json'},
            signal,
          }),
        signal,
      )
      if (response.status === 404) return 'gone'
      const answer = readOembed(JSON.parse(await response.text()))
      if (answer.gated) return 'gated'
      if (!response.ok) return undefined
      return answer.mediaId ? 'there' : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The routes that want a session or a browser: the web client's post query
   * (it asks for a session nowadays), then the post page through the client
   * (a browser on a challenge).
   *
   * Time Complexity: O(Q) where Q is the response payload size.
   */
  async #readSigned(code: string, signal?: AbortSignal): Promise<MetaPost> {
    const page = postUrl(this.#client.origin, code)
    // the user's cookies, once loaded (a song asked for earlier), stay out of this step: a visitor asks
    const visitor = this.#client.signedIn
    try {
      return await this.#graphql(
        this.#queries.post,
        {shortcode: code, fetch_tagged_user_count: null, hoisted_comment_id: null, hoisted_reply_id: null},
        readPostQuery,
        page,
        signal,
        visitor,
        true,
      )
    } catch (error) {
      if (!(error instanceof MetaError) || (error.problem !== 'format-changed' && error.problem !== 'login-required'))
        throw error
      // a login answer is the session phase's to handle: reading the login page here cools the
      // whole network for 30 s, and a paste gives up at 15 s — "try later" instead of "sign in"
      if (error.problem === 'login-required') throw error
      this.#log('info', `Instagram: the post query did not answer for ${code} (${error.message}) — reading its page`)
      return await this.#client.page(page, readPostPage, {signal, visitor, keepSource: true})
    }
  }

  /**
   * The anonymous routes in this try's order, at most `doors` of them asked
   * (a route with nothing to ask with yet does not count). A route that says
   * the post is gone or private ends the search. A route that refuses sits
   * out for the rest of the phase: the next try does not wake it. A route in
   * cool-down is skipped on every try, not only the first.
   *
   * Time Complexity: O(R) requests, R <= min(doors, 5).
   */
  async #readAnonymously(
    code: string,
    signal: AbortSignal | undefined,
    routeOrder: readonly string[],
    headers: Readonly<Record<string, string>>,
    tried: Set<string>,
    doors: number = ROUTES.length,
  ): Promise<{
    readonly post?: MetaPost
    readonly walled: boolean
    readonly failures: readonly string[]
    readonly asked: number
  }> {
    let walled = false
    let asked = 0
    const failures: string[] = []
    for (const name of routeOrder) {
      if (!isAnonymousRoute(name)) continue
      const route = name
      if (signal?.aborted) break
      const cooling = this.#health.coolingDownMs(route)
      if (tried.has(route) || cooling > 0) {
        if (cooling > 0) {
          failures.push(`${route}: resting ${Math.ceil(cooling / 1000)} s after a refusal`)
          walled = true
        }
        continue
      }
      tried.add(route)
      asked++
      try {
        const post = await this.#readRoute(route, code, signal, headers)
        if (!post) {
          tried.delete(route)
          asked--
          continue // nothing to ask it with yet (the logged-out query before any page named it)
        }
        if (!usable(post)) throw new MetaError('format-changed', 'the post came without its media links')
        this.#health.succeeded(route)
        this.#log('info', `Instagram: ${code} read anonymously (${route})`)
        return {post, walled, failures, asked}
      } catch (error) {
        // a cool-down longer than the caller waits ("try again in N") is the answer for every route
        if (signal?.aborted || error instanceof DownloadError) throw error
        if (error instanceof MetaError && (error.problem === 'removed' || error.problem === 'private')) throw error
        if (error instanceof NetworkLimit) {
          walled = true
          tried.delete(route)
        } else if (error instanceof MetaError && WALL_PROBLEMS.has(error.problem)) {
          walled = true
          this.#health.refused(route)
        } else this.#health.failed(route)
        failures.push(`${route}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (asked >= doors) break
    }
    return {walled, failures, asked}
  }

  /** One anonymous route; undefined when it has nothing to ask with yet. */
  async #readRoute(
    route: Route,
    code: string,
    signal: AbortSignal | undefined,
    headers: Readonly<Record<string, string>>,
  ): Promise<MetaPost | undefined> {
    const origin = this.#client.origin
    switch (route) {
      case 'embed':
        return readEmbedPage(
          await this.#anonymousGet(
            `${origin}${EMBED_PATH(code)}`,
            {...IFRAME_NAVIGATION_HEADERS, Referer: `${origin}/`, ...headers},
            signal,
          ),
        )
      case 'web info':
        return this.#readWebInfo(code, signal, headers)
      case 'post page': {
        // the embed has no data for a photo or a carousel of photos (contextJSON: null);
        // the post page a logged-out visitor gets carries the whole item — and names the
        // query ids its own client preloads now, for the logged-out query below
        const page = await this.#anonymousGet(
          postUrl(origin, code),
          {...DOCUMENT_NAVIGATION_HEADERS, ...headers},
          signal,
        )
        this.#book.learn(page.html)
        return readPostPage(page)
      }
      case 'logged-out query': {
        const docId = this.#book.id(LOGGED_OUT_POST_QUERY)
        const lsd = this.#book.lsd
        if (!docId || !lsd) return undefined
        const body = new URLSearchParams({
          lsd,
          doc_id: docId,
          variables: JSON.stringify({media_id: codeToPk(code)}),
          server_timestamps: 'true',
        })
        return readLoggedOutPostQuery(
          await this.#anonymousJson(
            `${origin}${API_GRAPHQL}`,
            body.toString(),
            {'X-FB-LSD': lsd, ...headers},
            postUrl(origin, code),
            signal,
          ),
        )
      }
      case 'app API': {
        const answer = await this.#anonymousGet(
          `${this.#apiOrigin}${MEDIA_INFO(codeToPk(code))}`,
          {
            'User-Agent': APP_USER_AGENT,
            Accept: '*/*',
            'X-IG-App-ID': APP_ID,
            'X-IG-App-Locale': 'en_US',
            'X-IG-Device-Locale': 'en_US',
            'X-IG-Mapped-Locale': 'en_US',
            'X-FB-HTTP-Engine': 'Liger',
            ...headers,
          },
          signal,
        )
        return readMediaInfo(parseJson(answer.html))
      }
    }
  }

  /**
   * The `web_info` query: its query ids best first (a host's own, then the
   * built-in ones), the next when one stops answering. Each id keeps its own
   * health, so a stale id is skipped from then on. O(D) requests, D <= 3.
   */
  async #readWebInfo(
    code: string,
    signal?: AbortSignal,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<MetaPost> {
    const page = postUrl(this.#client.origin, code)
    let last: unknown = new MetaError('format-changed', 'No web_info query id to ask.')
    for (const id of this.#health.order(this.#webInfoIds, id => `web info ${id}`)) {
      if (this.#health.coolingDownMs(`web info ${id}`) > 0) continue
      const body = new URLSearchParams({
        doc_id: id,
        variables: JSON.stringify({
          shortcode: code,
          __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
        }),
        server_timestamps: 'true',
      })
      try {
        const post = readWebInfoQuery(
          await this.#anonymousJson(`${this.#client.origin}${GRAPHQL}`, body.toString(), headers, page, signal),
        )
        this.#health.succeeded(`web info ${id}`)
        return post
      } catch (error) {
        if (signal?.aborted || isFinal(error) || error instanceof DownloadError || error instanceof NetworkLimit)
          throw error
        if (error instanceof MetaError && WALL_PROBLEMS.has(error.problem)) this.#health.refused(`web info ${id}`)
        else this.#health.failed(`web info ${id}`)
        last = error
      }
    }
    throw last
  }

  /** One GET of an anonymous route, paced with the rest of instagram.com. 401 / 403 / 429 are the wall. */
  async #anonymousGet(url: string, headers: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<PageRead> {
    const response = await this.#client.pacer.run(() => this.#anonymous.get(url, {headers, signal}), signal)
    const html = await response.text()
    refusal(response.status, this.#client.pacer)
    // a 404 here may be the route, not the post: the web client's query tells
    if (!response.ok) throw new MetaError('format-changed', `Instagram answered HTTP ${response.status}.`)
    return {html, url: response.url || url, status: response.status}
  }

  /** One POST of an anonymous query, as the logged-out web client sends it; the answer as JSON. */
  async #anonymousJson(
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    referer: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const csrf = this.#anonymous.cookie(new URL(url).hostname, 'csrftoken')
    const response = await this.#client.pacer.run(
      () =>
        this.#anonymous.request(url, {
          method: 'POST',
          body,
          headers: {
            Accept: '*/*',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-IG-App-ID': APP_ID,
            'X-ASBD-ID': ASBD_ID,
            'X-Requested-With': 'XMLHttpRequest',
            Origin: this.#client.origin,
            Referer: referer,
            ...(csrf && {'X-CSRFToken': csrf}),
            ...headers,
          },
          signal,
        }),
      signal,
    )
    const text = await response.text()
    refusal(response.status, this.#client.pacer)
    if (!response.ok) throw new MetaError('format-changed', `Instagram answered HTTP ${response.status}.`)
    return parseJson(text)
  }

  async #check(url: string, signal?: AbortSignal, attempt = 1): Promise<ExtractResult> {
    try {
      const link = await this.#resolve(url, signal)
      if (link.kind === 'profile' || (link.kind === 'stories' && !link.id) || link.kind === 'highlight') {
        throw new DownloadError('invalid-request', 'A profile or a set of stories is not a single post.')
      }
      let post: MetaPost | undefined
      if (link.kind === 'post') {
        const id = this.#byCode.get(link.code)
        post = id ? this.#posts.get(id)?.post : undefined
      } else post = this.#posts.get(link.id!)?.post
      post ??=
        link.kind === 'post'
          ? await this.#readPost(link.code, signal, false, attempt)
          : await this.#postFor(link, signal ?? new AbortController().signal, false)
      if (shapeOf(post) === 'empty') throw new MetaError('format-changed', 'This post has no media to download.')
      return {ok: true, analysis: this.#videoAnalysis(post)}
    } catch (error) {
      return {ok: false, error: toDownloadError(error, this.name).toJSON()}
    }
  }

  /** Its media links still have time to download. O(1). */
  #isFresh(cached: Cached): boolean {
    return Date.now() < cached.until
  }

  /**
   * Keep a read post until its links expire: the earliest CDN `oe` among
   * them, less a margin, or POST_FRESH_MS when they carry none. O(k) for its k links.
   */
  #remember(post: MetaPost): void {
    const at = Date.now()
    let expires = Number.POSITIVE_INFINITY
    for (const item of post.items) {
      const links = item.kind === 'video' ? item.renditions.flatMap(rendition => rendition.urls) : item.urls
      for (const link of links) expires = Math.min(expires, linkExpiry(link) ?? Number.POSITIVE_INFINITY)
    }
    const until = Number.isFinite(expires) ? Math.max(at, expires - EXPIRY_MARGIN_MS) : at + POST_FRESH_MS
    this.#posts.delete(post.id)
    this.#posts.set(post.id, {post, at, until})
    if (post.code) this.#byCode.set(post.code, post.id)
    if (this.#posts.size > CACHE_LIMIT) {
      const oldest = this.#posts.keys().next().value!
      const gone = this.#posts.get(oldest)
      this.#posts.delete(oldest)
      if (gone?.post.code) this.#byCode.delete(gone.post.code)
    }
  }

  #videoAnalysis(post: MetaPost): VideoAnalysis {
    return {kind: 'video', media: summaryOf(post, this.name), choices: choicesOf(post)}
  }

  // ─── accounts and profiles ───────────────────────────────────────────────

  async #account(user: string, signal?: AbortSignal): Promise<InstagramAccount> {
    const key = user.toLowerCase()
    const known = this.#accounts.get(key)
    if (known) return known
    await this.#client.loadCookies()
    const query = new URLSearchParams({username: user})
    const account = await this.#client.json(`${this.#client.origin}${PROFILE_INFO}?${query}`, readProfileInfo, {
      signal,
      headers: this.#apiHeaders(profileUrl(this.#client.origin, user)),
      recoverAt: profileUrl(this.#client.origin, user),
    })
    this.#accounts.set(key, account)
    this.#accounts.set(account.user.toLowerCase(), account)
    return account
  }

  async #profile(
    user: string,
    maxEntries: number | undefined,
    abort?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
    /** Posts already had: list from the newest until they start (an incremental sync). */
    owned?: ReadonlySet<string>,
  ): Promise<PlaylistAnalysis> {
    const account = await this.#account(user, abort)
    if (account.isPrivate && !this.#client.signedIn) {
      throw new MetaError('private', `@${account.user} is a private account.`)
    }
    const max = Math.max(
      1,
      Math.min(maxEntries ?? this.#maxProfileItems, account.mediaCount ?? Number.POSITIVE_INFINITY),
    )
    onProgress?.({listed: 0, expected: max})
    // a recent listing answers at once, or is continued where it stopped; an incremental walk
    // wants the newest posts, so it starts afresh
    const kept = this.#listings.get(account.id)
    const fresh = kept && !owned && Date.now() - kept.at < LISTING_FRESH_MS ? kept : undefined
    let posts: MetaPost[] = fresh?.posts.slice(0, max) ?? []
    let cursor = fresh?.cursor
    let complete = fresh?.complete ?? false
    let caughtUp = false
    const cached = fresh !== undefined && (fresh.posts.length >= max || fresh.complete)
    const keep = () => {
      const longest = this.#listings.get(account.id)
      if (!longest || posts.length >= longest.posts.length || Date.now() - longest.at >= LISTING_FRESH_MS) {
        this.#listings.set(account.id, {posts, cursor, complete, at: Date.now()})
      }
    }
    if (account.mediaCount === 0) posts = []
    else if (!cached) {
      try {
        // every chunk is kept as soon as it is listed: a refusal, a cancel or a closed
        // preview never loses it, and the next request continues from its cursor
        while (posts.length < max && !complete) {
          const target = Math.min(max, posts.length + PROFILE_CHUNK)
          const listing = await walkCursor(next => this.#timelinePage(account, next, abort), {
            max: target,
            idOf: post => post.id,
            isPinned: post => post.pinned,
            resume: posts.length > 0 || cursor !== undefined ? {items: posts, cursor} : undefined,
            known: owned,
            onProgress: listed => onProgress?.({listed, expected: max}),
            site: 'Instagram',
          })
          posts = listing.items
          cursor = listing.cursor
          complete = listing.complete
          caughtUp = listing.caughtUp
          keep()
          if (caughtUp || posts.length < target) break
        }
      } catch (error) {
        if (abort?.aborted) throw error
        // the listing query is gone (Instagram rotated it): the first posts the profile info carries
        if (error instanceof MetaError && error.problem === 'format-changed' && posts.length === 0) {
          this.#log('warn', `Instagram: @${account.user} listing query did not answer (${error.message})`)
          if (account.firstPage.items.length === 0) throw error
          posts = account.firstPage.items.slice(0, max)
          cursor = account.firstPage.next
          complete = cursor === undefined
          keep()
        } else if (posts.length === 0) throw error
        else {
          // a refusal half-way returns what was listed (the preview offers to continue)
          this.#log(
            'warn',
            `Instagram: @${account.user} listing stopped at ${posts.length} of ${max} (${String(error)}) — load again to continue`,
          )
        }
      }
    }
    onProgress?.({listed: posts.length, expected: max})
    for (const post of posts) this.#remember(post)
    return {
      kind: 'playlist',
      id: account.id,
      url: profileUrl(PUBLIC_ORIGIN, account.user),
      title: `Instagram @${account.user}`,
      uploader: account.name ?? account.user,
      extractor: this.name,
      entries: posts.map((post, i) => ({...summaryOf(post, this.name), index: i + 1})),
      choices: genericChoices(),
      total: account.mediaCount,
      complete,
      caughtUp: caughtUp || undefined,
    }
  }

  /**
   * One page of a profile's posts: the signed-in feed when the session is
   * signed in (what the app itself reads), else the web client's timeline query.
   */
  async #timelinePage(
    account: InstagramAccount,
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<CursorPage<MetaPost>> {
    const referer = profileUrl(this.#client.origin, account.user)
    if (this.#client.signedIn) {
      const query = new URLSearchParams({count: String(PAGE_SIZE), ...(cursor && {max_id: cursor})})
      return this.#client.json(`${this.#client.origin}${USER_FEED}${account.id}/?${query}`, readTimelinePage, {
        signal,
        headers: this.#apiHeaders(referer),
        recoverAt: referer,
      })
    }
    const data = {
      count: PAGE_SIZE,
      include_reel_media_seen_timestamp: true,
      include_relationship_info: true,
      latest_besties_reel_media: true,
      latest_reel_media: true,
    }
    const variables =
      cursor === undefined
        ? {data, username: account.user, __relay_internal__pv__PolarisIsLoggedInrelayprovider: false}
        : {
            after: cursor,
            before: null,
            data,
            first: PAGE_SIZE,
            last: null,
            username: account.user,
            __relay_internal__pv__PolarisIsLoggedInrelayprovider: false,
          }
    return this.#graphql(
      cursor === undefined ? this.#queries.profilePosts : this.#queries.profilePostsPage,
      variables,
      readTimelinePage,
      referer,
      signal,
    )
  }

  // ─── stories ─────────────────────────────────────────────────────────────

  /** The current stories of a reel (a user id, or `highlight:<id>`): signed-in sessions only. */
  async #reel(reelId: string, signal?: AbortSignal, fresh = false) {
    const kept = this.#stories.get(reelId)
    if (!fresh && kept && Date.now() - kept.at < STORIES_FRESH_MS) return kept
    await this.#client.requireSession(reelId.startsWith('highlight:') ? 'highlights' : 'stories')
    const query = new URLSearchParams({reel_ids: reelId})
    const reel = await this.#client.json(
      `${this.#client.origin}${REELS_MEDIA}?${query}`,
      json => readReelsMedia(json, reelId),
      {signal, headers: this.#apiHeaders(`${this.#client.origin}/`)},
    )
    const entry = {posts: reel.items, title: reel.title, at: Date.now()}
    this.#stories.set(reelId, entry)
    for (const post of reel.items) this.#remember(post)
    return entry
  }

  #storiesAnalysis(
    id: string,
    url: string,
    title: string,
    uploader: string | undefined,
    posts: readonly MetaPost[],
    maxEntries: number | undefined,
  ): PlaylistAnalysis {
    const shown = maxEntries === undefined ? posts : posts.slice(0, Math.max(1, maxEntries))
    return {
      kind: 'playlist',
      id,
      url,
      title,
      uploader,
      extractor: this.name,
      entries: shown.map((post, i) => ({...summaryOf(post, this.name), index: i + 1})),
      choices: genericChoices(),
      total: posts.length,
      complete: true,
    }
  }

  // ─── the web client's API ────────────────────────────────────────────────

  #apiHeaders(referer: string): Record<string, string> {
    const csrf = this.#client.cookie('csrftoken')
    return {
      'X-IG-App-ID': APP_ID,
      'X-ASBD-ID': ASBD_ID,
      'X-IG-WWW-Claim': '0',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: referer,
      ...(csrf && {'X-CSRFToken': csrf}),
    }
  }

  /** A Relay query of the web client (`doc_id` + variables), as JSON. */
  #graphql<T>(
    docId: string,
    variables: unknown,
    read: (json: unknown) => T,
    referer: string,
    signal?: AbortSignal,
    visitor = false,
    keepSource = false,
  ): Promise<T> {
    const body = new URLSearchParams({doc_id: docId, variables: JSON.stringify(variables), server_timestamps: 'true'})
    return this.#client.json(`${this.#client.origin}${GRAPHQL}`, json => read(json), {
      signal,
      method: 'POST',
      body: body.toString(),
      headers: {...this.#apiHeaders(referer), 'Content-Type': 'application/x-www-form-urlencoded'},
      recoverAt: referer,
      visitor,
      keepSource,
    })
  }
}

/** What a login wall, a refusal or "please wait a few minutes" turns into on the way here. */
const WALL_PROBLEMS: ReadonlySet<MetaProblem> = new Set(['challenge', 'login-required', 'refused', 'walled'])

/**
 * An anonymous answer that refuses: 429 ("please wait a few minutes") is the
 * site limiting this network, so every request backs off together (Pacer); a
 * 401 / 403 is this route turning a visitor away — the route rests, the others go on.
 */
function refusal(status: number, pacer: Pacer): void {
  if (status === 429) {
    pacer.refused()
    throw new NetworkLimit('refused', 'Instagram answered HTTP 429.')
  }
  if (status === 401 || status === 403) throw new MetaError('refused', `Instagram answered HTTP ${status}.`)
}

/** A refusal of the whole network (429), not of one route: the route keeps its standing. */
class NetworkLimit extends MetaError {}

/** What ends a search for good: no other route or try would say otherwise. */
const isFinal = (error: unknown): boolean =>
  error instanceof MetaError && (error.problem === 'removed' || error.problem === 'private')

/** One key per post whatever link named it (a long private code included): its numeric id. O(L). */
function canonicalKey(code: string): string {
  try {
    return codeToPk(code)
  } catch {
    return code
  }
}

/** An answer that should be JSON; a login page in its place is the wall. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    if (/\/accounts\/login|checkpoint_required|login_form/.test(text)) {
      throw new MetaError('challenge', 'Instagram answered with its login page.')
    }
    throw new MetaError('format-changed', 'Instagram answered something that is not JSON.')
  }
}

/** Something to download, with a link for every video in it. */
const usable = (post: MetaPost): boolean =>
  shapeOf(post) !== 'empty' && videosOf(post).every(video => video.renditions.length > 0)

/** A story by id among a reel's items; gone (expired) when it isn't there. */
function storyItem(posts: readonly MetaPost[], id: string): MetaPost {
  const post = posts.find(p => p.id === id)
  if (!post) throw new MetaError('removed', 'This story is no longer available (stories last 24 hours).')
  return post
}
