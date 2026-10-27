import type {ExtractResult} from '../../core/analyze.js'
import type {MediaTags} from '../../core/convert.js'
import type {DownloadedInfo} from '../../core/download.js'
import {cancelledError, DownloadError} from '../../core/errors.js'
import {genericChoices} from '../../core/formats.js'
import {
  chooseVariant,
  DEFAULT_MAX_RECORDING,
  downloadHls,
  HlsError,
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  type HlsRecordEvent,
  type HlsSegment,
  type HlsVariant,
  type ParseOptions,
  parsePlaylist,
  pathOf,
  type RefreshLive,
  type RefreshPlaylist,
  recordHls,
  variantChoices,
} from '../../core/hls/index.js'
import type {AnalysisResult, MediaSummary, PlaylistAnalysis, VideoAnalysis} from '../../types.js'
import {Coalescer} from '../coalesce.js'
import {type Fetch, HttpSession} from '../http.js'
import {SESSION_REFUSED_MS} from '../meta/client.js'
import {downloadPost} from '../meta/download.js'
import {MetaError, toDownloadError} from '../meta/errors.js'
import {walkCursor} from '../meta/listing.js'
import {choicesOf, summaryOf} from '../meta/post.js'
import {dig, text} from '../meta/relay.js'
import {Pacer, type PacerOptions} from '../pacer.js'
import {HostSession, type SessionProvider} from '../session.js'
import {
  type ListingProgress,
  type LivePlayback,
  type MediaSource,
  needsFallback,
  type SourceDownload,
  type SourceFile,
} from '../source.js'
import {
  type ClipsPage,
  readClipAnswer,
  readClipsPage,
  readLive,
  readLiveStream,
  readVideosPage,
  readVodAnswer,
  readVodToken,
  type TwitchClip,
  type TwitchLiveStream,
  type TwitchVod,
  toMetaPost,
  usherProblem,
  type VideosPage,
  type VodToken,
} from './data.js'
import {
  ALIAS_LIMIT,
  AUTH_CLIENT_ID,
  AUTH_COOKIE,
  CLIP_LISTING_LIMIT,
  CLIP_PERIODS,
  type ClipPeriod,
  CODECS_BEST,
  CODECS_COMPAT,
  channelStreamQuery,
  clipQuery,
  clipsPageQuery,
  clipsQuery,
  DEFAULT_CLIENT_ID,
  DEFAULT_ENDPOINTS,
  liveQuery,
  liveUsherUrl,
  TWITCH_ORIGIN,
  type TwitchEndpoints,
  usherUrl,
  VIDEO_SORTS,
  VIDEO_TYPES,
  videosPageQuery,
  vodQuery,
  vodsQuery,
  vodTokenQuery,
} from './endpoints.js'
import {
  clipsUrl,
  isNativeTwitchLink,
  parseTwitchLink,
  type TwitchLink,
  type VideoFilter,
  videosUrl,
  vodUrl,
} from './links.js'

export type TwitchOptions = {
  /**
   * A channel's clips and videos list at most this many unless asked
   * otherwise. Default 500 (Twitch lists 1,000 clips at most).
   */
  readonly maxListItems?: number | undefined
  /**
   * The `Client-ID` sent to Twitch's GraphQL endpoint. Default yt-dlp's
   * (`ue6666qo983tsx6so1t0vnawi233wa`): the web player's own
   * (`kimne78kx3ncx6brgo4mv6wki5h1ko`) reads single clips but gets an
   * integrity check on every listing page after the first (endpoints.ts).
   */
  readonly clientId?: string | undefined
  /**
   * The user's Twitch sign-in: the `auth-token` cookie of .twitch.tv (the engine passes the browser
   * cookies it reads for yt-dlp). Sent as `Authorization: OAuth <auth-token>` only on the single
   * reads that mint a playback token (a clip, a VOD, a live stream): subscriber-only VODs, clips and
   * streams. Listings and batched checks stay anonymous. A token Twitch refuses (401) is dropped
   * and reads go anonymous for 30 minutes (SESSION_REFUSED_MS).
   */
  readonly cookies?: SessionProvider | undefined
  /**
   * The `Client-ID` of signed-in reads. Default the web player's (`kimne78kx3ncx6brgo4mv6wki5h1ko`):
   * twitch.tv mints `auth-token` for it (endpoints.ts, AUTH_CLIENT_ID).
   */
  readonly authClientId?: string | undefined
  /** A clock for tests: the signed-in session's refusal window. */
  readonly now?: (() => number) | undefined
  /** Pace of GraphQL requests. Media downloads aren't paced. */
  readonly pacing?: PacerOptions | undefined
  /** The GraphQL endpoint and the clip fields read (endpoints.ts), overridable without a release. */
  readonly endpoints?: Partial<TwitchEndpoints> | undefined
  /** How a channel on the air is recorded (its link: twitch.tv/<channel>). */
  readonly live?: TwitchLiveOptions | undefined
  readonly fetch?: Fetch | undefined
  readonly log?: ((level: 'info' | 'warn', message: string) => void) | undefined
}

/** Recording a live channel (recorder.md §7: Isaac's defaults). */
export type TwitchLiveOptions = {
  /** Leave Twitch's stitched ads out of the recording (a new period where they were). Default true. */
  readonly skipAds?: boolean | undefined
  /** Cap of a recording, seconds of media or of wall clock. Default 12 h. */
  readonly maxDuration?: number | undefined
  /** 'window' (default): from the oldest segment Twitch still lists; 'now': from the live edge. */
  readonly from?: 'window' | 'now' | undefined
  /** Reloads in a row with nothing new before the channel counts as offline. Default 10. */
  readonly emptyReloads?: number | undefined
  /** A simulated clock for tests (the recorder's waits and elapsed time). */
  readonly now?: (() => number) | undefined
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined
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

/** VODs kept by id (a listing's are checked and downloaded without being read again). ~0.5 KB each. */
const VOD_CACHE_LIMIT = 2000
const VOD_FRESH_MS = 6 * 60 * 60_000
/** A VOD still recording is looked at again this soon: its broadcast may have ended meanwhile. */
const RECORDING_FRESH_MS = 60_000
/** A live read (the stream, its token, its masters) feeds the recording that follows it this long. */
const LIVE_FRESH_MS = 60_000
const LIVE_CACHE_LIMIT = 20
/** Twitch's class for the ads it stitches into a live stream (EXT-X-DATERANGE). */
const STITCHED_AD = 'twitch-stitched-ad'
/** Playback tokens (and the master playlists they signed) kept by VOD id; a master is ~1 KB. */
const PLAYBACK_CACHE_LIMIT = 100
/** What an `auth-token` looks like (30 alphanumerics today): anything else is never put in a header. */
const AUTH_TOKEN = /^[A-Za-z0-9_-]{1,200}$/
/**
 * Twitch's muted parts: a part listed `-unmuted` answers 403, the same part as
 * `-muted` 200 (Twitch lists `<n>-muted.ts` itself today, checked live
 * 2026-10-27; yt-dlp rewrites the same way). O(1) per segment, while parsing.
 */
const UNMUTED = /-unmuted(\.[A-Za-z0-9]+)(?=[?#]|$)/
const PARSE: ParseOptions = {mapSegmentUri: uri => uri.replace(UNMUTED, '-muted$1')}
const AUDIO_CODEC = /^mp4a/i
const AVC = /^avc[13]/i
const HEVC = /^(?:hvc1|hev1)/i
const AV1 = /^av01/i
const VIDEO_LABELS: Readonly<Record<VideoFilter, string>> = {
  all: 'videos',
  archives: 'past broadcasts',
  highlights: 'highlights',
  uploads: 'uploads',
  past_premieres: 'past premieres',
}

type ClipLink = Extract<TwitchLink, {kind: 'clip'}>
type ClipsLink = Extract<TwitchLink, {kind: 'clips'}>
type VodLink = Extract<TwitchLink, {kind: 'vod'}>
type VideosLink = Extract<TwitchLink, {kind: 'videos'}>
/** A channel: checked for a broadcast on the air, which is never downloaded. */
type ChannelLink = Extract<TwitchLink, {kind: 'channel'}>
type Timed<T> = {readonly value: T; readonly until: number}
type KeptListing = {
  readonly clips: TwitchClip[]
  readonly channel: ClipsPage['channel']
  readonly cursor: string | undefined
  readonly complete: boolean
  readonly at: number
}
type KeptVideos = {
  readonly vods: TwitchVod[]
  readonly channel: VideosPage['channel']
  readonly cursor: string | undefined
  readonly complete: boolean
  readonly total: number | undefined
  readonly at: number
}
/**
 * A VOD's token, the master playlists usher gave for it by `supported_codecs`, and whether a
 * signed-in read minted it (a refusal then is the account's, not a missing sign-in).
 */
type Playback = {
  readonly token: VodToken
  readonly masters: Map<string, HlsMasterPlaylist>
  readonly signed: boolean
}
/** A read that mints a playback token, and whether it went signed in. */
type Signed<T> = {readonly value: T; readonly signed: boolean}
/** A channel on the air: its stream, the token that signs its usher request, the masters it gave. */
type Live = {
  readonly stream: TwitchLiveStream
  readonly token: VodToken
  readonly masters: Map<string, HlsMasterPlaylist>
}

/**
 * Twitch clips, natively: a clip is one plain GraphQL query on
 * gql.twitch.tv (its encodings and the playback token that signs them, in one
 * answer), the file a signed progressive MP4 on Twitch's CDN, streamed to disk
 * with resume (Range). A channel's clips are its `clips(first: 100)` pages,
 * top by views in the link's period, every clip whole and signed in the page,
 * so a listed clip is never read again. Checks of clips not read yet go 15 a
 * request (aliases).
 *
 * VODs (archives, highlights, uploads) are HLS, downloaded by core/hls: one
 * query for the VOD and its playback token, one usher request for the master
 * playlist, the variant `chooseVariant` ranks for the profile (usher asked
 * for H.264 only for an mp4 profile), then its segments; a refused segment
 * re-signs through a fresh token. A channel's videos are `videos(first: 100)`
 * pages; a listed VOD is checked without another query and downloaded with
 * its token alone. A VOD still recording, like a channel on the air, is
 * `live-now` and never handed to yt-dlp (which would record the stream).
 * Anything else that stops looking as expected, or an integrity check, hands
 * the url to yt-dlp, whose Twitch extractor reads clips and VODs too.
 *
 * Signed in (`cookies`: the `auth-token` of .twitch.tv), the reads that mint
 * a playback token (a clip, a VOD, a live stream) carry `Authorization: OAuth`
 * on the web player's client id, so subscriber-only media plays; listings and
 * batched checks stay anonymous on yt-dlp's id. A refused token (401) costs
 * one anonymous retry and 30 minutes of anonymous reads, never one per link.
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
  /** id → VOD (insertion order = age). */
  readonly #vods = new Map<string, Timed<TwitchVod>>()
  /** id → its playback token and masters, until the token runs out. */
  readonly #playbacks = new Map<string, Timed<Playback>>()
  /** `<login>/videos/<filter>/<sort>` → what its listing gave. */
  readonly #videoListings = new Map<string, KeptVideos>()
  readonly #vodReading = new Coalescer<string, TwitchVod>()
  readonly #tokenReading = new Coalescer<string, Playback>()
  /** login → its last live read, for the recording right after an analysis. */
  readonly #lives = new Map<string, Timed<Live>>()
  readonly #liveOptions: TwitchLiveOptions
  #blockedUntil = 0
  readonly #authClientId: string
  /** Holds the host's Twitch cookies (never sent as cookies: only auth-token is read, into a header). */
  readonly #jar: HttpSession
  readonly #host: HostSession
  readonly #now: () => number
  /** While in the future, Twitch refused the signed-in session lately: every read goes anonymous. */
  #sessionRefusedUntil = 0

  constructor(options: TwitchOptions = {}) {
    this.#endpoints = {...DEFAULT_ENDPOINTS, ...options.endpoints}
    this.#clientId = options.clientId ?? DEFAULT_CLIENT_ID
    this.#authClientId = options.authClientId ?? AUTH_CLIENT_ID
    this.#session = new HttpSession({fetch: options.fetch})
    this.#pacer = new Pacer(options.pacing ?? DEFAULT_PACING, 'Twitch')
    this.#maxListItems = Math.max(1, Math.floor(options.maxListItems ?? TWITCH_LIST_DEFAULT_ITEMS))
    this.#log = options.log ?? (() => {})
    this.#liveOptions = options.live ?? {}
    this.#now = options.now ?? Date.now
    this.#jar = new HttpSession()
    this.#host = new HostSession({
      site: this.name,
      provider: options.cookies,
      session: this.#jar,
      log: this.#log,
      now: this.#now,
    })
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
   * Clips, VODs and both listings (read), channels (checked: on the air they
   * fail as live-now, never handed to yt-dlp; offline there is nothing to get).
   */
  handles(url: string): boolean {
    return isNativeTwitchLink(parseTwitchLink(url))
  }

  defaultListSize(url: string): number | undefined {
    const kind = parseTwitchLink(url)?.kind
    return kind === 'clips' || kind === 'videos' ? this.#maxListItems : undefined
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
      if (link.kind === 'clips') return await this.#listing(link, opts.maxEntries, opts.signal, opts.onProgress)
      if (link.kind === 'videos') {
        return await this.#videoListing(link, opts.maxEntries, opts.known, opts.signal, opts.onProgress)
      }
      if (link.kind === 'vod') return await this.#vodAnalysis(link, opts.signal)
      if (link.kind === 'channel') return await this.#liveAnalysis(link, opts.signal)
      return this.#videoAnalysis(usable(await this.#clip(link, opts.signal)))
    } catch (error) {
      throw this.#toDownloadError(error, opts.signal)
    }
  }

  /**
   * Each url's clip or VOD: from what a listing or an analysis read, else 15
   * a request (aliases of `clip`, of `video`; usher is not asked). O(n) work,
   * ⌈n / 15⌉ requests for n clips or VODs not read yet; channels one each.
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
    /** VOD id → the urls asking for it. */
    const vods = new Map<string, string[]>()
    /** Channels: one status request each (rare in a batch), through the pacer. */
    const onAir: Array<Promise<void>> = []
    // a clip forbidden to a visitor passes its check when the user is signed in: its download reads
    // it signed (the session is loaded once, only when such a clip comes up)
    let session: Promise<boolean> | undefined
    const forbiddenOk = async (clip: TwitchClip): Promise<boolean> => {
      if (!isForbidden(clip.problem)) return false
      session ??= this.#authToken().then(token => token !== undefined)
      return session
    }
    for (const {url} of items) {
      try {
        const native = this.#link(url)
        if (native.kind === 'channel') {
          onAir.push(this.#onAir(native, opts.signal).catch(error => fail(url, error)))
          continue
        }
        if (native.kind === 'vod') {
          const cached = this.#cachedVod(native.id)
          if (cached) settle(url, this.#vodCheck(cached))
          else {
            const urls = vods.get(native.id)
            if (urls) urls.push(url)
            else vods.set(native.id, [url])
          }
          continue
        }
        const link = this.#clipLink(url)
        const cached = this.#cached(link.slug)
        if (cached) {
          settle(url, this.#check(cached, await forbiddenOk(cached)))
          continue
        }
        const urls = wanted.get(link.slug)
        if (urls) urls.push(url)
        else wanted.set(link.slug, [url])
      } catch (error) {
        fail(url, error)
      }
    }
    await Promise.all([...onAir, this.#checkVods(vods, settle, fail, opts.signal)])
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
          for (const [i, slug] of chunk.entries()) {
            const answer = answers[i]!
            if (!(answer instanceof MetaError)) this.#remember(answer)
            const signedOk = !(answer instanceof MetaError) && (await forbiddenOk(answer))
            for (const url of wanted.get(slug) ?? []) {
              if (answer instanceof MetaError) fail(url, answer)
              else settle(url, this.#check(answer, signedOk))
            }
          }
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
        // a VOD's segments re-sign themselves (core/hls refresh) and resume: no second attempt here
        if (native.kind === 'vod') return await this.#downloadVod(native, task)
        // a channel on the air is recorded (never handed to yt-dlp); offline it has nothing to get
        if (native.kind === 'channel') return await this.#recordLive(native, task)
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
          !link ||
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

  #link(url: string): TwitchLink {
    const link = parseTwitchLink(url)
    if (!link || !isNativeTwitchLink(link)) {
      throw new DownloadError(
        'invalid-request',
        'Not a Twitch clip, clips page, video, videos page or channel url.',
        undefined,
        undefined,
        'unsupported-url',
      )
    }
    return link
  }

  #clipLink(url: string): ClipLink {
    const link = this.#link(url)
    if (link.kind === 'clips' || link.kind === 'videos') {
      throw new DownloadError(
        'invalid-request',
        `A channel’s ${link.kind} are a list: each ${link.kind === 'clips' ? 'clip' : 'video'} is its own item.`,
      )
    }
    if (link.kind !== 'clip') throw new DownloadError('invalid-request', 'Not a Twitch clip url.')
    return link
  }

  /** While Twitch gates this network, clip reads go to yt-dlp without asking (source:blocked). O(1). */
  #notBlocked(): void {
    if (Date.now() < this.#blockedUntil) throw blocked()
  }

  // ─── sign-in ─────────────────────────────────────────────────────────────

  /**
   * The user's `auth-token`, when the host has a Twitch session and Twitch has not refused it
   * lately. The host's cookies are read once and again every 6 h (HostSession). O(1) after that.
   */
  async #authToken(): Promise<string | undefined> {
    if (this.#now() < this.#sessionRefusedUntil) return undefined
    await this.#host.load()
    const token = this.#jar.cookie('www.twitch.tv', AUTH_COOKIE)
    return token !== undefined && AUTH_TOKEN.test(token) ? token : undefined
  }

  /**
   * A read that mints a playback token (a clip, a VOD, a live stream): signed in when the user is
   * (`Authorization: OAuth`, on the web player's client id), else anonymous as before. Twitch
   * refusing the session (401: the token is invalid or revoked; or an integrity check) → the same
   * read once more anonymously, and every read anonymous for SESSION_REFUSED_MS: one extra
   * request per window, never per link. O(1) on top of the read.
   */
  async #tokenGql<T>(
    query: string,
    variables: Record<string, unknown>,
    read: (body: unknown) => T,
    signal: AbortSignal | undefined,
  ): Promise<Signed<T>> {
    const auth = await this.#authToken()
    if (auth !== undefined) {
      try {
        return {value: await this.#gql(query, variables, read, signal, auth), signed: true}
      } catch (error) {
        if (signal?.aborted || !(error instanceof MetaError)) throw error
        if (error.status !== 401 && error.problem !== 'challenge') throw error
        this.#refuseSession(error)
      }
    }
    return {value: await this.#gql(query, variables, read, signal), signed: false}
  }

  /**
   * Twitch refused the signed-in session: its cookies are dropped, asked for again once
   * SESSION_REFUSED_MS is up, and the user is told once (reads in flight that were refused too
   * add nothing). O(1).
   */
  #refuseSession(refusal: MetaError): void {
    const now = this.#now()
    if (now < this.#sessionRefusedUntil) return
    this.#sessionRefusedUntil = now + SESSION_REFUSED_MS
    this.#host.forget()
    this.#jar.reset()
    this.#log(
      'warn',
      `Twitch: the signed-in session was refused (${refusal.message}); reading anonymously for ` +
        `${SESSION_REFUSED_MS / 60_000} min — sign in to twitch.tv again in the browser if it goes on`,
    )
  }

  /**
   * A live channel's signed master playlist for a host's player (MediaDownloader.livePlayback):
   * H.264 variants (what a browser's MSE plays), built and never fetched. The stream and its token
   * come from the read an analysis or a recording made within a minute, else one GraphQL query
   * (signed in when the user is); `fresh` reads again (a signature that ran out). Undefined for a
   * link that is not a channel, or a channel off the air. 0 or 1 request, no usher request.
   */
  async livePlayback(
    url: string,
    opts: {readonly signal?: AbortSignal | undefined; readonly fresh?: boolean | undefined} = {},
  ): Promise<LivePlayback | undefined> {
    const link = parseTwitchLink(url)
    if (link?.kind !== 'channel') return undefined
    try {
      const live = await this.#live(link.channel, opts.signal, opts.fresh ?? false)
      if (!live) return undefined
      const p = Math.floor(Math.random() * 10_000_000)
      return {
        url: liveUsherUrl(this.#endpoints.usher, live.stream.login, live.token, CODECS_COMPAT, p),
        expiresAt: live.token.expiresAt,
        media: liveSummary(live.stream, this.name),
      }
    } catch (error) {
      throw this.#toDownloadError(error, opts.signal)
    }
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
   * A channel in a batch's checks: on the air it is `live-now` (a recording
   * is its own job, from the channel link; a batch never records), offline
   * it has nothing to download. One GraphQL request.
   */
  async #onAir(link: ChannelLink, signal?: AbortSignal): Promise<never> {
    const stream = await this.liveStream(link.channel, signal)
    if (stream) {
      throw liveNow(
        `${stream.login} is live on Twitch right now: a live stream is recorded from its channel link on its own, not in a list`,
      )
    }
    throw offline(link)
  }

  // ─── live channels ───────────────────────────────────────────────────────

  /**
   * A channel's stream and its usher token: from the read an analysis just
   * made (a minute), else one GraphQL query for both. Offline: undefined.
   */
  async #live(login: string, signal: AbortSignal | undefined, fresh: boolean): Promise<Live | undefined> {
    const kept = this.#lives.get(login)
    if (!fresh && kept && Date.now() < kept.until) return kept.value
    const {value, signed} = await this.#tokenGql(liveQuery(), {login: login.toLowerCase()}, readLive, signal)
    const {stream, token} = value
    if (!stream) {
      this.#lives.delete(login)
      return undefined
    }
    if (token instanceof MetaError) throw signed && isForbidden(token) ? membersOnly('live stream') : token
    const live: Live = {stream, token, masters: new Map()}
    bounded(this.#lives, login, {value: live, until: Date.now() + LIVE_FRESH_MS}, LIVE_CACHE_LIMIT)
    return live
  }

  /** The stream's master for `codecs`: kept, else one usher request (not paced). Offline (404): undefined. */
  async #liveMaster(
    live: Live,
    codecs: string,
    signal: AbortSignal | undefined,
  ): Promise<HlsMasterPlaylist | undefined> {
    const kept = live.masters.get(codecs)
    if (kept) return kept
    const p = Math.floor(Math.random() * 10_000_000)
    const url = liveUsherUrl(this.#endpoints.usher, live.stream.login, live.token, codecs, p)
    const response = await this.#session.get(url, {
      signal,
      headers: {Origin: TWITCH_ORIGIN, Referer: `${TWITCH_ORIGIN}/`},
    })
    const status = response.status
    if (status === 404) {
      // usher has no transcode for a channel that just went offline
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    if (status === 429 || status >= 500) {
      await response.body?.cancel().catch(() => {})
      throw new MetaError('refused', `Twitch: usher answered HTTP ${status}.`, status)
    }
    if (!response.ok) throw usherProblem(await response.json().catch(() => undefined), status)
    const master = parsePlaylist(await response.text(), response.url || url)
    if (master.kind !== 'master') {
      throw new MetaError('format-changed', 'Twitch: usher answered a media playlist where a master was expected.')
    }
    const variants = master.variants.filter(v => v.codecs.length === 0 || v.codecs.some(c => AUDIO_CODEC.test(c)))
    const usable: HlsMasterPlaylist = {...master, variants}
    live.masters.set(codecs, usable)
    return usable
  }

  /**
   * A channel link: on the air, the stream as one item to record (its
   * qualities from usher's master: 1 query + 1 usher request, kept a minute
   * for the recording); offline, nothing to download.
   */
  async #liveAnalysis(link: ChannelLink, signal?: AbortSignal): Promise<VideoAnalysis> {
    const live = await this.#live(link.channel, signal, false)
    const master = live && (await this.#liveMaster(live, CODECS_BEST, signal))
    if (!live || !master) throw offline(link)
    return {kind: 'video', media: liveSummary(live.stream, this.name), choices: variantChoices(master, undefined)}
  }

  /**
   * Record a channel on the air through core/hls (recordHls): the variant
   * for the profile from usher's channel master, from the oldest segment the
   * window holds, Twitch's stitched ads left out (skipAds), until the user
   * stops it (kept), the broadcast ends, or 12 h. A refused playlist re-signs
   * through a fresh token (1 query + 1 usher request); a stream that ended or
   * restarted under another id ends the recording. Never handed to yt-dlp,
   * whatever fails. Before the first segment: 1 query and 1 usher request (0
   * of each right after an analysis), then 1 request per reload and per segment.
   */
  async #recordLive(link: ChannelLink, task: SourceDownload): Promise<SourceFile> {
    try {
      const profile = task.profile
      const codecs = profile.kind === 'video' && profile.container === 'mp4' ? CODECS_COMPAT : CODECS_BEST
      const live = await this.#live(link.channel, task.signal, task.fresh)
      const master = live && (await this.#liveMaster(live, codecs, task.signal))
      if (!live || !master) throw offline(link)
      const {stream} = live
      const variant = chooseVariant(master, profile).variant
      const startedAt = Date.now()
      const title = liveTitle(stream, startedAt)
      const info: DownloadedInfo = {
        id: liveMediaId(stream, startedAt),
        title,
        extractor: this.name,
        duration: null,
        publishedAt: stream.startedAt ?? Math.floor(startedAt / 1000),
      }
      task.onInfo(info)
      const refreshUrl: RefreshLive = async (_why, signal) => {
        const next = await this.#live(link.channel, signal, true)
        // offline, or a new broadcast: this recording is over
        if (!next || next.stream.id !== stream.id) return undefined
        const fresh = await this.#liveMaster(next, codecs, signal)
        if (!fresh) return undefined
        const same = sameVariant(fresh, variant)
        if (!same) {
          throw new HlsError('changed', 'Twitch: the re-signed master no longer has the quality being recorded.')
        }
        return same.uri
      }
      const options = this.#liveOptions
      const result = await recordHls({
        session: this.#session,
        site: this.name,
        headers: {Origin: TWITCH_ORIGIN, Referer: `${TWITCH_ORIGIN}/`},
        playlist: variant.uri,
        kind: profile.kind,
        codecs: variant.codecs,
        workDir: task.workDir,
        ffmpeg: task.ffmpeg,
        signal: task.signal,
        stop: task.stop,
        from: options.from ?? 'window',
        maxDuration: options.maxDuration ?? DEFAULT_MAX_RECORDING,
        refreshUrl,
        skip: (options.skipAds ?? true) ? isTwitchAd : undefined,
        emptyReloads: options.emptyReloads,
        onProgress: task.onProgress,
        onEvent: event => this.#liveEvent(stream.login, event),
        now: options.now,
        sleep: options.sleep,
      })
      this.#log(
        'info',
        `Twitch: recorded ${stream.login} for ${Math.round(result.duration)} s (${result.ended}); ` +
          `${Math.round(result.skippedSeconds)} s of ads left out, ${result.gaps} gap(s), ${result.refreshes} refresh(es)`,
      )
      return {
        filepath: result.filepath,
        info: {
          ...info,
          duration: result.duration,
          vcodec: profile.kind === 'audio' ? 'none' : videoCodecOf(variant.codecs),
          acodec: 'mp4a',
          filesize: result.bytes,
        },
        tags: {
          title,
          artist: stream.channelName ?? stream.login,
          date: new Date(startedAt).toISOString().slice(0, 10),
          comment: `${TWITCH_ORIGIN}/${stream.login}`,
        },
        recording: {
          ended: result.ended,
          seconds: result.duration,
          segments: result.segments,
          gaps: result.gaps,
          lostSegments: result.lostSegments,
          skippedSeconds: result.skippedSeconds,
          refreshes: result.refreshes,
        },
      }
    } catch (error) {
      this.#lives.delete(link.channel)
      const failure = this.#toDownloadError(error, task.signal)
      // a live stream is never handed to yt-dlp (it would record it): the source's own reason stands
      if (!needsFallback(failure.details)) throw failure
      throw new DownloadError(failure.code, failure.message, undefined, failure.params, failure.hint)
    }
  }

  /** The recorder's notable events, into the source's log. O(1). */
  #liveEvent(login: string, event: HlsRecordEvent): void {
    if (event.type === 'gap') this.#log('warn', `Twitch: ${login}: ${event.segments} segment(s) lost (a gap)`)
    else if (event.type === 'segment-lost')
      this.#log('warn', `Twitch: ${login}: segment ${event.sequence} lost (${event.code})`)
    else if (event.type === 'reload-failed')
      this.#log('warn', `Twitch: ${login}: playlist reload failed (${event.message})`)
    else if (event.type === 'refreshed') this.#log('info', `Twitch: ${login}: playlist re-signed (${event.status})`)
    else if (event.type === 'rebased') this.#log('info', `Twitch: ${login}: numbering restarted, re-anchored by date`)
  }

  // ─── VODs ────────────────────────────────────────────────────────────────

  /** A VOD read or listed lately. O(1). */
  #cachedVod(id: string): TwitchVod | undefined {
    const kept = this.#vods.get(id)
    return kept && Date.now() < kept.until ? kept.value : undefined
  }

  /** Keep a VOD 6 h (a minute while it is still recording). O(1); the oldest dropped past the bound. */
  #rememberVod(vod: TwitchVod): void {
    const until = Date.now() + (vod.recording ? RECORDING_FRESH_MS : VOD_FRESH_MS)
    bounded(this.#vods, vod.id, {value: vod, until}, VOD_CACHE_LIMIT)
  }

  /**
   * One VOD: from memory, else one query that brings its playback token
   * too (kept for the usher request that follows). Shared by callers at the
   * same time. A token Twitch refuses (subscribers only) is that error.
   */
  async #vod(id: string, signal?: AbortSignal): Promise<TwitchVod> {
    const cached = this.#cachedVod(id)
    if (cached) return cached
    return this.#vodReading.run(id, signal, async shared => {
      const {value, signed} = await this.#tokenGql(
        vodQuery(this.#endpoints.videoFields),
        {id},
        body => ({vod: readVodAnswer(body), token: readVodToken(body)}),
        shared,
      )
      const {vod, token} = value
      if (vod instanceof MetaError) throw vod
      this.#rememberVod(vod)
      if (!vod.recording) {
        if (token instanceof MetaError) throw signed && isForbidden(token) ? membersOnly('video') : token
        this.#keepPlayback(id, token, signed)
      }
      return vod
    })
  }

  /** A playback token and its masters, kept until the token runs out (6 h at most). O(1). */
  #keepPlayback(id: string, token: VodToken, signed: boolean): Playback {
    const playback: Playback = {token, masters: new Map(), signed}
    const until = Math.min(Date.now() + VOD_FRESH_MS, token.expiresAt ?? Number.POSITIVE_INFINITY)
    bounded(this.#playbacks, id, {value: playback, until}, PLAYBACK_CACHE_LIMIT)
    return playback
  }

  /** The VOD's token: from memory, else its own query (one request). */
  async #token(id: string, signal: AbortSignal | undefined, fresh: boolean): Promise<Playback> {
    const kept = this.#playbacks.get(id)
    if (!fresh && kept && Date.now() < kept.until) return kept.value
    return this.#tokenReading.run(id, signal, async shared => {
      const {value: token, signed} = await this.#tokenGql(vodTokenQuery(), {id}, readVodToken, shared)
      if (token instanceof MetaError) throw signed && isForbidden(token) ? membersOnly('video') : token
      return this.#keepPlayback(id, token, signed)
    })
  }

  /**
   * The VOD's master playlist for `codecs`: from memory (an H.264 variant of
   * the one asked for every codec does for an mp4 profile), else one usher
   * request with its token. A kept token usher no longer takes is replaced
   * once. Variants without sound (a 2016 highlight's "high") are left out.
   */
  async #master(
    vod: TwitchVod,
    codecs: string,
    signal: AbortSignal | undefined,
    fresh = false,
  ): Promise<HlsMasterPlaylist> {
    const playback = await this.#token(vod.id, signal, fresh)
    const best = playback.masters.get(CODECS_BEST)
    const kept =
      playback.masters.get(codecs) ??
      (codecs === CODECS_COMPAT && best?.variants.some(v => v.codecs.some(c => AVC.test(c))) ? best : undefined)
    if (kept) return kept
    try {
      const master = await this.#usher(vod.id, playback.token, codecs, signal)
      playback.masters.set(codecs, master)
      return master
    } catch (error) {
      if (!(error instanceof MetaError)) throw error
      if (isForbidden(error)) {
        // subscribers only: the signed-in account has no access; a visitor's token is signed once more
        // when the user has a session now (a VOD listed or read before signing in)
        if (playback.signed) throw membersOnly('video')
        if (fresh || (await this.#authToken()) === undefined) throw error
        return this.#master(vod, codecs, signal, true)
      }
      if (fresh || error.status !== 403 || error.problem !== 'format-changed') throw error
      return this.#master(vod, codecs, signal, true)
    }
  }

  /** One usher request: the master playlist, or why not. Not paced (another host than GraphQL). */
  async #usher(id: string, token: VodToken, codecs: string, signal?: AbortSignal): Promise<HlsMasterPlaylist> {
    const url = usherUrl(this.#endpoints.usher, id, token, codecs, Math.floor(Math.random() * 10_000_000))
    const response = await this.#session.get(url, {
      signal,
      headers: {Origin: TWITCH_ORIGIN, Referer: `${TWITCH_ORIGIN}/`},
    })
    const status = response.status
    if (status === 429 || status >= 500) {
      await response.body?.cancel().catch(() => {})
      throw new MetaError('refused', `Twitch: usher answered HTTP ${status}.`, status)
    }
    if (status === 404) {
      await response.body?.cancel().catch(() => {})
      throw new MetaError('removed', 'Twitch has no playback for this video any more (deleted, or expired).', status)
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined)
      throw usherProblem(body, status)
    }
    const master = parsePlaylist(await response.text(), response.url || url)
    if (master.kind !== 'master') {
      throw new MetaError('format-changed', 'Twitch: usher answered a media playlist where a master was expected.')
    }
    const variants = master.variants.filter(v => v.codecs.length === 0 || v.codecs.some(c => AUDIO_CODEC.test(c)))
    return {...master, variants}
  }

  async #vodAnalysis(link: VodLink, signal?: AbortSignal): Promise<VideoAnalysis> {
    const vod = playable(await this.#vod(link.id, signal))
    const master = await this.#master(vod, CODECS_BEST, signal)
    return {kind: 'video', media: vodSummary(vod, this.name), choices: variantChoices(master, vod.duration)}
  }

  /** A check from what is known of a VOD (a listing's, or a batch's): no token, no usher. O(1). */
  #vodCheck(vod: TwitchVod): ExtractResult {
    if (vod.recording) return {ok: false, error: recordingError(vod).toJSON()}
    return {ok: true, analysis: {kind: 'video', media: vodSummary(vod, this.name), choices: genericChoices()}}
  }

  /** VODs not read yet, 15 a request (aliases of `video`), each chunk through the pacer. ⌈n / 15⌉ requests. */
  async #checkVods(
    wanted: ReadonlyMap<string, readonly string[]>,
    settle: (url: string, result: ExtractResult) => void,
    fail: (url: string, error: unknown) => void,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const ids = [...wanted.keys()]
    const chunks: string[][] = []
    for (let i = 0; i < ids.length; i += ALIAS_LIMIT) chunks.push(ids.slice(i, i + ALIAS_LIMIT))
    await Promise.all(
      chunks.map(async chunk => {
        try {
          const variables: Record<string, string> = {}
          chunk.forEach((id, i) => {
            variables[`v${i}`] = id
          })
          const answers = await this.#gql(
            vodsQuery(this.#endpoints.videoFields, chunk.length),
            variables,
            body => chunk.map((_, i) => readVodAnswer(body, `v${i}`)),
            signal,
          )
          chunk.forEach((id, i) => {
            const answer = answers[i]!
            if (!(answer instanceof MetaError)) this.#rememberVod(answer)
            for (const url of wanted.get(id) ?? []) {
              if (answer instanceof MetaError) fail(url, answer)
              else settle(url, this.#vodCheck(answer))
            }
          })
        } catch (error) {
          for (const id of chunk) for (const url of wanted.get(id) ?? []) fail(url, error)
        }
      }),
    )
  }

  /**
   * A VOD to one file through core/hls: the variant for the profile (usher
   * asked for H.264 only for an mp4 profile, every codec otherwise), its
   * segments k at a time with resume; a refused segment re-signs through a
   * fresh token and the same variant of a new master. Before any segment:
   * 1 GraphQL query (0 when an analysis just read it), 1 usher request
   * (0 likewise), 1 media playlist. A broadcast still on the air is
   * `live-now` (by its status, and by an open playlist if it changed since).
   */
  async #downloadVod(link: VodLink, task: SourceDownload): Promise<SourceFile> {
    try {
      const vod = playable(await this.#vod(link.id, task.signal))
      const profile = task.profile
      const codecs = profile.kind === 'video' && profile.container === 'mp4' ? CODECS_COMPAT : CODECS_BEST
      const master = await this.#master(vod, codecs, task.signal, task.fresh)
      const choice = chooseVariant(master, profile, vod.duration)
      const title = vod.title || `Twitch video ${vod.id}`
      const info: DownloadedInfo = {
        id: vodMediaId(vod.id),
        title,
        extractor: this.name,
        duration: vod.duration ?? null,
        publishedAt: vod.publishedAt ?? null,
      }
      task.onInfo(info)
      const resign =
        (uri: string): RefreshPlaylist =>
        async (_why, signal) => {
          const path = pathOf(uri)
          const next = await this.#master(vod, codecs, signal, true)
          const same =
            next.variants.find(v => pathOf(v.uri) === path)?.uri ??
            [...next.audio.values()].flat().find(t => t.uri !== undefined && pathOf(t.uri) === path)?.uri
          if (!same)
            throw new HlsError('changed', 'Twitch: the re-signed master no longer has the variant being downloaded.')
          return same
        }
      const audioUri = choice.audio?.uri
      const result = await downloadHls({
        session: this.#session,
        site: this.name,
        main: {playlist: choice.variant.uri, refresh: resign(choice.variant.uri)},
        audio: audioUri ? {playlist: audioUri, refresh: resign(audioUri)} : undefined,
        kind: profile.kind,
        codecs: choice.variant.codecs,
        workDir: task.workDir,
        ffmpeg: task.ffmpeg,
        signal: task.signal,
        concurrency: task.fragments,
        parse: PARSE,
        expectedBytes: choice.estimatedBytes,
        fresh: task.fresh,
        onProgress: task.onProgress,
      })
      const tags: MediaTags = {
        title,
        artist: vod.channelName ?? vod.channel,
        date: vod.publishedAt ? new Date(vod.publishedAt * 1000).toISOString().slice(0, 10) : undefined,
        comment: vodUrl(vod.id),
      }
      return {
        filepath: result.filepath,
        info: {
          ...info,
          duration: vod.duration ?? result.duration,
          vcodec: profile.kind === 'audio' ? 'none' : videoCodecOf(choice.variant.codecs),
          acodec: 'mp4a',
          filesize: result.bytes,
        },
        tags,
      }
    } catch (error) {
      // the next attempt signs again (its token may be what broke)
      this.#playbacks.delete(link.id)
      throw this.#toDownloadError(error, task.signal)
    }
  }

  // ─── video listings ──────────────────────────────────────────────────────

  /**
   * A channel's videos (all, or the link's filter), newest first or by views,
   * up to `maxEntries`, one request per 100. Newest first, an incremental
   * walk (`known`) stops where the known ones start. Every listed VOD is kept,
   * so its check reads nothing and its download only its token. A refusal
   * half-way returns what was listed (`complete: false`). O(1) per VOD.
   */
  async #videoListing(
    link: VideosLink,
    maxEntries: number | undefined,
    known: ReadonlySet<string> | undefined,
    signal?: AbortSignal,
    onProgress?: (progress: ListingProgress) => void,
  ): Promise<PlaylistAnalysis> {
    const max = Math.max(1, Math.floor(maxEntries ?? this.#maxListItems))
    const key = `${link.channel}/videos/${link.filter}/${link.sort}`
    // known ids are only a stop where the newest come first
    const incremental = link.sort === 'time' && known && known.size > 0 ? known : undefined
    onProgress?.({listed: 0, expected: max})
    const kept = incremental ? undefined : this.#videoListings.get(key)
    const fresh = kept && Date.now() - kept.at < LISTING_FRESH_MS ? kept : undefined
    let vods: TwitchVod[] = fresh?.vods.slice(0, max) ?? []
    let channel = fresh?.channel
    let cursor = fresh?.cursor
    let complete = fresh?.complete ?? false
    let total = fresh?.total
    let caughtUp = false
    const expected = () => Math.min(max, total ?? max)
    if (!(fresh && (fresh.vods.length >= max || fresh.complete))) {
      const got = new Map<string, TwitchVod>(vods.map(vod => [vod.id, vod]))
      try {
        const listing = await walkCursor(
          async next => {
            const page = await this.#gql(
              videosPageQuery(this.#endpoints.videoFields),
              {
                login: link.channel,
                sort: VIDEO_SORTS[link.sort],
                ...(VIDEO_TYPES[link.filter] !== undefined && {type: VIDEO_TYPES[link.filter]}),
                ...(next !== undefined && {after: next}),
              },
              readVideosPage,
              signal,
            )
            channel = page.channel
            total = page.total ?? total
            for (const vod of page.vods) if (got.size < max && !got.has(vod.id)) got.set(vod.id, vod)
            return {items: page.vods, next: page.next}
          },
          {
            max,
            idOf: vod => vodMediaId(vod.id),
            resume: vods.length > 0 || cursor !== undefined ? {items: vods, cursor} : undefined,
            known: incremental,
            onProgress: listed => onProgress?.({listed, expected: expected()}),
            site: this.name,
          },
        )
        vods = listing.items
        cursor = listing.cursor
        complete = listing.complete
        caughtUp = listing.caughtUp
      } catch (error) {
        vods = [...got.values()]
        complete = false
        if (signal?.aborted || vods.length === 0 || !channel) throw error
        this.#log(
          'warn',
          `Twitch: ${link.channel}'s videos stopped at ${vods.length} of ${expected()} (${String(error)}) — load again to continue`,
        )
      }
      if (channel && !incremental) {
        bounded(this.#videoListings, key, {vods, channel, cursor, complete, total, at: Date.now()}, LISTING_CACHE_LIMIT)
      }
    }
    onProgress?.({listed: vods.length, expected: expected()})
    for (const vod of vods) this.#rememberVod(vod)
    const name = channel?.name ?? link.channel
    return {
      kind: 'playlist',
      id: `${link.channel}/videos/${link.filter}/${link.sort}`,
      url: videosUrl(link.channel, link.filter, link.sort),
      title: `Twitch ${name} · ${VIDEO_LABELS[link.filter]}${link.sort === 'views' ? ', most viewed' : ''}`,
      uploader: name,
      extractor: this.name,
      entries: vods.map((vod, i) => ({...vodSummary(vod, this.name), index: i + 1})),
      choices: genericChoices(),
      total,
      complete,
      ...(caughtUp && {caughtUp}),
    }
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
    /** The user's auth-token: a signed-in read (`#tokenGql`), on the web player's client id. */
    auth?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Client-ID': auth === undefined ? this.#clientId : this.#authClientId,
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: 'application/json',
      Origin: TWITCH_ORIGIN,
      Referer: `${TWITCH_ORIGIN}/`,
    }
    if (auth !== undefined) headers['Authorization'] = `OAuth ${auth}`
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#pacer.run(async () => {
          const response = await this.#session.request(this.#endpoints.gql, {
            method: 'POST',
            body: JSON.stringify({query, variables}),
            headers,
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
        // a verification is not waited out here: yt-dlp takes Twitch urls for a while (a signed-in
        // read's is the session's: it is read again anonymously, see #tokenGql)
        if (error.problem === 'challenge' && auth === undefined) this.#blockedUntil = Date.now() + BLOCKED_MS
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
    // a clip a listing (or a visitor) found forbidden is read once more, signed, when the user is
    if (cached && !(isForbidden(cached.problem) && (await this.#authToken()) !== undefined)) return cached
    this.#notBlocked()
    return this.#reading.run(link.slug, signal, async shared => {
      const {value: answer, signed} = await this.#tokenGql(
        clipQuery(this.#endpoints.clipFields),
        {slug: link.slug},
        readClipAnswer,
        shared,
      )
      if (answer instanceof MetaError) throw answer
      if (signed && isForbidden(answer.problem)) {
        this.#clips.delete(link.slug)
        throw membersOnly('clip')
      }
      this.#remember(answer)
      return answer
    })
  }

  /** Keep a clip until its token runs out (6 h at most). O(1); the oldest dropped past the bound. */
  #remember(clip: TwitchClip): void {
    const until = Math.min(Date.now() + CLIP_FRESH_MS, clip.expiresAt ?? Number.POSITIVE_INFINITY)
    bounded(this.#clips, clip.slug, {value: clip, until}, CLIP_CACHE_LIMIT)
  }

  /** A clip's check; `signedIn` lets a clip forbidden to a visitor through (its download reads it signed). */
  #check(clip: TwitchClip, signedIn = false): ExtractResult {
    if (clip.problem && !(signedIn && isForbidden(clip.problem))) {
      return {ok: false, error: this.#toDownloadError(clip.problem).toJSON()}
    }
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

/** A token Twitch keeps for some viewers (subscribers): `authorization.forbidden`, or usher's restriction. O(1). */
function isForbidden(problem: MetaError | undefined): boolean {
  return problem?.problem === 'login-required'
}

/** Forbidden to the signed-in account itself: no sign-in changes that (hint members-only). */
function membersOnly(what: 'clip' | 'video' | 'live stream'): DownloadError {
  return new DownloadError(
    'unavailable',
    `Twitch keeps this ${what} for some viewers only (subscribers): the signed-in Twitch account has no access to it.`,
    undefined,
    undefined,
    'members-only',
  )
}

/** On the air, where nothing is recorded (a VOD still recording, a batch's check); never handed to yt-dlp. */
function liveNow(what: string): DownloadError {
  return new DownloadError('unavailable', `${what}.`, undefined, undefined, 'live-now')
}

/** A VOD whose broadcast is still on the air: live-now, never handed to yt-dlp; its channel link records it. */
function recordingError(vod: TwitchVod): DownloadError {
  return liveNow(
    `This Twitch broadcast${vod.channel ? ` of ${vod.channel}` : ''} is still on the air: its VOD can be downloaded once it ends` +
      (vod.channel ? `, and the broadcast is recorded from its channel link (${TWITCH_ORIGIN}/${vod.channel})` : ''),
  )
}

/** A channel that is not on the air: nothing to record, and a channel page has nothing else. */
function offline(link: ChannelLink): DownloadError {
  return new DownloadError(
    'unavailable',
    `${link.channel} is not live: a channel page has nothing else to download (its broadcasts are at /${link.channel}/videos, its clips at /${link.channel}/clips).`,
  )
}

/**
 * A segment Twitch stitched in as an ad: titled other than "live" (Twitch titles ads "Amazon|…"), or
 * dated inside an EXT-X-DATERANGE of CLASS twitch-stitched-ad. O(1) for the title, O(r) for the few
 * date ranges a window lists.
 */
export function isTwitchAd(segment: HlsSegment, playlist: HlsMediaPlaylist): boolean {
  if (segment.title !== undefined && segment.title !== 'live') return true
  const date = segment.programDateTime
  if (date === undefined) return false
  for (const range of playlist.dateRanges) {
    if (range.class !== STITCHED_AD && !range.id.startsWith('stitched-ad')) continue
    const seconds = range.duration ?? range.plannedDuration
    const end = range.endDate ?? (seconds !== undefined ? range.startDate + seconds * 1000 : undefined)
    if (end !== undefined && date >= range.startDate && date < end) return true
  }
  return false
}

/** The same quality in a re-signed master: by its name ("1080p60 (source)"), else size, rate and codec. O(v). */
function sameVariant(master: HlsMasterPlaylist, variant: HlsVariant): HlsVariant | undefined {
  if (variant.name) {
    const named = master.variants.find(v => v.name === variant.name)
    if (named) return named
  }
  const family = (codecs: readonly string[]) => (codecs[0] ?? '').split('.')[0]
  return master.variants.find(
    v =>
      v.height === variant.height && v.frameRate === variant.frameRate && family(v.codecs) === family(variant.codecs),
  )
}

/** "2026-10-27 18-05", local time: a file name's start time (no colons). */
function stamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}`
}

/** A recording's title (and file name): `<channel> <started-at> <title>`, the broadcast's start. */
export function liveTitle(stream: TwitchLiveStream, recordingStart: number): string {
  const start = stream.startedAt !== undefined ? stream.startedAt * 1000 : recordingStart
  return `${stream.channelName ?? stream.login} ${stamp(start)} ${stream.title || 'live'}`
}

/**
 * A recording's archive id: the broadcast and when this recording began, so recording the same
 * broadcast again later makes a new file instead of "already archived".
 */
export function liveMediaId(stream: TwitchLiveStream, recordingStart: number): string {
  return `live-${stream.id}-${Math.floor(recordingStart / 1000)}`
}

function liveSummary(stream: TwitchLiveStream, site: string): MediaSummary {
  return {
    id: `live-${stream.id}`,
    url: `${TWITCH_ORIGIN}/${stream.login}`,
    title: liveTitle(stream, Date.now()),
    uploader: stream.channelName ?? stream.login,
    publishedAt: stream.startedAt,
    extractor: site,
    isLive: true,
  }
}

/** A VOD that can be downloaded now; else live-now. O(1). */
function playable(vod: TwitchVod): TwitchVod {
  if (vod.recording) throw recordingError(vod)
  return vod
}

/** The id a VOD is recorded under: `v<id>`, as yt-dlp's Twitch extractor names it (download archives). */
export function vodMediaId(id: string): string {
  return `v${id}`
}

function vodSummary(vod: TwitchVod, site: string): MediaSummary {
  return {
    id: vodMediaId(vod.id),
    url: vodUrl(vod.id),
    title: vod.title || `Twitch video ${vod.id}`,
    uploader: vod.channelName ?? vod.channel,
    duration: vod.duration,
    thumbnail: vod.thumbnail,
    publishedAt: vod.publishedAt,
    extractor: site,
    isLive: vod.recording,
  }
}

/** The engine's vcodec of a variant's CODECS. O(c). */
function videoCodecOf(codecs: readonly string[]): string {
  for (const codec of codecs) {
    if (AVC.test(codec)) return 'avc1'
    if (HEVC.test(codec)) return 'hvc1'
    if (AV1.test(codec)) return 'av01'
  }
  return 'avc1'
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
