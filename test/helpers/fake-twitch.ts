// A local stand-in for Twitch's GraphQL endpoint and its clip CDN, with the
// shapes the real ones served (verified live 2026-10-26, trimmed to what is
// read; samples in .local/twitch/): `POST /gql` with a plain query and its
// variables (a missing Client-ID is a 400, as on the real one), `clip(slug)`
// with its H.264 `videoQualities`, its landscape and portrait assets and its
// `playbackAccessToken` (a JSON value naming the HEVC 1440p file, `expires`
// ~20 h ahead, `authorization.forbidden`), aliased batches c0…c14 (more than
// 15 root fields is an error), `user(login).clips(first: 100, after, criteria)`
// with the cursor on the last edge only (base64 of the offset), `hasNextPage`
// false at offset 1000, and every page after the first an
// `IntegrityCheckFailed` for the web player's client id; `clip: null` and
// `user: null` for what is not there; GraphQL errors for a field Twitch
// renamed. The CDN serves a signed file only (401 unsigned or with another
// signature) and answers Range with 206.
//
// VODs (verified live 2026-10-27): `video(id)` + `videoPlaybackAccessToken(id)`
// in one query (`video: null`, no token, for one that is gone), the token
// alone, aliased batches v0…v14 of `video`, and
// `user(login).videos(first: 100, after, type, sort)` with `totalCount` and
// one cursor `"<id>|<offset>|<publishedAt>|<n>"` on every edge of a page,
// null on the last. Usher (`GET /vod/<id>.m3u8?…&sig&token`) checks the
// token's signature (403 `nauth_sig_invalid` JSON otherwise) and answers a
// master playlist whose variants live on a fake HLS origin
// (test/helpers/fake-hls.ts): a `chunked` source, a video-only "high", 720p60
// and audio_only.
//
// Live channels (the recorder): `user(login).stream` and
// `streamPlaybackAccessToken(channelName)` in one query (`LiveStream`), and
// usher's `GET /api/channel/hls/<login>.m3u8?…&sig&token` (the token's
// signature checked; 404 once the channel is offline, as usher answers a
// channel with no transcode) giving a master whose variants are sliding
// windows on the fake live origin (startFakeLive), minted anew per master.
//
// Signed-in reads (as yt-dlp and streamlink describe them; not checked live:
// no account): `Authorization: OAuth <auth-token>` on the web player's
// client id. `OAuth fake-ok` is a subscriber (the locked VOD and the forbidden
// clip get allowed tokens, usher serves the subscriber-only VOD to its token),
// `OAuth fake-nosub` an account without access (tokens stay forbidden); any
// other token, or a token on another client id, is a 401 for the whole query,
// as Twitch answers an invalid one (checked live, anonymous).
import * as http from 'node:http'
import type {FakeHls, FakeLive, FakeLiveTrack, FakeTrack} from './fake-hls.js'
import {listenLocal} from './listen.js'

export const WEB_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

/** auth-token values the fake knows (anything else is a 401). */
export const AUTH = {
  /** Subscribed: subscriber-only VODs and clips play. */
  sub: 'fake-ok',
  /** Signed in, not subscribed: still forbidden. */
  free: 'fake-nosub',
  /** Revoked (signed out elsewhere): 401. */
  stale: 'stale',
} as const
type Account = 'sub' | 'free' | undefined

export const SLUGS = {
  /** A 2026 clip: H.264 1080/720/480/360, a portrait asset, HEVC 1440 in its token. */
  good: 'PreciousRelievedCodCorgiDerp-IqjaHMAL8JQQH78F',
  /** A 2016 clip: one /avc/1080 file, no HEVC. */
  old: 'FaintLightGullWholeWheat',
  /** Its token says forbidden (subscriber-only / restricted). */
  forbidden: 'LockedAwayClipForSubsOnly-abcdEFGHijklMNOP',
  /** No encodings in the answer. */
  empty: 'ProcessingClipNoQualities-abcdEFGHijklMNOP',
  /** `clip: null`: deleted. */
  gone: 'DeletedClipNoLongerThere-abcdEFGHijklMNOP',
  /** Twitch renamed a field: a GraphQL error and no data. */
  changed: 'RenamedFieldClipAnswer-abcdEFGHijklMNOP',
  /** Its first token is refused by the CDN (it ran out); a fresh read signs again. */
  stale: 'StaleTokenClipSignedTwice-abcdEFGHijklMNOP',
} as const

/** VODs, each with the master playlist usher gives for it (served from a fake HLS origin). */
export const VODS = {
  /** Its broadcast is still on the air (`status: RECORDING`). */
  recording: '2911744751',
  /** A finished archive: 6 TS segments of 2 s. */
  recorded: '2602093345',
  /** `video: null`. */
  gone: '9999',
  /** Segments 2 and 3 listed `-unmuted` (403); `-muted` answers. */
  muted: '2700000001',
  /** Its CDN token is good for 5 segments; a fresh usher master re-signs. */
  expiring: '2700000002',
  /** Usher answers 403 `vod_manifest_restricted` (a subscriber-only VOD, as yt-dlp and streamlink read it). */
  subsOnly: '2700000003',
  /** Its token says `authorization.forbidden`. */
  locked: '2700000004',
  /** Usher answers an HTML page: the native read fails, yt-dlp takes over. */
  broken: '2700000005',
  /** RECORDED by its status, but its playlist is still open (the broadcast just ended). */
  racing: '2700000006',
  highlight: '2700000007',
  upload: '2700000008',
} as const

/** The fake HLS origin's tracks the VODs above play from (start it with these). */
export const VOD_TRACKS: Readonly<Record<string, FakeTrack>> = {
  rec: {segments: 6},
  rec720: {segments: 6, bytes: 188 * 8},
  recaudio: {segments: 6, bytes: 188 * 2},
  /** A video-only variant (a 2016 highlight's "high", no mp4a): never chosen. */
  high: {segments: 6, bytes: 188 * 24},
  muted: {segments: 6, muted: [2, 3]},
  signed: {segments: 12, signed: {validFor: 5}},
  open: {segments: 4, ended: false, playlistType: 'EVENT'},
}
/** Listed VODs' ids start here (newest first: 3,000,000,000 + total − 1 − i). */
const LISTED_VOD = 3_000_000_000

export const CHANNELS = {
  /** 1,200 clips (the listing stops at 1,000). */
  big: 'bigchannel',
  /** 250 clips: three pages. */
  mid: 'midchannel',
  /** No clip in any period. */
  empty: 'quietchannel',
  /** Every page an integrity check, whatever the client id. */
  gated: 'gatedchannel',
  /** On the air right now (`stream` set); every other channel is offline. */
  live: 'liveonair',
} as const

/**
 * Channels on the air whose streams play from the fake live origin (start it with LIVE_TRACKS). Each
 * channel's source variant is the track named after it; liveonair also has 720p60 and audio_only.
 */
export const LIVE = {
  /** 1080p60 source, 720p60, audio only; never ends. */
  onAir: CHANNELS.live,
  /** An ad break titled "Amazon|…" (segments 8–10) and one told only by its date range (14–15). */
  ads: 'adbreaker',
  /** Its usher token signs 6 requests, then 403: refreshed through a new query and usher. */
  expiring: 'shorttoken',
  /** The broadcast ends: ENDLIST after 10 segments. */
  ending: 'endingsoon',
  /** Its usher answers a web page, not a playlist. */
  broken: 'brokenusher',
} as const

export const LIVE_TRACKS: Readonly<Record<string, FakeLiveTrack>> = {
  [LIVE.onAir]: {made: 6},
  [`${LIVE.onAir}~720`]: {made: 6, bytes: 188 * 8},
  [`${LIVE.onAir}~audio`]: {made: 6, bytes: 188 * 2},
  [LIVE.ads]: {
    made: 6,
    endAfter: 20,
    ads: [
      {from: 8, to: 11},
      {from: 14, to: 16, titled: false},
    ],
  },
  [LIVE.expiring]: {made: 6, endAfter: 20, signed: {validFor: 6}},
  [LIVE.ending]: {made: 6, endAfter: 10},
}

/** Stream ids of the live channels. */
const STREAM_IDS: Readonly<Record<string, string>> = {
  [LIVE.onAir]: '320926770780',
  [LIVE.ads]: '320926770781',
  [LIVE.expiring]: '320926770782',
  [LIVE.ending]: '320926770783',
  [LIVE.broken]: '320926770784',
}

const VIDEO_BYTES = 48 * 1024
const PAGE = 100
const LIMIT = 1000
const SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '1080': [1920, 1080],
  '720': [1280, 720],
  '480': [853, 480],
  '360': [640, 360],
}

export type FakeTwitch = {
  readonly origin: string
  readonly gql: string
  readonly hits: {
    clip: number
    batch: number
    page: number
    media: number
    refused: number
    denied: number
    stream: number
    /** `video(id)` + token queries. */
    vod: number
    /** Token-only queries. */
    token: number
    /** Aliased VOD batches. */
    vodBatch: number
    videoPage: number
    usher: number
    /** `LiveStream` queries (stream + token). */
    live: number
    /** Live usher requests (`/api/channel/hls/`). */
    liveUsher: number
    /** GraphQL requests that carried `Authorization` (refused ones included). */
    signed: number
    /** Of those, the ones answered 401. */
    unauthorized: number
  }
  /** Every GraphQL request: its operation, client id and Authorization header (undefined: none). */
  readonly requests: Array<{readonly op: string; readonly clientId: string; readonly auth: string | undefined}>
  /** Variables of every listing page asked. */
  readonly pages: Array<Record<string, unknown>>
  /** Variables of every videos page asked. */
  readonly videoPages: Array<Record<string, unknown>>
  /** Slugs of every batch asked, in order. */
  readonly batches: string[][]
  /** Ids of every VOD batch asked, in order. */
  readonly vodBatches: string[][]
  /** Every usher request: the VOD and its `supported_codecs`. */
  readonly ushers: Array<{readonly id: string; readonly codecs: string | null}>
  /** Range headers the CDN saw (undefined: none). */
  readonly ranges: Array<string | undefined>
  readonly usher: string
  /** `supported_codecs` of every live usher request. */
  readonly liveUshers: Array<string | null>
  /** Take a channel off the air (or back on). */
  setOnAir(login: string, on: boolean): void
  close(): Promise<void>
}

export type FakeTwitchConfig = {
  /** The first N GraphQL requests answer 429. */
  readonly refusals?: number | undefined
  /** The HLS origin usher's variants point at (started with VOD_TRACKS). */
  readonly hls?: FakeHls | undefined
  /** The live origin live usher's variants point at (started with LIVE_TRACKS). */
  readonly live?: FakeLive | undefined
}

/** Videos per channel listing (all types). */
const VIDEO_TOTALS: Readonly<Record<string, number>> = {
  [CHANNELS.mid]: 250,
  [CHANNELS.empty]: 0,
}

export async function startFakeTwitch(config: FakeTwitchConfig = {}): Promise<FakeTwitch> {
  const hits = {
    clip: 0,
    batch: 0,
    page: 0,
    media: 0,
    refused: 0,
    denied: 0,
    stream: 0,
    vod: 0,
    token: 0,
    vodBatch: 0,
    videoPage: 0,
    usher: 0,
    live: 0,
    liveUsher: 0,
    signed: 0,
    unauthorized: 0,
  }
  const requests: Array<{readonly op: string; readonly clientId: string; readonly auth: string | undefined}> = []
  const pages: Array<Record<string, unknown>> = []
  const videoPages: Array<Record<string, unknown>> = []
  const vodBatches: string[][] = []
  const ushers: Array<{readonly id: string; readonly codecs: string | null}> = []
  /** VOD id → tokens signed so far (vsig-<id>-<n>). */
  const signed = new Map<string, number>()
  const batches: string[][] = []
  const ranges: Array<string | undefined> = []
  /** slug → reads so far (each read signs anew: sig-<slug>-<n>). */
  const reads = new Map<string, number>()
  let refusalsLeft = config.refusals ?? 0
  /** Live channels on the air (every one of LIVE at the start). */
  const onAir = new Set<string>(Object.values(LIVE))
  /** login → stream tokens signed so far (ssig-<login>-<n>). */
  const streamSigned = new Map<string, number>()
  const liveUshers: Array<string | null> = []
  let origin = ''

  const media = (uuid: string, path: string) => `${origin}/media/${uuid}/${path}/index.mp4`
  const quality = (uuid: string, q: string, codec = 'h264', orientation = 'landscape') => {
    const [w, h] = SIZES[q]!
    const [width, height] = orientation === 'portrait' ? [h, w] : [w, h]
    return {
      quality: q,
      frameRate: 60,
      width,
      height,
      bitrate: Number(q) * 5000,
      codecs: codec === 'h264' ? 'avc1.4D401F,mp4a.40.2' : 'hvc1.1.6.L120.90',
      sourceURL: media(uuid, `${orientation}/${codec}/${q}`),
    }
  }
  const userId = (account: Account) => (account === 'sub' ? 'fake-sub' : account === 'free' ? 'fake-free' : '')
  const token = (slug: string, uuid: string, forbidden = false, account?: Account) => {
    const n = (reads.get(slug) ?? 0) + 1
    reads.set(slug, n)
    return {
      signature: `sig-${slug}-${n}`,
      value: JSON.stringify({
        authorization: {forbidden, reason: forbidden ? 'UNAUTHORIZED_ENTITLEMENTS' : ''},
        clip_uri: media(uuid, 'landscape/hevc/1440'),
        clip_slug: slug,
        device_id: null,
        expires: Math.floor(Date.now() / 1000) + 20 * 3600,
        user_id: userId(account),
        version: 3,
      }),
    }
  }
  const clip = (slug: string, id: string, channel: string, extra: Record<string, unknown> = {}) => {
    const uuid = `uuid-${slug.toLowerCase()}`
    const landscape = ['1080', '720', '480', '360'].map(q => quality(uuid, q))
    return {
      id,
      slug,
      url: `https://www.twitch.tv/${channel}/clip/${slug}`,
      title: `Clip ${slug.slice(0, 12)}`,
      createdAt: '2026-10-10T05:25:43Z',
      durationSeconds: 51,
      viewCount: 1000,
      language: 'EN',
      thumbnailURL: `${origin}/thumb/${uuid}.jpg`,
      broadcaster: {login: channel, displayName: channel.toUpperCase()},
      curator: {login: 'someone', displayName: 'Someone'},
      game: {name: 'A Game'},
      videoQualities: landscape,
      assets: [
        {aspectRatio: 16 / 9, videoQualities: landscape},
        {aspectRatio: 9 / 16, videoQualities: ['720', '480'].map(q => quality(uuid, q, 'h264', 'portrait'))},
      ],
      playbackAccessToken: token(slug, uuid),
      ...extra,
    }
  }
  const node = (slug: string, account?: Account): unknown => {
    switch (slug) {
      case SLUGS.good:
      case SLUGS.stale:
        return clip(slug, slug === SLUGS.good ? '3573895506' : '777', 'shroud')
      case SLUGS.old: {
        const uuid = 'uuid-old'
        return clip(slug, '396245304', 'ea', {
          videoQualities: [{quality: '1080', frameRate: 0, sourceURL: media(uuid, 'landscape/avc/1080')}],
          assets: [],
          playbackAccessToken: {
            ...token(slug, uuid),
            value: JSON.stringify({
              authorization: {forbidden: false, reason: ''},
              clip_uri: media(uuid, 'landscape/avc/1080'),
              expires: Math.floor(Date.now() / 1000) + 20 * 3600,
            }),
          },
        })
      }
      case SLUGS.forbidden:
        return clip(slug, '888', 'subsonly', {
          playbackAccessToken: token(slug, `uuid-${slug.toLowerCase()}`, account !== 'sub', account),
        })
      case SLUGS.empty:
        return clip(slug, '999', 'shroud', {videoQualities: [], assets: []})
      default:
        // a listed clip, or a slug that was never there
        return /^Listed\d+-/.test(slug) ? listed(slug.split('-')[1]!, Number(slug.slice(6, slug.indexOf('-')))) : null
    }
  }
  const listed = (channel: string, i: number) => clip(`Listed${i}-${channel}`, String(100_000 + i), channel)
  const totals: Readonly<Record<string, number>> = {
    [CHANNELS.big]: 1200,
    [CHANNELS.mid]: 250,
    [CHANNELS.empty]: 0,
    [CHANNELS.gated]: 50,
  }

  const vodType = (i: number) => (i % 10 === 3 ? 'HIGHLIGHT' : i % 10 === 7 ? 'UPLOAD' : 'ARCHIVE')
  /** Video i of a channel's listing, newest first; the newest of midchannel is still recording. */
  const listedVod = (login: string, i: number, total: number) => {
    const id = String(LISTED_VOD + total - 1 - i)
    return {
      id,
      title: `Video ${i} of ${login}`,
      createdAt: new Date(Date.UTC(2026, 9, 26) - i * 86_400_000).toISOString().replace('.000', ''),
      publishedAt: new Date(Date.UTC(2026, 9, 26) - i * 86_400_000).toISOString().replace('.000', ''),
      lengthSeconds: 12,
      viewCount: (i * 7919) % 1000,
      broadcastType: vodType(i),
      status: i === 0 && login === CHANNELS.mid ? 'RECORDING' : 'RECORDED',
      owner: {login, displayName: login.toUpperCase()},
      game: {name: 'A Game'},
      previewThumbnailURL: `${origin}/thumb/vod-${id}.jpg`,
    }
  }
  const vodNode = (id: string): Record<string, unknown> | null => {
    if (id === VODS.gone) return null
    const number = Number(id)
    if (number >= LISTED_VOD && number < LISTED_VOD + 250) {
      return listedVod(CHANNELS.mid, LISTED_VOD + 249 - number, 250)
    }
    const type = id === VODS.highlight ? 'HIGHLIGHT' : id === VODS.upload ? 'UPLOAD' : 'ARCHIVE'
    const segments = id === VODS.expiring ? 12 : id === VODS.racing ? 4 : 6
    return {
      id,
      title: `VOD ${id}`,
      createdAt: '2026-10-20T17:45:11Z',
      publishedAt: '2026-10-20T17:45:11Z',
      lengthSeconds: segments * 2,
      viewCount: 1234,
      broadcastType: type,
      status: id === VODS.recording ? 'RECORDING' : 'RECORDED',
      owner: {login: id === VODS.recording ? CHANNELS.live : 'shroud', displayName: 'Shroud'},
      game: {name: 'A Game'},
      previewThumbnailURL: `${origin}/thumb/vod-${id}.jpg`,
    }
  }
  const vodToken = (id: string, account?: Account) => {
    const n = (signed.get(id) ?? 0) + 1
    signed.set(id, n)
    const forbidden = id === VODS.locked && account !== 'sub'
    return {
      signature: `vsig-${id}-${n}`,
      value: JSON.stringify({
        authorization: {forbidden, reason: forbidden ? 'UNAUTHORIZED_ENTITLEMENTS' : ''},
        chansub: {restricted_bitrates: []},
        expires: Math.floor(Date.now() / 1000) + 20 * 3600,
        maximum_resolution: 'FULL_HD',
        user_id: userId(account),
        vod_id: Number(id),
        version: 3,
      }),
    }
  }
  /** Usher's master for a VOD: the variants on the HLS origin, minted anew (signed tracks get a fresh token). */
  const master = (id: string): string => {
    const hls = config.hls
    if (!hls) throw new Error('the fake usher needs the fake HLS origin (config.hls)')
    const main = id === VODS.muted ? 'muted' : id === VODS.expiring ? 'signed' : id === VODS.racing ? 'open' : 'rec'
    const variant = (attrs: string, group: string, name: string, track: string) =>
      `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${group}",NAME="${name}",AUTOSELECT=YES,DEFAULT=YES\n` +
      `#EXT-X-STREAM-INF:${attrs},VIDEO="${group}"\n${hls.playlistUrl(track)}`
    return [
      '#EXTM3U',
      '#EXT-X-TWITCH-INFO:ORIGIN="s3",B="false",REGION="NA",USER-IP="127.0.0.1",CLUSTER="cloudfront_vod"',
      variant('BANDWIDTH=8500000,CODECS="avc1.42C01F",RESOLUTION=1920x1080,FRAME-RATE=60.000', 'high', 'high', 'high'),
      variant(
        'BANDWIDTH=7712738,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60.000',
        'chunked',
        '1080p60 (source)',
        main,
      ),
      variant(
        'BANDWIDTH=3249811,CODECS="avc1.4D4020,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=60.000',
        '720p60',
        '720p60',
        'rec720',
      ),
      variant('BANDWIDTH=203877,CODECS="mp4a.40.2"', 'audio_only', 'Audio Only', 'recaudio'),
      '',
    ].join('\n')
  }
  const streamOf = (login: string) =>
    onAir.has(login)
      ? {
          id: STREAM_IDS[login] ?? '320926770799',
          type: 'live',
          title: login === CHANNELS.live ? 'On the air' : `Live on ${login}`,
          createdAt: '2026-10-26T20:59:27Z',
        }
      : null
  const streamToken = (login: string) => {
    const n = (streamSigned.get(login) ?? 0) + 1
    streamSigned.set(login, n)
    return {
      signature: `ssig-${login}-${n}`,
      value: JSON.stringify({
        adblock: false,
        authorization: {forbidden: false, reason: ''},
        channel: login,
        expires: Math.floor(Date.now() / 1000) + 20 * 60,
        version: 2,
      }),
    }
  }
  /** `GET /api/channel/hls/<login>.m3u8`: signature checked; 404 offline; the master on the live origin. */
  const liveUsher = (res: http.ServerResponse, url: URL) => {
    hits.liveUsher++
    const login = /^\/api\/channel\/hls\/([^/]+)\.m3u8$/.exec(url.pathname)?.[1] ?? ''
    liveUshers.push(url.searchParams.get('supported_codecs'))
    const sig = url.searchParams.get('sig') ?? ''
    const n = Number(sig.slice(`ssig-${login}-`.length))
    if (!sig.startsWith(`ssig-${login}-`) || !(n >= 1 && n <= (streamSigned.get(login) ?? 0))) {
      return json(res, 403, [{error: 'invalid token signature', error_code: 'nauth_sig_invalid', type: 'error'}])
    }
    if (!onAir.has(login)) {
      return json(res, 404, [
        {error: 'twirp error not_found: transcode does not exist', error_code: 'transcode_does_not_exist'},
      ])
    }
    if (login === LIVE.broken) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'})
      return res.end('<!doctype html><title>Twitch</title>')
    }
    const live = config.live
    if (!live) throw new Error('the fake live usher needs the fake live origin (config.live)')
    const lines = ['#EXTM3U', '#EXT-X-TWITCH-INFO:NODE="video-edge-fake",SERVING-ID="x",CLUSTER="fake",B="false"']
    const variant = (attrs: string, group: string, name: string, track: string) =>
      lines.push(
        `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${group}",NAME="${name}",AUTOSELECT=YES,DEFAULT=YES`,
        `#EXT-X-STREAM-INF:${attrs},VIDEO="${group}"`,
        live.playlistUrl(track),
      )
    variant(
      'BANDWIDTH=7712738,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60.000',
      'chunked',
      '1080p60 (source)',
      login,
    )
    if (login === LIVE.onAir) {
      variant(
        'BANDWIDTH=3249811,CODECS="avc1.4D4020,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=60.000',
        '720p60',
        '720p60',
        `${login}~720`,
      )
      variant('BANDWIDTH=203877,CODECS="mp4a.40.2"', 'audio_only', 'audio_only', `${login}~audio`)
    }
    res.writeHead(200, {'content-type': 'application/vnd.apple.mpegurl'})
    return res.end(`${lines.join('\n')}\n`)
  }

  /** `GET /vod/<id>.m3u8`: the token's signature checked, then the master (or how usher refuses). */
  const usher = (res: http.ServerResponse, url: URL) => {
    hits.usher++
    const id = /^\/vod\/(\d+)\.m3u8$/.exec(url.pathname)?.[1] ?? ''
    ushers.push({id, codecs: url.searchParams.get('supported_codecs')})
    const sig = url.searchParams.get('sig') ?? ''
    const n = Number(sig.slice(`vsig-${id}-`.length))
    const value = url.searchParams.get('token')
    if (!sig.startsWith(`vsig-${id}-`) || !(n >= 1 && n <= (signed.get(id) ?? 0)) || !value) {
      return json(res, 403, [{error: 'invalid token signature', error_code: 'nauth_sig_invalid', type: 'error'}])
    }
    // a subscriber's token opens the subscriber-only VOD (the token's value says who asked)
    const subscriber = /"user_id":"fake-sub"/.test(value)
    if (id === VODS.subsOnly && !subscriber) {
      return json(res, 403, [
        {error: 'You must be subscribed to watch this video', error_code: 'vod_manifest_restricted', type: 'error'},
      ])
    }
    if (id === VODS.broken) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'})
      return res.end('<!doctype html><title>Twitch</title>')
    }
    if (!vodNode(id)) return json(res, 404, [{error: 'vod not found', error_code: 'vod_manifest_not_found'}])
    res.writeHead(200, {'content-type': 'application/vnd.apple.mpegurl'})
    return res.end(master(id))
  }

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {'content-type': 'application/json'})
    res.end(JSON.stringify(body))
  }

  const answer = (
    res: http.ServerResponse,
    clientId: string,
    query: string,
    variables: Record<string, unknown>,
    account: Account,
  ) => {
    if (query.startsWith('query Clip(')) {
      hits.clip++
      const slug = String(variables['slug'])
      if (slug === SLUGS.changed) {
        return json(res, 200, {
          errors: [{message: 'Cannot query field "videoQualities" on type "Clip".', path: ['query', 'clip']}],
        })
      }
      return json(res, 200, {data: {clip: node(slug, account)}})
    }
    if (query.startsWith('query Clips(')) {
      hits.batch++
      const slugs = Object.keys(variables)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        .map(key => String(variables[key]))
      batches.push(slugs)
      if (slugs.length > 15) return json(res, 200, {errors: [{message: 'root field aliases limit allowed (15)'}]})
      const data: Record<string, unknown> = {}
      slugs.forEach((slug, i) => {
        data[`c${i}`] = node(slug)
      })
      return json(res, 200, {data})
    }
    if (query.startsWith('query ChannelStream(')) {
      hits.stream++
      const login = String(variables['login'])
      if (!STREAM_IDS[login] && totals[login] === undefined) return json(res, 200, {data: {user: null}})
      const stream = streamOf(login)
      return json(res, 200, {data: {user: {id: '71092938', login, displayName: login.toUpperCase(), stream}}})
    }
    if (query.startsWith('query LiveStream(')) {
      hits.live++
      const login = String(variables['login'])
      if (!STREAM_IDS[login] && totals[login] === undefined) {
        return json(res, 200, {data: {user: null, streamPlaybackAccessToken: null}})
      }
      return json(res, 200, {
        data: {
          user: {id: '71092938', login, displayName: login.toUpperCase(), stream: streamOf(login)},
          streamPlaybackAccessToken: streamToken(login),
        },
      })
    }
    if (query.startsWith('query Vod(')) {
      hits.vod++
      const id = String(variables['id'])
      const video = vodNode(id)
      return json(res, 200, {data: {video, videoPlaybackAccessToken: video ? vodToken(id, account) : null}})
    }
    if (query.startsWith('query VodToken(')) {
      hits.token++
      const id = String(variables['id'])
      return json(res, 200, {data: {videoPlaybackAccessToken: vodNode(id) ? vodToken(id, account) : null}})
    }
    if (query.startsWith('query Vods(')) {
      hits.vodBatch++
      const ids = Object.keys(variables)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        .map(key => String(variables[key]))
      vodBatches.push(ids)
      if (ids.length > 15) return json(res, 200, {errors: [{message: 'root field aliases limit allowed (15)'}]})
      const data: Record<string, unknown> = {}
      ids.forEach((id, i) => {
        data[`v${i}`] = vodNode(id)
      })
      return json(res, 200, {data})
    }
    if (query.startsWith('query ChannelVideos(')) {
      hits.videoPage++
      videoPages.push(variables)
      const login = String(variables['login'])
      const total = VIDEO_TOTALS[login]
      if (total === undefined) return json(res, 200, {data: {user: null}})
      const type = typeof variables['type'] === 'string' ? variables['type'] : undefined
      let nodes = Array.from({length: total}, (_, i) => listedVod(login, i, total))
      if (type) nodes = nodes.filter(node => node.broadcastType === type)
      if (variables['sort'] === 'VIEWS') nodes.sort((a, b) => b.viewCount - a.viewCount)
      const after = typeof variables['after'] === 'string' ? Number(variables['after'].split('|')[1]) : 0
      const end = Math.min(nodes.length, after + PAGE)
      const page = nodes.slice(after, end)
      const last = page.at(-1)
      const more = end < nodes.length
      const cursor = more && last ? `${last.id}|${end}|${last.publishedAt}|${end * 7}` : null
      return json(res, 200, {
        data: {
          user: {
            id: '37402112',
            login,
            displayName: login.toUpperCase(),
            videos: {
              totalCount: nodes.length,
              pageInfo: {hasNextPage: more},
              edges: page.map(node => ({cursor, node})),
            },
          },
        },
      })
    }
    if (query.startsWith('query ChannelClips(')) {
      hits.page++
      pages.push(variables)
      const login = String(variables['login'])
      const total = totals[login]
      if (total === undefined) return json(res, 200, {data: {user: null}})
      const after =
        typeof variables['after'] === 'string' ? Number(Buffer.from(variables['after'], 'base64').toString()) : 0
      const user = {id: '37402112', login, displayName: login.toUpperCase()}
      if ((after > 0 && clientId === WEB_ID) || login === CHANNELS.gated) {
        return json(res, 200, [
          {
            errors: [
              {message: 'failed integrity check', path: ['user', 'clips'], extensions: {code: 'IntegrityCheckFailed'}},
            ],
            data: {user: {...user, clips: null}},
            extensions: {challenge: {type: 'integrity'}},
          },
        ])
      }
      const end = Math.min(total, after + PAGE)
      const edges = []
      for (let i = after; i < end; i++) edges.push({cursor: null as string | null, node: listed(login, i)})
      if (edges.length > 0) edges[edges.length - 1]!.cursor = Buffer.from(String(end)).toString('base64')
      return json(res, 200, {
        data: {user: {...user, clips: {pageInfo: {hasNextPage: end < total && end < LIMIT}, edges}}},
      })
    }
    return json(res, 200, {errors: [{message: `Unknown query: ${query.slice(0, 40)}`}]})
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.test')
    if (req.method === 'POST' && url.pathname === '/gql') {
      let raw = ''
      req.on('data', chunk => {
        raw += chunk
      })
      req.on('end', () => {
        const clientId = req.headers['client-id']
        if (typeof clientId !== 'string' || !clientId) {
          return json(res, 400, {
            error: 'Bad Request',
            status: 400,
            message: 'The "Client-ID" header is missing from the request.',
          })
        }
        if (refusalsLeft > 0) {
          refusalsLeft--
          hits.refused++
          return json(res, 429, {error: 'Too Many Requests'})
        }
        let body: {query?: unknown; variables?: unknown}
        try {
          body = JSON.parse(raw)
        } catch {
          return json(res, 400, {error: 'Bad Request', message: 'invalid JSON'})
        }
        const query = String(body.query ?? '')
        const auth = req.headers.authorization
        requests.push({op: /^query (\w+)/.exec(query)?.[1] ?? '?', clientId, auth})
        let account: Account
        if (auth !== undefined) {
          hits.signed++
          account =
            clientId !== WEB_ID
              ? undefined
              : auth === `OAuth ${AUTH.sub}`
                ? 'sub'
                : auth === `OAuth ${AUTH.free}`
                  ? 'free'
                  : undefined
          if (!account) {
            hits.unauthorized++
            return json(res, 401, {
              error: 'Unauthorized',
              status: 401,
              message: 'The "Authorization" token is invalid.',
            })
          }
        }
        return answer(res, clientId, query, (body.variables ?? {}) as Record<string, unknown>, account)
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vod/')) return usher(res, url)
    if (req.method === 'GET' && url.pathname.startsWith('/api/channel/hls/')) return liveUsher(res, url)
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      hits.media++
      const uuid = url.pathname.split('/')[2] ?? ''
      const slug = [...reads.keys()].find(
        s => `uuid-${s.toLowerCase()}` === uuid || (uuid === 'uuid-old' && s === SLUGS.old),
      )
      const sig = url.searchParams.get('sig')
      const tokenValue = url.searchParams.get('token')
      const n = slug ? (reads.get(slug) ?? 0) : 0
      const valid =
        slug !== undefined &&
        tokenValue !== null &&
        sig?.startsWith(`sig-${slug}-`) &&
        // the stale clip's first signature ran out
        !(slug === SLUGS.stale && sig === `sig-${slug}-1`) &&
        Number(sig.slice(`sig-${slug}-`.length)) <= n
      if (!valid) {
        hits.denied++
        res.writeHead(401, {'content-type': 'text/xml'})
        return res.end('<Error><Code>AccessDenied</Code></Error>')
      }
      const body = mp4(VIDEO_BYTES)
      const range = req.headers.range
      ranges.push(range)
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
      res.writeHead(range ? 206 : 200, {
        'content-type': 'binary/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': String(body.length - start),
        ...(range && {'content-range': `bytes ${start}-${body.length - 1}/${body.length}`}),
      })
      return res.end(body.subarray(start))
    }
    res.writeHead(404)
    return res.end()
  })
  const port = await listenLocal(server)
  origin = `http://127.0.0.1:${port}`
  return {
    origin,
    gql: `${origin}/gql`,
    hits,
    requests,
    pages,
    videoPages,
    batches,
    vodBatches,
    ushers,
    ranges,
    usher: origin,
    liveUshers,
    setOnAir: (login, on) => {
      if (on) onAir.add(login)
      else onAir.delete(login)
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Bytes that start like an MP4 (an ftyp box), then zeros. */
function mp4(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  bytes.writeUInt32BE(24, 0)
  bytes.write('ftypisom', 4, 'latin1')
  return bytes
}
