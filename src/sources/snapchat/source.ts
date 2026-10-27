import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtractResult} from '../../core/analyze.js'
import type {MediaTags} from '../../core/convert.js'
import type {DownloadedInfo} from '../../core/download.js'
import {cancelledError, DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, FormatChoice, MediaSummary, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import {Coalescer} from '../coalesce.js'
import {DOCUMENT_NAVIGATION_HEADERS, type Fetch, HttpSession} from '../http.js'
import {fetchMedia} from '../media-fetch.js'
import {extensionOf} from '../meta/download.js'
import {MetaError, toDownloadError} from '../meta/errors.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import {followShortLink, resolved, unresolvedMessage} from '../redirects.js'
import {renditionChoices} from '../renditions.js'
import type {ListingProgress, MediaSource, SourceDownload, SourceFile} from '../source.js'
import {imagesChoices} from '../tiktok/renditions.js'
import {buildSlideshowVideo, slideshowFrame} from '../tiktok/slideshow.js'
import {
  readHighlight,
  readNextData,
  readProfile,
  readSnapPage,
  readSpotlight,
  type SnapItem,
  type SnapPage,
} from './data.js'
import {DEFAULT_ENDPOINTS, type SnapchatEndpoints} from './endpoints.js'
import {parseSnapchatLink, type SnapchatLink, snapchatUrl} from './links.js'

export type SnapchatOptions = {
  /** Profiles and highlights load at most this many items unless asked otherwise. Default 500. */
  readonly maxListItems?: number | undefined
  /** Pace of page reads on www.snapchat.com. Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** The site's origin, the data marker and the routes (endpoints.ts), overridable without a release. */
  readonly endpoints?: Partial<SnapchatEndpoints> | undefined
  readonly fetch?: Fetch | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const SNAPCHAT_LIST_DEFAULT_ITEMS = 500
/** Media links are unsigned and stable; a page is read again after this only to catch removed content. */
const PAGE_FRESH_MS = 10 * 60_000
/** Parsed pages kept (their items, not their HTML): ~150 items each at most. */
const PAGE_CACHE_LIMIT = 200
/** Items kept by entry (what a listing names, read back by the check and the download). */
const ITEM_CACHE_LIMIT = 5000
const READ_ATTEMPTS = 3
/** No bot check seen at ~1 page every 3 s: two at a time, a second or so apart. */
const DEFAULT_PACING: PacerOptions = {concurrency: 2, spacingMs: 1000, jitterMs: 500}

type Resolved = Exclude<SnapchatLink, {kind: 'short'}>
/** A link to one item: a spotlight, a story snap or one snap of a highlight. */
type ItemLink =
  | Extract<SnapchatLink, {kind: 'spotlight'} | {kind: 'snap'}>
  | (Extract<SnapchatLink, {kind: 'highlight'}> & {readonly index: number})
type Timed<T> = {readonly value: T; readonly at: number}

/**
 * Snapchat, natively: spotlights, a public profile's live story, curated
 * highlights and spotlights, one highlight, one story snap. Each link is one
 * anonymous page read (the data Snapchat's own web page embeds in
 * `__NEXT_DATA__`; no API, no session, no browser); the media is a
 * progressive MP4 or a JPEG on Snapchat's CDN, fetched exactly as the page
 * serves it. A profile lists only what its page embeds (Snapchat pages on
 * server side only): `complete: false` when the page says there is more.
 * Private accounts are app-only. When the page stops looking as expected,
 * the engine hands the url to yt-dlp (which reads spotlights).
 */
export class SnapchatSource implements MediaSource {
  readonly name = 'Snapchat'
  readonly #session: HttpSession
  readonly #pacer: Pacer
  readonly #endpoints: SnapchatEndpoints
  readonly #origin: string
  readonly #maxListItems: number
  readonly #log: (level: 'info' | 'warn', message: string) => void
  /** Page path → its parsed page (insertion order = age: the oldest is evicted first). */
  readonly #pages = new Map<string, Timed<SnapPage>>()
  /** Item id → the item, from whichever page named it (a profile's listing feeds each entry's download). */
  readonly #items = new Map<string, Timed<SnapItem>>()
  /** Reads of one page at the same time share one request (an analysis, its check and its download). */
  readonly #reading = new Coalescer<string, SnapPage>()

  constructor(options: SnapchatOptions = {}) {
    this.#endpoints = {...DEFAULT_ENDPOINTS, ...options.endpoints}
    this.#origin = this.#endpoints.origin.replace(/\/+$/, '')
    this.#session = new HttpSession({fetch: options.fetch})
    this.#pacer = new Pacer(options.pacing ?? DEFAULT_PACING, 'Snapchat')
    this.#maxListItems = Math.max(1, Math.floor(options.maxListItems ?? SNAPCHAT_LIST_DEFAULT_ITEMS))
    this.#log = options.log ?? (() => {})
  }

  /** Nothing to step aside for: no verification page seen. */
  get available(): boolean {
    return true
  }

  handles(url: string): boolean {
    return parseSnapchatLink(url) !== undefined
  }

  defaultListSize(url: string): number | undefined {
    const link = parseSnapchatLink(url)
    return link?.kind === 'profile' || (link?.kind === 'highlight' && link.index === undefined)
      ? this.#maxListItems
      : undefined
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
      if (link.kind === 'profile' || (link.kind === 'highlight' && link.index === undefined)) {
        const page = await this.#page(link, opts.signal)
        return this.#listing(link, page, opts.maxEntries, opts.known, opts.onProgress)
      }
      return this.#analysis(await this.#item(link as ItemLink, opts.signal))
    } catch (error) {
      throw this.#toDownloadError(error, opts.signal)
    }
  }

  /** Each url's item; items of one page (a profile's entries) share its one read. O(items) work. */
  async preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {signal?: AbortSignal | undefined; onResult?: ((url: string, result: ExtractResult) => void) | undefined},
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    await Promise.all(
      items.map(async ({url}) => {
        let result: ExtractResult
        try {
          const link = await this.#resolve(url, opts.signal)
          result = {ok: true, analysis: this.#analysis(await this.#item(single(link), opts.signal))}
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
    let key: string | undefined
    try {
      const link = single(await this.#resolve(task.url, task.signal))
      key = idOf(link)
      const item = await this.#item(link, task.signal, task.fresh)
      return item.kind === 'image' ? await this.#image(item, task) : await this.#video(item, task)
    } catch (error) {
      // read again next time: the snap may have expired, the page changed
      if (key) this.#items.delete(key)
      throw this.#toDownloadError(error, task.signal)
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  async #resolve(url: string, signal?: AbortSignal): Promise<Resolved> {
    const link = parseSnapchatLink(url)
    if (!link) {
      throw new DownloadError(
        'invalid-request',
        'Not a Snapchat spotlight, story, highlight or profile url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    if (link.kind !== 'short') return link
    const followed = await followShortLink(
      link.url,
      next => this.#retrying(() => this.#hop(next, signal), signal),
      next => resolved(parseSnapchatLink(next)),
    )
    if (followed.ok) return followed.link
    throw new MetaError(
      'removed',
      followed.reason === 'dead-end' && parseSnapchatLink(followed.resolvedUrl)?.kind !== 'short'
        ? 'This Snapchat short link does not lead to a spotlight, a story or a profile.'
        : unresolvedMessage(followed.reason),
    )
  }

  /**
   * One short-link hop: its Location. `snapchat.com/t/<code>` is asked on the
   * configured origin; `t.snapchat.com` as it is; a link that left Snapchat
   * is not followed. Only a 404 / 410 is a dead end; 403 / 429 / 5xx are
   * refusals (retried after the shared cool-down). O(1).
   */
  async #hop(url: string, signal?: AbortSignal): Promise<string | undefined> {
    const link = parseSnapchatLink(url)
    if (link?.kind !== 'short') return undefined
    const code = link.url.startsWith('https://t.snapchat.com/')
      ? undefined
      : link.url.slice(link.url.lastIndexOf('/') + 1)
    const target = code === undefined ? link.url : `${this.#origin}${this.#endpoints.shortPath(code)}`
    return this.#pacer.run(async () => {
      const response = await this.#session.get(target, {redirect: 'manual', signal})
      await response.body?.cancel()
      if (response.status >= 300 && response.status < 400) {
        this.#pacer.succeeded()
        const location = response.headers.get('location')
        return location ? new URL(location, target).href : undefined
      }
      if (response.status === 404 || response.status === 410 || response.ok) return undefined
      this.#pacer.refused()
      throw new MetaError('refused', `Snapchat answered HTTP ${response.status} to a short link.`)
    }, signal)
  }

  // ─── pages ───────────────────────────────────────────────────────────────

  /** The page a link is read from, and the key it is kept under. O(1). */
  #pathOf(link: Resolved): string {
    const e = this.#endpoints
    switch (link.kind) {
      case 'spotlight':
        return e.spotlightPath(link.id, link.user)
      case 'profile':
        return e.profilePath(link.user.toLowerCase())
      case 'snap':
        return e.snapPath(link.user.toLowerCase(), link.id)
      case 'highlight':
        return e.highlightPath(link.user.toLowerCase(), link.id)
    }
  }

  /**
   * A link's page: a recent read reused (bounded: oldest dropped past
   * PAGE_CACHE_LIMIT), reads at the same time shared. O(1) requests per page
   * while it is fresh, whatever the number of callers.
   */
  async #page(link: Resolved, signal?: AbortSignal, fresh = false): Promise<SnapPage> {
    const key = this.#pathOf(link)
    const cached = this.#pages.get(key)
    if (!fresh && cached && Date.now() - cached.at < PAGE_FRESH_MS) return cached.value
    return this.#reading.run(key, signal, async shared => {
      const page = await this.#retrying(() => this.#readOnce(key, link, shared), shared)
      remember(this.#pages, key, page, PAGE_CACHE_LIMIT)
      for (const item of itemsOf(page)) remember(this.#items, item.id, item, ITEM_CACHE_LIMIT)
      return page
    })
  }

  /** One item: from the listing or page that named it, else its own page read. O(1) besides the read. */
  async #item(link: ItemLink, signal?: AbortSignal, fresh = false): Promise<SnapItem> {
    const id = idOf(link)
    const cached = this.#items.get(id)
    if (!fresh && cached && Date.now() - cached.at < PAGE_FRESH_MS) return cached.value
    await this.#page(link.kind === 'highlight' ? {...link, index: undefined} : link, signal, fresh)
    // the page's items are in the cache now (a page holds ~150 at most, far below its bound)
    const item = this.#items.get(id)?.value
    if (item) return item
    if (link.kind === 'snap') {
      throw new MetaError('removed', 'This snap is no longer on the story (stories last 24 hours).')
    }
    if (link.kind === 'highlight') {
      throw new MetaError('removed', `This highlight has no snap ${link.index} (any more).`)
    }
    throw new MetaError('format-changed', 'Snapchat: the spotlight page does not hold this spotlight.')
  }

  async #retrying<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read()
      } catch (error) {
        if (signal?.aborted || !(error instanceof MetaError) || !error.transient || attempt >= READ_ATTEMPTS)
          throw error
        this.#log('info', `Snapchat: ${error.message} (try ${attempt} of ${READ_ATTEMPTS})`)
      }
    }
  }

  /** One paced page read, its data parsed once and kept as items (not as HTML). O(size of the page). */
  #readOnce(pagePath: string, link: Resolved, signal?: AbortSignal): Promise<SnapPage> {
    return this.#pacer.run(async () => {
      const response = await this.#session.get(`${this.#origin}${pagePath}`, {
        headers: DOCUMENT_NAVIGATION_HEADERS,
        signal,
      })
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel()
        throw new MetaError('removed', notFound(link))
      }
      if (response.status === 403 || response.status === 429 || response.status >= 500) {
        await response.body?.cancel()
        this.#pacer.refused()
        throw new MetaError('refused', `Snapchat answered HTTP ${response.status}.`)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new MetaError('format-changed', `Snapchat: the page answered HTTP ${response.status}.`)
      }
      const props = readNextData(await response.text(), this.#endpoints.nextDataMarker)
      this.#pacer.succeeded()
      switch (link.kind) {
        case 'profile':
          return readProfile(props, link.user)
        case 'highlight':
          return readHighlight(props, link.user, link.id)
        case 'snap':
          return readSnapPage(props, link.user)
        case 'spotlight':
          return readSpotlight(props, link.id, link.user)
      }
    }, signal)
  }

  // ─── analyses ────────────────────────────────────────────────────────────

  #summary(item: SnapItem): MediaSummary {
    return {
      id: item.id,
      url: item.url,
      title: item.title,
      uploader: item.user,
      duration: item.duration,
      thumbnail: item.thumbnail,
      publishedAt: item.publishedAt,
      // a picture is a one-image photo post: an MP4 or the picture itself, as `slideshow` asks
      ...(item.kind === 'image' && {slideshow: {images: 1, audio: false}}),
      extractor: this.name,
      isLive: false,
    }
  }

  #analysis(item: SnapItem): VideoAnalysis {
    return {kind: 'video', media: this.#summary(item), choices: choicesOf(item)}
  }

  /**
   * A profile (its live story, then its highlights' snaps, then its
   * spotlights) or a highlight, as the page embeds it. `known` entries are
   * left out and `maxEntries` caps the rest: O(1) per item, O(items) in all.
   */
  #listing(
    link: Extract<Resolved, {kind: 'profile' | 'highlight'}>,
    page: SnapPage,
    maxEntries: number | undefined,
    known: ReadonlySet<string> | undefined,
    onProgress: ((progress: ListingProgress) => void) | undefined,
  ): PlaylistAnalysis {
    const max = Math.max(1, Math.floor(maxEntries ?? this.#maxListItems))
    const listed = listedItems(link, page)
    const entries: Array<MediaSummary & {readonly index: number}> = []
    let skipped = 0
    let capped = false
    for (const item of listed) {
      if (known?.has(item.id)) {
        skipped++
        continue
      }
      if (entries.length >= max) {
        capped = true
        break
      }
      entries.push({...this.#summary(item), index: entries.length + 1})
    }
    onProgress?.({listed: entries.length, expected: entries.length})
    const more = page.kind === 'profile' && page.more
    if (more) this.#log('info', `Snapchat: @${link.user} has more than its page shows; listed what it embeds`)
    const user = page.kind === 'single' ? link.user : page.user
    return {
      kind: 'playlist',
      id:
        page.kind === 'highlight'
          ? page.id
          : `${user}${link.kind === 'profile' && link.section ? `-${link.section}` : ''}`,
      url: snapchatUrl(link),
      title:
        page.kind === 'highlight'
          ? `Snapchat ${user} ${page.title ?? 'highlight'}`
          : `Snapchat ${page.kind === 'profile' ? (page.userName ?? user) : user}`,
      uploader: user,
      extractor: this.name,
      entries,
      choices: genericChoices(),
      total: more ? undefined : listed.length,
      complete: !capped && !more,
      ...(known && skipped > 0 && {caughtUp: true}),
    }
  }

  // ─── media ───────────────────────────────────────────────────────────────

  #info(item: SnapItem): {info: DownloadedInfo; tags: MediaTags} {
    return {
      info: {
        id: item.id,
        title: item.title,
        extractor: this.name,
        publishedAt: item.publishedAt ?? null,
        duration: item.duration ?? null,
      },
      tags: {
        title: item.title,
        artist: item.userName ?? item.user,
        date: item.publishedAt ? new Date(item.publishedAt * 1000).toISOString().slice(0, 10) : undefined,
        comment: item.url,
      },
    }
  }

  /** A video snap or spotlight: its one MP4, streamed to disk (resumable), checked to be one. */
  async #video(item: SnapItem, task: SourceDownload): Promise<SourceFile> {
    const {info, tags} = this.#info(item)
    task.onInfo(info)
    const file = path.join(task.workDir, `${item.id}.mp4`)
    try {
      const {bytes, contentType} = await fetchMedia(this.#session, item.mediaUrl, file, {
        site: this.name,
        signal: task.signal,
        onProgress: task.onProgress,
      })
      await expectMedia(file, contentType, 'video')
      const hasAudio = await task.hasAudio(file)
      if (task.profile.kind === 'audio' && !hasAudio)
        throw new MetaError('no-media', 'This snap has no sound to extract.')
      return {
        filepath: file,
        info: {...info, vcodec: 'avc1', acodec: hasAudio ? 'mp4a' : 'none', filesize: bytes},
        tags,
      }
    } catch (error) {
      await fs.rm(file, {force: true})
      throw error
    }
  }

  /**
   * A picture snap, as a one-picture photo post (the Instagram / TikTok
   * convention): an MP4 of it (`slideshow.mode` 'video') or a folder with it;
   * an audio profile has nothing to take.
   */
  async #image(item: SnapItem, task: SourceDownload): Promise<SourceFile> {
    if (task.profile.kind === 'audio') throw new MetaError('no-media', 'A picture has no sound to extract.')
    const {info, tags} = this.#info(item)
    const {mode, secondsPerImage} = task.slideshow
    task.onInfo({...info, duration: mode === 'video' ? secondsPerImage : null})
    const folder = path.join(task.workDir, `${item.id}-items`)
    await fs.mkdir(folder, {recursive: true})
    const partial = path.join(folder, '01.part')
    const fetched = await fetchMedia(this.#session, item.mediaUrl, partial, {
      site: this.name,
      signal: task.signal,
      onProgress: task.onProgress,
    })
    await expectMedia(partial, fetched.contentType, 'image')
    const picture = path.join(folder, `01${extensionOf(fetched.contentType, '.jpg')}`)
    await fs.rename(partial, picture)
    if (mode !== 'video') return {filepath: folder, bundle: true, info}
    const output = path.join(task.workDir, `${item.id}-slideshow.mp4`)
    const image = {width: item.width ?? 0, height: item.height ?? 0}
    await buildSlideshowVideo({
      ffmpeg: task.ffmpeg,
      images: [picture],
      frame: slideshowFrame([image]),
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
      info: {...info, duration: secondsPerImage, vcodec: 'avc1', acodec: 'none', filesize: bytes},
      tags,
    }
  }

  #toDownloadError(error: unknown, signal?: AbortSignal): DownloadError {
    if (signal?.aborted && !(error instanceof DownloadError)) return cancelledError()
    return toDownloadError(error, this.name)
  }
}

/** A link to one item; a listing link is an error here (its entries are the items). */
function single(link: Resolved): ItemLink {
  if (link.kind === 'profile' || (link.kind === 'highlight' && link.index === undefined)) {
    throw new DownloadError('invalid-request', `A Snapchat ${link.kind} is a list: each of its snaps is its own item.`)
  }
  return link as ItemLink
}

/** The archive id of the item a link names. O(1). */
function idOf(link: ItemLink): string {
  return link.kind === 'highlight' ? `${link.id}-${link.index}` : link.id
}

/** Every item a page names. O(items). */
function itemsOf(page: SnapPage): readonly SnapItem[] {
  if (page.kind === 'profile') return [...page.story, ...page.highlights, ...page.spotlights]
  return page.items
}

/** The items a listing link means, in the order the profile shows them. O(items). */
function listedItems(link: Extract<Resolved, {kind: 'profile' | 'highlight'}>, page: SnapPage): readonly SnapItem[] {
  if (page.kind !== 'profile') return page.items
  const section = link.kind === 'profile' ? link.section : undefined
  if (section === 'stories') return page.story
  if (section === 'highlights') return page.highlights
  if (section === 'spotlights') return page.spotlights
  return itemsOf(page)
}

/** A bounded cache entry: re-inserted as the newest; the oldest dropped past `limit`. O(1). */
function remember<T>(map: Map<string, Timed<T>>, key: string, value: T, limit: number): void {
  map.delete(key)
  map.set(key, {value, at: Date.now()})
  if (map.size > limit) map.delete(map.keys().next().value!)
}

/** What an item can become: a video as its one MP4 (sizes when the page says), a picture as a photo post's. */
function choicesOf(item: SnapItem): FormatChoice[] {
  if (item.kind === 'image') return imagesChoices([{width: item.width ?? 0, height: item.height ?? 0}], undefined)
  if (!item.width || !item.height) return genericChoices()
  const rendition = {
    codec: 'h264' as const,
    width: item.width,
    height: item.height,
    resolution: Math.min(item.width, item.height),
    bitrate: 0,
    urls: [item.mediaUrl],
  }
  return renditionChoices([rendition], item.duration)
}

function notFound(link: Resolved): string {
  switch (link.kind) {
    case 'spotlight':
      return 'This spotlight does not exist (or no longer does).'
    case 'profile':
      return `There is no public Snapchat account @${link.user} (or no longer).`
    case 'snap':
      return 'This snap is gone (stories last 24 hours) or never existed.'
    case 'highlight':
      return 'This highlight does not exist (or no longer does).'
  }
}

/** Media types a CDN answers for pages and errors, never for media. */
const NOT_MEDIA = /^(?:text\/|application\/(?:json|xml|xhtml))/

/**
 * Throws (and removes the file) unless it starts like what was asked for:
 * an MP4 (`ftyp` box) or a JPEG / PNG / WebP / GIF. Snapchat's CDN can
 * answer 200 with bytes that are neither (a render a key lacks). O(1): the
 * first 12 bytes.
 */
async function expectMedia(file: string, contentType: string | undefined, kind: 'video' | 'image'): Promise<void> {
  const head = Buffer.alloc(12)
  const handle = await fs.open(file, 'r')
  try {
    await handle.read(head, 0, head.length, 0)
  } finally {
    await handle.close()
  }
  const ok =
    !(contentType && NOT_MEDIA.test(contentType)) &&
    (kind === 'video'
      ? head.toString('latin1', 4, 8) === 'ftyp'
      : (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
        head.toString('latin1', 1, 4) === 'PNG' ||
        (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') ||
        head.toString('latin1', 0, 4) === 'GIF8')
  if (ok) return
  await fs.rm(file, {force: true})
  throw new MetaError(
    'format-changed',
    `Snapchat: the media link answered ${contentType ?? 'something'} that is not ${kind === 'video' ? 'an MP4 video' : 'a picture'}.`,
  )
}
