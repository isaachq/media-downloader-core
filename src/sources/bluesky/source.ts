import type {ExtractResult} from '../../core/analyze.js'
import {cancelledError, DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, FormatChoice, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import {Coalescer} from '../coalesce.js'
import {type Fetch, HttpSession} from '../http.js'
import {downloadPost} from '../meta/download.js'
import {MetaError, toDownloadError} from '../meta/errors.js'
import {walkCursor} from '../meta/listing.js'
import {choicesOf, type MetaPost, shapeOf, summaryOf} from '../meta/post.js'
import {dig, num, text} from '../meta/relay.js'
import {COOLING_DOWN, Pacer, type PacerOptions} from '../pacer.js'
import {type ListingProgress, type MediaSource, needsFallback, type SourceDownload, type SourceFile} from '../source.js'
import {
  type BlueskyAccount,
  type BlueskyPost,
  readFeedPage,
  readPds,
  readPosts,
  readProfile,
  readThread,
  toMetaPost,
  unreadable,
} from './data.js'
import {
  BLUESKY_ORIGIN,
  type BlueskyEndpoints,
  DEFAULT_ENDPOINTS,
  FEED_PAGE,
  POSTS_PER_REQUEST,
  XRPC,
} from './endpoints.js'
import {atUri, type BlueskyLink, parseBlueskyLink, profileUrl} from './links.js'

export type BlueskyOptions = {
  /** Profiles list at most this many posts unless asked otherwise. Default 500. */
  readonly maxProfileItems?: number | undefined
  /** Pace of AppView requests (posts, profiles, feed pages). */
  readonly pacing?: PacerOptions | undefined
  /** Pace of blob requests, per PDS host (each allows 3000 per 5 minutes per IP). The CDN isn't paced. */
  readonly pdsPacing?: PacerOptions | undefined
  /** The AppView, the PLC directory, the CDN and the feed filter (endpoints.ts), overridable without a release. */
  readonly endpoints?: Partial<BlueskyEndpoints> | undefined
  readonly fetch?: Fetch | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const BLUESKY_PROFILE_DEFAULT_ITEMS = 500
/** Profiles are listed this many posts at a time, each chunk kept as soon as it is in. */
const PROFILE_CHUNK = 500
/** Blobs never change; a read post is kept this long only to notice a deletion. */
const POST_FRESH_MS = 60 * 60_000
const POST_CACHE_LIMIT = 5000
/** Handles can move to another account: a resolved one is trusted this long. */
const HANDLE_FRESH_MS = 60 * 60_000
const HANDLE_CACHE_LIMIT = 2000
const PDS_CACHE_LIMIT = 2000
/** PDS hosts with a pacer of their own (bsky.social's are a few dozen mushrooms; self-hosted ones a few). */
const PDS_HOST_LIMIT = 64
const ACCOUNT_FRESH_MS = 30 * 60_000
const ACCOUNT_CACHE_LIMIT = 500
const LISTING_FRESH_MS = 15 * 60_000
const LISTING_CACHE_LIMIT = 100
const READ_ATTEMPTS = 3
/** A blob download that broke is started over once (the PDS ignores Range: a resume is a restart). */
const DOWNLOAD_ATTEMPTS = 2
/** Requests a PDS may still take in its window below which pictures come from the CDN first. */
const RATE_RESERVE = 50
/** A 429 longer than this is not waited out by the pacer (the window is 5 minutes). */
const MAX_RATE_WAIT_MS = 5 * 60_000 + 5_000
/**
 * A limited PDS that does not say when its window resets: pictures come from the CDN first at
 * least this long (the CDN serves the same pictures; the PDS's window is 5 minutes), not only for
 * the pacer's cool-down, which may be a few milliseconds.
 */
const UNKNOWN_RESET_MS = 60_000
/** The AppView sends no rate limit headers and serves the whole network: a brisk, polite pace. */
const DEFAULT_PACING: PacerOptions = {concurrency: 3, spacingMs: 300, jitterMs: 200}
/** 10 requests a second at most: 3000 per 5 minutes, the PDS's own limit. */
const DEFAULT_PDS_PACING: PacerOptions = {concurrency: 2, spacingMs: 100, jitterMs: 0}
/** XRPC errors (HTTP 400) that mean the post or the account is not there for anyone. */
const GONE_ERRORS: ReadonlySet<string> = new Set([
  'NotFound',
  'AccountTakedown',
  'AccountDeactivated',
  'RepoNotFound',
  'BlockedActor',
  'BlockedByActor',
])
const GONE_MESSAGE = /not found|unable to resolve handle/i
/**
 * What every reason a native source would hand to yt-dlp turns into: yt-dlp's
 * Bluesky extractor reads the same AppView and the same blobs, for posts only
 * (no galleries, no profiles), so it would stop where this one did.
 */
const NO_FALLBACK = 'yt-dlp’s Bluesky extractor reads the same API (posts only), so it would not get further'

type PostLink = Extract<BlueskyLink, {kind: 'post'}>
type Timed<T> = {readonly value: T; readonly at: number}
type KeptListing = {
  readonly posts: BlueskyPost[]
  readonly cursor: string | undefined
  readonly complete: boolean
  readonly at: number
}

/**
 * Bluesky, natively: posts with pictures (up to 4 images, or a gallery of up
 * to 10), a video, or a quote with media of its own, and public profiles'
 * media posts, all from the public AppView without a session. A post is one
 * request (getPostThread; a batch of checks, getPosts for 25 at a time); a
 * profile is one getProfile and one getAuthorFeed per 100 posts, every post
 * whole in the page, so a listed post is never asked for again. Every file is
 * the author's original blob from their own PDS (found once per account in
 * its DID document), paced per PDS host; a picture falls back to the CDN's
 * re-encode. Videos are the blob's progressive MP4, never HLS.
 */
export class BlueskySource implements MediaSource {
  readonly name = 'Bluesky'
  readonly #session: HttpSession
  /** Media requests: blobs through each PDS host's pacer, the CDN straight. */
  readonly #media: HttpSession
  readonly #fetch: Fetch
  readonly #pacer: Pacer
  readonly #pdsPacing: PacerOptions
  readonly #endpoints: BlueskyEndpoints
  readonly #appView: string
  readonly #maxProfileItems: number
  readonly #log: (level: 'info' | 'warn', message: string) => void
  /** rkey → post (insertion order = age: the oldest evicted first). */
  readonly #posts = new Map<string, Timed<BlueskyPost>>()
  /** handle → DID, learned from every post and profile read and from resolveHandle. */
  readonly #dids = new Map<string, Timed<string>>()
  /** DID → its PDS origin. */
  readonly #pds = new Map<string, string>()
  /** PDS origin → its pacer. */
  readonly #pdsPacers = new Map<string, Pacer>()
  /** PDS origin → until when it limits this network (ms): pictures go to the CDN first meanwhile. */
  readonly #limited = new Map<string, number>()
  /** actor → its profile. */
  readonly #accounts = new Map<string, Timed<BlueskyAccount>>()
  /** DID → what its listing gave. */
  readonly #listings = new Map<string, KeptListing>()
  readonly #readingPosts = new Coalescer<string, BlueskyPost>()
  readonly #readingDids = new Coalescer<string, string>()
  readonly #readingPds = new Coalescer<string, string | undefined>()
  readonly #readingAccounts = new Coalescer<string, BlueskyAccount>()

  constructor(options: BlueskyOptions = {}) {
    this.#endpoints = {...DEFAULT_ENDPOINTS, ...options.endpoints}
    this.#appView = this.#endpoints.appView.replace(/\/+$/, '')
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#session = new HttpSession({fetch: this.#fetch})
    this.#media = new HttpSession({fetch: (input, init) => this.#mediaFetch(input, init)})
    this.#pacer = new Pacer(options.pacing ?? DEFAULT_PACING, 'Bluesky')
    this.#pdsPacing = options.pdsPacing ?? DEFAULT_PDS_PACING
    this.#maxProfileItems = Math.max(1, Math.floor(options.maxProfileItems ?? BLUESKY_PROFILE_DEFAULT_ITEMS))
    this.#log = options.log ?? (() => {})
  }

  /** Always: no verification page, and yt-dlp would read nothing more (see NO_FALLBACK). */
  get available(): boolean {
    return true
  }

  handles(url: string): boolean {
    return parseBlueskyLink(url) !== undefined
  }

  defaultListSize(url: string): number | undefined {
    return parseBlueskyLink(url)?.kind === 'profile' ? this.#maxProfileItems : undefined
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
        return await this.#profile(link.actor, opts.maxEntries, opts.signal, opts.onProgress, opts.known)
      }
      return this.#videoAnalysis(usable(await this.#post(link, opts.signal)))
    } catch (error) {
      throw this.#toDownloadError(error, opts.signal)
    }
  }

  /**
   * Each url's post: from what a listing or an analysis read, else getPosts,
   * 25 posts a request (their handles resolved to DIDs first, once each).
   * O(n) work, ⌈n / 25⌉ requests for n posts not read yet.
   */
  async preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {signal?: AbortSignal | undefined; onResult?: ((url: string, result: ExtractResult) => void) | undefined},
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    const settle = (url: string, result: ExtractResult) => {
      results.set(url, result)
      opts.onResult?.(url, result)
    }
    const fail = (url: string, error: unknown) => {
      if (!opts.signal?.aborted) settle(url, {ok: false, error: this.#toDownloadError(error, opts.signal).toJSON()})
    }
    /** at-uri (with the DID) → the urls asking for it. */
    const wanted = new Map<string, string[]>()
    await Promise.all(
      items.map(async ({url}) => {
        try {
          const link = this.#postLink(url)
          const cached = this.#cached(link)
          if (cached) {
            settle(url, this.#check(cached))
            return
          }
          const uri = atUri(await this.#did(link.actor, opts.signal), link.rkey)
          const urls = wanted.get(uri)
          if (urls) urls.push(url)
          else wanted.set(uri, [url])
        } catch (error) {
          fail(url, error)
        }
      }),
    )
    const uris = [...wanted.keys()]
    const chunks: string[][] = []
    for (let i = 0; i < uris.length; i += POSTS_PER_REQUEST) chunks.push(uris.slice(i, i + POSTS_PER_REQUEST))
    // each chunk waits its turn in the AppView's pacer
    await Promise.all(
      chunks.map(async chunk => {
        try {
          const query = new URLSearchParams()
          for (const uri of chunk) query.append('uris', uri)
          const byUri = await this.#api(XRPC.posts, query, json => readPosts(json, this.#endpoints), opts.signal)
          for (const uri of chunk) {
            const post = byUri.get(uri)
            if (post && !(post instanceof MetaError)) this.#remember(post)
            for (const url of wanted.get(uri) ?? []) {
              if (post instanceof MetaError) fail(url, post)
              else if (post) settle(url, this.#check(post))
              else fail(url, new MetaError('removed', 'This Bluesky post was deleted (or never existed).'))
            }
          }
        } catch (error) {
          for (const uri of chunk) for (const url of wanted.get(uri) ?? []) fail(url, error)
        }
      }),
    )
    return results
  }

  async download(task: SourceDownload): Promise<SourceFile> {
    let link: PostLink | undefined
    for (let attempt = 1; ; attempt++) {
      try {
        link = this.#postLink(task.url)
        const post = usable(await this.#post(link, task.signal, task.fresh && attempt === 1))
        const pds = await this.#pdsOf(post.did, task.signal, task.fresh && attempt === 1)
        if (!pds && post.media.some(media => media.kind === 'video')) {
          throw new MetaError(
            'refused',
            `Bluesky: the server that keeps @${post.handle}'s files did not say where it is (its DID document did not answer).`,
          )
        }
        const meta = toMetaPost(post, {pds, cdnFirst: pds !== undefined && this.#isLimited(pds)})
        // TODO(core-hls): when the blob can't be had, the video's HLS playlist (video.cdn.bsky.app,
        // 720p TS with muxed audio) through the core's HLS module, once it exists.
        return await downloadPost({
          client: {session: this.#media},
          post: meta,
          task,
          site: this.name,
          referer: `${BLUESKY_ORIGIN}/`,
        })
      } catch (error) {
        if (task.signal.aborted || attempt >= DOWNLOAD_ATTEMPTS || !restartable(error)) {
          // read again next time: the post may be gone, the account moved to another PDS
          if (link) this.#posts.delete(link.rkey)
          throw this.#toDownloadError(error, task.signal)
        }
        this.#log('info', `Bluesky: ${(error as Error).message} — starting over (a PDS can't resume a download)`)
      }
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  #link(url: string): BlueskyLink {
    const link = parseBlueskyLink(url)
    if (!link) {
      throw new DownloadError(
        'invalid-request',
        'Not a Bluesky post or profile url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    return link
  }

  #postLink(url: string): PostLink {
    const link = this.#link(url)
    if (link.kind === 'profile') {
      throw new DownloadError('invalid-request', 'A Bluesky profile is a list: each of its posts is its own item.')
    }
    return link
  }

  // ─── the AppView ─────────────────────────────────────────────────────────

  /**
   * One paced XRPC query on the AppView, retried after the shared cool-down
   * when it is refused (429 / 5xx). A 400 that says the thing is not there is
   * `removed`; any other answer the module doesn't expect is a change on
   * Bluesky's side. O(size of the answer).
   */
  #api<T>(method: string, query: URLSearchParams, read: (json: unknown) => T, signal?: AbortSignal): Promise<T> {
    const url = `${this.#appView}/xrpc/${method}?${query.toString()}`
    return this.#retrying(
      () =>
        this.#pacer.run(async () => {
          const response = await this.#session.get(url, {headers: {Accept: 'application/json'}, signal})
          const body: unknown = await response.json().catch(() => undefined)
          if (response.ok) {
            this.#pacer.succeeded()
            return read(body)
          }
          const status = response.status
          const error = text(dig(body, 'error'))
          const message = text(dig(body, 'message')) ?? ''
          if (status === 429 || status >= 500) {
            this.#pacer.refused()
            throw new MetaError('refused', `Bluesky answered HTTP ${status}${error ? ` (${error})` : ''}.`, status)
          }
          if (status === 400 && ((error && GONE_ERRORS.has(error)) || GONE_MESSAGE.test(message))) {
            throw new MetaError('removed', goneMessage(method, message), status)
          }
          if (status === 401 || status === 403) {
            throw new MetaError('login-required', 'Bluesky shows this to signed-in accounts only.', status)
          }
          throw new MetaError(
            'format-changed',
            `Bluesky: ${method} answered HTTP ${status}${error ? ` (${error}: ${message})` : ''}.`,
            status,
          )
        }, signal),
      signal,
    )
  }

  async #retrying<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read()
      } catch (error) {
        if (signal?.aborted || !(error instanceof MetaError) || !error.transient || attempt >= READ_ATTEMPTS) {
          throw error
        }
        this.#log('info', `Bluesky: ${error.message} (try ${attempt} of ${READ_ATTEMPTS})`)
      }
    }
  }

  // ─── posts ───────────────────────────────────────────────────────────────

  /** A post read or listed lately, if the link names its author. O(1). */
  #cached(link: PostLink): BlueskyPost | undefined {
    const kept = this.#posts.get(link.rkey)
    if (!kept || Date.now() - kept.at >= POST_FRESH_MS) return undefined
    const post = kept.value
    return post.did === link.actor || post.handle === link.actor ? post : undefined
  }

  /** One post: from memory, else getPostThread (a handle works in its at-uri), shared by callers at the same time. */
  async #post(link: PostLink, signal?: AbortSignal, fresh = false): Promise<BlueskyPost> {
    const cached = fresh ? undefined : this.#cached(link)
    if (cached) return cached
    return this.#readingPosts.run(`${link.actor}/${link.rkey}`, signal, async shared => {
      const query = new URLSearchParams({uri: atUri(link.actor, link.rkey), depth: '0', parentHeight: '0'})
      const post = await this.#api(XRPC.postThread, query, json => readThread(json, this.#endpoints), shared)
      this.#remember(post)
      return post
    })
  }

  /** Keep a post (and its author's handle → DID). O(1); the oldest dropped past the bound. */
  #remember(post: BlueskyPost): void {
    bounded(this.#posts, post.rkey, {value: post, at: Date.now()}, POST_CACHE_LIMIT)
    if (post.handle !== post.did)
      bounded(this.#dids, post.handle, {value: post.did, at: Date.now()}, HANDLE_CACHE_LIMIT)
  }

  #check(post: BlueskyPost): ExtractResult {
    const problem = unreadable(post)
    if (problem) return {ok: false, error: this.#toDownloadError(problem).toJSON()}
    return {ok: true, analysis: this.#videoAnalysis(post)}
  }

  #videoAnalysis(post: BlueskyPost): VideoAnalysis {
    const meta = toMetaPost(post)
    return {kind: 'video', media: summaryOf(meta, this.name), choices: choices(meta)}
  }

  // ─── identities ──────────────────────────────────────────────────────────

  /** An actor's DID: a DID as it is; a handle from what was read, else resolveHandle (once, shared). */
  async #did(actor: string, signal?: AbortSignal): Promise<string> {
    if (actor.startsWith('did:')) return actor
    const known = this.#dids.get(actor)
    if (known && Date.now() - known.at < HANDLE_FRESH_MS) return known.value
    return this.#readingDids.run(actor, signal, async shared => {
      const did = await this.#api(
        XRPC.resolveHandle,
        new URLSearchParams({handle: actor}),
        json => {
          const value = text(dig(json, 'did'))
          if (!value?.startsWith('did:')) throw new MetaError('format-changed', 'Bluesky: resolveHandle without a DID.')
          return value
        },
        shared,
      )
      bounded(this.#dids, actor, {value: did, at: Date.now()}, HANDLE_CACHE_LIMIT)
      return did
    })
  }

  /**
   * Where an account keeps its blobs: its DID document's `#atproto_pds`
   * (plc.directory for did:plc, the host's well-known document for did:web),
   * read once per account and kept. Undefined when the document can't be had:
   * pictures then come from the CDN. O(1) requests per account.
   */
  async #pdsOf(did: string, signal?: AbortSignal, fresh = false): Promise<string | undefined> {
    const known = fresh ? undefined : this.#pds.get(did)
    if (known) return known
    return this.#readingPds.run(did, signal, async shared => {
      const document = didDocument(did, this.#endpoints)
      if (!document) return undefined
      try {
        const response = await this.#retrying(async () => {
          const answer = await this.#session.get(document, {headers: {Accept: 'application/json'}, signal: shared})
          if (answer.status === 429 || answer.status >= 500) {
            await answer.body?.cancel()
            throw new MetaError('refused', `Bluesky: the DID directory answered HTTP ${answer.status}.`)
          }
          return answer
        }, shared)
        if (!response.ok) await response.body?.cancel()
        const pds = response.ok ? readPds(await response.json()) : undefined
        if (pds) {
          this.#pds.delete(did)
          this.#pds.set(did, pds)
          if (this.#pds.size > PDS_CACHE_LIMIT) this.#pds.delete(this.#pds.keys().next().value!)
        } else this.#log('warn', `Bluesky: no PDS in the DID document of ${did} (HTTP ${response.status})`)
        return pds
      } catch (error) {
        if (shared.aborted) throw error
        this.#log('warn', `Bluesky: the DID document of ${did} did not answer (${String(error)})`)
        return undefined
      }
    })
  }

  // ─── blobs ───────────────────────────────────────────────────────────────

  /**
   * The media session's fetch: a blob request waits its turn in its PDS
   * host's pacer and is read for the host's rate limit headers; anything else
   * (the CDN) goes straight. O(1) per request.
   */
  async #mediaFetch(input: string, init?: RequestInit): Promise<Response> {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      return this.#fetch(input, init)
    }
    if (!url.pathname.endsWith(`/xrpc/${XRPC.blob}`)) return this.#fetch(input, init)
    const origin = url.origin
    return this.#pdsPacer(origin).run(async () => {
      const response = await this.#fetch(input, init)
      this.#observe(origin, response)
      return response
    }, init?.signal ?? undefined)
  }

  #pdsPacer(origin: string): Pacer {
    let pacer = this.#pdsPacers.get(origin)
    if (!pacer) {
      pacer = new Pacer(this.#pdsPacing, 'Bluesky')
      this.#pdsPacers.set(origin, pacer)
      if (this.#pdsPacers.size > PDS_HOST_LIMIT) {
        const oldest = this.#pdsPacers.keys().next().value!
        this.#pdsPacers.delete(oldest)
        this.#limited.delete(oldest)
      }
    }
    return pacer
  }

  /**
   * A PDS's rate limit headers (3000 per 5 minutes per IP): close to the
   * limit, pictures go to the CDN first until the window resets; past it
   * (429), its blob requests wait for the reset. O(1).
   */
  #observe(origin: string, response: Response): void {
    const remaining = num(response.headers.get('ratelimit-remaining'))
    const reset = num(response.headers.get('ratelimit-reset'))
    const limited = response.status === 429 || (remaining !== undefined && remaining <= RATE_RESERVE)
    if (!limited) return
    const now = Date.now()
    const until = reset !== undefined && reset * 1000 > now ? reset * 1000 : undefined
    const pacer = this.#pdsPacer(origin)
    if (response.status === 429) {
      if (until !== undefined && until - now <= MAX_RATE_WAIT_MS) pacer.pause(until - now)
      else pacer.refused()
    }
    this.#limited.set(origin, until ?? now + Math.max(pacer.coolingDownMs, UNKNOWN_RESET_MS))
    this.#log(
      'warn',
      `Bluesky: ${new URL(origin).host} is rate limiting this network (${remaining ?? 0} left); pictures from the CDN meanwhile`,
    )
  }

  #isLimited(pds: string): boolean {
    let origin: string
    try {
      origin = new URL(pds).origin
    } catch {
      return false
    }
    return (this.#limited.get(origin) ?? 0) > Date.now()
  }

  // ─── profiles ────────────────────────────────────────────────────────────

  /** A profile (getProfile), read once per ACCOUNT_FRESH_MS. */
  async #account(actor: string, signal?: AbortSignal): Promise<BlueskyAccount> {
    const known = this.#accounts.get(actor)
    if (known && Date.now() - known.at < ACCOUNT_FRESH_MS) return known.value
    return this.#readingAccounts.run(actor, signal, async shared => {
      const account = await this.#api(XRPC.profile, new URLSearchParams({actor}), readProfile, shared)
      bounded(this.#accounts, actor, {value: account, at: Date.now()}, ACCOUNT_CACHE_LIMIT)
      if (account.handle !== account.did) {
        bounded(this.#dids, account.handle, {value: account.did, at: Date.now()}, HANDLE_CACHE_LIMIT)
      }
      return account
    })
  }

  /**
   * A profile's own posts with media, newest first (the pinned one first, as
   * the profile shows it), up to `maxEntries`, PROFILE_CHUNK at a time, each
   * chunk kept as soon as it is in. `known` stops an incremental walk where
   * known posts start (the pinned post never counts). O(1) per post; one
   * request per 100 posts.
   */
  async #profile(
    actor: string,
    maxEntries: number | undefined,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
    owned?: ReadonlySet<string>,
  ): Promise<PlaylistAnalysis> {
    const account = await this.#account(actor, signal)
    if (account.signInOnly) {
      throw new MetaError(
        'login-required',
        `@${account.handle} asks Bluesky to show its posts to signed-in accounts only.`,
      )
    }
    const max = Math.max(1, Math.floor(maxEntries ?? this.#maxProfileItems))
    onProgress?.({listed: 0, expected: max})
    const kept = this.#listings.get(account.did)
    const fresh = kept && !owned && Date.now() - kept.at < LISTING_FRESH_MS ? kept : undefined
    let posts: BlueskyPost[] = fresh?.posts.slice(0, max) ?? []
    let cursor = fresh?.cursor
    let complete = fresh?.complete ?? false
    let caughtUp = false
    const cached = fresh !== undefined && (fresh.posts.length >= max || fresh.complete)
    const keep = () => {
      const longest = this.#listings.get(account.did)
      if (!longest || posts.length >= longest.posts.length || Date.now() - longest.at >= LISTING_FRESH_MS) {
        bounded(this.#listings, account.did, {posts, cursor, complete, at: Date.now()}, LISTING_CACHE_LIMIT)
      }
    }
    if (!cached) {
      try {
        while (posts.length < max && !complete) {
          const target = Math.min(max, posts.length + PROFILE_CHUNK)
          const listing = await walkCursor(next => this.#feedPage(account.did, next, signal), {
            max: target,
            idOf: post => post.rkey,
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
        if (signal?.aborted || posts.length === 0) throw error
        // a refusal half-way returns what was listed (the preview offers to continue)
        this.#log(
          'warn',
          `Bluesky: @${account.handle} listing stopped at ${posts.length} of ${max} (${String(error)}) — load again to continue`,
        )
      }
    }
    onProgress?.({listed: posts.length, expected: max})
    for (const post of posts) this.#remember(post)
    return {
      kind: 'playlist',
      id: account.did,
      url: profileUrl(BLUESKY_ORIGIN, account.handle),
      title: `Bluesky @${account.handle}`,
      uploader: account.name ?? account.handle,
      extractor: this.name,
      entries: posts.map((post, i) => ({...summaryOf(toMetaPost(post), this.name), index: i + 1})),
      choices: genericChoices(),
      complete,
      caughtUp: caughtUp || undefined,
    }
  }

  /** One page of the author's feed: its media posts with the pinned one, 100 posts a page. */
  #feedPage(did: string, cursor: string | undefined, signal?: AbortSignal) {
    const query = new URLSearchParams({
      actor: did,
      filter: this.#endpoints.feedFilter,
      includePins: 'true',
      limit: String(FEED_PAGE),
      ...(cursor !== undefined && {cursor}),
    })
    return this.#api(XRPC.authorFeed, query, json => readFeedPage(json, did, this.#endpoints), signal)
  }

  // ─── errors ──────────────────────────────────────────────────────────────

  /**
   * The engine's error, with nothing handed to yt-dlp (see NO_FALLBACK): a
   * changed answer says so in its own words ('retry-later' unless it has a hint).
   */
  #toDownloadError(error: unknown, signal?: AbortSignal): DownloadError {
    if (signal?.aborted && !(error instanceof DownloadError)) return cancelledError()
    const converted = toDownloadError(error, this.name)
    if (!needsFallback(converted.details)) return converted
    const changed = error instanceof MetaError && error.problem === 'format-changed'
    return new DownloadError(
      'unavailable',
      changed
        ? `${converted.message} Bluesky changed its API; ${NO_FALLBACK}: an update of this library will.`
        : `${converted.message} (${NO_FALLBACK}; try again in a few minutes.)`,
      undefined,
      converted.params,
      converted.hint ?? 'retry-later',
    )
  }
}

/** A post with something to download that a visitor may see; else why not. O(1). */
function usable(post: BlueskyPost): BlueskyPost {
  const problem = unreadable(post)
  if (problem) throw problem
  return post
}

/** A video's size isn't in the post: the generic choices; pictures as a photo post's. */
function choices(post: MetaPost): FormatChoice[] {
  return shapeOf(post) === 'video' ? genericChoices() : choicesOf(post)
}

/**
 * A transfer that broke (a dropped connection, a short body, a 5xx), not a
 * refusal to wait out and not a cancel: worth starting over once. O(1).
 */
function restartable(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return false
  const converted = toDownloadError(error, 'Bluesky')
  return converted.code === 'network' && converted.details !== COOLING_DOWN
}

/** Where a DID's document is; undefined for a method this module doesn't know. O(1). */
function didDocument(did: string, endpoints: BlueskyEndpoints): string | undefined {
  if (did.startsWith('did:plc:')) return `${endpoints.plc.replace(/\/+$/, '')}/${did}`
  if (did.startsWith('did:web:')) {
    // a colon would be a path (did:web:host:path), which atproto doesn't use; a port is %3A
    const raw = did.slice('did:web:'.length)
    const host = raw.includes(':') ? '' : decodeURIComponent(raw)
    return host && !host.includes('/') ? endpoints.didWebDocument(host) : undefined
  }
  return undefined
}

function goneMessage(method: string, message: string): string {
  if (method === XRPC.profile || method === XRPC.authorFeed || /profile|handle/i.test(message)) {
    return 'There is no Bluesky account by that name (or no longer).'
  }
  return 'This Bluesky post was deleted (or never existed).'
}

/** A bounded cache entry: re-inserted as the newest, the oldest dropped past `limit`. O(1). */
function bounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) map.delete(map.keys().next().value!)
}
