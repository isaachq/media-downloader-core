import type {ExtractResult} from '../../core/analyze.js'
import {cancelledError, DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import {Coalescer} from '../coalesce.js'
import {DOCUMENT_NAVIGATION_HEADERS, type Fetch, navigationFetch} from '../http.js'
import {linkExpiry} from '../instagram/routes.js'
import {MetaClient, type SessionProvider} from '../meta/client.js'
import {downloadPost} from '../meta/download.js'
import {MetaError, toDownloadError} from '../meta/errors.js'
import {type CursorPage, walkCursor} from '../meta/listing.js'
import {choicesOf, type MetaPost, shapeOf, summaryOf} from '../meta/post.js'
import type {PacerOptions} from '../pacer.js'
import {type ListingProgress, type MediaSource, needsFallback, type SourceDownload, type SourceFile} from '../source.js'
import {readPostPage, readProfilePage, readTabPage, type TabPage, type ThreadsAccount} from './data.js'
import {
  API_GRAPHQL,
  APP_ID,
  DEFAULT_QUERIES,
  DEFAULT_TAB_VARIABLES,
  PAGE_SIZE,
  THREADS_ORIGIN,
  type ThreadsQueries,
} from './endpoints.js'
import {parseThreadsLink, postUrl, profileUrl, type ThreadsLink} from './links.js'

export type ThreadsOptions = {
  /** Profiles list at most this many posts unless asked otherwise. Default 500. */
  readonly maxProfileItems?: number | undefined
  /** Pace of requests to threads.com (pages and the listing query). Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** Tests: serve "Threads" from another origin. */
  readonly origin?: string | undefined
  /** Default: page loads over node:http (`navigationFetch`), the only way Threads hands a page its data. */
  readonly fetch?: Fetch | undefined
  /**
   * The user's Threads cookies (a browser's signed-in session on threads.com),
   * for private accounts the user follows. The engine passes the browser
   * cookies it already reads for yt-dlp. Without them everything public is
   * read anonymously.
   */
  readonly cookies?: SessionProvider | undefined
  /** The web client's query names and ids, should Threads rotate them before a release does. */
  readonly queries?: Partial<ThreadsQueries> | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const THREADS_PROFILE_DEFAULT_ITEMS = 500
/** Profiles are listed this many posts at a time, each chunk kept as soon as it is in. */
export const PROFILE_CHUNK = 500
/** Media links expire within hours (the CDN's `oe`); without one, a read post is kept this long. */
const POST_FRESH_MS = 10 * 60_000
/** Media links are not reused this close to the CDN's own expiry. */
const EXPIRY_MARGIN_MS = 10 * 60_000
const POST_CACHE_LIMIT = 5000
/** A profile's page (its id, LSD token, query) is reused this long: the token is good for longer. */
const ACCOUNT_FRESH_MS = 30 * 60_000
const ACCOUNT_CACHE_LIMIT = 500
/** A profile listing is reused (or continued) for this long. */
const LISTING_FRESH_MS = 15 * 60_000
const LISTING_CACHE_LIMIT = 100
/**
 * Pages of text posts only in a row, read on before a page is handed to the
 * walk as empty (which would count as a stall): a talkative account can
 * write ten text threads between two photos. A constant bound, not per item.
 */
const TEXT_PAGES_MAX = 10
/** What every reason a native source would hand to yt-dlp turns into: yt-dlp has no Threads extractor. */
const NO_FALLBACK = 'yt-dlp has no Threads extractor, so nothing else reads it either'

type Cached = {readonly post: MetaPost; readonly until: number}
type Timed<T> = {readonly value: T; readonly at: number}
type KeptListing = {
  readonly posts: MetaPost[]
  readonly cursor: string | undefined
  readonly complete: boolean
  readonly at: number
}

/**
 * Threads, natively: posts (a video, a photo, a carousel of both) and public
 * profiles, over plain HTTP, media straight from the CDN. A post is one page
 * load (the post page's own preloaded query); a profile is one page load
 * (the account, its LSD token and its threads tab's query) plus one GraphQL
 * request per 10 threads, every post's media in the answer, so a listed
 * post is never asked for again. Threads has no stories. A private account
 * is read with the user's own session when the host supplies one, and
 * reported as needing one when it doesn't. yt-dlp has no Threads extractor:
 * every failure says its own reason, none is handed to yt-dlp.
 */
export class ThreadsSource implements MediaSource {
  readonly name = 'Threads'
  readonly #client: MetaClient
  readonly #maxProfileItems: number
  readonly #queries: ThreadsQueries
  /** A host's own threads tab id wins over the page's. */
  readonly #tabIdOverride: string | undefined
  readonly #log: (level: 'info' | 'warn', message: string) => void
  /** Posts read or listed, by id (insertion order = age: the oldest evicted first). */
  readonly #posts = new Map<string, Cached>()
  /** code → id, for links that name the code. */
  readonly #byCode = new Map<string, string>()
  /** user (lower case) → the profile page's account. */
  readonly #accounts = new Map<string, Timed<ThreadsAccount>>()
  /** account id → what its listing gave. */
  readonly #listings = new Map<string, KeptListing>()
  /** Reads of one post page or one profile page at the same time share one request. */
  readonly #readingPosts = new Coalescer<string, MetaPost>()
  readonly #readingAccounts = new Coalescer<string, ThreadsAccount>()

  constructor(options: ThreadsOptions = {}) {
    this.#client = new MetaClient({
      site: 'Threads',
      origin: options.origin ?? THREADS_ORIGIN,
      // Threads signs in with the Instagram account; its own cookie on .threads.com
      sessionCookie: 'sessionid',
      pacing: options.pacing,
      fetch: options.fetch ?? navigationFetch,
      cookies: options.cookies,
      log: options.log,
    })
    this.#maxProfileItems = Math.max(1, Math.floor(options.maxProfileItems ?? THREADS_PROFILE_DEFAULT_ITEMS))
    this.#queries = {...DEFAULT_QUERIES, ...options.queries}
    this.#tabIdOverride = options.queries?.threadsTabId
    this.#log = options.log ?? (() => {})
  }

  /**
   * Always: a source that stepped aside would send its urls to yt-dlp, which
   * has no Threads extractor. While Threads walls this network the source
   * answers "try later" itself (see #guard).
   */
  get available(): boolean {
    return true
  }

  handles(url: string): boolean {
    return parseThreadsLink(url, this.#client.host) !== undefined
  }

  defaultListSize(url: string): number | undefined {
    return parseThreadsLink(url, this.#client.host)?.kind === 'profile' ? this.#maxProfileItems : undefined
  }

  async analyze(
    url: string,
    opts: {
      signal?: AbortSignal
      maxEntries?: number
      onProgress?: (progress: ListingProgress) => void
      known?: ReadonlySet<string>
    } = {},
  ): Promise<AnalysisResult> {
    try {
      const link = this.#link(url)
      if (link.kind === 'profile') {
        return await this.#profile(link.user, opts.maxEntries, opts.signal, opts.onProgress, opts.known)
      }
      return this.#videoAnalysis(withMedia(await this.#post(link, opts.signal)))
    } catch (error) {
      throw this.#toDownloadError(error, opts.signal)
    }
  }

  /** Each url's post: from what a listing or an analysis read, else its page (shared with other callers). */
  async preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {signal?: AbortSignal | undefined; onResult?: ((url: string, result: ExtractResult) => void) | undefined},
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    await Promise.all(
      items.map(async ({url}) => {
        let result: ExtractResult
        try {
          const link = this.#link(url)
          if (link.kind === 'profile') {
            throw new DownloadError(
              'invalid-request',
              'A Threads profile is a list: each of its posts is its own item.',
            )
          }
          result = {ok: true, analysis: this.#videoAnalysis(withMedia(await this.#post(link, opts.signal)))}
        } catch (error) {
          if (opts.signal?.aborted) return
          result = {ok: false, error: this.#toDownloadError(error, opts.signal).toJSON()}
        }
        results.set(url, result)
        opts.onResult?.(url, result)
      }),
    )
    return results
  }

  async download(task: SourceDownload): Promise<SourceFile> {
    let post: MetaPost | undefined
    try {
      const link = this.#link(task.url)
      if (link.kind === 'profile') {
        throw new DownloadError('invalid-request', 'A Threads profile is a list: each of its posts is its own item.')
      }
      post = withMedia(await this.#post(link, task.signal, task.fresh))
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
      throw this.#toDownloadError(error, task.signal)
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  #link(url: string): ThreadsLink {
    const link = parseThreadsLink(url, this.#client.host)
    if (!link) {
      throw new DownloadError(
        'invalid-request',
        'Not a Threads post or profile url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    return link
  }

  // ─── posts ───────────────────────────────────────────────────────────────

  /**
   * One post: from memory while its media links are good (a listing put it
   * there), else its page — one paced page load, shared by every caller at
   * the same time. O(1) requests per post.
   */
  async #post(link: Extract<ThreadsLink, {kind: 'post'}>, signal?: AbortSignal, fresh = false): Promise<MetaPost> {
    const id = this.#byCode.get(link.code)
    const cached = id ? this.#posts.get(id) : undefined
    if (!fresh && cached && Date.now() < cached.until) return cached.post
    return this.#readingPosts.run(link.code, signal, async shared => {
      this.#guard()
      await this.#client.loadCookies()
      const page = postUrl(this.#client.origin, link.code, link.user)
      const post = await this.#client.page(
        page,
        read => readPostPage(read, link.code, {queries: this.#queries, signedIn: this.#client.signedIn}),
        {signal: shared, headers: DOCUMENT_NAVIGATION_HEADERS},
      )
      this.#remember(post)
      return post
    })
  }

  /**
   * Keep a read post until its links expire: the earliest CDN `oe` among
   * them, less a margin, or POST_FRESH_MS when they carry none. O(k) for its
   * k links; the oldest post dropped past POST_CACHE_LIMIT.
   */
  #remember(post: MetaPost): void {
    const now = Date.now()
    let expires = Number.POSITIVE_INFINITY
    for (const item of post.items) {
      const links = item.kind === 'video' ? item.renditions.flatMap(rendition => rendition.urls) : item.urls
      for (const link of links) expires = Math.min(expires, linkExpiry(link) ?? Number.POSITIVE_INFINITY)
    }
    const until = Number.isFinite(expires) ? Math.max(now, expires - EXPIRY_MARGIN_MS) : now + POST_FRESH_MS
    this.#posts.delete(post.id)
    this.#posts.set(post.id, {post, until})
    if (post.code) this.#byCode.set(post.code, post.id)
    if (this.#posts.size > POST_CACHE_LIMIT) {
      const oldest = this.#posts.keys().next().value!
      const gone = this.#posts.get(oldest)
      this.#posts.delete(oldest)
      if (gone?.post.code) this.#byCode.delete(gone.post.code)
    }
  }

  #videoAnalysis(post: MetaPost): VideoAnalysis {
    return {kind: 'video', media: summaryOf(post, this.name), choices: choicesOf(post)}
  }

  // ─── profiles ────────────────────────────────────────────────────────────

  /** A profile's page, read once per ACCOUNT_FRESH_MS (its LSD token and query id with it). */
  async #account(user: string, signal?: AbortSignal): Promise<ThreadsAccount> {
    const key = user.toLowerCase()
    const known = this.#accounts.get(key)
    if (known && Date.now() - known.at < ACCOUNT_FRESH_MS) return known.value
    return this.#readingAccounts.run(key, signal, async shared => {
      this.#guard()
      await this.#client.loadCookies()
      const account = await this.#client.page(
        profileUrl(this.#client.origin, user),
        read => readProfilePage(read, user, {queries: this.#queries, signedIn: this.#client.signedIn}),
        {signal: shared, headers: DOCUMENT_NAVIGATION_HEADERS},
      )
      bounded(this.#accounts, key, {value: account, at: Date.now()}, ACCOUNT_CACHE_LIMIT)
      return account
    })
  }

  /**
   * A profile's posts with media, newest first (pinned ones where the
   * profile shows them), up to `maxEntries`, PROFILE_CHUNK at a time, each
   * chunk kept as soon as it is in (a refusal half-way loses nothing; the
   * next request continues from its cursor). `known` stops an incremental
   * walk where known posts start. O(1) per post; one request per 10 threads.
   */
  async #profile(
    user: string,
    maxEntries: number | undefined,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
    owned?: ReadonlySet<string>,
  ): Promise<PlaylistAnalysis> {
    const account = await this.#account(user, signal)
    if (account.isPrivate && !this.#client.signedIn) {
      throw new MetaError(
        'login-required',
        `@${account.user} is a private Threads account: a signed-in session (browser cookies) that follows it can list it.`,
      )
    }
    const max = Math.max(1, Math.floor(maxEntries ?? this.#maxProfileItems))
    onProgress?.({listed: 0, expected: max})
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
        this.#listings.delete(account.id)
        this.#listings.set(account.id, {posts, cursor, complete, at: Date.now()})
        if (this.#listings.size > LISTING_CACHE_LIMIT) this.#listings.delete(this.#listings.keys().next().value!)
      }
    }
    if (!cached) {
      try {
        while (posts.length < max && !complete) {
          const target = Math.min(max, posts.length + PROFILE_CHUNK)
          const listing = await walkCursor(next => this.#tabPage(account, next, signal), {
            max: target,
            idOf: post => post.id,
            isPinned: post => post.pinned,
            resume: posts.length > 0 || cursor !== undefined ? {items: posts, cursor} : undefined,
            known: owned,
            onProgress: listed => onProgress?.({listed, expected: max}),
            site: this.name,
          })
          posts = listing.items
          cursor = listing.cursor
          complete = listing.complete
          caughtUp = listing.caughtUp
          keep()
          if (caughtUp || posts.length < target) break
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (posts.length > 0) {
          // a refusal half-way returns what was listed (the preview offers to continue)
          this.#log(
            'warn',
            `Threads: @${account.user} listing stopped at ${posts.length} of ${max} (${String(error)}) — load again to continue`,
          )
        } else if (
          error instanceof MetaError &&
          error.problem === 'format-changed' &&
          account.firstPage.length > 0 &&
          !owned
        ) {
          // the listing query no longer answers: what the profile page itself embeds
          this.#log('warn', `Threads: @${account.user} listing query did not answer (${error.message})`)
          posts = account.firstPage.slice(0, max)
          cursor = undefined
          complete = false
        } else if (error instanceof MetaError && error.problem === 'refused' && /no items/.test(error.message)) {
          // page after page of text posts only (or none at all): an empty listing, not a failure
          this.#log('info', `Threads: @${account.user} has no photo or video in its latest threads`)
        } else throw error
      }
    }
    onProgress?.({listed: posts.length, expected: max})
    for (const post of posts) this.#remember(post)
    return {
      kind: 'playlist',
      id: account.id,
      url: profileUrl(THREADS_ORIGIN, account.user),
      title: `Threads @${account.user}`,
      uploader: account.name ?? account.user,
      extractor: this.name,
      entries: posts.map((post, i) => ({...summaryOf(post, this.name), index: i + 1})),
      choices: genericChoices(),
      complete,
      caughtUp: caughtUp || undefined,
    }
  }

  /**
   * One page of the threads tab for the walk, as the page's own client asks
   * it (`first`, `after`); pages of text posts only are read on, up to
   * TEXT_PAGES_MAX, so the walk only sees a page with nothing new when the
   * site repeats itself.
   */
  async #tabPage(
    account: ThreadsAccount,
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<CursorPage<MetaPost>> {
    let page = await this.#tabQuery(account, cursor, signal)
    for (let skipped = 0; page.items.length === 0 && page.posts > 0 && page.next !== undefined; skipped++) {
      if (skipped >= TEXT_PAGES_MAX || page.next === cursor) break
      cursor = page.next
      page = await this.#tabQuery(account, cursor, signal)
    }
    return {items: page.items, next: page.next}
  }

  /** The threads tab query (`POST /api/graphql`, the page's LSD and cookies), one page. */
  #tabQuery(account: ThreadsAccount, cursor: string | undefined, signal?: AbortSignal): Promise<TabPage> {
    this.#guard()
    const referer = profileUrl(this.#client.origin, account.user)
    const docId = this.#tabIdOverride ?? account.tab?.id ?? this.#queries.threadsTabId
    const variables = {
      ...(account.tab?.variables ?? DEFAULT_TAB_VARIABLES),
      userID: account.id,
      first: PAGE_SIZE,
      ...(cursor !== undefined && {after: cursor}),
    }
    const lsd = account.lsd
    const csrf = this.#client.cookie('csrftoken')
    const body = new URLSearchParams({
      ...(lsd && {lsd}),
      doc_id: docId,
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
    })
    return this.#client.json(`${this.#client.origin}${API_GRAPHQL}`, json => readTabPage(json, account.id), {
      signal,
      method: 'POST',
      body: body.toString(),
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-IG-App-ID': APP_ID,
        'X-FB-Friendly-Name': this.#queries.threadsTab,
        ...(lsd && {'X-FB-LSD': lsd}),
        ...(csrf && {'X-CSRFToken': csrf}),
        Origin: this.#client.origin,
        Referer: referer,
        // a request of the page's own script: what navigationFetch sends only when told
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    })
  }

  // ─── errors ──────────────────────────────────────────────────────────────

  /**
   * While Threads walls this network (a verification page made the client
   * step aside), nothing is asked: the answer is "try later", not yt-dlp.
   */
  #guard(): void {
    if (!this.#client.available) {
      throw new MetaError('refused', 'Threads is asking this network to verify itself: try again in a few minutes.')
    }
  }

  /**
   * The engine's error, with nothing handed to yt-dlp: a page that changed
   * or a wall says so in its own words ('retry-later' unless it has a hint).
   */
  #toDownloadError(error: unknown, signal?: AbortSignal): DownloadError {
    if (signal?.aborted && !(error instanceof DownloadError)) return cancelledError()
    const converted = toDownloadError(error, this.name)
    if (!needsFallback(converted.details)) return converted
    const changed = error instanceof MetaError && error.problem === 'format-changed'
    return new DownloadError(
      'unavailable',
      changed
        ? `${converted.message} Threads changed its pages; ${NO_FALLBACK}: an update of this library will.`
        : `${converted.message} (${NO_FALLBACK}; try again in a few minutes.)`,
      undefined,
      converted.params,
      converted.hint ?? 'retry-later',
    )
  }
}

/** A post with something to download; a text post says it has none. O(1). */
function withMedia(post: MetaPost): MetaPost {
  if (shapeOf(post) === 'empty') {
    throw new MetaError('no-media', 'This Threads post is text only: it has no photo or video to download.')
  }
  return post
}

/** A bounded cache entry: re-inserted as the newest, the oldest dropped past `limit`. O(1). */
function bounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) map.delete(map.keys().next().value!)
}
