import type {ExtractResult} from '../../core/analyze.js'
import {DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import type {BrowserAssist} from '../browser.js'
import type {Fetch} from '../http.js'
import {MetaClient, type SessionCookies} from '../meta/client.js'
import {downloadPost} from '../meta/download.js'
import {MetaError, toDownloadError} from '../meta/errors.js'
import {type CursorPage, walkCursor} from '../meta/listing.js'
import {choicesOf, type MetaPost, shapeOf, summaryOf} from '../meta/post.js'
import type {PacerOptions} from '../pacer.js'
import type {ListingProgress, MediaSource, SourceDownload, SourceFile} from '../source.js'
import {
  type InstagramAccount,
  PUBLIC_ORIGIN,
  readPostPage,
  readPostQuery,
  readProfileInfo,
  readReelsMedia,
  readTimelinePage,
} from './data.js'
import {
  APP_ID,
  ASBD_ID,
  DEFAULT_QUERIES,
  GRAPHQL,
  type InstagramQueries,
  PAGE_SIZE,
  PROFILE_INFO,
  REELS_MEDIA,
  USER_FEED,
} from './endpoints.js'
import {highlightUrl, type InstagramLink, parseInstagramLink, postUrl, profileUrl, storiesUrl} from './links.js'

export type InstagramOptions = {
  /** Profiles list at most this many posts unless asked otherwise. Default 500. */
  readonly maxProfileItems?: number | undefined
  /** Pace of requests to instagram.com (pages, API, listing). Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** Tests: serve "Instagram" from another origin. */
  readonly origin?: string | undefined
  readonly fetch?: Fetch | undefined
  /** A real browser (the host app's) for pages Instagram only serves after its own check has run. */
  readonly browser?: BrowserAssist | undefined
  /**
   * The user's Instagram cookies (a browser's signed-in session), asked for
   * when something needs one — stories, highlights, private accounts the user
   * follows — and again when they are old. The engine passes the browser
   * cookies it already reads for yt-dlp.
   */
  readonly cookies?: (() => Promise<SessionCookies | undefined>) | undefined
  /** The web client's query ids, should Instagram rotate them before a release does. */
  readonly queries?: Partial<InstagramQueries> | undefined
  /** Where the source reports what it did (the engine's log). */
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
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

type Cached = {readonly post: MetaPost; readonly at: number}
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
    } = {},
  ): Promise<AnalysisResult> {
    try {
      const link = await this.#resolve(url, opts.signal)
      switch (link.kind) {
        case 'post':
          return this.#videoAnalysis(await this.#readPost(link.code, opts.signal))
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
    opts: {signal?: AbortSignal | undefined; onResult?: ((url: string, result: ExtractResult) => void) | undefined},
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    // items from a listing are already known: no request at all. Others are paced.
    await Promise.all(
      items.map(async ({url}) => {
        const result = await this.#check(url, opts.signal)
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

  /** Share links are redirects: follow one hop; landing anywhere else means the post is gone. */
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
    const target = await this.#client.redirectOf(link.url, signal)
    const resolved = target ? parseInstagramLink(target, this.#client.host) : undefined
    if (!resolved || resolved.kind === 'short') throw new MetaError('removed', 'This short link leads nowhere.')
    return resolved
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
      if (!fresh && cached && Date.now() - cached.at < POST_FRESH_MS) return cached.post
      return storyItem((await this.#reel(account.id, signal, true)).posts, link.id)
    }
    throw new DownloadError('invalid-request', 'A profile or a set of stories is not a single post.')
  }

  // ─── posts ───────────────────────────────────────────────────────────────

  /**
   * One post by shortcode: the web client's query first (JSON, answers
   * without a session for public posts), the post page when the query no
   * longer answers — a page a browser or a signed-in session can get.
   */
  async #readPost(code: string, signal?: AbortSignal, fresh = false): Promise<MetaPost> {
    const id = this.#byCode.get(code)
    const cached = id ? this.#posts.get(id) : undefined
    if (!fresh && cached && Date.now() - cached.at < POST_FRESH_MS && shapeOf(cached.post) !== 'empty')
      return cached.post
    const page = postUrl(this.#client.origin, code)
    let post: MetaPost
    try {
      post = await this.#graphql(
        this.#queries.post,
        {shortcode: code, fetch_tagged_user_count: null, hoisted_comment_id: null, hoisted_reply_id: null},
        readPostQuery,
        page,
        signal,
      )
    } catch (error) {
      if (!(error instanceof MetaError) || (error.problem !== 'format-changed' && error.problem !== 'login-required'))
        throw error
      this.#log('info', `Instagram: the post query did not answer for ${code} (${error.message}) — reading its page`)
      post = await this.#client.page(page, readPostPage, {signal})
    }
    this.#remember(post)
    return post
  }

  async #check(url: string, signal?: AbortSignal): Promise<ExtractResult> {
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
      post ??= await this.#postFor(link, signal ?? new AbortController().signal, false)
      if (shapeOf(post) === 'empty') throw new MetaError('format-changed', 'This post has no media to download.')
      return {ok: true, analysis: this.#videoAnalysis(post)}
    } catch (error) {
      return {ok: false, error: toDownloadError(error, this.name).toJSON()}
    }
  }

  #remember(post: MetaPost): void {
    this.#posts.delete(post.id)
    this.#posts.set(post.id, {post, at: Date.now()})
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
  ): Promise<T> {
    const body = new URLSearchParams({doc_id: docId, variables: JSON.stringify(variables), server_timestamps: 'true'})
    return this.#client.json(`${this.#client.origin}${GRAPHQL}`, json => read(json), {
      signal,
      method: 'POST',
      body: body.toString(),
      headers: {...this.#apiHeaders(referer), 'Content-Type': 'application/x-www-form-urlencoded'},
      recoverAt: referer,
    })
  }
}

/** A story by id among a reel's items; gone (expired) when it isn't there. */
function storyItem(posts: readonly MetaPost[], id: string): MetaPost {
  const post = posts.find(p => p.id === id)
  if (!post) throw new MetaError('removed', 'This story is no longer available (stories last 24 hours).')
  return post
}
