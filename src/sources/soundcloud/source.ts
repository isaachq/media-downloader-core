import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtractResult} from '../../core/analyze.js'
import type {MediaTags} from '../../core/convert.js'
import type {DownloadedInfo} from '../../core/download.js'
import {cancelledError, DownloadError} from '../../core/errors.js'
import {downloadHls, fetchPlaylist, HlsError, type HlsMediaPlaylist, isHlsError} from '../../core/hls/index.js'
import type {
  AnalysisResult,
  AudioContainer,
  MediaSummary,
  PlaylistAnalysis,
  PlaylistEntry,
  VideoAnalysis,
} from '../../types.js'
import {Coalescer} from '../coalesce.js'
import {DOCUMENT_NAVIGATION_HEADERS, type Fetch, HttpSession} from '../http.js'
import {fetchMedia} from '../media-fetch.js'
import {MetaError, toDownloadError} from '../meta/errors.js'
import {type CursorPage, walkCursor} from '../meta/listing.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import {followShortLink, resolved, unresolvedMessage} from '../redirects.js'
import {audioChoices} from '../renditions.js'
import type {ListingProgress, MediaSource, SourceDownload, SourceFile} from '../source.js'
import {bundleScripts, hydrationClientId, scanForClientId} from './client-id.js'
import {
  type AudioCodec,
  candidates,
  codecOf,
  problemOf,
  type Resolved,
  readLikesPage,
  readResolved,
  readSetPage,
  readStream,
  readTrackPage,
  readTracks,
  type SoundcloudSet,
  type SoundcloudTrack,
  type SoundcloudUser,
  stubsOf,
  type TrackRef,
  type Transcoding,
} from './data.js'
import {DEFAULT_ENDPOINTS, IDS_PER_REQUEST, SOUNDCLOUD_ORIGIN, type SoundcloudEndpoints} from './endpoints.js'
import {canonicalUrl, keyOf, parseSoundcloudLink, type SoundcloudLink} from './links.js'

export type SoundcloudOptions = {
  /**
   * The api-v2 `client_id` to use instead of reading one from the web app
   * (yt-dlp users ask for this when the home page sits behind a WAF, #16742).
   * A 401 on it still falls back to reading the page.
   */
  readonly clientId?: string | undefined
  /** Profiles and sets list at most this many tracks unless asked otherwise. Default 500. */
  readonly maxListItems?: number | undefined
  /** Pace of api-v2 and web page requests. Media (the CDN) isn't paced. */
  readonly pacing?: PacerOptions | undefined
  /** The API, the web app, the short-link host, the asset host and the page size (endpoints.ts). */
  readonly endpoints?: Partial<SoundcloudEndpoints> | undefined
  readonly fetch?: Fetch | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const SOUNDCLOUD_LIST_DEFAULT_ITEMS = 500
/** A read track is trusted this long (its transcodings and authorization). */
const TRACK_FRESH_MS = 30 * 60_000
const TRACK_CACHE_LIMIT = 5000
const USER_FRESH_MS = 30 * 60_000
const USER_CACHE_LIMIT = 500
const LISTING_FRESH_MS = 15 * 60_000
const LISTING_CACHE_LIMIT = 100
/** Client ids the API refused lately: never picked again within this window. */
const REFUSED_ID_MS = 60 * 60_000
const REFUSED_ID_LIMIT = 16
const READ_ATTEMPTS = 3
/** A download whose links ran out is tried once more with a fresh read of the track. */
const DOWNLOAD_ATTEMPTS = 2
/** After a DataDome wall or a WAF page, SoundCloud urls go to yt-dlp (where there is one) for this long. */
const BLOCKED_MS = 10 * 60_000
/** yt-dlp's figure is about 600 api requests per 10 minutes: about one a second, two in flight. */
const DEFAULT_PACING: PacerOptions = {concurrency: 2, spacingMs: 700, jitterMs: 400}
/** A minted stream that is a 30-second preview anyway. */
const PREVIEW_STREAM = /\/preview\/|\/playlist\/0\/30\//
/** DataDome's or a captcha's answer instead of JSON. */
const WALL = /datadome|captcha-delivery|geo\.captcha|cf-chl|aws-waf|challenge-platform/i
const SITE_HEADERS: Readonly<Record<string, string>> = {
  Origin: SOUNDCLOUD_ORIGIN,
  Referer: `${SOUNDCLOUD_ORIGIN}/`,
}
const API_HEADERS: Readonly<Record<string, string>> = {...SITE_HEADERS, Accept: 'application/json'}
const EXTENSIONS: Readonly<Record<AudioCodec, string>> = {aac: 'm4a', mp3: 'mp3', opus: 'opus'}

type TrackLink = Extract<SoundcloudLink, {kind: 'track'}>
type Resolvable = Exclude<SoundcloudLink, {kind: 'short'}>
type Timed<T> = {readonly value: T; readonly at: number}
type KeptListing = {
  readonly tracks: SoundcloudTrack[]
  readonly cursor: string | undefined
  readonly complete: boolean
  readonly at: number
}

/**
 * SoundCloud, natively: tracks (private ones by their `s-` link too), sets
 * (playlists and albums) and public profiles (tracks, likes, sets, albums),
 * from the anonymous api-v2 with the `client_id` the web app itself uses
 * (read once per session from the home page's hydration or its bundle, read
 * again once when the API refuses it). Audio only. A track is one `/resolve`;
 * listings carry every track whole, so a listed track is never read again; a
 * set's stubs are fetched 50 at a time and put back in the set's order. The
 * media is the clear HLS fMP4 AAC (160k, else 96k) through the core's HLS
 * module, re-signed when its 5-minute playlist link runs out; old tracks'
 * MP3 / Opus too, progressive through `fetchMedia`. DRM-only label releases,
 * Go+ previews and region blocks are refused as what they are, never handed
 * to yt-dlp; a changed API or a DataDome wall is (yt-dlp's SoundCloud
 * extractor reads the same API).
 */
export class SoundcloudSource implements MediaSource {
  readonly name = 'SoundCloud'
  readonly #session: HttpSession
  /** The CDN: playlists, segments, progressive files. Not paced. */
  readonly #media: HttpSession
  readonly #pacer: Pacer
  readonly #endpoints: SoundcloudEndpoints
  readonly #api: string
  readonly #maxListItems: number
  readonly #log: (level: 'info' | 'warn', message: string) => void
  readonly #option: string | undefined
  #clientId: string | undefined
  /** id → when the API refused it. */
  readonly #refusedIds = new Map<string, number>()
  readonly #extracting = new Coalescer<'client-id', string>()
  /** track id → track (insertion order = age). */
  readonly #tracks = new Map<string, Timed<SoundcloudTrack>>()
  /** `<user>/<slug>` → track id. */
  readonly #keys = new Map<string, string>()
  /** permalink → user. */
  readonly #users = new Map<string, Timed<SoundcloudUser>>()
  /** `<user id>/<tab>` → what its listing gave. */
  readonly #listings = new Map<string, KeptListing>()
  readonly #resolving = new Coalescer<string, Resolved>()
  #blockedUntil = 0

  constructor(options: SoundcloudOptions = {}) {
    this.#endpoints = {...DEFAULT_ENDPOINTS, ...options.endpoints}
    this.#api = this.#endpoints.api.replace(/\/+$/, '')
    const fetcher = options.fetch ?? ((input, init) => fetch(input, init))
    this.#session = new HttpSession({fetch: fetcher})
    this.#media = new HttpSession({fetch: fetcher})
    this.#pacer = new Pacer(options.pacing ?? DEFAULT_PACING, 'SoundCloud')
    this.#maxListItems = Math.max(1, Math.floor(options.maxListItems ?? SOUNDCLOUD_LIST_DEFAULT_ITEMS))
    this.#log = options.log ?? (() => {})
    this.#option = options.clientId
    this.#clientId = options.clientId
  }

  /** False for 10 minutes after a DataDome wall or a WAF page: yt-dlp takes SoundCloud urls meanwhile. */
  get available(): boolean {
    return Date.now() >= this.#blockedUntil
  }

  handles(url: string): boolean {
    return parseSoundcloudLink(url) !== undefined
  }

  defaultListSize(url: string): number | undefined {
    const kind = parseSoundcloudLink(url)?.kind
    return kind === 'profile' || kind === 'set' ? this.#maxListItems : undefined
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
      const link = await this.#link(url, opts.signal)
      const max = Math.max(1, Math.floor(opts.maxEntries ?? this.#maxListItems))
      switch (link.kind) {
        case 'track':
          return this.#videoAnalysis(usable(await this.#track(link, opts.signal)))
        case 'set':
          return await this.#set(link, max, opts.signal, opts.onProgress)
        case 'profile':
          return await this.#profile(link, max, opts.signal, opts.onProgress, opts.known)
      }
    } catch (error) {
      throw this.#toDownloadError(error, opts.signal)
    }
  }

  /**
   * Each url's track: from what a listing or an analysis read, else one
   * `/resolve` (paced; the same url at the same time shares one). O(n) work,
   * at most n requests for n tracks not read yet.
   */
  async preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {signal?: AbortSignal | undefined; onResult?: ((url: string, result: ExtractResult) => void) | undefined},
  ): Promise<Map<string, ExtractResult>> {
    const results = new Map<string, ExtractResult>()
    await Promise.all(
      items.map(async ({url}) => {
        let result: ExtractResult
        try {
          const track = await this.#track(await this.#trackLink(url, opts.signal), opts.signal)
          result = this.#check(track)
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
    if (task.profile.kind !== 'audio') {
      // before any request: SoundCloud has no video to give
      throw new DownloadError(
        'invalid-request',
        'SoundCloud tracks are audio only: choose an audio format (M4A keeps SoundCloud’s AAC as it is).',
        undefined,
        undefined,
        'format-unavailable',
      )
    }
    const container = task.profile.container
    let id: string | undefined
    for (let attempt = 1; ; attempt++) {
      try {
        const link = await this.#trackLink(task.url, task.signal)
        const track = usable(await this.#track(link, task.signal, task.fresh || attempt > 1))
        id = track.id
        return await this.#fetchTrack(track, container, task)
      } catch (error) {
        const retry = error instanceof DownloadError && error.code === 'expired'
        if (task.signal.aborted || attempt >= DOWNLOAD_ATTEMPTS || !retry) {
          // read again next time: the track may be gone, its formats changed
          if (id) this.#tracks.delete(id)
          throw this.#toDownloadError(error, task.signal)
        }
        this.#log('info', `SoundCloud: ${(error as Error).message} — reading the track again`)
      }
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  /** A link, a short one followed (one 302). */
  async #link(url: string, signal?: AbortSignal): Promise<Resolvable> {
    const link = parseSoundcloudLink(url)
    if (!link) {
      throw new DownloadError(
        'invalid-request',
        'Not a SoundCloud track, set or profile url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    if (link.kind !== 'short') return link
    const followed = await followShortLink(
      link.url,
      next => this.#retrying(() => this.#hop(next, signal), signal),
      next => resolved(parseSoundcloudLink(next)),
    )
    if (followed.ok) return followed.link
    throw new MetaError(
      'removed',
      followed.reason === 'dead-end'
        ? 'This SoundCloud short link does not lead to a track, a set or a profile.'
        : unresolvedMessage(followed.reason),
    )
  }

  async #trackLink(url: string, signal?: AbortSignal): Promise<TrackLink> {
    const link = await this.#link(url, signal)
    if (link.kind !== 'track') {
      throw new DownloadError(
        'invalid-request',
        'A SoundCloud set or profile is a list: each of its tracks is its own item.',
      )
    }
    return link
  }

  /**
   * One short-link hop: its Location, asked on the configured short host. A
   * link that left SoundCloud is not followed; 404 / 410 is a dead end, 429 /
   * 5xx a refusal. O(1).
   */
  async #hop(url: string, signal?: AbortSignal): Promise<string | undefined> {
    const link = parseSoundcloudLink(url)
    if (link?.kind !== 'short') return undefined
    const code = link.url.slice(link.url.lastIndexOf('/') + 1)
    const target = `${this.#endpoints.short.replace(/\/+$/, '')}/${code}`
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
      throw new MetaError('refused', `SoundCloud answered HTTP ${response.status} to a short link.`, response.status)
    }, signal)
  }

  // ─── client id ───────────────────────────────────────────────────────────

  /** The client id to send: the option, the one read this session, else read now (once, shared). */
  async #currentClientId(signal?: AbortSignal): Promise<string> {
    if (this.#clientId && !this.#refused(this.#clientId)) return this.#clientId
    return this.#extracting.run('client-id', signal, async shared => {
      const id = await this.#extractClientId(shared)
      this.#clientId = id
      return id
    })
  }

  #refused(id: string): boolean {
    const at = this.#refusedIds.get(id)
    return at !== undefined && Date.now() - at < REFUSED_ID_MS
  }

  /** The API answered 401 to `id`: never picked again for a while. O(1). */
  #refuse(id: string): void {
    bounded(this.#refusedIds, id, Date.now(), REFUSED_ID_LIMIT)
    if (this.#clientId === id) this.#clientId = undefined
    this.#log('info', `SoundCloud: the API refused client id ${id.slice(0, 4)}… — reading another from the web app`)
  }

  /**
   * The web app's client id: the home page's hydration one (free), else the
   * bundle scripts' from last to first, each streamed and left at the first
   * match. Ids the API refused lately are passed over. A page that is not
   * the app (a WAF challenge) is a wall; an app page without an id is a
   * change. At most 1 page + k scripts (k ≤ ~9), once per session.
   */
  async #extractClientId(signal: AbortSignal): Promise<string> {
    if (this.#option && !this.#refused(this.#option)) return this.#option
    const home = `${this.#endpoints.web.replace(/\/+$/, '')}/`
    const html = await this.#retrying(
      () =>
        this.#pacer.run(async () => {
          const response = await this.#session.get(home, {headers: DOCUMENT_NAVIGATION_HEADERS, signal})
          const body = await response.text()
          if (response.status === 429 || response.status >= 500) {
            this.#pacer.refused()
            throw new MetaError('refused', `SoundCloud's home page answered HTTP ${response.status}.`, response.status)
          }
          if (!response.ok || response.status === 202) {
            throw new MetaError(
              'challenge',
              `SoundCloud's home page answered HTTP ${response.status} (a bot check on this network).`,
              response.status,
            )
          }
          this.#pacer.succeeded()
          return body
        }, signal),
      signal,
    )
    const hydrated = hydrationClientId(html)
    if (hydrated && !this.#refused(hydrated)) return hydrated
    const scripts = bundleScripts(html, this.#endpoints.assetHost)
    for (const script of scripts) {
      const id = await this.#pacer.run(async () => {
        const response = await this.#session.get(script, {headers: SITE_HEADERS, signal})
        if (!response.ok || !response.body) {
          await response.body?.cancel()
          return undefined
        }
        return scanForClientId(response.body, candidate => !this.#refused(candidate))
      }, signal)
      if (id) return id
    }
    if (scripts.length === 0 && !hydrated) {
      if (WALL.test(html) || !/soundcloud/i.test(html)) {
        throw new MetaError('challenge', 'SoundCloud answered with a bot check instead of its web app.')
      }
    }
    throw new MetaError(
      'format-changed',
      hydrated
        ? 'SoundCloud refused every client id its web app names.'
        : 'SoundCloud: no client id in the web app (its page or bundle changed).',
    )
  }

  // ─── the API ─────────────────────────────────────────────────────────────

  /**
   * One paced GET on api-v2 with the client id, retried after the shared
   * cool-down when refused (429 / 5xx). A 401 refuses the id and reads
   * another once; a second 401 means the scheme changed. 404 is `missing()`
   * when given, else `removed`. A 403 with DataDome's marks is a wall. Only
   * urls on the API's own origin are asked (the client id goes nowhere else).
   * O(size of the answer).
   */
  #get<T>(
    url: string,
    read: (json: unknown) => T,
    signal: AbortSignal | undefined,
    opts: {readonly missing?: (() => T) | undefined; readonly gone?: string | undefined} = {},
  ): Promise<T> {
    if (!url.startsWith(`${this.#api}/`)) {
      return Promise.reject(new MetaError('format-changed', `SoundCloud pointed at another host (${hostOf(url)}).`))
    }
    return this.#retrying(async () => {
      for (let renewed = false; ; renewed = true) {
        if (Date.now() < this.#blockedUntil) {
          throw new MetaError('challenge', 'SoundCloud is showing this network a bot check (DataDome); waiting it out.')
        }
        const id = await this.#currentClientId(signal)
        const target = `${url}${url.includes('?') ? '&' : '?'}client_id=${encodeURIComponent(id)}`
        const outcome = await this.#pacer.run(async (): Promise<{value: T} | 'renew'> => {
          const response = await this.#session.get(target, {headers: API_HEADERS, signal})
          const status = response.status
          if (status === 401) {
            await response.body?.cancel()
            return 'renew'
          }
          const body = await response.text()
          if (response.ok) {
            this.#pacer.succeeded()
            let json: unknown
            try {
              json = JSON.parse(body)
            } catch {
              throw new MetaError('format-changed', 'SoundCloud answered with something that is not JSON.', status)
            }
            return {value: read(json)}
          }
          if (status === 429 || status >= 500) {
            this.#pacer.refused()
            throw new MetaError('refused', `SoundCloud answered HTTP ${status}.`, status)
          }
          if (status === 404 || status === 410) {
            if (opts.missing) return {value: opts.missing()}
            throw new MetaError('removed', opts.gone ?? 'This SoundCloud page is gone (or never existed).', status)
          }
          if (status === 403 && (response.headers.has('x-datadome') || WALL.test(body))) {
            throw new MetaError('challenge', 'SoundCloud is showing this network a bot check (DataDome).', status)
          }
          if (status === 403) throw new MetaError('refused', 'SoundCloud refused the request (HTTP 403).', status)
          throw new MetaError('format-changed', `SoundCloud answered HTTP ${status}.`, status)
        }, signal)
        if (outcome !== 'renew') return outcome.value
        if (renewed)
          throw new MetaError('format-changed', 'SoundCloud refused a freshly read client id (HTTP 401).', 401)
        this.#refuse(id)
      }
    }, signal)
  }

  async #retrying<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read()
      } catch (error) {
        // a wall starts the window once: refusals while it lasts don't stretch it
        if (error instanceof MetaError && error.problem === 'challenge' && Date.now() >= this.#blockedUntil) {
          this.#blockedUntil = Date.now() + BLOCKED_MS
        }
        const transient = error instanceof MetaError && error.problem === 'refused'
        if (signal?.aborted || !transient || attempt >= READ_ATTEMPTS) throw error
        this.#log('info', `SoundCloud: ${(error as Error).message} (try ${attempt} of ${READ_ATTEMPTS})`)
      }
    }
  }

  /** `/resolve` of a page, shared by callers at the same time. */
  #resolve(link: Resolvable, signal?: AbortSignal): Promise<Resolved> {
    const page = canonicalUrl(SOUNDCLOUD_ORIGIN, link)
    return this.#resolving.run(page, signal, shared =>
      this.#get(`${this.#api}/resolve?url=${encodeURIComponent(page)}`, readResolved, shared, {
        gone: goneMessage(link),
      }),
    )
  }

  // ─── tracks ──────────────────────────────────────────────────────────────

  /** A track read or listed lately. O(1). */
  #cached(id: string | undefined): SoundcloudTrack | undefined {
    const kept = id === undefined ? undefined : this.#tracks.get(id)
    return kept && Date.now() - kept.at < TRACK_FRESH_MS ? kept.value : undefined
  }

  async #track(link: TrackLink, signal?: AbortSignal, fresh = false): Promise<SoundcloudTrack> {
    const cached = fresh ? undefined : this.#cached(this.#keys.get(keyOf(link.user, link.slug)))
    if (cached && (!link.secret || cached.secret === link.secret)) return cached
    const found = await this.#resolve(link, signal)
    if (found.kind !== 'track') {
      throw new MetaError('format-changed', `SoundCloud: this link is a ${found.kind}, not a track.`)
    }
    this.#remember(found.track)
    return found.track
  }

  /** Keep a track (by id and by its page). O(1); the oldest dropped past the bound. */
  #remember(track: SoundcloudTrack): void {
    bounded(this.#tracks, track.id, {value: track, at: Date.now()}, TRACK_CACHE_LIMIT)
    if (track.key) bounded(this.#keys, track.key, track.id, TRACK_CACHE_LIMIT)
  }

  #check(track: SoundcloudTrack): ExtractResult {
    const problem = problemOf(track)
    if (problem) return {ok: false, error: this.#toDownloadError(problem).toJSON()}
    return {ok: true, analysis: this.#videoAnalysis(track)}
  }

  #summary(track: SoundcloudTrack): MediaSummary {
    return {
      id: track.id,
      url: track.url,
      title: track.title,
      uploader: track.userName,
      duration: track.duration,
      thumbnail: track.artwork,
      publishedAt: track.createdAt,
      extractor: this.name,
      isLive: false,
    }
  }

  /** One track: audio choices only (M4A first: SoundCloud's AAC is kept as it is). */
  #videoAnalysis(track: SoundcloudTrack): VideoAnalysis {
    return {kind: 'video', media: this.#summary(track), choices: audioChoices(track.duration)}
  }

  // ─── sets ────────────────────────────────────────────────────────────────

  async #set(
    link: Extract<SoundcloudLink, {kind: 'set'}>,
    max: number,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
  ): Promise<PlaylistAnalysis> {
    const found = await this.#resolve(link, signal)
    if (found.kind !== 'set')
      throw new MetaError('format-changed', `SoundCloud: this link is a ${found.kind}, not a set.`)
    const set = found.set
    const wanted = set.tracks.slice(0, max)
    onProgress?.({listed: 0, expected: wanted.length})
    const tracks = await this.#materialize(wanted, signal, set.secret ? set : undefined)
    onProgress?.({listed: tracks.length, expected: wanted.length})
    return this.#playlist({
      id: set.id,
      url: set.url,
      title: set.title,
      uploader: set.userName,
      tracks,
      complete: set.tracks.length <= max,
      total: set.trackCount ?? set.tracks.length,
    })
  }

  /**
   * A set's tracks in its order: the whole ones as they are, the stubs from
   * memory or `/tracks?ids=`, 50 a request (each chunk waits its turn in the
   * pacer), put back in place by id (the API answers in no particular order);
   * an id the API leaves out was removed. O(n), ⌈stubs / 50⌉ requests.
   */
  async #materialize(
    refs: readonly TrackRef[],
    signal?: AbortSignal,
    privateSet?: SoundcloudSet,
  ): Promise<SoundcloudTrack[]> {
    const byId = new Map<string, SoundcloudTrack>()
    const missing: string[] = []
    for (const id of stubsOf(refs)) {
      const cached = this.#cached(id)
      if (cached) byId.set(id, cached)
      else missing.push(id)
    }
    const chunks: string[][] = []
    for (let i = 0; i < missing.length; i += IDS_PER_REQUEST) chunks.push(missing.slice(i, i + IDS_PER_REQUEST))
    await Promise.all(
      chunks.map(async chunk => {
        const query = new URLSearchParams({ids: chunk.join(',')})
        if (privateSet?.secret) {
          query.set('playlistId', privateSet.id)
          query.set('playlistSecretToken', privateSet.secret)
        }
        for (const track of await this.#get(`${this.#api}/tracks?${query.toString()}`, readTracks, signal)) {
          byId.set(track.id, track)
          this.#remember(track)
        }
      }),
    )
    const out: SoundcloudTrack[] = []
    let removed = 0
    for (const ref of refs) {
      const track = typeof ref === 'string' ? byId.get(ref) : ref
      if (!track) {
        removed++
        continue
      }
      if (typeof ref !== 'string') this.#remember(ref)
      out.push(track)
    }
    if (removed > 0) this.#log('info', `SoundCloud: ${removed} track(s) of the set are gone (left out)`)
    return out
  }

  #playlist(p: {
    id: string
    url: string
    title: string
    uploader: string
    tracks: readonly SoundcloudTrack[]
    complete: boolean
    total?: number | undefined
    caughtUp?: boolean | undefined
  }): PlaylistAnalysis {
    const entries: PlaylistEntry[] = p.tracks.map((track, i) => ({...this.#summary(track), index: i + 1}))
    return {
      kind: 'playlist',
      id: p.id,
      url: p.url,
      title: p.title,
      uploader: p.uploader,
      extractor: this.name,
      entries,
      choices: audioChoices(undefined),
      complete: p.complete,
      ...(p.total !== undefined && {total: p.total}),
      caughtUp: p.caughtUp || undefined,
    }
  }

  // ─── profiles ────────────────────────────────────────────────────────────

  async #user(link: Extract<SoundcloudLink, {kind: 'profile'}>, signal?: AbortSignal): Promise<SoundcloudUser> {
    const key = link.user.toLowerCase()
    const kept = this.#users.get(key)
    if (kept && Date.now() - kept.at < USER_FRESH_MS) return kept.value
    const found = await this.#resolve(link, signal)
    if (found.kind !== 'user') {
      throw new MetaError('format-changed', `SoundCloud: this link is a ${found.kind}, not a profile.`)
    }
    bounded(this.#users, key, {value: found.user, at: Date.now()}, USER_CACHE_LIMIT)
    return found.user
  }

  /**
   * A profile's tab, newest first (tracks, likes) or set by set (sets,
   * albums), up to `max`. `known` stops an incremental walk where known
   * tracks start (tracks and likes). The walk follows `next_href` to its end,
   * never the page size (pages come back short: 17 of 20). O(1) per track;
   * ⌈n / 50⌉ requests (plus a set's stubs).
   */
  async #profile(
    link: Extract<SoundcloudLink, {kind: 'profile'}>,
    max: number,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
    known?: ReadonlySet<string>,
  ): Promise<PlaylistAnalysis> {
    const user = await this.#user(link, signal)
    onProgress?.({listed: 0, expected: max})
    const listingKey = `${user.id}/${link.tab}`
    const kept = this.#listings.get(listingKey)
    const fresh = kept && !known && Date.now() - kept.at < LISTING_FRESH_MS ? kept : undefined
    let tracks = fresh?.tracks.slice(0, max) ?? []
    let cursor = fresh?.cursor
    let complete = fresh?.complete ?? false
    let caughtUp = false
    if (!(fresh && (fresh.tracks.length >= max || fresh.complete))) {
      if (link.tab === 'sets' || link.tab === 'albums') {
        const listed = await this.#setsListing(user, link.tab, max, signal, onProgress)
        tracks = listed.tracks
        complete = listed.complete
        cursor = undefined
      } else {
        const read = link.tab === 'likes' ? readLikesPage : readTrackPage
        const first = `${this.#api}/users/${user.id}/${link.tab}?${this.#pageQuery()}`
        try {
          const listing = await walkCursor<SoundcloudTrack>(next => this.#page(next ?? first, read, signal), {
            max,
            idOf: track => track.id,
            resume: tracks.length > 0 || cursor !== undefined ? {items: tracks, cursor} : undefined,
            known,
            onProgress: listed => onProgress?.({listed, expected: max}),
            site: this.name,
          })
          tracks = listing.items
          cursor = listing.cursor
          complete = listing.complete
          caughtUp = listing.caughtUp
        } catch (error) {
          if (signal?.aborted || tracks.length === 0) throw error
          this.#log('warn', `SoundCloud: ${user.permalink} listing stopped at ${tracks.length} (${String(error)})`)
        }
      }
      if (!known) {
        bounded(this.#listings, listingKey, {tracks, cursor, complete, at: Date.now()}, LISTING_CACHE_LIMIT)
      }
    }
    for (const track of tracks) this.#remember(track)
    onProgress?.({listed: tracks.length, expected: max})
    const tab = link.tab === 'tracks' ? '' : ` · ${link.tab}`
    return this.#playlist({
      id: user.id,
      url: `${SOUNDCLOUD_ORIGIN}/${user.permalink}${link.tab === 'tracks' ? '' : `/${link.tab}`}`,
      title: `SoundCloud ${user.name}${tab}`,
      uploader: user.name,
      tracks,
      complete,
      total: link.tab === 'tracks' ? user.trackCount : undefined,
      caughtUp,
    })
  }

  /** `limit` and `linked_partitioning` of a listing's first page. */
  #pageQuery(): string {
    return new URLSearchParams({limit: String(this.#endpoints.pageSize), linked_partitioning: '1'}).toString()
  }

  /** One listing page; `next_href` leaves out `linked_partitioning` (and the client id, added by #get). */
  #page<T>(url: string, read: (json: unknown) => CursorPage<T>, signal?: AbortSignal): Promise<CursorPage<T>> {
    const target = url.includes('linked_partitioning=')
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}linked_partitioning=1`
    return this.#get(stripClientId(target), read, signal)
  }

  /**
   * A profile's sets or albums, flattened into their tracks in order (each
   * track once), up to `max`: the set pages until enough refs are in, then
   * the stubs 50 a request. O(n) for n tracks.
   */
  async #setsListing(
    user: SoundcloudUser,
    tab: 'sets' | 'albums',
    max: number,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
  ): Promise<{tracks: SoundcloudTrack[]; complete: boolean}> {
    const seen = new Set<string>()
    const refs: TrackRef[] = []
    const cursors = new Set<string>()
    let next: string | undefined =
      `${this.#api}/users/${user.id}/${tab === 'sets' ? 'playlists' : 'albums'}?${this.#pageQuery()}`
    let complete = false
    while (next !== undefined && refs.length < max) {
      cursors.add(next)
      const page: CursorPage<SoundcloudSet> = await this.#page(next, readSetPage, signal)
      for (const set of page.items) {
        for (const ref of set.tracks) {
          const id = typeof ref === 'string' ? ref : ref.id
          if (seen.has(id) || refs.length >= max) continue
          seen.add(id)
          refs.push(ref)
        }
      }
      onProgress?.({listed: refs.length, expected: max})
      if (page.next === undefined) complete = true
      next = page.next !== undefined && !cursors.has(page.next) ? page.next : undefined
    }
    return {tracks: await this.#materialize(refs, signal), complete}
  }

  // ─── media ───────────────────────────────────────────────────────────────

  /**
   * The signed media url of one transcoding (`{url}`), or undefined when it
   * answers 404 (`abr_*`, a format gone): the next one is tried. One request.
   */
  #mint(track: SoundcloudTrack, t: Transcoding, signal?: AbortSignal): Promise<string | undefined> {
    const auth = track.authorization
      ? `${t.url.includes('?') ? '&' : '?'}track_authorization=${encodeURIComponent(track.authorization)}`
      : ''
    return this.#get<string | undefined>(`${t.url}${auth}`, readStream, signal, {missing: () => undefined})
  }

  /**
   * The best transcoding that mints, downloaded: HLS through the core's HLS
   * module (re-signed through a new transcoding call when the CDN refuses the
   * 5-minute link), progressive through `fetchMedia` (re-minted once when its
   * link runs out mid-file, then resumed with Range). The engine extracts the
   * profile's format from the file (M4A from AAC: a copy).
   */
  async #fetchTrack(track: SoundcloudTrack, container: AudioContainer, task: SourceDownload): Promise<SourceFile> {
    const tried = candidates(track, container)
    let previews = 0
    for (const t of tried) {
      const first = await this.#mint(track, t, task.signal)
      if (first === undefined) continue
      if (PREVIEW_STREAM.test(first)) {
        previews++
        continue
      }
      const codec = codecOf(t) ?? 'aac'
      const info: DownloadedInfo = {
        id: track.id,
        title: track.title,
        extractor: this.name,
        duration: track.duration ?? null,
        formatId: `${t.preset}/${t.protocol}`,
        vcodec: 'none',
        acodec: codec,
        publishedAt: track.createdAt ?? null,
      }
      task.onInfo(info)
      const tags: MediaTags = {
        title: track.title,
        artist: track.artist,
        date: track.createdAt ? new Date(track.createdAt * 1000).toISOString().slice(0, 10) : undefined,
        comment: track.url,
      }
      const remint = async (signal: AbortSignal): Promise<string> => {
        const url = await this.#mint(track, t, signal)
        if (!url) throw new DownloadError('expired', 'SoundCloud: this format is gone since the download started.')
        return url
      }
      if (t.protocol === 'progressive') {
        const file = path.join(task.workDir, `${track.id}.${EXTENSIONS[codec]}`)
        await fs.mkdir(task.workDir, {recursive: true})
        const bytes = await this.#progressive(first, remint, file, task)
        return {filepath: file, info: {...info, filesize: bytes}, tags}
      }
      const playlist = await this.#playlistOf(first, remint, task.signal)
      const result = await downloadHls({
        session: this.#media,
        site: this.name,
        headers: SITE_HEADERS,
        main: {playlist, refresh: (_why, signal) => remint(signal)},
        kind: 'audio',
        codecs: codecsOf(t),
        workDir: task.workDir,
        ffmpeg: task.ffmpeg,
        signal: task.signal,
        concurrency: task.fragments,
        fresh: task.fresh,
        expectedBytes: estimate(t, track.duration),
        onProgress: task.onProgress,
      })
      return {filepath: result.filepath, info: {...info, filesize: result.bytes}, tags}
    }
    if (previews > 0) {
      throw new DownloadError(
        'unavailable',
        'SoundCloud plays only a 30-second preview of this track (the whole track is for SoundCloud Go+ subscribers): not downloaded.',
        undefined,
        undefined,
        'format-unavailable',
      )
    }
    throw new MetaError(
      'format-changed',
      `SoundCloud: every format of this track answered 404 (${tried.map(t => t.preset).join(', ')}).`,
    )
  }

  /** The media playlist, fetched at once (its link lives ~5 minutes); a refusal re-mints it once. */
  async #playlistOf(
    first: string,
    remint: (signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ): Promise<HlsMediaPlaylist> {
    const read = async (url: string) => {
      const p = await fetchPlaylist(this.#media, url, {site: this.name, headers: SITE_HEADERS, signal})
      if (p.kind !== 'media') throw new HlsError('not-hls', 'The SoundCloud stream is a master playlist.')
      return p
    }
    try {
      return await read(first)
    } catch (error) {
      if (!isHlsError(error, 'refused') || signal.aborted) throw error
      this.#log('info', 'SoundCloud: the playlist link ran out before it was read — asking for a new one')
      return read(await remint(signal))
    }
  }

  async #progressive(
    first: string,
    remint: (signal: AbortSignal) => Promise<string>,
    file: string,
    task: SourceDownload,
  ): Promise<number> {
    const opts = {site: this.name, headers: SITE_HEADERS, signal: task.signal, onProgress: task.onProgress}
    try {
      return (await fetchMedia(this.#media, first, file, opts)).bytes
    } catch (error) {
      if (!(error instanceof DownloadError) || error.code !== 'expired' || task.signal.aborted) throw error
      // the link lives ~5 minutes: a new one, and the file goes on from where it stopped (Range)
      return (await fetchMedia(this.#media, await remint(task.signal), file, opts)).bytes
    }
  }

  // ─── errors ──────────────────────────────────────────────────────────────

  /**
   * The engine's error. A changed API (`source:format-changed`) and a
   * DataDome wall (`source:blocked`) go to yt-dlp, whose SoundCloud
   * extractor reads the same API; DRM, Go+ previews and region blocks carry
   * no `source:*` details, so nothing hands them over.
   */
  #toDownloadError(error: unknown, signal?: AbortSignal): DownloadError {
    if (signal?.aborted && !(error instanceof DownloadError)) return cancelledError()
    return toDownloadError(error, this.name)
  }
}

/** A track with something to download; else why not. O(transcodings). */
function usable(track: SoundcloudTrack): SoundcloudTrack {
  const problem = problemOf(track)
  if (problem) throw problem
  return track
}

function goneMessage(link: Resolvable): string {
  switch (link.kind) {
    case 'track':
      return link.secret
        ? 'This SoundCloud track was deleted, or its private link was reset.'
        : 'This SoundCloud track was deleted, or is private (a private track opens with its secret link only).'
    case 'set':
      return 'This SoundCloud set was deleted, or is private (a private set opens with its secret link only).'
    case 'profile':
      return 'There is no SoundCloud account by that name (or no longer).'
  }
}

/** The CODECS of a transcoding's mime (`audio/mp4; codecs="mp4a.40.2"` → `mp4a.40.2`). */
function codecsOf(t: Transcoding): string[] {
  const raw = /codecs="?([^";]+)"?/i.exec(t.mime)?.[1]
  return raw ? raw.split(',').map(c => c.trim()) : codecOf(t) === 'aac' ? ['mp4a.40.2'] : []
}

/** Bytes from the preset's bit rate (`aac_160k` → 160 kb/s), for progress before segments are measured. */
function estimate(t: Transcoding, duration: number | undefined): number | undefined {
  const kbps = Number(/_(\d+)k$/.exec(t.preset)?.[1] ?? 128)
  return duration ? Math.ceil((kbps * 1000 * duration) / 8) : undefined
}

/** `next_href` never carries it, but a host override might: the current one is added once. */
function stripClientId(url: string): string {
  return url
    .replace(/([?&])client_id=[^&]*(&|$)/, (_, lead: string, tail: string) => (tail ? lead : ''))
    .replace(/[?&]$/, '')
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return 'an invalid url'
  }
}

/** A bounded cache entry: re-inserted as the newest, the oldest dropped past `limit`. O(1). */
function bounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) map.delete(map.keys().next().value!)
}
