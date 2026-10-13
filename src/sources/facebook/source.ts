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
import {choicesOf, type MetaPost, shapeOf, summaryOf, videosOf} from '../meta/post.js'
import type {PacerOptions} from '../pacer.js'
import type {ListingProgress, MediaSource, SourceDownload, SourceFile} from '../source.js'
import {
  PUBLIC_ORIGIN,
  pageTokens,
  readListingPage,
  readStoriesPage,
  readVideoListing,
  readVideoPage,
  type VideoListing,
} from './data.js'
import {DEFAULT_QUERIES, type FacebookQueries, GRAPHQL, PAGE_SIZE} from './endpoints.js'
import {
  type FacebookLink,
  parseFacebookLink,
  postUrl,
  profileUrl,
  profileVideosUrl,
  storiesUrl,
  videoUrl,
} from './links.js'

export type FacebookOptions = {
  /** Profiles list at most this many videos unless asked otherwise. Default 500. */
  readonly maxProfileItems?: number | undefined
  /** Pace of requests to facebook.com (pages and listing). Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** Tests: serve "Facebook" from another origin. */
  readonly origin?: string | undefined
  readonly fetch?: Fetch | undefined
  /** A real browser (the host app's) for pages Facebook only serves after its own check has run. */
  readonly browser?: BrowserAssist | undefined
  /**
   * The user's Facebook cookies (a browser's signed-in session), asked for
   * when something needs one — stories, and the listings Facebook keeps for
   * signed-in sessions — and again when they are old.
   */
  readonly cookies?: (() => Promise<SessionCookies | undefined>) | undefined
  /** The web client's query ids, should Facebook rotate them before a release does. */
  readonly queries?: Partial<FacebookQueries> | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const FACEBOOK_PROFILE_DEFAULT_ITEMS = 500
/** Media links expire within hours; videos read longer ago than this are read again before downloading. */
const POST_FRESH_MS = 10 * 60_000
const CACHE_LIMIT = 5000
const LISTING_FRESH_MS = 15 * 60_000
const STORIES_FRESH_MS = 5 * 60_000
export const PROFILE_CHUNK = 500

type Cached = {readonly post: MetaPost; readonly at: number}
type KeptListing = {
  posts: MetaPost[]
  cursor: string | undefined
  complete: boolean
  collectionId: string | undefined
  tokens: {readonly dtsg?: string | undefined; readonly lsd?: string | undefined}
  at: number
}

/**
 * Facebook, natively: video pages over plain HTTP (the data Facebook embeds
 * for its own player), media straight from the CDN; a profile's or page's
 * videos as its Videos tab lists them, continued with the web client's own
 * pagination; stories with the user's signed-in session. No signatures, no
 * challenge solving — when Facebook pushes back, every request backs off
 * together (Pacer), a login wall goes through the host's browser or hands
 * the url to yt-dlp.
 */
export class FacebookSource implements MediaSource {
  readonly name = 'Facebook'
  readonly #client: MetaClient
  readonly #maxProfileItems: number
  readonly #queries: FacebookQueries
  readonly #posts = new Map<string, Cached>()
  /** page handle (lower case) → what its listing gave. */
  readonly #listings = new Map<string, KeptListing>()
  readonly #stories = new Map<string, {posts: MetaPost[]; at: number}>()
  readonly #log: (level: 'info' | 'warn', message: string) => void

  constructor(options: FacebookOptions = {}) {
    this.#client = new MetaClient({
      site: 'Facebook',
      origin: options.origin ?? PUBLIC_ORIGIN,
      sessionCookie: 'c_user',
      pacing: options.pacing,
      fetch: options.fetch,
      browser: options.browser,
      cookies: options.cookies,
      log: options.log,
    })
    this.#maxProfileItems = Math.max(1, options.maxProfileItems ?? FACEBOOK_PROFILE_DEFAULT_ITEMS)
    this.#queries = {...DEFAULT_QUERIES, ...options.queries}
    this.#log = options.log ?? (() => {})
  }

  get available(): boolean {
    return this.#client.available
  }

  handles(url: string): boolean {
    return parseFacebookLink(url, this.#client.host) !== undefined
  }

  defaultListSize(url: string): number | undefined {
    return parseFacebookLink(url, this.#client.host)?.kind === 'profile' ? this.#maxProfileItems : undefined
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
        case 'video':
        case 'post':
          return this.#videoAnalysis(await this.#readVideo(link, opts.signal))
        case 'profile':
          return await this.#profile(link.page, opts.maxEntries, opts.signal, opts.onProgress, opts.known)
        case 'stories': {
          const posts = await this.#bucket(link.bucket, opts.signal)
          if (link.card) return this.#videoAnalysis(storyCard(posts, link.card))
          const shown = opts.maxEntries === undefined ? posts : posts.slice(0, Math.max(1, opts.maxEntries))
          const owner = posts[0]
          return {
            kind: 'playlist',
            id: `stories:${link.bucket}`,
            url: storiesUrl(PUBLIC_ORIGIN, link.bucket),
            title: `Facebook stories ${owner?.authorName ?? owner?.author ?? link.bucket}`,
            uploader: owner?.authorName ?? owner?.author,
            extractor: this.name,
            entries: shown.map((post, i) => ({...summaryOf(post, this.name), index: i + 1})),
            choices: genericChoices(),
            total: posts.length,
            complete: true,
          }
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
      return await downloadPost({
        client: this.#client,
        post,
        task,
        site: this.name,
        referer: `${this.#client.origin}/`,
      })
    } catch (error) {
      if (post) this.#posts.delete(post.id)
      throw toDownloadError(error, this.name)
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  async #resolve(url: string, signal?: AbortSignal): Promise<Exclude<FacebookLink, {kind: 'short'}>> {
    const link = parseFacebookLink(url, this.#client.host)
    if (!link) {
      throw new DownloadError(
        'invalid-request',
        'Not a Facebook video, post, profile or stories url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    if (link.kind !== 'short') return link
    const target = await this.#client.redirectOf(link.url, signal)
    const resolved = target ? parseFacebookLink(target, this.#client.host) : undefined
    if (!resolved || resolved.kind === 'short') throw new MetaError('removed', 'This short link leads nowhere.')
    return resolved
  }

  async #postFor(link: Exclude<FacebookLink, {kind: 'short'}>, signal: AbortSignal, fresh: boolean): Promise<MetaPost> {
    if (link.kind === 'video' || link.kind === 'post') return this.#readVideo(link, signal, fresh)
    if (link.kind === 'stories' && link.card) {
      const cached = this.#posts.get(link.card)
      if (!fresh && cached && Date.now() - cached.at < POST_FRESH_MS) return cached.post
      return storyCard(await this.#bucket(link.bucket, signal, true), link.card)
    }
    throw new DownloadError('invalid-request', 'A profile or a set of stories is not a single video.')
  }

  // ─── videos ──────────────────────────────────────────────────────────────

  /** One video (or the video of a post) from its page; a recent read with media is reused. */
  async #readVideo(
    link: {readonly kind: 'video' | 'post'; readonly id: string; readonly page?: string | undefined},
    signal?: AbortSignal,
    fresh = false,
  ): Promise<MetaPost> {
    const cached = this.#posts.get(link.id)
    if (!fresh && cached && Date.now() - cached.at < POST_FRESH_MS && downloadable(cached.post)) return cached.post
    const page =
      link.kind === 'video' ? videoUrl(this.#client.origin, link.id) : postUrl(this.#client.origin, link.id, link.page)
    const post = await this.#client.page(page, p => readVideoPage(p, link.kind === 'video' ? link.id : undefined), {
      signal,
    })
    // a post's video has its own id: remember it under both
    this.#remember(post)
    if (post.id !== link.id) this.#posts.set(link.id, {post, at: Date.now()})
    return post
  }

  async #check(url: string, signal?: AbortSignal): Promise<ExtractResult> {
    try {
      const link = await this.#resolve(url, signal)
      if (link.kind === 'profile' || (link.kind === 'stories' && !link.card)) {
        throw new DownloadError('invalid-request', 'A profile or a set of stories is not a single video.')
      }
      // listed videos are known (their page is read at download time); others are read now
      const known = this.#posts.get(link.kind === 'stories' ? link.card! : link.id)?.post
      const post = known ?? (await this.#postFor(link, signal ?? new AbortController().signal, false))
      if (shapeOf(post) === 'empty') throw new MetaError('format-changed', 'This post has no media to download.')
      return {ok: true, analysis: this.#videoAnalysis(post)}
    } catch (error) {
      return {ok: false, error: toDownloadError(error, this.name).toJSON()}
    }
  }

  #remember(post: MetaPost): void {
    this.#posts.delete(post.id)
    this.#posts.set(post.id, {post, at: Date.now()})
    if (this.#posts.size > CACHE_LIMIT) this.#posts.delete(this.#posts.keys().next().value!)
  }

  #videoAnalysis(post: MetaPost): VideoAnalysis {
    return {kind: 'video', media: summaryOf(post, this.name), choices: choicesOf(post)}
  }

  // ─── profiles ────────────────────────────────────────────────────────────

  async #profile(
    page: string,
    maxEntries: number | undefined,
    abort?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
    owned?: ReadonlySet<string>,
  ): Promise<PlaylistAnalysis> {
    const key = page.toLowerCase()
    const max = Math.max(1, maxEntries ?? this.#maxProfileItems)
    onProgress?.({listed: 0, expected: max})
    await this.#client.loadCookies()
    const kept = this.#listings.get(key)
    const fresh = kept && !owned && Date.now() - kept.at < LISTING_FRESH_MS ? kept : undefined
    let posts: MetaPost[] = fresh?.posts.slice(0, max) ?? []
    let cursor = fresh?.cursor
    let complete = fresh?.complete ?? false
    let caughtUp = false
    let collectionId = fresh?.collectionId
    let tokens = fresh?.tokens ?? {}
    const cached = fresh !== undefined && (fresh.posts.length >= max || fresh.complete)
    const keep = () => {
      const longest = this.#listings.get(key)
      if (!longest || posts.length >= longest.posts.length || Date.now() - longest.at >= LISTING_FRESH_MS) {
        this.#listings.set(key, {posts, cursor, complete, collectionId, tokens, at: Date.now()})
      }
    }
    if (!cached) {
      // the Videos tab itself: the first videos, the cursor of the rest, and the page's tokens
      let first: VideoListing | undefined
      if (posts.length === 0) {
        const url = profileVideosUrl(this.#client.origin, page)
        first = await this.#client.page(
          url,
          p => {
            const listing = readVideoListing(p)
            tokens = pageTokens(p.html)
            return listing
          },
          {signal: abort},
        )
        collectionId = first.collectionId
      }
      try {
        while (posts.length < max && !complete) {
          const target = Math.min(max, posts.length + PROFILE_CHUNK)
          const seed = first
          first = undefined
          const listing = await walkCursor(
            next => (seed ? Promise.resolve(seed) : this.#listingPage(page, collectionId, tokens, next, abort)),
            {
              max: target,
              idOf: post => post.id,
              isPinned: post => post.pinned,
              resume: posts.length > 0 || cursor !== undefined ? {items: posts, cursor} : undefined,
              known: owned,
              onProgress: listed => onProgress?.({listed, expected: max}),
              site: 'Facebook',
            },
          )
          posts = listing.items
          cursor = listing.cursor
          complete = listing.complete
          caughtUp = listing.caughtUp
          keep()
          if (caughtUp || posts.length < target) break
        }
      } catch (error) {
        if (abort?.aborted || posts.length === 0) throw error
        // the pagination query is gone or refused: the listing stays at what the page showed
        this.#log(
          'warn',
          `Facebook: ${page} listing stopped at ${posts.length} of ${max} (${String(error)}) — load again to continue`,
        )
        keep()
      }
    }
    onProgress?.({listed: posts.length, expected: max})
    for (const post of posts) this.#remember(post)
    const owner = posts[0]
    return {
      kind: 'playlist',
      id: `videos:${key}`,
      url: profileUrl(PUBLIC_ORIGIN, page),
      title: `Facebook ${owner?.authorName ?? page} videos`,
      uploader: owner?.authorName ?? owner?.author ?? page,
      extractor: this.name,
      entries: posts.map((post, i) => ({...summaryOf(post, this.name), index: i + 1})),
      choices: genericChoices(),
      complete,
      caughtUp: caughtUp || undefined,
    }
  }

  /** The next page of a profile's videos: the web client's own pagination query, with the page's tokens. */
  async #listingPage(
    page: string,
    collectionId: string | undefined,
    tokens: {readonly dtsg?: string | undefined; readonly lsd?: string | undefined},
    cursor: string | undefined,
    signal?: AbortSignal,
  ): Promise<CursorPage<MetaPost>> {
    if (cursor === undefined || !collectionId) {
      throw new MetaError('format-changed', 'Facebook videos page without a pagination cursor.')
    }
    const variables = {count: PAGE_SIZE, cursor, scale: 1, id: collectionId}
    const body = new URLSearchParams({
      ...(tokens.dtsg && {fb_dtsg: tokens.dtsg}),
      ...(tokens.lsd && {lsd: tokens.lsd}),
      __a: '1',
      __comet_req: '15',
      doc_id: this.#queries.profileVideosPage,
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
    })
    const referer = profileVideosUrl(this.#client.origin, page)
    return this.#client.json(`${this.#client.origin}${GRAPHQL}`, readListingPage, {
      signal,
      method: 'POST',
      body: body.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-FB-Friendly-Name': 'ProfileCometAppCollectionListRendererPaginationQuery',
        ...(tokens.lsd && {'X-FB-LSD': tokens.lsd}),
        Referer: referer,
      },
      recoverAt: referer,
    })
  }

  // ─── stories ─────────────────────────────────────────────────────────────

  /** The cards of a stories bucket: signed-in sessions only. */
  async #bucket(bucket: string, signal?: AbortSignal, fresh = false): Promise<MetaPost[]> {
    const kept = this.#stories.get(bucket)
    if (!fresh && kept && Date.now() - kept.at < STORIES_FRESH_MS) return kept.posts
    await this.#client.requireSession('stories')
    const posts = await this.#client.page(storiesUrl(this.#client.origin, bucket), p => readStoriesPage(p, bucket), {
      signal,
    })
    this.#stories.set(bucket, {posts, at: Date.now()})
    for (const post of posts) this.#remember(post)
    return posts
  }
}

/** A listed video has no media links until its page is read; a story's or a page's does. */
const downloadable = (post: MetaPost): boolean =>
  videosOf(post).some(v => v.renditions.length > 0) || shapeOf(post) === 'photo'

function storyCard(posts: readonly MetaPost[], card: string): MetaPost {
  const post = posts.find(p => p.id === card || p.url.endsWith(`/${card}/`))
  if (!post) throw new MetaError('removed', 'This story is no longer available (stories last 24 hours).')
  return post
}
