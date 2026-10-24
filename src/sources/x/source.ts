import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtractResult} from '../../core/analyze.js'
import type {MediaTags} from '../../core/convert.js'
import type {DownloadedInfo} from '../../core/download.js'
import {DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, FormatChoice, VideoAnalysis} from '../../types.js'
import {type Fetch, HttpSession} from '../http.js'
import {fetchMedia} from '../media-fetch.js'
import {MetaError, toDownloadError} from '../meta/errors.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import {followShortLink, resolved, unresolvedMessage} from '../redirects.js'
import {rankRenditions, renditionChoices} from '../renditions.js'
import type {MediaSource, SourceDownload, SourceFile} from '../source.js'
import {
  readTweetResult,
  SYNDICATION_ORIGIN,
  summaryOf,
  titleOf,
  tweetResultUrl,
  videoIdOf,
  type XPost,
  type XVideo,
} from './data.js'
import {parseXLink, postUrl, X_ORIGIN, type XLink} from './links.js'

export type XOptions = {
  /** Pace of requests for post data (the syndication endpoint). Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** Tests: serve the post data from another origin (default the syndication CDN). */
  readonly origin?: string | undefined
  /** Tests: also accept post urls on this host as X's. */
  readonly linkHost?: string | undefined
  readonly fetch?: Fetch | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

/** Post reads kept: media links on video.twimg.com last days, the bound is memory. */
const CACHE_LIMIT = 1000
const POST_FRESH_MS = 10 * 60_000
const READ_ATTEMPTS = 3
/** The syndication CDN serves embeds to the whole web: a brisker pace than a site's own pages. */
const DEFAULT_PACING: PacerOptions = {concurrency: 3, spacingMs: 300, jitterMs: 300}

type PostLink = Extract<XLink, {kind: 'post'}>

/**
 * X (Twitter) videos, natively: a post's data from the public endpoint X's
 * own embedded-post widget reads (anonymous plain JSON: no guest token, no
 * session, no browser), its progressive MP4s straight from video.twimg.com.
 * A post with one video (or GIF) is a video; with several, a playlist of its
 * `/video/<n>` pages. Profiles and timelines are not read; a post with no
 * video says so. When the data stops looking as expected, the engine hands
 * the url to yt-dlp (where there is one).
 */
export class XSource implements MediaSource {
  readonly name = 'Twitter'
  readonly #session: HttpSession
  readonly #pacer: Pacer
  readonly #origin: string
  readonly #linkHost: string | undefined
  readonly #posts = new Map<string, {readonly post: XPost; readonly at: number}>()
  readonly #log: (level: 'info' | 'warn', message: string) => void

  constructor(options: XOptions = {}) {
    this.#session = new HttpSession({fetch: options.fetch})
    this.#pacer = new Pacer(options.pacing ?? DEFAULT_PACING, 'X')
    this.#origin = (options.origin ?? SYNDICATION_ORIGIN).replace(/\/$/, '')
    this.#linkHost = options.linkHost?.toLowerCase()
    this.#log = options.log ?? (() => {})
  }

  /** Nothing to step aside for: the endpoint has no verification page. */
  get available(): boolean {
    return true
  }

  handles(url: string): boolean {
    return parseXLink(url, this.#linkHost) !== undefined
  }

  async analyze(url: string, opts: {signal?: AbortSignal} = {}): Promise<AnalysisResult> {
    try {
      const link = await this.#resolve(url, opts.signal)
      const post = await this.#read(link.id, opts.signal)
      if (link.index !== undefined || post.videos.length <= 1) return this.#videoAnalysis(post, pick(post, link))
      return {
        kind: 'playlist',
        id: post.id,
        url: postUrl(post.id, post.user, X_ORIGIN),
        title: titleOf(post),
        uploader: post.user,
        extractor: this.name,
        entries: post.videos.map((_, i) => ({...summaryOf(post, i + 1, this.name), index: i + 1})),
        choices: genericChoices(),
        total: post.videos.length,
        complete: true,
      }
    } catch (error) {
      throw toDownloadError(error, this.name)
    }
  }

  /** Each url's post read once (several videos of one post share the read). O(items) requests at most. */
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
          const post = await this.#read(link.id, opts.signal)
          if (link.index === undefined && post.videos.length > 1) {
            throw new DownloadError('invalid-request', 'This post has several videos: each is its own item.')
          }
          result = {ok: true, analysis: this.#videoAnalysis(post, pick(post, link))}
        } catch (error) {
          result = {ok: false, error: toDownloadError(error, this.name).toJSON()}
        }
        results.set(url, result)
        opts.onResult?.(url, result)
      }),
    )
    return results
  }

  async download(task: SourceDownload): Promise<SourceFile> {
    let id: string | undefined
    try {
      const link = await this.#resolve(task.url, task.signal)
      id = link.id
      const post = await this.#read(link.id, task.signal, task.fresh)
      if (link.index === undefined && post.videos.length > 1) {
        throw new DownloadError('invalid-request', 'This post has several videos: download each one.')
      }
      const index = pick(post, link)
      return await this.#fetch(post, index, task)
    } catch (error) {
      if (id) this.#posts.delete(id)
      throw toDownloadError(error, this.name)
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  async #resolve(url: string, signal?: AbortSignal): Promise<PostLink> {
    const link = parseXLink(url, this.#linkHost)
    if (!link || link.kind === 'profile') {
      throw new DownloadError(
        'invalid-request',
        link
          ? 'X profiles and timelines are not supported: paste the link of a post with a video.'
          : 'Not an X post url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    if (link.kind === 'post') return link
    const followed = await followShortLink(
      link.url,
      next => this.#hop(next, signal),
      next => resolved(parseXLink(next, this.#linkHost)),
    )
    if (!followed.ok) {
      const host = hostOf(followed.resolvedUrl)
      if (followed.reason === 'dead-end' && host && host !== 't.co') {
        throw new DownloadError(
          'invalid-request',
          `This t.co link leads to ${host}, not to an X post: paste the link it leads to instead.`,
          undefined,
          undefined,
          'unsupported-url',
        )
      }
      throw new MetaError('removed', unresolvedMessage(followed.reason))
    }
    if (followed.link.kind !== 'post') {
      throw new DownloadError(
        'invalid-request',
        'This t.co link leads to an X profile, not a post.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    // a post's t.co link always names its first video (`/video/1`): it stands for the whole post
    const {index: _first, ...post} = followed.link
    return post
  }

  /**
   * One t.co hop: a redirect's Location, or — what t.co answers a browser —
   * the page's meta refresh. A link that has left t.co (an article, another
   * site) is not followed further: it is no X post. O(size of the page).
   */
  async #hop(url: string, signal?: AbortSignal): Promise<string | undefined> {
    if (parseXLink(url)?.kind !== 'short') return undefined
    const response = await this.#session.get(url, {redirect: 'manual', signal})
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      return location ?? undefined
    }
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const html = (await response.text()).slice(0, 64 * 1024)
    const refresh = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"'>]+)/i.exec(html)?.[1]
    return refresh?.replace(/&amp;/g, '&').trim() || undefined
  }

  // ─── posts ───────────────────────────────────────────────────────────────

  /** A post's data, a recent read reused (bounded: oldest dropped past CACHE_LIMIT). */
  async #read(id: string, signal?: AbortSignal, fresh = false): Promise<XPost> {
    const cached = this.#posts.get(id)
    if (!fresh && cached && Date.now() - cached.at < POST_FRESH_MS) return cached.post
    const post = await this.#retrying(() => this.#readOnce(id, signal), signal)
    this.#posts.delete(id)
    this.#posts.set(id, {post, at: Date.now()})
    if (this.#posts.size > CACHE_LIMIT) this.#posts.delete(this.#posts.keys().next().value!)
    return post
  }

  async #retrying<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read()
      } catch (error) {
        if (signal?.aborted || !(error instanceof MetaError) || !error.transient || attempt >= READ_ATTEMPTS)
          throw error
        this.#log('info', `X: ${error.message} (try ${attempt} of ${READ_ATTEMPTS})`)
      }
    }
  }

  #readOnce(id: string, signal?: AbortSignal): Promise<XPost> {
    return this.#pacer.run(async () => {
      const response = await this.#session.get(tweetResultUrl(id, this.#origin), {
        headers: {Accept: 'application/json', Origin: 'https://platform.twitter.com'},
        signal,
      })
      if (response.status === 404) {
        await response.body?.cancel()
        throw new MetaError('removed', 'This post does not exist (or no longer does).')
      }
      if (!response.ok) {
        await response.body?.cancel()
        this.#pacer.refused()
        throw new MetaError('refused', `X answered HTTP ${response.status}.`)
      }
      let body: unknown
      try {
        body = JSON.parse(await response.text())
      } catch {
        throw new MetaError('format-changed', 'X: the post data is not JSON.')
      }
      this.#pacer.succeeded()
      return readTweetResult(body)
    }, signal)
  }

  #videoAnalysis(post: XPost, index: number): VideoAnalysis {
    return {kind: 'video', media: summaryOf(post, index, this.name), choices: choicesOf(post.videos[index - 1]!)}
  }

  // ─── media ───────────────────────────────────────────────────────────────

  /** The best MP4 for the profile, the next ones as fallbacks; streamed to disk, resumable. */
  async #fetch(post: XPost, index: number, task: SourceDownload): Promise<SourceFile> {
    const video = post.videos[index - 1]!
    const id = videoIdOf(post, index)
    const title = post.videos.length > 1 ? `${titleOf(post)} #${index}` : titleOf(post)
    const pageUrl = postUrl(post.id, post.user, X_ORIGIN)
    const info: DownloadedInfo = {
      id,
      title,
      extractor: this.name,
      publishedAt: post.createdAt ?? null,
      duration: video.duration ?? null,
    }
    const tags: MediaTags = {
      title,
      artist: post.userName ?? post.user,
      date: post.createdAt ? new Date(post.createdAt * 1000).toISOString().slice(0, 10) : undefined,
      comment: pageUrl,
    }
    if (task.profile.kind === 'audio' && video.gif) throw new MetaError('no-media', 'A GIF has no sound to extract.')
    task.onInfo(info)
    let last: unknown
    for (const rendition of rankRenditions(video.renditions, task.profile)) {
      const file = path.join(task.workDir, `${id}-${rendition.width}x${rendition.height}.mp4`)
      try {
        const {bytes} = await fetchMedia(this.#session, rendition.urls[0]!, file, {
          site: 'X',
          headers: {Referer: `${X_ORIGIN}/`},
          signal: task.signal,
          onProgress: task.onProgress,
        })
        const hasAudio = await task.hasAudio(file)
        if (task.profile.kind === 'audio' && !hasAudio) {
          await fs.rm(file, {force: true})
          throw new MetaError('no-media', 'This video has no sound to extract.')
        }
        return {
          filepath: file,
          info: {...info, vcodec: 'avc1', acodec: hasAudio ? 'mp4a' : 'none', filesize: bytes},
          tags,
        }
      } catch (error) {
        if (task.signal.aborted || (error instanceof MetaError && error.problem === 'no-media')) throw error
        await fs.rm(file, {force: true})
        last = error
      }
    }
    throw last ?? new MetaError('format-changed', 'This video has no downloadable MP4.')
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** Which video of the post a link means (1-based), or why none. O(1). */
function pick(post: XPost, link: PostLink): number {
  if (post.videos.length === 0) throw new MetaError('no-media', 'This post has no video.')
  const index = link.index ?? 1
  if (index > post.videos.length) {
    throw new MetaError(
      'removed',
      `This post has ${post.videos.length === 1 ? 'one video' : `${post.videos.length} videos`}, not ${index}.`,
    )
  }
  return index
}

/** A video's encodings as choices; a GIF has no sound, so no audio choices. */
function choicesOf(video: XVideo): FormatChoice[] {
  const choices = renditionChoices(video.renditions, video.duration)
  return video.gif ? choices.filter(choice => choice.profile.kind !== 'audio') : choices
}
