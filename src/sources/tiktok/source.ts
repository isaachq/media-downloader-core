import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtractResult} from '../../core/analyze.js'
import {DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, FailureHint, MediaSummary, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import type {BrowserAssist} from '../browser.js'
import {type Fetch, HttpSession} from '../http.js'
import {fetchMedia} from '../media-fetch.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import {followShortLink, resolved, unresolvedMessage} from '../redirects.js'
import {HostSession, type SessionProvider} from '../session.js'
import {
  type ListingProgress,
  type MediaSource,
  SOURCE_BLOCKED,
  SOURCE_FORMAT_CHANGED,
  type SourceDownload,
  type SourceFile,
} from '../source.js'
import {
  canonicalUrl,
  pageScope,
  postFromDetail,
  postFromPage,
  readListPage,
  type TikTokPost,
  type TikTokUser,
  userFromPage,
} from './data.js'
import {TikTokError} from './errors.js'
import {parseTikTokLink, postUrl, profileUrl} from './links.js'
import {walkProfile} from './profile.js'
import {rankRenditions, slideshowChoices, tiktokChoices} from './renditions.js'
import {buildSlideshowVideo, slideshowFrame} from './slideshow.js'

export type TikTokOptions = {
  /** Profiles list at most this many posts unless asked otherwise. Default 500. */
  readonly maxProfileItems?: number | undefined
  /** Pace of requests to tiktok.com (pages and listing). Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** Tests: serve "TikTok" from another origin. */
  readonly origin?: string | undefined
  readonly fetch?: Fetch | undefined
  /**
   * A real browser (the host app's) for pages TikTok only serves after its own
   * check has run in a browser. Without one, such pages hand TikTok to yt-dlp.
   */
  readonly browser?: BrowserAssist | undefined
  /**
   * The user's TikTok session (cookies, and the agent that earned them when
   * the host knows it), as Instagram and Facebook take it: asked for when the
   * source starts reading and again every 6 hours. Pages, listings and media
   * then go with it. Without one TikTok is read as a visitor.
   */
  readonly cookies?: SessionProvider | undefined
  /** Where the source reports what it did (the engine's log). */
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const TIKTOK_PROFILE_DEFAULT_ITEMS = 500
/** Media links are tied to the session and minutes-fresh pages; older ones are re-read. */
const PAGE_FRESH_MS = 10 * 60_000
/**
 * How many downloads of a listed post may end on "doesn't exist" (10204), even
 * with fresh cookies, before TikTok is believed. Each one is retried by its job.
 */
const GONE_DOUBTS = 2
const CACHE_LIMIT = 5000
const LIST_PAGE_SIZE = 15
/** A profile listing is reused (or continued) for this long. */
const LISTING_FRESH_MS = 15 * 60_000
/** Profiles are listed this many posts at a time, each chunk kept as soon as it is in. */
export const PROFILE_CHUNK = 500
/** A profile listing below this share of the expected count gets a second pass. */
const COMPLETE_SHARE = 0.95
/** Reads of a page / listing page that TikTok refused, retried after the shared cool-down. */
const READ_ATTEMPTS = 3
/** After a verification page, TikTok urls go to yt-dlp for this long (a circuit breaker). */
const BLOCKED_MS = 10 * 60_000

type Cached = {readonly post: TikTokPost; readonly fromPage: boolean; readonly at: number}

/** TikTok's bot shell: a reflow page with no post, after a listing has marked the jar. */
function botShell(scope: unknown): boolean {
  return typeof scope === 'object' && scope !== null && 'webapp.reflow.video.strategy' in scope
}

/** The embedded post, or undefined when this page is a shell. Private and removed still throw. */
/**
 * "Doesn't exist" (10204) or "private" (10216): final for a link nobody listed,
 * doubted for a post a listing just showed (razr 50: a listed post read as
 * private that PC and two earlier runs read fine).
 */
function isGoneAnswer(error: unknown): boolean {
  return error instanceof TikTokError && (error.problem === 'removed' || error.problem === 'private')
}

function takePost(scope: unknown): TikTokPost | undefined {
  try {
    return postFromPage(scope)
  } catch (error) {
    if (error instanceof TikTokError && (error.problem === 'private' || error.problem === 'removed')) throw error
    if (error instanceof TikTokError && error.problem === 'format-changed') return undefined
    throw error
  }
}

/**
 * TikTok, natively: pages and the public profile listing over plain HTTP,
 * media straight from the CDN. No signatures, no challenge solving — when
 * TikTok asks to slow down, every request backs off together (Pacer).
 */
export class TikTokSource implements MediaSource {
  readonly name = 'TikTok'
  readonly #origin: string
  readonly #originHost: string
  readonly #maxProfileItems: number
  readonly #session: HttpSession
  readonly #pacer: Pacer
  /** Posts seen in listings and pages, by id (insertion order = age: oldest evicted first). */
  readonly #posts = new Map<string, Cached>()
  /** user name → account, so a profile page is read once per session. */
  readonly #accounts = new Map<string, TikTokUser>()
  /** secUid → what its listing gave, reused for LISTING_FRESH_MS (a reopened preview costs nothing). */
  readonly #listings = new Map<string, {posts: TikTokPost[]; complete: boolean; at: number}>()
  readonly #log: (level: 'info' | 'warn', message: string) => void
  #blockedUntil = 0
  readonly #browser: BrowserAssist | undefined
  /** One browser page at a time: each is a full page load. */
  readonly #browserTurns = new Pacer({concurrency: 1, spacingMs: 0, jitterMs: 0})
  readonly #host: HostSession
  /** The in-flight cookie reset, so parallel downloads don't wipe each other's fresh jar. */
  #refreshing: Promise<void> | undefined
  /** A listing ran since the jar was last reset: its cookie may make posts "not exist". */
  #listedSinceReset = false
  /**
   * Known posts TikTok called gone (status 10204), with how many times, while
   * they wait for another read after the back-off. Cleared when they are read
   * or given up: holds only posts in flight, O(1) per check.
   */
  readonly #doubted = new Map<string, number>()

  constructor(options: TikTokOptions = {}) {
    this.#origin = (options.origin ?? 'https://www.tiktok.com').replace(/\/$/, '')
    this.#originHost = new URL(this.#origin).hostname
    this.#maxProfileItems = Math.max(1, options.maxProfileItems ?? TIKTOK_PROFILE_DEFAULT_ITEMS)
    this.#session = new HttpSession({fetch: options.fetch})
    this.#pacer = new Pacer(options.pacing)
    this.#browser = options.browser
    this.#log = options.log ?? (() => {})
    this.#host = new HostSession({site: this.name, provider: options.cookies, session: this.#session, log: this.#log})
  }

  get available(): boolean {
    return Date.now() >= this.#blockedUntil
  }

  handles(url: string): boolean {
    return parseTikTokLink(url, this.#originHost) !== undefined
  }

  defaultListSize(url: string): number | undefined {
    return parseTikTokLink(url, this.#originHost)?.kind === 'profile' ? this.#maxProfileItems : undefined
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
      if (link.kind === 'profile') {
        return await this.#profile(link.user, opts.maxEntries, opts.signal, opts.onProgress, opts.known)
      }
      const post = await this.#readPost(link.id, link.user, opts.signal)
      return this.#videoAnalysis(post)
    } catch (error) {
      throw toDownloadError(error)
    }
  }

  async preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {signal?: AbortSignal | undefined; onResult?: ((url: string, result: ExtractResult) => void) | undefined},
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    // items from a profile listing are already known: no request at all. Others are paced.
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
    try {
      const link = await this.#resolve(task.url, task.signal)
      if (link.kind === 'profile') throw new DownloadError('invalid-request', 'A profile is not a single post.')
      // a slideshow from a listing needs no page: its image links open without a session
      const listed = this.#posts.get(link.id)?.post
      const post =
        !task.fresh && listed?.photoPost && listed.images.length > 0
          ? listed
          : await this.#readPost(link.id, link.user, task.signal, task.fresh)
      if (post.photoPost) return await this.#slideshow(post, task)
      if (post.renditions.length === 0) {
        throw new TikTokError('format-changed', 'This post has no video to download.')
      }
      task.onInfo({id: post.id, title: titleOf(post), duration: post.duration ?? null, extractor: this.name})
      const file = await this.#fetchBest(post, task)
      return {
        filepath: file.path,
        info: {
          id: post.id,
          title: titleOf(post),
          duration: post.duration ?? null,
          extractor: this.name,
          vcodec: file.codec === 'h264' ? 'avc1' : 'hvc1',
          acodec: 'mp4a',
          filesize: file.bytes,
          publishedAt: post.createdAt ?? null,
        },
        tags: {
          title: titleOf(post),
          artist: post.authorName ?? post.author,
          date: post.createdAt ? new Date(post.createdAt * 1000).toISOString().slice(0, 10) : undefined,
          comment: postUrl('https://www.tiktok.com', post.id, post.author),
        },
      }
    } catch (error) {
      // the page or links may be stale: the next attempt reads the page again
      this.#posts.delete(parseTikTokLink(task.url, this.#originHost)?.kind === 'video' ? idOf(task.url) : '')
      throw toDownloadError(error)
    }
  }

  // ─── slideshows ──────────────────────────────────────────────────────────

  /**
   * A photo post, as the task asks: its soundtrack alone (audio profiles), an
   * MP4 of its images over the soundtrack, or a folder of its images (with
   * the soundtrack in 'images-audio'). Images download 4 at a time, each from
   * its first mirror that answers.
   */
  async #slideshow(post: TikTokPost, task: SourceDownload): Promise<SourceFile> {
    if (post.images.length === 0) throw new TikTokError('photo-post', 'This slideshow has no images.')
    const title = titleOf(post)
    const {mode, secondsPerImage} = task.slideshow
    const audioOnly = task.profile.kind === 'audio'
    const seconds = post.images.length * secondsPerImage
    task.onInfo({
      id: post.id,
      title,
      duration: audioOnly ? (post.music?.duration ?? null) : seconds,
      extractor: this.name,
    })
    const tags = {
      title,
      artist: post.authorName ?? post.author,
      date: post.createdAt ? new Date(post.createdAt * 1000).toISOString().slice(0, 10) : undefined,
      comment: postUrl('https://www.tiktok.com', post.id, post.author),
    }
    const info = {id: post.id, title, extractor: this.name, publishedAt: post.createdAt ?? null}
    const folder = path.join(task.workDir, `${post.id}-slides`)
    await fs.mkdir(folder, {recursive: true})

    const wantsSound = audioOnly || mode !== 'images'
    const sound = wantsSound && post.music?.url ? await this.#fetchSound(post.music.url, folder, task) : undefined
    if (audioOnly) {
      if (!sound) throw new TikTokError('photo-post', 'This slideshow has no soundtrack to download.')
      return {
        filepath: sound.file,
        info: {...info, duration: post.music?.duration ?? null, acodec: 'mp4a', filesize: sound.bytes},
        tags,
      }
    }

    const images = await this.#fetchImages(post, folder, task)
    if (mode === 'video') {
      const output = path.join(task.workDir, `${post.id}-slideshow.mp4`)
      task.onProgress({fraction: 0})
      await buildSlideshowVideo({
        ffmpeg: task.ffmpeg,
        images,
        frame: slideshowFrame(post.images),
        audio: sound?.file,
        secondsPerImage,
        output,
        threads: task.threads,
        signal: task.signal,
        onProgress: fraction => task.onProgress({fraction}),
      })
      await fs.rm(folder, {recursive: true, force: true})
      const bytes = (await fs.stat(output)).size
      return {
        filepath: output,
        info: {...info, duration: seconds, vcodec: 'avc1', acodec: sound ? 'mp4a' : 'none', filesize: bytes},
        tags,
      }
    }
    // a folder of images (and the soundtrack): kept as it is, each file checked by the engine
    return {filepath: folder, bundle: true, info: {...info, duration: sound ? (post.music?.duration ?? null) : null}}
  }

  async #fetchImages(post: TikTokPost, folder: string, task: SourceDownload): Promise<string[]> {
    const files: string[] = new Array(post.images.length)
    let done = 0
    let next = 0
    const width = String(post.images.length).length < 2 ? 2 : String(post.images.length).length
    const worker = async () => {
      for (let i = next++; i < post.images.length; i = next++) {
        const name = String(i + 1).padStart(width, '0')
        let last: unknown
        for (const url of post.images[i]!.urls) {
          const partial = path.join(folder, `${name}.part`)
          try {
            const fetched = await fetchMedia(this.#session, url, partial, {
              site: 'TikTok',
              headers: {Referer: `${this.#origin}/`},
              signal: task.signal,
              onProgress: () => {},
            })
            const file = path.join(folder, `${name}${extensionOf(fetched.contentType, '.jpg')}`)
            await fs.rename(partial, file)
            files[i] = file
            last = undefined
            break
          } catch (error) {
            if (task.signal.aborted) throw error
            await fs.rm(partial, {force: true})
            last = error
          }
        }
        if (last !== undefined) throw last
        task.onProgress({fraction: ++done / post.images.length})
      }
    }
    await Promise.all(Array.from({length: Math.min(4, post.images.length)}, worker))
    return files
  }

  async #fetchSound(url: string, folder: string, task: SourceDownload): Promise<{file: string; bytes: number}> {
    const partial = path.join(folder, 'sound.part')
    const fetched = await fetchMedia(this.#session, url, partial, {
      site: 'TikTok',
      headers: {Referer: `${this.#origin}/`},
      signal: task.signal,
      onProgress: () => {},
    })
    const file = path.join(folder, `sound${extensionOf(fetched.contentType, '.mp3')}`)
    await fs.rename(partial, file)
    return {file, bytes: fetched.bytes}
  }

  // ─── links, pages, listing ───────────────────────────────────────────────

  /** Short links are redirects (a hop or a few): landing on the home page means the post is gone. */
  async #resolve(url: string, signal?: AbortSignal) {
    // every read starts here: the host's session (when it gives one) goes with it
    await this.#host.load()
    const link = parseTikTokLink(url, this.#originHost)
    if (!link)
      throw new DownloadError(
        'invalid-request',
        'Not a TikTok post or profile url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    if (link.kind !== 'short') return link
    const followed = await followShortLink(
      link.url,
      async url => {
        const response = await this.#pacer.run(() => this.#session.get(url, {redirect: 'manual', signal}), signal)
        await response.body?.cancel()
        return response.headers.get('location') ?? undefined
      },
      url => resolved(parseTikTokLink(url, this.#originHost)),
    )
    if (!followed.ok) throw new TikTokError('removed', unresolvedMessage(followed.reason))
    return followed.link
  }

  /**
   * A refusal (403 / 429 / empty answer) is retried after the shared cool-down.
   * A verification page is not: solving it is out of scope, so the source steps
   * aside for BLOCKED_MS and the engine uses yt-dlp meanwhile.
   */
  async #retrying<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read()
      } catch (error) {
        if (error instanceof TikTokError && error.problem === 'challenge') {
          // with a browser at hand the caller tries it before stepping aside
          if (!this.#browser) this.#blockedUntil = Date.now() + BLOCKED_MS
          throw error
        }
        if (signal?.aborted || !(error instanceof TikTokError) || !error.transient || attempt >= READ_ATTEMPTS)
          throw error
      }
    }
  }

  async #page(url: string, signal?: AbortSignal) {
    try {
      return await this.#retrying(() => this.#pageOnce(url, signal), signal)
    } catch (error) {
      if (!(error instanceof TikTokError) || error.problem !== 'challenge' || !this.#browser) throw error
      return (await this.#pageInBrowser(url, signal)).scope
    }
  }

  /**
   * The page as a real browser gets it: TikTok's check runs there by itself.
   * Its session is adopted, so the listing, the next pages and the media
   * download go on over plain HTTP — the browser is only needed again when
   * that session is refused. A captcha or login wall stays a challenge.
   */
  async #pageInBrowser(
    url: string,
    signal?: AbortSignal,
  ): Promise<{scope: ReturnType<typeof pageScope>; html: string}> {
    let scope: ReturnType<typeof pageScope>
    let page: Awaited<ReturnType<BrowserAssist>>
    try {
      page = await this.#browserTurns.run(() => this.#browser!(url, signal), signal)
      scope = pageScope(page.html)
    } catch (error) {
      // the browser got a captcha / login wall too: step aside (yt-dlp) for a while
      if (error instanceof TikTokError && error.transient) {
        this.#blockedUntil = Date.now() + BLOCKED_MS
        this.#log(
          'warn',
          `TikTok: even the browser got a verification page — using yt-dlp for ${BLOCKED_MS / 60_000} min`,
        )
      }
      throw error
    }
    this.#session.adopt(page)
    this.#log('info', `TikTok: ${url} read in the in-app browser`)
    this.#blockedUntil = 0
    // the refusal that sent us here no longer applies: no cool-down before the listing
    this.#pacer.resume()
    return {scope, html: page.html}
  }

  async #pageOnce(url: string, signal?: AbortSignal) {
    return this.#pacer.run(async () => {
      const response = await this.#session.get(url, {headers: {Accept: 'text/html,application/xhtml+xml'}, signal})
      if (response.status === 404) throw new TikTokError('removed', 'TikTok answered 404.')
      if (!response.ok) {
        this.#pacer.refused()
        throw new TikTokError('refused', `TikTok answered HTTP ${response.status}.`)
      }
      try {
        const scope = pageScope(await response.text())
        this.#pacer.succeeded()
        return scope
      } catch (error) {
        if (error instanceof TikTokError && error.transient) this.#pacer.refused()
        throw error
      }
    }, signal)
  }

  async #readPost(id: string, user: string | undefined, signal?: AbortSignal, fresh = false): Promise<TikTokPost> {
    const cached = this.#posts.get(id)
    // a page read is minutes-fresh; listing links are only a last resort (see below)
    if (!fresh && cached?.fromPage && Date.now() - cached.at < PAGE_FRESH_MS) return cached.post
    // known: in the cache now, or doubted before (a failed download drops its cache entry)
    const doubts = this.#doubted.get(id) ?? 0
    const known = cached !== undefined || doubts > 0
    try {
      const post = await this.#readPage(id, user, cached, known, signal)
      this.#doubted.delete(id)
      return post
    } catch (error) {
      // Still "doesn't exist" with a fresh jar: the job retries (its own delay, nobody else
      // waits), and after GONE_DOUBTS such answers TikTok is believed.
      const gone = isGoneAnswer(error)
      if (!gone || !known || doubts >= GONE_DOUBTS) {
        this.#doubted.delete(id)
        throw error
      }
      this.#doubted.set(id, doubts + 1)
      this.#log(
        'warn',
        `TikTok: ${id} was listed but TikTok says it doesn't exist or is private, even with fresh cookies — retrying`,
      )
      throw new TikTokError('refused', 'TikTok said a post it listed no longer exists; it is read again.')
    }
  }

  async #readPage(
    id: string,
    user: string | undefined,
    cached: Cached | undefined,
    known: boolean,
    signal?: AbortSignal,
  ): Promise<TikTokPost> {
    const url = postUrl(this.#origin, id, user ?? cached?.post.author)
    const scope = await this.#page(url, signal)
    let embedded: TikTokPost | undefined
    try {
      embedded = takePost(scope)
    } catch (error) {
      // A profile listing leaves a cookie that makes TikTok answer some of its posts' pages
      // with status 10204 ("doesn't exist"): on a razr 50, 56 of the first 164 posts of an
      // 840-video profile; all 18 that failed that way again downloaded at once with a clean
      // jar. A post is read once more with the listing cookie dropped (one reset shared by the
      // downloads in flight, like the shell page below) when this session has seen it — or has
      // listed anything since the jar was last reset: on a razr 50, after a long session, three
      // public posts pasted by hand answered 10204 on every read, and a fresh start read them at
      // once. With a clean jar, "doesn't exist" is believed at once.
      if (!(isGoneAnswer(error) && (known || this.#listedSinceReset))) throw error
      embedded = await this.#afterFreshJar(url, signal)
      if (embedded)
        this.#log('info', `TikTok: ${id} read again with fresh cookies after a "doesn't exist" or "private" page`)
    }
    // Plain HTTP often gets a reflow shell after a listing (no post). The in-app
    // browser still receives the page the site gives a real client; one load.
    if (!embedded && this.#browser) {
      embedded = await this.#readViaBrowser(url, signal)
      if (embedded) this.#log('info', `TikTok: ${id} read from the in-app browser`)
    }
    // No browser: drop the listing cookie once and read the page again.
    if (!embedded && botShell(scope)) {
      embedded = await this.#afterFreshJar(url, signal)
      if (embedded) this.#log('info', `TikTok: ${id} read again after a shell page`)
    }
    if (embedded) {
      this.#remember(embedded, true)
      return embedded
    }
    // one canonical follow when the first page is a shell (a /video/ url for a photo, or the other way)
    const canonical = this.#canonical(url, scope)
    if (canonical) {
      const followed = takePost(await this.#page(canonical, signal))
      if (followed) {
        this.#log('info', `TikTok: ${id} read from its canonical page`)
        this.#remember(followed, true)
        return followed
      }
    }
    // the item api returns the same itemStruct the page used to embed; one request, paced with the rest
    const fromApi = await this.#itemDetail(id, signal)
    if (fromApi) {
      this.#log('info', `TikTok: ${id} read from the item api`)
      this.#remember(fromApi, true)
      return fromApi
    }
    // profile listings already parsed the post. Their media links are often refused, so this is last.
    const listed = cached?.post
    if (listed && (listed.renditions.length > 0 || (listed.photoPost && listed.images.length > 0))) {
      this.#log('info', `TikTok: ${id} read from the profile listing`)
      return listed
    }
    throw new TikTokError('format-changed', 'TikTok video page without video details.')
  }

  /** The video page as the in-app browser receives it. Undefined when that page has no post either. */
  async #readViaBrowser(url: string, signal?: AbortSignal): Promise<TikTokPost | undefined> {
    try {
      return takePost((await this.#pageInBrowser(url, signal)).scope)
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof TikTokError && (error.problem === 'private' || error.problem === 'removed')) throw error
      return undefined
    }
  }

  /** One reset shared by the downloads in flight, then this post's page. */
  async #afterFreshJar(url: string, signal?: AbortSignal): Promise<TikTokPost | undefined> {
    const pending = this.#refreshing
    if (pending) {
      await pending
    } else {
      let done: () => void = () => {}
      this.#refreshing = new Promise(resolve => {
        done = resolve
      })
      try {
        this.#session.reset()
        this.#listedSinceReset = false
        this.#host.forget()
        await this.#host.load()
      } finally {
        this.#refreshing = undefined
        done()
      }
    }
    return takePost(await this.#page(url, signal))
  }

  /** A different post url advertised on a shell page, or undefined when it is the page we already read. */
  #canonical(current: string, scope: unknown): string | undefined {
    const canonical = canonicalUrl(scope)
    if (!canonical) return undefined
    const next = parseTikTokLink(canonical, this.#originHost)
    if (!next || (next.kind !== 'video' && next.kind !== 'photo')) return undefined
    const now = parseTikTokLink(current, this.#originHost)
    if (now && (now.kind === 'video' || now.kind === 'photo') && now.id === next.id && now.kind === next.kind)
      return undefined
    return canonical
  }

  /** `/api/item/detail/`. Undefined when it has no post; private and removed still throw. */
  async #itemDetail(id: string, signal?: AbortSignal): Promise<TikTokPost | undefined> {
    const query = new URLSearchParams({aid: '1988', itemId: id})
    try {
      return await this.#pacer.run(async () => {
        const response = await this.#session.get(`${this.#origin}/api/item/detail/?${query}`, {
          headers: {Accept: 'application/json', Referer: `${this.#origin}/`},
          signal,
        })
        const body = response.ok ? await response.text() : ''
        if (!body) return undefined
        try {
          return postFromDetail(JSON.parse(body) as unknown)
        } catch (error) {
          if (error instanceof TikTokError && (error.problem === 'private' || error.problem === 'removed')) throw error
          return undefined
        }
      }, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof TikTokError && (error.problem === 'private' || error.problem === 'removed')) throw error
      return undefined
    }
  }

  async #profile(
    user: string,
    maxEntries: number | undefined,
    abort?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
    /** Posts already had: list from the newest until they start (an incremental sync). */
    owned?: ReadonlySet<string>,
  ): Promise<PlaylistAnalysis> {
    const key = user.toLowerCase()
    const account = this.#accounts.get(key) ?? userFromPage(await this.#page(profileUrl(this.#origin, user), abort))
    this.#accounts.set(key, account)
    if (account.privateAccount) throw new TikTokError('private', `@${account.user || user} is a private account.`)
    const max = Math.max(
      1,
      Math.min(maxEntries ?? this.#maxProfileItems, account.videoCount ?? Number.POSITIVE_INFINITY),
    )
    onProgress?.({listed: 0, expected: max})
    // a recent listing of this account answers at once, or is continued where it stopped
    const known = this.#listings.get(account.secUid)
    // an incremental walk wants the newest posts: it starts afresh, never from a kept listing
    const fresh = known && !owned && Date.now() - known.at < LISTING_FRESH_MS ? known : undefined
    let caughtUp = false
    let complete = fresh?.complete ?? false
    const walk = (target: number, resume?: readonly TikTokPost[]) =>
      walkProfile((cursor, deviceId) => this.#listPage(account.secUid, cursor, deviceId, abort), {
        max: target,
        newDeviceId,
        resume,
        onProgress: listed => onProgress?.({listed, expected: max}),
        // once the end was reached, a later (second) pass that stops short doesn't undo it
        onEnd: whole => {
          complete ||= whole
        },
        known: owned,
        onCaughtUp: () => {
          caughtUp = true
        },
      })
    // every chunk is kept as soon as it is listed: a refusal, a cancel or a
    // closed preview never loses it, and the next request continues from there
    const keep = (list: TikTokPost[]) => {
      const longest = this.#listings.get(account.secUid)
      if (!longest || list.length >= longest.posts.length || Date.now() - longest.at >= LISTING_FRESH_MS) {
        this.#listings.set(account.secUid, {posts: list, complete, at: Date.now()})
      }
    }
    let posts: TikTokPost[] = fresh?.posts.slice(0, max) ?? []
    const cached = fresh !== undefined && (fresh.posts.length >= max || fresh.complete)
    if (account.videoCount === 0) posts = []
    else if (!cached) {
      try {
        while (posts.length < max && !complete) {
          const target = Math.min(max, posts.length + PROFILE_CHUNK)
          posts = await walk(target, posts)
          keep(posts)
          if (caughtUp || posts.length < target) break // the listing ended or stalled: the second pass below decides
        }
      } catch (error) {
        // a cancel cancels; a refusal half-way returns what was listed (the preview offers to continue)
        if (abort?.aborted || posts.length === 0) throw error
        this.#log(
          'warn',
          `TikTok: @${account.user || user} listing stopped at ${posts.length} of ${max} (${String(error)}) — load again to continue`,
        )
      }
    }
    // the listing is known to come back short between runs: one more pass with a
    // fresh identity when more than 5% is missing, merged by id. Up to one chunk
    // it walks again from the top (gaps can be anywhere); beyond that it
    // continues below the oldest post (a full re-walk would cost as much again)
    if (!cached && !caughtUp && !abort?.aborted && posts.length > 0 && posts.length < max * COMPLETE_SHARE) {
      this.#log('info', `TikTok: @${account.user || user} listed ${posts.length} of ${max} — second pass`)
      const again = await walk(max, max <= PROFILE_CHUNK ? undefined : posts).catch(() => [])
      const merged = new Map(posts.map(post => [post.id, post]))
      for (const post of again) if (merged.size < max) merged.set(post.id, post)
      posts = [...merged.values()].sort(newestFirst)
      keep(posts)
    }
    onProgress?.({listed: posts.length, expected: max})
    for (const post of posts) this.#remember(post, false)
    const owner = account.user || user
    return {
      kind: 'playlist',
      id: account.secUid,
      url: profileUrl('https://www.tiktok.com', owner),
      title: `TikTok @${owner}`,
      uploader: account.name ?? owner,
      extractor: this.name,
      entries: posts.map((post, i) => ({...this.#summary(post), index: i + 1})),
      choices: genericChoices(),
      total: account.videoCount,
      complete,
      // set by the walk's callback: TypeScript can't see that it may have changed
      caughtUp: (caughtUp as boolean) || undefined,
    }
  }

  async #listPage(secUid: string, cursor: number, deviceId: string, signal?: AbortSignal) {
    const query = new URLSearchParams({
      aid: '1988',
      count: String(LIST_PAGE_SIZE),
      cursor: String(Math.floor(cursor)),
      type: '1',
      secUid,
      device_id: deviceId,
    })
    return this.#retrying(() => this.#listPageOnce(query, signal), signal)
  }

  async #listPageOnce(query: URLSearchParams, signal?: AbortSignal) {
    return this.#pacer.run(async () => {
      const response = await this.#session.get(`${this.#origin}/api/creator/item_list/?${query}`, {
        headers: {Accept: 'application/json', Referer: `${this.#origin}/`},
        signal,
      })
      // the listing's answer sets the cookie that can make posts "not exist" afterwards
      this.#listedSinceReset = true
      const body = response.ok ? await response.text() : ''
      if (!body) {
        this.#pacer.refused()
        throw new TikTokError('refused', `TikTok listing answered HTTP ${response.status} with no data.`)
      }
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch {
        throw new TikTokError('format-changed', 'TikTok listing is not JSON any more.')
      }
      const page = readListPage(json)
      this.#pacer.succeeded()
      return page
    }, signal)
  }

  async #check(url: string, signal?: AbortSignal): Promise<ExtractResult> {
    try {
      const link = await this.#resolve(url, signal)
      if (link.kind === 'profile') throw new DownloadError('invalid-request', 'A profile is not a single post.')
      const post = this.#posts.get(link.id)?.post ?? (await this.#readPost(link.id, link.user, signal))
      if (post.privateItem) throw new TikTokError('private', 'This post is private.')
      if (post.photoPost && post.images.length === 0)
        throw new TikTokError('photo-post', 'This slideshow has no images.')
      if (!post.photoPost && post.renditions.length === 0) {
        throw new TikTokError('format-changed', 'This post has no video to download.')
      }
      return {ok: true, analysis: this.#videoAnalysis(post)}
    } catch (error) {
      return {ok: false, error: toDownloadError(error).toJSON()}
    }
  }

  #remember(post: TikTokPost, fromPage: boolean): void {
    // a page read is worth more than a listing entry: never downgrade it
    const known = this.#posts.get(post.id)
    if (known?.fromPage && !fromPage) return
    this.#posts.delete(post.id)
    this.#posts.set(post.id, {post, fromPage, at: Date.now()})
    if (this.#posts.size > CACHE_LIMIT) this.#posts.delete(this.#posts.keys().next().value!)
  }

  #summary(post: TikTokPost): MediaSummary {
    return {
      id: post.id,
      url: postUrl('https://www.tiktok.com', post.id, post.author),
      title: titleOf(post),
      uploader: post.authorName ?? post.author,
      duration: post.duration,
      thumbnail: post.cover,
      publishedAt: post.createdAt,
      ...(post.photoPost && {slideshow: {images: post.images.length, audio: Boolean(post.music?.url)}}),
      extractor: this.name,
      isLive: false,
    }
  }

  #videoAnalysis(post: TikTokPost): VideoAnalysis {
    return {
      kind: 'video',
      media: this.#summary(post),
      choices: post.photoPost ? slideshowChoices(post) : tiktokChoices(post),
    }
  }

  // ─── media ───────────────────────────────────────────────────────────────

  /** Try encodings best first, every mirror of each; skip silent ones when sound is needed. */
  async #fetchBest(post: TikTokPost, task: SourceDownload) {
    const ranked = rankRenditions(post.renditions, task.profile)
    let last: unknown
    for (const rendition of ranked) {
      for (const url of rendition.urls) {
        const file = path.join(task.workDir, `${post.id}-${rendition.codec}-${rendition.resolution}.mp4`)
        try {
          const {bytes} = await fetchMedia(this.#session, url, file, {
            site: 'TikTok',
            headers: {Referer: `${this.#origin}/`},
            expected: rendition.bytes,
            signal: task.signal,
            onProgress: task.onProgress,
          })
          if (await task.hasAudio(file)) return {path: file, bytes, codec: rendition.codec}
          await fs.rm(file, {force: true})
          last = new TikTokError(
            'format-changed',
            `The ${rendition.resolution}p ${rendition.codec} encoding has no sound.`,
          )
          break // other mirrors serve the same silent file
        } catch (error) {
          if (task.signal.aborted) throw error
          last = error
        }
      }
    }
    throw last ?? new TikTokError('format-changed', 'No downloadable encoding.')
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** First line of the caption without trailing hashtags; the id when there is no caption. */
export function titleOf(post: TikTokPost): string {
  const caption = post.description
    .split('\n', 1)[0]!
    .replace(/(\s*[#@][^\s#@]+)+\s*$/u, '')
    .trim()
  const short = caption.length > 90 ? `${caption.slice(0, 90).replace(/\s+\S*$/, '')}…` : caption
  return short || `TikTok ${post.id}`
}

/** Pinned posts keep their place on top; the rest newest first. */
const newestFirst = (a: TikTokPost, b: TikTokPost): number =>
  Number(b.pinned) - Number(a.pinned) || (b.createdAt ?? 0) - (a.createdAt ?? 0)

/** A file extension for a media type ("image/webp" → ".webp"); `fallback` for anything else. */
function extensionOf(contentType: string | undefined, fallback: string): string {
  const known: Readonly<Record<string, string>> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
  }
  return (contentType && known[contentType]) || fallback
}

const idOf = (url: string): string => /\/(\d{6,25})(?:[/?#.]|$)/.exec(url)?.[1] ?? ''

/** A random 19-digit device id, like the web client's. */
function newDeviceId(): string {
  let id = String(7 + Math.floor(Math.random() * 2))
  while (id.length < 19) id += String(Math.floor(Math.random() * 10))
  return id
}

const HINTS: Readonly<Record<string, FailureHint>> = {
  private: 'private',
  removed: 'removed',
  'photo-post': 'format-unavailable',
  challenge: 'retry-later',
  refused: 'retry-later',
}

/** TikTok's problems in the engine's terms (codes drive retries, hints drive the UI). */
export function toDownloadError(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error
  if (!(error instanceof TikTokError)) {
    const message = error instanceof Error ? error.message : String(error)
    return new DownloadError('network', message)
  }
  switch (error.problem) {
    case 'private':
    case 'removed':
      return new DownloadError('unavailable', error.message, undefined, undefined, HINTS[error.problem])
    case 'photo-post':
      return new DownloadError('unavailable', error.message, undefined, undefined, HINTS[error.problem])
    case 'challenge':
      return new DownloadError('network', error.message, SOURCE_BLOCKED, undefined, 'retry-later')
    case 'refused':
      return new DownloadError('network', error.message, undefined, undefined, 'retry-later')
    case 'format-changed':
      // 'unknown' lets the engine fall back to yt-dlp for this post
      return new DownloadError('unknown', error.message, SOURCE_FORMAT_CHANGED)
  }
}
