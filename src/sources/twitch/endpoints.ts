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
 * A VOD's state: `status` "RECORDING" while its broadcast is still on the air
 * (verified live 2026-10-26), "RECORDED" once it ended. O(1).
 */
export function vodStatusQuery(): string {
  return 'query VodStatus($id: ID!) { video(id: $id) { id status broadcastType owner { login } } }'
}
