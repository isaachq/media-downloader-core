/**
 * Where Twitch's public clip data lives, as this module reads it. Everything
 * site-specific that is not a key of the JSON lives here, so a change on
 * Twitch's side is a change in one file, and a host can override any entry
 * (`TwitchOptions.endpoints`, `TwitchOptions.clientId`) without waiting for a
 * release.
 *
 * Verified live on 2026-10-26 (anonymous, from Mexico; samples in
 * `.local/twitch/`, served by test/helpers/fake-twitch.ts):
 *  - `POST https://gql.twitch.tv/gql` takes plain (raw) GraphQL queries on
 *    both client ids below; without a `Client-ID` it is a 400. Raw queries
 *    are used on purpose: the persisted-query hashes yt-dlp sends rotated four
 *    times in 13 months (each a `PersistedQueryNotFound`), the raw `clip`
 *    query cobalt sends has not changed in two years;
 *  - a clip's `videoQualities` (H.264, 1080 down to 360) and its
 *    `playbackAccessToken` (signature + value) give signed cloudfront MP4s:
 *    `sourceURL?sig=<signature>&token=<value>`, one token for every quality
 *    (and for the HEVC 1440p file the token's own `clip_uri` names), Range
 *    answered with 206, unsigned a 401, the token valid ~20 h;
 *  - a channel's `clips(first: 100)` carries the same fields per clip, signed
 *    URLs included, so a listed clip is never read again; the cursor is the
 *    last edge's (a base64 offset: "MTAw" = 100) and `hasNextPage` turns
 *    false at offset 1000, whatever the period;
 *  - up to 15 root fields (aliases) per query ("root field aliases limit
 *    allowed (15)" past that).
 *
 * VODs (verified live 2026-10-27, anonymous, from Mexico):
 *  - `video(id)` and `videoPlaybackAccessToken(id)` in one raw query: the VOD
 *    (`status` RECORDING while its broadcast is on the air, RECORDED once it
 *    ended; `broadcastType` ARCHIVE, HIGHLIGHT, UPLOAD) and a token for usher
 *    (`expires` ~20 h ahead, `authorization.forbidden`, `maximum_resolution`
 *    FULL_HD anonymously); `video: null` and no token for a VOD that is gone;
 *  - `usher.ttvnw.net/vod/<id>.m3u8?…&sig&token` is the master playlist of
 *    archives, highlights, uploads and past premieres alike: H.264 + AAC
 *    variants (`chunked` is the source), an audio_only one, unsigned absolute
 *    variant urls on cloudfront; fMP4 (newer) or MPEG-TS segments of 10 s in
 *    an EVENT playlist that ends (ENDLIST) once recorded and stays open while
 *    recording; muted parts listed as `<n>-muted.ts` (200; `-unmuted` and the
 *    bare name answer 403). A refused token is a 403 JSON
 *    `[{"error", "error_code": "nauth_sig_invalid", "type"}]`.
 *    `supported_codecs` is sent per profile, but no VOD of 32 channels
 *    answered anything but H.264 either way (nor for `av1` alone);
 *  - a channel's `videos(first: 100, after, type, sort)` pages by a cursor
 *    `"<videoId>|<n>|<publishedAt>|<n>"`, the same on every edge of a page and
 *    null on the last; `totalCount` counts them all (2,667 on one channel,
 *    read past page 3 on the default client id).
 *
 * Live channels (verified live 2026-10-27, anonymous, from Mexico, on the
 * default client id): `user(login).stream` and
 * `streamPlaybackAccessToken(channelName, params)` in one raw query (a token
 * comes for an offline channel too); `usher.ttvnw.net/api/channel/hls/<login>.m3u8`
 * (and `/api/v2/…`, which answers the same master with its info as
 * EXT-X-SESSION-DATA) gives H.264 + AAC variants on weaver; the media
 * playlist is MPEG-TS, 2 s segments titled `live`, EXT-X-TARGETDURATION 6,
 * a window of about 30 s, a program date-time per segment, and date ranges
 * of their own CLASS (`twitch-session`, `twitch-stream-source`, ads as
 * `twitch-stitched-ad`).
 */

/**
 * The client id sent as `Client-ID`. Two are known to work anonymously:
 *  - `kimne78kx3ncx6brgo4mv6wki5h1ko`: the web player's own (cobalt and
 *    streamlink send it). Single clips read fine, but every listing page
 *    after the first answers `IntegrityCheckFailed` (a Client-Integrity
 *    token the site's own JavaScript makes, which this library does not run);
 *  - `ue6666qo983tsx6so1t0vnawi233wa`: yt-dlp's since 2023-06. Single clips
 *    and every listing page read fine (checked live 2026-10-26: pages 1 to 3
 *    of a 1,000-clip listing, and clips from 2016 to 2026).
 * The default is the one that reads every page. If Twitch gates it too, a
 * host passes the other (or a newer one) as `twitch.clientId`.
 */
export const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
export const ALT_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa'
export const DEFAULT_CLIENT_ID = ALT_CLIENT_ID

export type TwitchEndpoints = {
  /** The GraphQL endpoint. */
  readonly gql: string
  /**
   * The selection set read of every clip (a single read, a batch of checks, a
   * listing page): a GraphQL fragment on `Clip`. Overridable when Twitch
   * renames a field, without a release.
   */
  readonly clipFields: string
  /** The selection set read of every VOD (a single read, a batch of checks, a listing page): a fragment on `Video`. */
  readonly videoFields: string
  /** Where VOD master playlists are asked for (`<usher>/vod/<id>.m3u8`). */
  readonly usher: string
}

const QUALITY_FIELDS = 'quality frameRate width height bitrate codecs sourceURL'
/** The parameters the web player asks a clip's token with. */
const ACCESS_PARAMS = 'platform: "web", playerBackend: "mediaplayer", playerType: "site"'

/** O(1) string construction each. */
export const DEFAULT_ENDPOINTS: TwitchEndpoints = {
  gql: 'https://gql.twitch.tv/gql',
  clipFields:
    'id slug url title createdAt durationSeconds viewCount language thumbnailURL ' +
    'broadcaster { login displayName } curator { login displayName } game { name } ' +
    `videoQualities { ${QUALITY_FIELDS} } ` +
    `assets { aspectRatio videoQualities { ${QUALITY_FIELDS} } } ` +
    `playbackAccessToken(params: {${ACCESS_PARAMS}}) { signature value }`,
  videoFields:
    'id title createdAt publishedAt lengthSeconds viewCount broadcastType status ' +
    'owner { login displayName } game { name } previewThumbnailURL(width: 1280, height: 720)',
  usher: 'https://usher.ttvnw.net',
}

/** The web site, for the links handed back (entries, playlists) and the Referer. */
export const TWITCH_ORIGIN = 'https://www.twitch.tv'

/** Clips a listing page brings (the API's largest page). */
export const PAGE_SIZE = 100
/** Root fields (aliases) one query may have: the batch size of checks. */
export const ALIAS_LIMIT = 15
/** A listing ends at this offset whatever the period (`hasNextPage: false`). */
export const CLIP_LISTING_LIMIT = 1000

/** A clips page's `?range=` → the API's `criteria.filter`. The site's own default is a week. */
export const CLIP_PERIODS = {
  '24hr': 'LAST_DAY',
  '7d': 'LAST_WEEK',
  '30d': 'LAST_MONTH',
  all: 'ALL_TIME',
} as const
export type ClipPeriod = keyof typeof CLIP_PERIODS
export const DEFAULT_CLIP_PERIOD: ClipPeriod = '7d'

/** One clip: `query($slug: ID!) { clip(slug: $slug) { … } }`. O(1). */
export function clipQuery(fields: string): string {
  return `query Clip($slug: ID!) { clip(slug: $slug) { ${fields} } }`
}

/** n clips in one request, as aliases c0…c(n-1) of `clip`, n ≤ ALIAS_LIMIT. O(n). */
export function clipsQuery(fields: string, n: number): string {
  const vars: string[] = []
  const roots: string[] = []
  for (let i = 0; i < n; i++) {
    vars.push(`$s${i}: ID!`)
    roots.push(`c${i}: clip(slug: $s${i}) { ...C }`)
  }
  return `query Clips(${vars.join(', ')}) { ${roots.join(' ')} } fragment C on Clip { ${fields} }`
}

/** One page of a channel's clips, top by views in a period. O(1). */
export function clipsPageQuery(fields: string): string {
  return (
    'query ChannelClips($login: String!, $after: Cursor, $filter: ClipsFilter) { ' +
    'user(login: $login) { id login displayName ' +
    `clips(first: ${PAGE_SIZE}, after: $after, criteria: {filter: $filter}) { ` +
    `pageInfo { hasNextPage } edges { cursor node { ${fields} } } } } }`
  )
}

/**
 * Whether a channel is on the air, and what its stream is: one query, the
 * fields a recorder needs (id, title, start) included at no extra request.
 * Verified live 2026-10-26: `stream` is null when the channel is offline,
 * `type` "live" (or "rerun") while it streams. O(1).
 */
export function channelStreamQuery(): string {
  return 'query ChannelStream($login: String!) { user(login: $login) { id login displayName stream { id type title createdAt } } }'
}

/**
 * A channel's stream and the token that signs its usher request, in one query (a recording and each
 * of its refreshes ask it once). Offline, `stream` is null (a token comes anyway). O(1).
 */
export function liveQuery(): string {
  return (
    'query LiveStream($login: String!) { user(login: $login) { id login displayName stream { id type title createdAt } } ' +
    `streamPlaybackAccessToken(channelName: $login, params: {${ACCESS_PARAMS}}) { value signature } }`
  )
}

/**
 * A channel's live master playlist at usher (`<usher>/api/channel/hls/<login>.m3u8`), signed with its
 * stream token, with the parameters the web player sends. O(L).
 */
export function liveUsherUrl(
  origin: string,
  login: string,
  token: {readonly signature: string; readonly value: string},
  codecs: string,
  p: number,
): string {
  const query = new URLSearchParams({
    allow_source: 'true',
    allow_audio_only: 'true',
    fast_bread: 'true',
    platform: 'web',
    player: 'twitchweb',
    supported_codecs: codecs,
    playlist_include_framerate: 'true',
    p: String(p),
    sig: token.signature,
    token: token.value,
  })
  return `${origin}/api/channel/hls/${encodeURIComponent(login)}.m3u8?${query}`
}

/** The token that signs a VOD's usher request, asked as the web player asks it. */
const VOD_TOKEN = `videoPlaybackAccessToken(id: $id, params: {${ACCESS_PARAMS}}) { value signature }`

/**
 * One VOD and its playback token in one request: `status` "RECORDING" while
 * its broadcast is still on the air, "RECORDED" once it ended. O(1).
 */
export function vodQuery(fields: string): string {
  return `query Vod($id: ID!) { video(id: $id) { ${fields} } ${VOD_TOKEN} }`
}

/** A VOD's token alone (a VOD a listing read, a token that ran out). O(1). */
export function vodTokenQuery(): string {
  return `query VodToken($id: ID!) { ${VOD_TOKEN} }`
}

/** n VODs in one request, as aliases v0…v(n-1) of `video`, n ≤ ALIAS_LIMIT (checks: no token). O(n). */
export function vodsQuery(fields: string, n: number): string {
  const vars: string[] = []
  const roots: string[] = []
  for (let i = 0; i < n; i++) {
    vars.push(`$v${i}: ID!`)
    roots.push(`v${i}: video(id: $v${i}) { ...V }`)
  }
  return `query Vods(${vars.join(', ')}) { ${roots.join(' ')} } fragment V on Video { ${fields} }`
}

/** A video listing's `?filter=` → the API's `type` (all: none). */
export const VIDEO_TYPES = {
  all: undefined,
  archives: 'ARCHIVE',
  highlights: 'HIGHLIGHT',
  uploads: 'UPLOAD',
  past_premieres: 'PAST_PREMIERE',
} as const
/** A video listing's `?sort=` → the API's `sort`. */
export const VIDEO_SORTS = {time: 'TIME', views: 'VIEWS'} as const

/** One page of a channel's videos (100), newest first or by views. O(1). */
export function videosPageQuery(fields: string): string {
  return (
    'query ChannelVideos($login: String!, $after: Cursor, $type: BroadcastType, $sort: VideoSort) { ' +
    'user(login: $login) { id login displayName ' +
    `videos(first: ${PAGE_SIZE}, after: $after, type: $type, sort: $sort) { totalCount ` +
    `pageInfo { hasNextPage } edges { cursor node { ${fields} } } } } }`
  )
}

/** `supported_codecs` of an mp4 profile (no transcode), and of every other one. */
export const CODECS_COMPAT = 'h264'
export const CODECS_BEST = 'av1,h265,h264'

/**
 * A VOD's master playlist url at usher, signed with its token, the
 * parameters the web player sends. `p` is the player's cache buster. O(L).
 */
export function usherUrl(
  origin: string,
  id: string,
  token: {readonly signature: string; readonly value: string},
  codecs: string,
  p: number,
): string {
  const query = new URLSearchParams({
    allow_source: 'true',
    allow_audio_only: 'true',
    platform: 'web',
    player: 'twitchweb',
    supported_codecs: codecs,
    playlist_include_framerate: 'true',
    p: String(p),
    sig: token.signature,
    token: token.value,
  })
  return `${origin}/vod/${id}.m3u8?${query}`
}
