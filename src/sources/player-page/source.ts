import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtractResult} from '../../core/analyze.js'
import {cancelledError, DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, MediaSummary, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import type {MediaResolver} from '../browser.js'
import {type Fetch, HttpSession} from '../http.js'
import {fetchMedia} from '../media-fetch.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import type {ListingProgress, MediaSource, SourceDownload, SourceFile} from '../source.js'
import {
  firstPage,
  type ListedVideo,
  readListing,
  readVideoPage,
  type VideoPage,
  type VideoPathMatcher,
  videoMatcher,
} from './parse.js'

/**
 * A site whose videos each have a page with a player, listed by paged
 * listings (search results, categories). Described by the host, never built
 * in: which sites to read is the user's configuration.
 */
export type PlayerPageSite = {
  /** Shown in the app and recorded as the archive's extractor. */
  readonly name: string
  /** Host names the site answers on (`www.` variants are added). */
  readonly hosts: readonly string[]
  /** Regular expression for a video page's path; its first group is the video id. */
  readonly videoPath?: string | undefined
}

export type PlayerPageOptions = {
  readonly site: PlayerPageSite
  /**
   * A real browser that opens a video page and reports the link its player
   * was given. Without one, listings and checks work but downloads can't.
   */
  readonly resolveMedia?: MediaResolver | undefined
  /** Listings load at most this many videos unless asked otherwise. Default 500. */
  readonly maxListItems?: number | undefined
  /** Pace of page requests. Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  readonly fetch?: Fetch | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const PLAYER_PAGE_DEFAULT_ITEMS = 500
/** Pages read beyond the furthest one the pagination links to (it shows only a window). */
const LOOKAHEAD_PAGES = 6
/** Most pages of one listing read (a runaway pagination stops here). */
const MAX_LISTING_PAGES = 2000
/** Reads of a page that failed transiently, before giving up. */
const READ_ATTEMPTS = 3
const CACHE_LIMIT = 5000
/** Such sites take ~1 s to render a page: many in flight, briefly spaced; a 429 / 5xx backs all off. */
const DEFAULT_PACING: PacerOptions = {
  concurrency: 10,
  spacingMs: 40,
  jitterMs: 40,
  backoffMs: 5000,
  maxBackoffMs: 60_000,
}

/**
 * Player-page sites, natively: listings and video pages over plain HTTP
 * (paced, several at once), the media link from the site's own player in a
 * real browser (one page load per download, nothing else), the file straight
 * from the media server with resume. The listing reads every page of a
 * search, following its pagination ahead in parallel.
 */
export class PlayerPageSource implements MediaSource {
  readonly name: string
  readonly available = true
  readonly #hosts: ReadonlySet<string>
  readonly #isVideo: VideoPathMatcher
  readonly #session: HttpSession
  readonly #pacer: Pacer
  readonly #resolveMedia: MediaResolver | undefined
  readonly #maxListItems: number
  readonly #log: (level: 'info' | 'warn', message: string) => void
  /** Video pages read, by url (insertion order = age: oldest evicted first). */
  readonly #pages = new Map<string, VideoPage>()
  /** Media links resolved for a page, reused until a download with them fails. */
  readonly #media = new Map<string, string>()

  constructor(options: PlayerPageOptions) {
    const {site} = options
    if (!site.name.trim()) throw new TypeError('A player-page site needs a name.')
    const hosts = new Set<string>()
    for (const host of site.hosts) {
      const bare = host
        .trim()
        .toLowerCase()
        .replace(/^www\./, '')
      if (!bare) continue
      hosts.add(bare)
      hosts.add(`www.${bare}`)
    }
    if (hosts.size === 0) throw new TypeError(`${site.name}: no hosts.`)
    this.name = site.name.trim()
    this.#hosts = hosts
    this.#isVideo = videoMatcher(hosts, site.videoPath)
    this.#session = new HttpSession({fetch: options.fetch})
    this.#pacer = new Pacer(options.pacing ?? DEFAULT_PACING)
    this.#resolveMedia = options.resolveMedia
    this.#maxListItems = Math.max(1, Math.floor(options.maxListItems ?? PLAYER_PAGE_DEFAULT_ITEMS))
    this.#log = options.log ?? (() => {})
  }

  handles(url: string): boolean {
    try {
      return this.#hosts.has(new URL(url).hostname.toLowerCase())
    } catch {
      return false
    }
  }

  defaultListSize(url: string): number | undefined {
    try {
      const target = new URL(url)
      return this.#hosts.has(target.hostname.toLowerCase()) && !this.#isVideo(target) ? this.#maxListItems : undefined
    } catch {
      return undefined
    }
  }

  async analyze(
    url: string,
    opts: {signal?: AbortSignal; maxEntries?: number; onProgress?: (progress: ListingProgress) => void} = {},
  ): Promise<AnalysisResult> {
    const target = new URL(url)
    const id = this.#isVideo(target)
    if (id) return this.#videoAnalysis(id, canonical(target), await this.#videoPage(canonical(target), opts.signal))
    return this.#listing(url, opts.maxEntries, opts.signal, opts.onProgress)
  }

  /** Each item's page is read (paced, several at once): gone pages and pages without a player are unavailable. */
  async preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {signal?: AbortSignal | undefined; onResult?: ((url: string, result: ExtractResult) => void) | undefined},
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    await Promise.all(
      items.map(async ({url}) => {
        let result: ExtractResult
        try {
          const page = new URL(url)
          const id = this.#isVideo(page)
          if (!id)
            throw new DownloadError('invalid-request', 'Not a video page.', undefined, undefined, 'unsupported-url')
          const read = await this.#videoPage(canonical(page), opts.signal)
          if (!read.player) {
            throw new DownloadError('unavailable', 'This page has no video player.', undefined, undefined, 'removed')
          }
          result = {ok: true, analysis: this.#videoAnalysis(id, canonical(page), read)}
        } catch (error) {
          if (opts.signal?.aborted) return
          result = {ok: false, error: asDownloadError(error).toJSON()}
        }
        results.set(url, result)
        opts.onResult?.(url, result)
      }),
    )
    return results
  }

  async download(task: SourceDownload): Promise<SourceFile> {
    const pageUrl = new URL(task.url)
    const id = this.#isVideo(pageUrl)
    if (!id) throw new DownloadError('invalid-request', 'Not a video page.', undefined, undefined, 'unsupported-url')
    const page = canonical(pageUrl)
    if (task.fresh) {
      this.#pages.delete(page)
      this.#media.delete(page)
    }
    const read = await this.#videoPage(page, task.signal)
    if (!read.player)
      throw new DownloadError('unavailable', 'This page has no video player.', undefined, undefined, 'removed')
    const title = read.title ?? `${this.name} ${id}`
    task.onInfo({id, title, duration: read.duration ?? null, extractor: this.name})

    const played = await this.#playerLink(page, task.signal)
    const file = path.join(task.workDir, `${id}.mp4`)
    let fetched: Awaited<ReturnType<typeof fetchMedia>> | undefined
    let last: unknown
    for (const url of candidates(played, read.heights, task.profile)) {
      try {
        fetched = await fetchMedia(this.#session, url, file, {
          site: this.name,
          headers: {Referer: page},
          signal: task.signal,
          onProgress: task.onProgress,
        })
        break
      } catch (error) {
        if (task.signal.aborted) throw error
        last = error
        await fs.rm(file, {force: true}) // another rendition: never append to this one
      }
    }
    if (!fetched) {
      this.#media.delete(page) // the next attempt asks the player again
      throw asDownloadError(last)
    }
    const audio = await task.hasAudio(file)
    // no tags: an MP4 from the server is kept byte for byte (no rewrite), only
    // validated; its date is the file's modification time
    return {
      filepath: file,
      info: {
        id,
        title,
        duration: read.duration ?? null,
        extractor: this.name,
        acodec: audio ? 'mp4a' : 'none',
        filesize: fetched.bytes,
        publishedAt: fetched.lastModified ?? null,
      },
    }
  }

  // ─── pages ───────────────────────────────────────────────────────────────

  /** The media link the site's player gets for `page`, through the host's browser; cached per page. */
  async #playerLink(page: string, signal: AbortSignal): Promise<string> {
    const known = this.#media.get(page)
    if (known) return known
    if (!this.#resolveMedia) {
      throw new DownloadError(
        'unavailable',
        `${this.name} downloads need the app's built-in browser.`,
        undefined,
        undefined,
        'format-unavailable',
      )
    }
    let media: Awaited<ReturnType<MediaResolver>>
    try {
      media = await this.#resolveMedia(page, signal)
    } catch (error) {
      if (signal.aborted) throw cancelledError()
      const reason = error instanceof Error ? error.message : String(error)
      throw new DownloadError('network', `${this.name}: ${reason}`, undefined, undefined, 'retry-later')
    }
    if (!/^https?:\/\//i.test(media.url)) {
      throw new DownloadError(
        'unavailable',
        `${this.name}: the player has no downloadable link.`,
        undefined,
        undefined,
        'format-unavailable',
      )
    }
    this.#session.adopt(media)
    remember(this.#media, page, media.url)
    return media.url
  }

  async #videoPage(url: string, signal?: AbortSignal): Promise<VideoPage> {
    const known = this.#pages.get(url)
    if (known) return known
    const page = readVideoPage(await this.#html(url, signal, true))
    remember(this.#pages, url, page)
    return page
  }

  /**
   * Every page of a listing, from its first page whatever page the link shows.
   * Page requests overlap: the first few pages go out together, then the
   * pages the pagination links to plus a few beyond the furthest one linked
   * (pagination shows only a window), all in parallel. The end is where a page comes back empty, missing, or as a
   * copy of an earlier page (sites answer past-the-end pages with their last
   * one). 9 pages take 1–2 round trips instead of 9. Entries come out in page
   * order, each video once.
   */
  async #listing(
    url: string,
    maxEntries: number | undefined,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
  ): Promise<PlaylistAnalysis> {
    const max = Math.max(1, maxEntries ?? this.#maxListItems)
    const start = firstPage(url)
    const pageUrl = (page: number): string => {
      if (page === 1) return start
      const next = new URL(start)
      next.searchParams.set('page', String(page))
      return next.href
    }
    const local = new AbortController()
    const stop = AbortSignal.any([local.signal, ...(signal ? [signal] : [])])
    const read = new Map<number, readonly ListedVideo[]>()
    /** A page's ids → the lowest page that had exactly them (a repeat marks the end). */
    const contents = new Map<string, number>()
    const launched = new Set<number>()
    const running = new Set<Promise<void>>()
    const ids = new Set<string>()
    let furthestLinked = 1
    let lastPage = Number.POSITIVE_INFINITY
    let failure: unknown
    let title: string | undefined

    /** Entries of pages 1…n read without a gap: what can be returned already. */
    const contiguous = (): number => {
      let count = 0
      for (let page = 1; page <= lastPage && read.has(page); page++) count += read.get(page)!.length
      return count
    }
    const settle = (page: number, videos: readonly ListedVideo[]) => {
      read.set(page, videos)
      if (videos.length === 0) {
        lastPage = Math.min(lastPage, page - 1)
        return
      }
      const key = videos.map(video => video.id).join(',')
      const twin = contents.get(key)
      if (twin !== undefined) {
        // the same results twice: everything from the later of the two on is past the end
        lastPage = Math.min(lastPage, Math.min(twin, page))
        contents.set(key, Math.min(twin, page))
        return
      }
      contents.set(key, page)
      for (const video of videos) ids.add(video.id)
      onProgress?.({listed: Math.min(ids.size, max)})
    }
    const launch = (page: number) => {
      launched.add(page)
      const address = pageUrl(page)
      const task: Promise<void> = this.#html(address, stop, false)
        .then(html => {
          const listing = readListing(html, address, this.#isVideo)
          if (page === 1) title = listing.title
          for (const linked of listing.pages.keys()) furthestLinked = Math.max(furthestLinked, linked)
          settle(page, listing.videos)
        })
        .catch(error => {
          // a page past the end may be missing; any other failed page stops the
          // listing: a list with a hole in it would look complete
          if (page > 1 && error instanceof DownloadError && error.hint === 'removed') settle(page, [])
          else failure ??= error
        })
        .finally(() => running.delete(task))
      running.add(task)
    }

    try {
      // the first pages go out together: most listings fit in this first round
      const opening = Math.min(1 + LOOKAHEAD_PAGES, maxEntries === undefined ? Number.POSITIVE_INFINITY : max)
      for (let page = 1; page <= opening; page++) launch(page)
      while (running.size > 0) {
        await Promise.race(running)
        if (failure !== undefined) throw failure
        if (contiguous() >= max) break
        // a capped listing reads ahead only as far as the cap reaches (page 1 tells the page size)
        const perPage = read.get(1)?.length ?? 0
        const enough = perPage > 0 ? Math.ceil(max / perPage) : Number.POSITIVE_INFINITY
        const horizon = Math.min(lastPage, furthestLinked + LOOKAHEAD_PAGES, enough, MAX_LISTING_PAGES)
        for (let page = 2; page <= horizon; page++) if (!launched.has(page)) launch(page)
      }
    } finally {
      local.abort() // pages still in flight past the cap (or after a failure) are not needed
      await Promise.allSettled(running)
    }

    const seen = new Set<string>()
    const videos: ListedVideo[] = []
    for (let page = 1; page <= lastPage && read.has(page) && videos.length < max; page++) {
      for (const video of read.get(page)!) {
        if (videos.length >= max) break
        if (!seen.has(video.id)) {
          seen.add(video.id)
          videos.push(video)
        }
      }
    }
    if (launched.size >= MAX_LISTING_PAGES && videos.length < max) {
      this.#log('warn', `${this.name}: listing stopped after ${MAX_LISTING_PAGES} pages`)
    }
    onProgress?.({listed: videos.length})
    const term = lastSegment(start)
    return {
      kind: 'playlist',
      id: start,
      url: start,
      title: [title ?? this.name, term && !title?.toLowerCase().includes(term.toLowerCase()) ? term : undefined]
        .filter(Boolean)
        .join(' · '),
      uploader: this.name,
      extractor: this.name,
      entries: videos.map((video, i) => ({...this.#summary(video), index: i + 1})),
      choices: genericChoices(),
    }
  }

  /**
   * One page's HTML. A video page that redirects elsewhere is gone (the site
   * sends removed videos to its home page); refusals are retried after the
   * shared cool-down.
   */
  async #html(url: string, signal: AbortSignal | undefined, videoPage: boolean): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#pacer.run(async () => {
          const response = await this.#session.get(url, {
            headers: {Accept: 'text/html,application/xhtml+xml'},
            redirect: videoPage ? 'manual' : 'follow',
            signal,
          })
          if (
            response.status === 404 ||
            response.status === 410 ||
            (videoPage && response.status >= 300 && response.status < 400)
          ) {
            await response.body?.cancel()
            throw new DownloadError(
              'unavailable',
              `${this.name}: this video no longer exists.`,
              undefined,
              undefined,
              'removed',
            )
          }
          if (!response.ok) {
            await response.body?.cancel()
            if (response.status === 429 || response.status >= 500) this.#pacer.refused()
            throw new DownloadError(
              'network',
              `${this.name} answered HTTP ${response.status}.`,
              undefined,
              undefined,
              'retry-later',
            )
          }
          const html = await response.text()
          this.#pacer.succeeded()
          return html
        }, signal)
      } catch (error) {
        const retryable = error instanceof DownloadError && error.code === 'network'
        if (signal?.aborted || !retryable || attempt >= READ_ATTEMPTS) throw asDownloadError(error)
      }
    }
  }

  #summary(video: {
    id: string
    url: string
    title?: string | undefined
    duration?: number | undefined
    thumbnail?: string | undefined
  }): MediaSummary {
    return {
      id: video.id,
      url: video.url,
      title: video.title ?? `${this.name} ${video.id}`,
      uploader: this.name,
      duration: video.duration,
      thumbnail: video.thumbnail,
      extractor: this.name,
      isLive: false,
    }
  }

  #videoAnalysis(id: string, url: string, page: VideoPage): VideoAnalysis {
    return {
      kind: 'video',
      media: this.#summary({id, url, title: page.title, duration: page.duration, thumbnail: page.thumbnail}),
      choices: page.player ? genericChoices() : [],
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** A page url without query or fragment: one cache key per video. */
const canonical = (url: URL): string => `${url.origin}${url.pathname}`

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}

/** The listing's own name for what it lists: the last path segment (a search term, a category). */
function lastSegment(url: string): string | undefined {
  const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1)
  if (!segment) return undefined
  try {
    return (
      decodeURIComponent(segment)
        .replace(/[-_+]+/g, ' ')
        .trim() || undefined
    )
  } catch {
    return segment
  }
}

/**
 * The links to try for a profile, best first. Players are usually given the
 * best rendition, named `<id>_<height>p.<ext>` beside its siblings: a video
 * capped below it tries the best sibling within the cap first, and audio the
 * smallest one (same soundtrack, a fraction of the bytes). The player's own
 * link always stays as the last resort.
 */
export function candidates(played: string, heights: readonly number[], profile: SourceDownload['profile']): string[] {
  const named = /_(\d{3,4})p(\.[a-z0-9]+)(?=$|[?#])/i.exec(played)
  if (!named || heights.length < 2) return [played]
  const current = Number(named[1])
  const wanted =
    profile.kind === 'audio'
      ? heights.at(-1)
      : profile.maxHeight !== undefined
        ? (heights.find(height => height <= profile.maxHeight!) ?? heights.at(-1))
        : undefined
  if (wanted === undefined || wanted === current) return [played]
  const sibling = `${played.slice(0, named.index)}_${wanted}p${named[2]}${played.slice(named.index + named[0].length)}`
  return [sibling, played]
}

function asDownloadError(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error
  if (error instanceof Error && error.name === 'AbortError') return cancelledError()
  return new DownloadError('network', error instanceof Error ? error.message : String(error))
}
