import type {ExtractResult} from '../../core/analyze.js'
import {cancelledError, DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import type {AnalysisResult, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import {Coalescer} from '../coalesce.js'
import {type Fetch, HttpSession} from '../http.js'
import {downloadPost} from '../meta/download.js'
import {MetaError, toDownloadError} from '../meta/errors.js'
import {walkCursor} from '../meta/listing.js'
import {choicesOf, summaryOf} from '../meta/post.js'
import {dig, text} from '../meta/relay.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import type {ListingProgress, MediaSource, SourceDownload, SourceFile} from '../source.js'
import {
  type ClipsPage,
  readClipAnswer,
  readClipsPage,
  readLiveStream,
  readVodStatus,
  type TwitchClip,
  type TwitchLiveStream,
  toMetaPost,
} from './data.js'
import {
  ALIAS_LIMIT,
  CLIP_LISTING_LIMIT,
  CLIP_PERIODS,
  type ClipPeriod,
  channelStreamQuery,
  clipQuery,
  clipsPageQuery,
  clipsQuery,
  DEFAULT_CLIENT_ID,
  DEFAULT_ENDPOINTS,
  TWITCH_ORIGIN,
  type TwitchEndpoints,
  vodStatusQuery,
} from './endpoints.js'
import {clipsUrl, isNativeTwitchLink, parseTwitchLink, type TwitchLink} from './links.js'

export type TwitchOptions = {
  /** A channel's clips list at most this many unless asked otherwise. Default 500 (Twitch lists 1,000 at most). */
  readonly maxListItems?: number | undefined
  /**
   * The `Client-ID` sent to Twitch's GraphQL endpoint. Default yt-dlp's
   * (`ue6666qo983tsx6so1t0vnawi233wa`): the web player's own
   * (`kimne78kx3ncx6brgo4mv6wki5h1ko`) reads single clips but gets an
   * integrity check on every listing page after the first (endpoints.ts).
   */
  readonly clientId?: string | undefined
  /** Pace of GraphQL requests. Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** The GraphQL endpoint and the clip fields read (endpoints.ts), overridable without a release. */
  readonly endpoints?: Partial<TwitchEndpoints> | undefined
  readonly fetch?: Fetch | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

export const TWITCH_LIST_DEFAULT_ITEMS = 500
/** Clips kept by slug (a listing's are read back by their checks and downloads). ~2 KB each. */
const CLIP_CACHE_LIMIT = 2000
/** A read clip is trusted this long at most, and never past its token's expiry (~20 h, less 10 min). */
const CLIP_FRESH_MS = 6 * 60 * 60_000
const LISTING_FRESH_MS = 15 * 60_000
const LISTING_CACHE_LIMIT = 100
const READ_ATTEMPTS = 3
/** A download that broke is tried once more with a fresh read (its token may have run out). */
const DOWNLOAD_ATTEMPTS = 2
/** After an integrity check, clips and clip listings go to yt-dlp (where there is one) for this long. */
const BLOCKED_MS = 10 * 60_000
/** No rate limit seen at ~1 request every 2 s: two at a time, about a second apart. */
const DEFAULT_PACING: PacerOptions = {concurrency: 2, spacingMs: 500, jitterMs: 500}
const PERIOD_LABELS: Readonly<Record<ClipPeriod, string>> = {
  '24hr': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  all: 'all time',
}

type ClipLink = Extract<TwitchLink, {kind: 'clip'}>
type ClipsLink = Extract<TwitchLink, {kind: 'clips'}>
/** A VOD or a channel: checked for a broadcast on the air, never read here (HLS). */
type OnAirLink = Extract<TwitchLink, {kind: 'vod'} | {kind: 'channel'}>
type NativeLink = Exclude<TwitchLink, {kind: 'videos'}>
type Timed<T> = {readonly value: T; readonly until: number}
type KeptListing = {
  readonly clips: TwitchClip[]
  readonly channel: ClipsPage['channel']
  readonly cursor: string | undefined
  readonly complete: boolean
  readonly at: number
}

/**
 * Twitch clips, natively: a clip is one plain GraphQL query on
 * gql.twitch.tv (its encodings and the playback token that signs them, in one
 * answer), the file a signed progressive MP4 on Twitch's CDN, streamed to disk
 * with resume (Range). A channel's clips are its `clips(first: 100)` pages,
 * top by views in the link's period, every clip whole and signed in the page,
 * so a listed clip is never read again. Checks of clips not read yet go 15 a
 * request (aliases). VODs, video listings and live channels are HLS: they are
 * not handled here and go to yt-dlp (TODO(core-hls)). Anything that stops
 * looking as expected, or an integrity check, hands the url to yt-dlp, whose
 * Twitch extractor reads clips too.
 */
export class TwitchSource implements MediaSource {
  readonly name = 'Twitch'
  readonly #session: HttpSession
  readonly #pacer: Pacer
  readonly #endpoints: TwitchEndpoints
  readonly #clientId: string
  readonly #maxListItems: number
  readonly #log: (level: 'info' | 'warn', message: string) => void
  /** slug → clip (insertion order = age: the oldest evicted first). */
  readonly #clips = new Map<string, Timed<TwitchClip>>()
  /** `<login>/<period>` → what its listing gave. */
  readonly #listings = new Map<string, KeptListing>()
  readonly #reading = new Coalescer<string, TwitchClip>()
  #blockedUntil = 0

  constructor(options: TwitchOptions = {}) {
    this.#endpoints = {...DEFAULT_ENDPOINTS, ...options.endpoints}
    this.#clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.#session = new HttpSession({fetch: options.fetch})
    this.#pacer = new Pacer(options.pacing ?? DEFAULT_PACING, 'Twitch')
    this.#maxListItems = Math.max(1, Math.floor(options.maxListItems ?? TWITCH_LIST_DEFAULT_ITEMS))
    this.#log = options.log ?? (() => {})
  }

  /**
   * Always: VODs and channels must be checked here even while Twitch gates
   * this network (on the air they are live-now, never handed to yt-dlp), so
   * the source never steps aside as a whole. During an integrity block it is
   * each clip read that goes to yt-dlp instead (`#notBlocked`).
   */
  get available(): boolean {
    return true
  }

  /**
   * Clips and clip listings (read), VODs and channels (checked: on the air they
   * fail as live-now, never handed to yt-dlp; a finished VOD goes to yt-dlp).
   * Video listings go to yt-dlp (TODO(core-hls)).
   */
  handles(url: string): boolean {
    return isNativeTwitchLink(parseTwitchLink(url))
  }

  defaultListSize(url: string): number | undefined {
    return parseTwitchLink(url)?.kind === 'clips' ? this.#maxListItems : undefined
  }

  async analyze(
    url: string,
    opts: {
      signal?: AbortSignal
      maxEntries?: number
      onProgress?: (progress: ListingProgress) => void
    } = {},
  ): Promise<AnalysisResult> {
    try {
      const link = this.#link(url)
      if (link.kind === 'clips') return await this.#listing(link, opts.maxEntries, opts.signal, opts.onProgress)
      if (link.kind === 'vod' || link.kind === 'channel') return await this.#onAir(link, opts.signal)
      return this.#videoAnalysis(usable(await this.#clip(link, opts.signal)))
    } catch (error) {
      throw this.#toDownloadError(error, opts.signal)
    }
  }

  /**
   * Each url's clip: from what a listing or an analysis read, else 15 clips a
   * request (aliases of `clip`). O(n) work, ⌈n / 15⌉ requests for n clips not
   * read yet.
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
    /** slug → the urls asking for it. */
    const wanted = new Map<string, string[]>()
    /** VODs and channels: one status request each (rare in a batch), through the pacer. */
    const onAir: Array<Promise<void>> = []
    for (const {url} of items) {
      try {
        const native = this.#link(url)
        if (native.kind === 'vod' || native.kind === 'channel') {
          onAir.push(this.#onAir(native, opts.signal).catch(error => fail(url, error)))
          continue
        }
        const link = this.#clipLink(url)
        const cached = this.#cached(link.slug)
        if (cached) {
          settle(url, this.#check(cached))
          continue
        }
        const urls = wanted.get(link.slug)
        if (urls) urls.push(url)
        else wanted.set(link.slug, [url])
      } catch (error) {
        fail(url, error)
      }
    }
    await Promise.all(onAir)
    if (wanted.size > 0 && Date.now() < this.#blockedUntil) {
      for (const urls of wanted.values()) for (const url of urls) fail(url, blocked())
      return results
    }
    const slugs = [...wanted.keys()]
    const chunks: string[][] = []
    for (let i = 0; i < slugs.length; i += ALIAS_LIMIT) chunks.push(slugs.slice(i, i + ALIAS_LIMIT))
    // each chunk waits its turn in the pacer
    await Promise.all(
      chunks.map(async chunk => {
        try {
          const variables: Record<string, string> = {}
          chunk.forEach((slug, i) => {
            variables[`s${i}`] = slug
          })
          const answers = await this.#gql(
            clipsQuery(this.#endpoints.clipFields, chunk.length),
            variables,
            body => chunk.map((_, i) => readClipAnswer(body, `c${i}`)),
            opts.signal,
          )
          chunk.forEach((slug, i) => {
            const answer = answers[i]!
            if (!(answer instanceof MetaError)) this.#remember(answer)
            for (const url of wanted.get(slug) ?? []) {
              if (answer instanceof MetaError) fail(url, answer)
              else settle(url, this.#check(answer))
            }
          })
        } catch (error) {
          for (const slug of chunk) for (const url of wanted.get(slug) ?? []) fail(url, error)
        }
      }),
    )
    return results
  }

  async download(task: SourceDownload): Promise<SourceFile> {
    let link: ClipLink | undefined
    for (let attempt = 1; ; attempt++) {
      try {
        const native = this.#link(task.url)
        if (native.kind === 'vod' || native.kind === 'channel') await this.#onAir(native, task.signal)
        link = this.#clipLink(task.url)
        const clip = usable(await this.#clip(link, task.signal, task.fresh || attempt > 1))
        return await downloadPost({
          client: {session: this.#session},
          post: toMetaPost(clip),
          task,
          site: this.name,
          referer: `${TWITCH_ORIGIN}/`,
        })
      } catch (error) {
        // read again next time: the clip may be gone, its token run out
        if (link) this.#clips.delete(link.slug)
        // only a refused or broken transfer is worth a fresh token; anything else is the answer
        const final =
          error instanceof MetaError ||
          (error instanceof DownloadError && error.code !== 'expired' && error.code !== 'network')
        if (task.signal.aborted || attempt >= DOWNLOAD_ATTEMPTS || final) {
          throw this.#toDownloadError(error, task.signal)
        }
        this.#log('info', `Twitch: ${(error as Error).message} — reading the clip again (its token may have run out)`)
      }
    }
  }

  // ─── links ───────────────────────────────────────────────────────────────

  #link(url: string): NativeLink {
    const link = parseTwitchLink(url)
    if (!link || !isNativeTwitchLink(link)) {
      throw new DownloadError(
        'invalid-request',
        'Not a Twitch clip, clips page, video or channel url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    return link as NativeLink
  }

  #clipLink(url: string): ClipLink {
    const link = this.#link(url)
    if (link.kind === 'clips') {
      throw new DownloadError('invalid-request', 'A channel’s clips are a list: each clip is its own item.')
    }
    if (link.kind !== 'clip') throw new DownloadError('invalid-request', 'Not a Twitch clip url.')
    return link
  }

  /** While Twitch gates this network, clip reads go to yt-dlp without asking (source:blocked). O(1). */
  #notBlocked(): void {
    if (Date.now() < this.#blockedUntil) throw blocked()
  }

  // ─── on the air ──────────────────────────────────────────────────────────

  /**
   * A channel's live stream (its id, title, start and login), or undefined
   * when it is offline: one GraphQL request. Live detection on its own, for
   * the live recorder that comes with the core's HLS module.
   */
  async liveStream(login: string, signal?: AbortSignal): Promise<TwitchLiveStream | undefined> {
    try {
      return await this.#gql(channelStreamQuery(), {login: login.toLowerCase()}, readLiveStream, signal)
    } catch (error) {
      throw this.#toDownloadError(error, signal)
    }
  }

  /**
   * A VOD or a channel, which this source does not download: on the air it
   * is `live-now` here, never handed to yt-dlp (which would record the live
   * stream: only what is already available is downloaded). A finished VOD
   * goes to yt-dlp (HLS: TODO(core-hls)); an offline channel has nothing to
   * download. One GraphQL request.
   */
  async #onAir(link: OnAirLink, signal?: AbortSignal): Promise<never> {
    if (link.kind === 'channel') {
      const stream = await this.liveStream(link.channel, signal)
      if (stream) throw liveNow(`${stream.login} is live on Twitch right now`)
      throw new DownloadError(
        'unavailable',
        `${link.channel} is not live: a channel page has nothing else to download (its broadcasts are at /${link.channel}/videos, its clips at /${link.channel}/clips).`,
      )
    }
    const vod = await this.#gql(vodStatusQuery(), {id: link.id}, readVodStatus, signal)
    if (vod.recording) throw liveNow(`This Twitch broadcast${vod.owner ? ` of ${vod.owner}` : ''} is still on the air`)
    throw new MetaError('other-extractor', 'Twitch VODs are HLS: yt-dlp reads them until the core does.')
  }

  // ─── GraphQL ─────────────────────────────────────────────────────────────

  /**
   * One paced GraphQL query, retried after the shared cool-down when it is
   * refused (429 / 5xx). An integrity check sends clip reads to yt-dlp for a
   * while (`#notBlocked`); any other answer the module doesn't expect is a
   * change on Twitch's side. O(size of the answer).
   */
  async #gql<T>(
    query: string,
    variables: Record<string, unknown>,
    read: (body: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#pacer.run(async () => {
          const response = await this.#session.request(this.#endpoints.gql, {
            method: 'POST',
            body: JSON.stringify({query, variables}),
            headers: {
              'Client-ID': this.#clientId,
              'Content-Type': 'text/plain;charset=UTF-8',
              Accept: 'application/json',
              Origin: TWITCH_ORIGIN,
              Referer: `${TWITCH_ORIGIN}/`,
            },
            signal,
          })
          const body: unknown = await response.json().catch(() => undefined)
          const status = response.status
          if (status === 429 || status >= 500) {
            this.#pacer.refused()
            throw new MetaError('refused', `Twitch answered HTTP ${status}.`, status)
          }
          if (!response.ok) {
            const message = text(dig(body, 'message')) ?? text(dig(body, 'error')) ?? ''
            throw new MetaError(
              'format-changed',
              `Twitch: GraphQL answered HTTP ${status}${message ? ` (${message})` : ''}.`,
              status,
            )
          }
          this.#pacer.succeeded()
          return read(body)
        }, signal)
      } catch (error) {
        if (!(error instanceof MetaError) || signal?.aborted) throw error
        // a verification is not waited out here: yt-dlp takes Twitch urls for a while
        if (error.problem === 'challenge') this.#blockedUntil = Date.now() + BLOCKED_MS
        if (error.problem !== 'refused' || attempt >= READ_ATTEMPTS) throw error
        this.#log('info', `Twitch: ${error.message} (try ${attempt} of ${READ_ATTEMPTS})`)
      }
    }
  }

  // ─── clips ───────────────────────────────────────────────────────────────

  /** A clip read or listed lately, while its token is good. O(1). */
  #cached(slug: string): TwitchClip | undefined {
    const kept = this.#clips.get(slug)
    return kept && Date.now() < kept.until ? kept.value : undefined
  }

  /** One clip: from memory, else one query, shared by callers at the same time. */
  async #clip(link: ClipLink, signal?: AbortSignal, fresh = false): Promise<TwitchClip> {
    const cached = fresh ? undefined : this.#cached(link.slug)
    if (cached) return cached
    this.#notBlocked()
    return this.#reading.run(link.slug, signal, async shared => {
      const answer = await this.#gql(clipQuery(this.#endpoints.clipFields), {slug: link.slug}, readClipAnswer, shared)
      if (answer instanceof MetaError) throw answer
      this.#remember(answer)
      return answer
    })
  }

  /** Keep a clip until its token runs out (6 h at most). O(1); the oldest dropped past the bound. */
  #remember(clip: TwitchClip): void {
    const until = Math.min(Date.now() + CLIP_FRESH_MS, clip.expiresAt ?? Number.POSITIVE_INFINITY)
    bounded(this.#clips, clip.slug, {value: clip, until}, CLIP_CACHE_LIMIT)
  }

  #check(clip: TwitchClip): ExtractResult {
    if (clip.problem) return {ok: false, error: this.#toDownloadError(clip.problem).toJSON()}
    return {ok: true, analysis: this.#videoAnalysis(clip)}
  }

  #videoAnalysis(clip: TwitchClip): VideoAnalysis {
    const meta = toMetaPost(clip)
    return {kind: 'video', media: summaryOf(meta, this.name), choices: choicesOf(meta)}
  }

  // ─── listings ────────────────────────────────────────────────────────────

  /**
   * A channel's clips in the link's period, top by views (the site's order),
   * up to `maxEntries` (Twitch lists 1,000 at most), one request per 100
   * clips. Not newest first, so an incremental walk (`known`) can't stop
   * early: known clips are de-duplicated by the engine as usual. A refusal
   * half-way returns what was listed (`complete: false`). O(1) per clip.
   */
  async #listing(
    link: ClipsLink,
    maxEntries: number | undefined,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
  ): Promise<PlaylistAnalysis> {
    const max = Math.min(CLIP_LISTING_LIMIT, Math.max(1, Math.floor(maxEntries ?? this.#maxListItems)))
    const key = `${link.channel}/${link.period}`
    onProgress?.({listed: 0, expected: max})
    const kept = this.#listings.get(key)
    const fresh = kept && Date.now() - kept.at < LISTING_FRESH_MS ? kept : undefined
    let clips: TwitchClip[] = fresh?.clips.slice(0, max) ?? []
    let channel = fresh?.channel
    let cursor = fresh?.cursor
    let complete = fresh?.complete ?? false
    if (!(fresh && (fresh.clips.length >= max || fresh.complete))) {
      // what the pages brought so far, by id: kept when a later page is refused (O(1) per clip)
      this.#notBlocked()
      const got = new Map<string, TwitchClip>(clips.map(clip => [clip.id, clip]))
      try {
        const listing = await walkCursor(
          async next => {
            const page = await this.#page(link, next, signal)
            channel = page.channel
            for (const clip of page.clips) if (got.size < max && !got.has(clip.id)) got.set(clip.id, clip)
            cursor = page.next
            return {items: page.clips, next: page.next}
          },
          {
            max,
            idOf: clip => clip.id,
            resume: clips.length > 0 || cursor !== undefined ? {items: clips, cursor} : undefined,
            onProgress: listed => onProgress?.({listed, expected: max}),
            site: this.name,
          },
        )
        clips = listing.items
        cursor = listing.cursor
        complete = listing.complete
      } catch (error) {
        clips = [...got.values()]
        complete = false
        if (signal?.aborted || clips.length === 0 || !channel) throw error
        this.#log(
          'warn',
          `Twitch: ${link.channel}'s clips stopped at ${clips.length} of ${max} (${String(error)}) — load again to continue`,
        )
      }
      if (channel) {
        bounded(this.#listings, key, {clips, channel, cursor, complete, at: Date.now()}, LISTING_CACHE_LIMIT)
      }
    }
    onProgress?.({listed: clips.length, expected: max})
    for (const clip of clips) this.#remember(clip)
    const name = channel?.name ?? link.channel
    return {
      kind: 'playlist',
      id: `${link.channel}/clips/${link.period}`,
      url: clipsUrl(link.channel, link.period),
      title: `Twitch ${name} · clips, ${PERIOD_LABELS[link.period]}`,
      uploader: name,
      extractor: this.name,
      entries: clips.map((clip, i) => ({...summaryOf(toMetaPost(clip), this.name), index: i + 1})),
      choices: genericChoices(),
      complete,
    }
  }

  #page(link: ClipsLink, cursor: string | undefined, signal?: AbortSignal): Promise<ClipsPage> {
    return this.#gql(
      clipsPageQuery(this.#endpoints.clipFields),
      {login: link.channel, filter: CLIP_PERIODS[link.period], ...(cursor !== undefined && {after: cursor})},
      readClipsPage,
      signal,
    )
  }

  // ─── errors ──────────────────────────────────────────────────────────────

  /** The engine's error: a change on Twitch's side or an integrity check hands the url to yt-dlp. */
  #toDownloadError(error: unknown, signal?: AbortSignal): DownloadError {
    if (signal?.aborted && !(error instanceof DownloadError)) return cancelledError()
    return toDownloadError(error, this.name)
  }
}

function blocked(): MetaError {
  return new MetaError(
    'challenge',
    'Twitch asked this network for an integrity check a few minutes ago: clips are read by yt-dlp meanwhile.',
  )
}

/** On the air: nothing to download until it ends (and never handed to yt-dlp, which would record it). */
function liveNow(what: string): DownloadError {
  return new DownloadError(
    'unavailable',
    `${what}: live streams are not downloaded, only what is already available (its VOD, once the broadcast ends).`,
    undefined,
    undefined,
    'live-now',
  )
}

/** A clip something can be downloaded of; else why not. O(1). */
function usable(clip: TwitchClip): TwitchClip {
  if (clip.problem) throw clip.problem
  return clip
}

/** A bounded cache entry: re-inserted as the newest, the oldest dropped past `limit`. O(1). */
function bounded<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) map.delete(map.keys().next().value!)
}
