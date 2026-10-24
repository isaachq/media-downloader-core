import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtractResult} from '../../core/analyze.js'
import type {MediaTags} from '../../core/convert.js'
import {cancelledError, DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, MediaSummary, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import {Coalescer} from '../coalesce.js'
import {type Fetch, HttpSession} from '../http.js'
import {fetchMedia} from '../media-fetch.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import {followShortLink, resolved, unresolvedMessage} from '../redirects.js'
import {rankRenditions, renditionChoices} from '../renditions.js'
import type {ListingProgress, MediaSource, SourceDownload, SourceFile} from '../source.js'
import {SOURCE_BLOCKED, SOURCE_FORMAT_CHANGED} from '../source.js'
import {
  decodeBody,
  type ListedVideo,
  PUBLIC_ORIGIN,
  readAnswer,
  readEmbed,
  readListing,
  readVideo,
  VkError,
  type VkVideo,
} from './data.js'
import {linkUrl, parseVkLink, playlistUrl, type VkLink, videoUrl} from './links.js'

export type VkOptions = {
  /** Albums and owners' video lists load at most this many videos unless asked otherwise. Default 500. */
  readonly maxListItems?: number | undefined
  /** Pace of requests to VK's endpoint (videos and listings). Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** Tests: serve "VK" from another origin. */
  readonly origin?: string | undefined
  readonly fetch?: Fetch | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const VK_LIST_DEFAULT_ITEMS = 500
/** Media links are signed for days, but for this IP: a read older than this is read again before downloading. */
const VIDEO_FRESH_MS = 10 * 60_000
const CACHE_LIMIT = 2000
/** Pages of a listing read at most (a runaway pagination stops here). */
const MAX_LISTING_PAGES = 200
/** Reads of an answer refused transiently (429 / 5xx), before giving up. */
const READ_ATTEMPTS = 3
/** After a bot check, VK urls go to yt-dlp (where there is one) for this long. */
const BLOCKED_MS = 10 * 60_000
/** VK rate-limits its web endpoints: two at a time, a second or so apart, everyone backs off on a refusal. */
const DEFAULT_PACING: PacerOptions = {concurrency: 2, spacingMs: 1000, jitterMs: 600, backoffMs: 20_000}

type Resolved = Exclude<VkLink, {kind: 'short'}>
type Cached = {readonly video: VkVideo; readonly at: number}

/**
 * VK video, natively: one POST to the endpoint the site's own video layer
 * calls (`al_video.php?act=show`, anonymous) gives the title, author and the
 * progressive MP4s by size; the file comes straight from VK's CDN (signed for
 * this IP and user agent, so the same session fetches it). Albums and an
 * owner's videos are listed with the web client's own pagination
 * (`act=load_videos_silent`, by offset), bounded by `maxEntries`. No browser,
 * no login, no HLS (the core has no HLS downloader: an HLS-only video goes to
 * yt-dlp where there is one). Live streams are refused clearly.
 */
export class VkSource implements MediaSource {
  readonly name = 'VK'
  readonly #origin: string
  readonly #host: string
  readonly #session: HttpSession
  readonly #pacer: Pacer
  readonly #maxListItems: number
  readonly #log: (level: 'info' | 'warn', message: string) => void
  /** `<oid>_<id>` → the last read (insertion order = age: oldest evicted first). */
  readonly #videos = new Map<string, Cached>()
  /** Reads of one video at the same time share one request (analysis, preflight and download landing together). */
  readonly #reading = new Coalescer<string, VkVideo>()
  #blockedUntil = 0

  constructor(options: VkOptions = {}) {
    this.#origin = (options.origin ?? PUBLIC_ORIGIN).replace(/\/+$/, '')
    this.#host = new URL(this.#origin).hostname.toLowerCase()
    this.#session = new HttpSession({fetch: options.fetch})
    this.#pacer = new Pacer(options.pacing ?? DEFAULT_PACING, 'VK')
    this.#maxListItems = Math.max(1, Math.floor(options.maxListItems ?? VK_LIST_DEFAULT_ITEMS))
    this.#log = options.log ?? (() => {})
  }

  get available(): boolean {
    return Date.now() >= this.#blockedUntil
  }

  handles(url: string): boolean {
    return parseVkLink(url, this.#host) !== undefined
  }

  defaultListSize(url: string): number | undefined {
    return parseVkLink(url, this.#host)?.kind === 'playlist' ? this.#maxListItems : undefined
  }

  async analyze(
    url: string,
    opts: {signal?: AbortSignal; maxEntries?: number; onProgress?: (progress: ListingProgress) => void} = {},
  ): Promise<AnalysisResult> {
    try {
      const link = await this.#resolve(url, opts.signal)
      if (link.kind === 'playlist') return await this.#listing(link, opts.maxEntries, opts.signal, opts.onProgress)
      return this.#videoAnalysis(await this.#video(link, opts.signal), link)
    } catch (error) {
      throw this.#toDownloadError(error, opts.signal)
    }
  }

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
          if (link.kind === 'playlist')
            throw new DownloadError('invalid-request', 'A VK playlist is not a single video.')
          const video = await this.#video(link, opts.signal)
          downloadable(video)
          result = {ok: true, analysis: this.#videoAnalysis(video, link)}
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
      const link = await this.#resolve(task.url, task.signal)
      if (link.kind === 'playlist') throw new DownloadError('invalid-request', 'A VK playlist is not a single video.')
      key = `${link.oid}_${link.id}`
      const video = await this.#video(link, task.signal, task.fresh)
      downloadable(video)
      const id = `${video.oid}_${video.id}`
      const title = video.title ?? `VK video ${id}`
      const url = linkUrl(PUBLIC_ORIGIN, {...link, oid: video.oid, id: video.id})
      const info = {id, title, duration: video.duration ?? null, extractor: this.name, publishedAt: video.date ?? null}
      task.onInfo(info)
      const audioOnly = task.profile.kind === 'audio'
      let last: unknown
      for (const rendition of rankRenditions(video.renditions, task.profile)) {
        const file = path.join(task.workDir, `${id}-${rendition.resolution}.mp4`)
        try {
          const fetched = await fetchMedia(this.#session, rendition.urls[0]!, file, {
            site: this.name,
            signal: task.signal,
            onProgress: task.onProgress,
          })
          const hasAudio = await task.hasAudio(file)
          if (audioOnly && !hasAudio) {
            await fs.rm(file, {force: true})
            throw new VkError('no-media', 'This VK video has no sound to extract.')
          }
          const tags: MediaTags = {
            title,
            artist: video.author,
            date: video.date ? new Date(video.date * 1000).toISOString().slice(0, 10) : undefined,
            comment: url,
          }
          return {
            filepath: file,
            info: {...info, vcodec: 'avc1', acodec: hasAudio ? 'mp4a' : 'none', filesize: fetched.bytes},
            tags,
          }
        } catch (error) {
          if (task.signal.aborted || (error instanceof VkError && error.problem === 'no-media')) throw error
          await fs.rm(file, {force: true}) // another size: never append to this one
          last = error
        }
      }
      throw last ?? new VkError('format-changed', 'This VK video has no downloadable file.')
    } catch (error) {
      // links that failed (another IP since, expired) are read again next time
      if (key) this.#videos.delete(key)
      throw this.#toDownloadError(error, task.signal)
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  async #resolve(url: string, signal?: AbortSignal): Promise<Resolved> {
    const link = parseVkLink(url, this.#host)
    if (!link) {
      throw new DownloadError(
        'invalid-request',
        'Not a VK video, clip or playlist url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    if (link.kind !== 'short') return link
    const followed = await followShortLink(
      link.url,
      async hop => {
        const response = await this.#pacer.run(() => this.#session.get(hop, {redirect: 'manual', signal}), signal)
        void response.body?.cancel()
        const location = response.headers.get('location')
        return location ? new URL(location, hop).href : undefined
      },
      target => resolved(parseVkLink(target, this.#host)),
    )
    if (followed.ok) return followed.link
    throw new VkError(
      'removed',
      followed.reason === 'dead-end' && parseVkLink(followed.resolvedUrl, this.#host) === undefined
        ? 'This VK short link does not lead to a video.'
        : unresolvedMessage(followed.reason),
    )
  }

  // ─── videos ──────────────────────────────────────────────────────────────

  /** One video from act=show; a recent read is reused (the preflight's, by the download). */
  async #video(link: Extract<VkLink, {kind: 'video'}>, signal?: AbortSignal, fresh = false): Promise<VkVideo> {
    const key = `${link.oid}_${link.id}`
    const cached = this.#videos.get(key)
    if (!fresh && cached && Date.now() - cached.at < VIDEO_FRESH_MS) return cached.video
    return this.#reading.run(key, signal, async shared => {
      // an embed's hash opens what act=show refuses (an embedded hidden video): its page has the files
      const video = link.hash
        ? readEmbed(await this.#embedPage(link.oid, link.id, link.hash, shared), link.oid, link.id)
        : readVideo(
            await this.#al(
              'show',
              {act: 'show', al: '1', video: key, ...(link.list && {list: link.list})},
              videoUrl(this.#origin, link.oid, link.id, link.clip),
              shared,
            ),
            link.oid,
            link.id,
          )
      this.#videos.delete(key)
      this.#videos.set(key, {video, at: Date.now()})
      if (this.#videos.size > CACHE_LIMIT) this.#videos.delete(this.#videos.keys().next().value!)
      return video
    })
  }

  /** The analysis of a video, its url carrying the link's access key or embed hash (retries need them). */
  #videoAnalysis(video: VkVideo, link: Extract<VkLink, {kind: 'video'}>): VideoAnalysis {
    return {
      kind: 'video',
      media: this.#summary({...video, clip: link.clip ?? false, list: link.list, hash: link.hash}),
      choices: video.live ? [] : renditionChoices(video.renditions, video.duration),
    }
  }

  #summary(
    video: ListedVideo & {readonly hash?: string | undefined; readonly live?: boolean | undefined},
  ): MediaSummary {
    return {
      id: `${video.oid}_${video.id}`,
      url: linkUrl(PUBLIC_ORIGIN, video),
      title: video.title ?? `VK video ${video.oid}_${video.id}`,
      uploader: video.author,
      duration: video.duration,
      thumbnail: video.thumbnail,
      publishedAt: video.date,
      extractor: this.name,
      isLive: video.live ?? false,
    }
  }

  // ─── listings ────────────────────────────────────────────────────────────

  /**
   * An album or every video of an owner, page by page (by offset, as the web
   * client scrolls), until `maxEntries`, the section's end, or
   * MAX_LISTING_PAGES. O(e) for e entries listed; each video once.
   */
  async #listing(
    link: Extract<VkLink, {kind: 'playlist'}>,
    maxEntries: number | undefined,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
  ): Promise<PlaylistAnalysis> {
    const max = Math.max(1, maxEntries ?? this.#maxListItems)
    const section = link.album === 'all' ? 'all' : `album_${link.album}`
    const referer = playlistUrl(this.#origin, link.oid, link.album)
    const seen = new Set<string>()
    const videos: ListedVideo[] = []
    let offset = 0
    let total: number | undefined
    let albumName: string | undefined
    let complete = false
    onProgress?.({listed: 0, expected: max})
    for (let page = 0; page < MAX_LISTING_PAGES && videos.length < max; page++) {
      const data = await this.#al(
        'load_videos_silent',
        {
          act: 'load_videos_silent',
          al: '1',
          need_albums: page === 0 && link.album !== 'all' ? '1' : '0',
          oid: link.oid,
          section,
          offset: String(offset),
          rowlen: '3',
        },
        referer,
        signal,
      )
      const listing = readListing(data, section, link.oid, link.album)
      total = listing.total ?? total
      albumName ??= listing.albumName
      let fresh = 0
      for (const video of listing.videos) {
        const key = `${video.oid}_${video.id}`
        if (seen.has(key)) continue
        seen.add(key)
        fresh++
        if (videos.length < max) videos.push(video)
      }
      offset += listing.count
      onProgress?.({listed: videos.length, expected: total !== undefined ? Math.min(total, max) : max})
      if (listing.count === 0 || listing.videos.length === 0 || (total !== undefined && offset >= total)) {
        complete = true
        break
      }
      // a page with nothing new: VK ignores the offset (or repeats its last page); going on would read the same
      if (fresh === 0) {
        this.#log('warn', `VK: the listing repeats itself at offset ${offset}: stopped at ${videos.length}`)
        complete = true
        break
      }
      if (page === MAX_LISTING_PAGES - 1) this.#log('warn', `VK: listing stopped after ${MAX_LISTING_PAGES} pages`)
    }
    if (videos.length === 0 && !complete) throw new VkError('format-changed', 'VK listed no videos here.')
    const uploader = videos[0]?.author
    const what = link.album === 'all' ? 'videos' : (albumName ?? `playlist ${link.oid}_${link.album}`)
    return {
      kind: 'playlist',
      id: `${link.oid}_${section}`,
      url: playlistUrl(PUBLIC_ORIGIN, link.oid, link.album),
      title: `VK ${uploader ?? link.oid} ${what}`,
      uploader,
      extractor: this.name,
      entries: videos.map((video, i) => ({...this.#summary(video), index: i + 1})),
      choices: genericChoices(),
      total,
      complete,
    }
  }

  // ─── the endpoint ────────────────────────────────────────────────────────

  /**
   * One paced POST to `al_video.php`, its windows-1251 answer decoded and
   * unwrapped. 429 / 5xx back every request off together and are retried.
   */
  async #al(act: string, form: Record<string, string>, referer: string, signal?: AbortSignal): Promise<unknown[]> {
    const body = new URLSearchParams(form).toString()
    return this.#read(
      () =>
        this.#session.request(`${this.#origin}/al_video.php?act=${act}`, {
          method: 'POST',
          body,
          headers: {
            Accept: '*/*',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: this.#origin,
            Referer: referer,
          },
          signal,
        }),
      readAnswer,
      signal,
    )
  }

  /** The embedded player's page for a video and its hash (HTML, windows-1251), paced like the endpoint. */
  #embedPage(oid: string, id: string, hash: string, signal?: AbortSignal): Promise<string> {
    return this.#read(
      () =>
        this.#session.get(linkUrl(this.#origin, {oid, id, hash}), {
          headers: {Accept: 'text/html,application/xhtml+xml', Referer: `${this.#origin}/`},
          signal,
        }),
      html => html,
      signal,
    )
  }

  /**
   * One paced request, its answer decoded (windows-1251 unless it says
   * otherwise) and read by `parse`. 429 / 5xx back every request off together
   * and are retried, READ_ATTEMPTS times at most.
   */
  async #read<T>(send: () => Promise<Response>, parse: (text: string) => T, signal?: AbortSignal): Promise<T> {
    if (!this.available) throw new VkError('blocked', 'VK asked to confirm this is not a bot: waiting a while.')
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#pacer.run(async () => {
          const response = await send()
          if (response.status === 429 || response.status >= 500) {
            await response.body?.cancel()
            this.#pacer.refused()
            throw new VkError('refused', `VK answered HTTP ${response.status}.`)
          }
          if (!response.ok) {
            await response.body?.cancel()
            throw new VkError('format-changed', `VK's video endpoint answered HTTP ${response.status}.`)
          }
          const text = decodeBody(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type'))
          const data = parse(text)
          this.#pacer.succeeded()
          return data
        }, signal)
      } catch (error) {
        if (error instanceof VkError && error.problem === 'blocked') {
          this.#blockedUntil = Date.now() + BLOCKED_MS
          this.#log('warn', `VK: a bot check — VK urls go to yt-dlp for ${BLOCKED_MS / 60_000} min`)
        }
        const transient = error instanceof VkError ? error.problem === 'refused' : !(error instanceof DownloadError)
        if (signal?.aborted || !transient || attempt >= READ_ATTEMPTS) throw error
      }
    }
  }

  #toDownloadError(error: unknown, signal?: AbortSignal): DownloadError {
    if (error instanceof DownloadError) return error
    if (signal?.aborted) return cancelledError()
    if (!(error instanceof VkError)) {
      return new DownloadError('network', error instanceof Error ? error.message : String(error))
    }
    switch (error.problem) {
      case 'removed':
        return new DownloadError('unavailable', error.message, undefined, undefined, 'removed')
      case 'private':
        return new DownloadError('unavailable', error.message, undefined, undefined, 'private')
      case 'login-required':
        return new DownloadError('unavailable', error.message, undefined, undefined, 'needs-sign-in')
      case 'geo-blocked':
        return new DownloadError('unavailable', error.message, undefined, undefined, 'geo-blocked')
      case 'live':
        return new DownloadError('unavailable', error.message, undefined, undefined, 'live-now')
      case 'no-media':
        return new DownloadError('unavailable', error.message, undefined, undefined, 'format-unavailable')
      case 'stream-only':
        // yt-dlp reads it where there is one; without it (Android) the hint is what the user sees
        return new DownloadError('unknown', error.message, SOURCE_FORMAT_CHANGED, undefined, 'stream-only')
      case 'refused':
        return new DownloadError('network', error.message, undefined, undefined, 'retry-later')
      case 'blocked':
        // yt-dlp takes over for a while
        return new DownloadError('network', error.message, SOURCE_BLOCKED, undefined, 'retry-later')
      case 'format-changed':
        // 'unknown' lets the engine fall back to yt-dlp for this url
        return new DownloadError(
          'unknown',
          error.message.startsWith('VK') ? error.message : `VK: ${error.message}`,
          SOURCE_FORMAT_CHANGED,
        )
    }
  }
}

/** Throws unless the video has a file to fetch: live streams and HLS-only videos are named as such. */
function downloadable(video: VkVideo): void {
  if (video.live) throw new VkError('live', 'VK live streams cannot be downloaded (only finished recordings).')
  if (video.renditions.length > 0) return
  if (video.external) {
    throw new VkError('stream-only', 'VK: this video plays from another site; VK has no file of its own.')
  }
  // an HLS-only video: yt-dlp (desktop) reads HLS; the built-in extractor doesn't
  throw new VkError(
    video.hls ? 'stream-only' : 'format-changed',
    video.hls
      ? 'VK: this video is only offered as an HLS stream, which the built-in extractor does not download.'
      : 'VK: this video has no downloadable file.',
  )
}
