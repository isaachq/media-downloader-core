/**
 * Where SoundCloud's public data lives, as this module reads it. Everything
 * site-specific that is not a key of the JSON lives here, so a change on
 * SoundCloud's side is a change in one file, and a host can override any
 * entry (`SoundcloudOptions.endpoints`) without waiting for a release.
 *
 * Verified live on 2026-10-27 (anonymous, from Mexico; samples in
 * `.local/soundcloud/`, served by test/helpers/fake-soundcloud.ts):
 *  - `api-v2.soundcloud.com` answers every read here with a `client_id`
 *    query parameter and no session: `/resolve?url=` (a track, a set or a
 *    user), `/tracks?ids=` (50 ids at most, 51 is a 400; the answer is in no
 *    particular order), `/users/<id>/{tracks,likes,playlists,albums}`
 *    (`linked_partitioning=1`, a `next_href` that leaves out `client_id`);
 *    a missing or bad `client_id` is a 401 with an empty body;
 *  - the `client_id` is in the home page's hydration
 *    (`"hydratable":"apiClient","data":{"id":"…"}`, flagged `isExpiring`) and
 *    in the last `a-v2.sndcdn.com/assets/*.js` bundle (`client_id:"…"`,
 *    2.9 MB, `client_is_expiring:!1`): both answered 200;
 *  - a transcoding's url plus `client_id` (and `track_authorization`) is
 *    `{url}`: a CloudFront-signed HLS playlist that expires in about 5
 *    minutes, its segments in about 2 hours.
 */

export type SoundcloudEndpoints = {
  /** The JSON API. */
  readonly api: string
  /** The web app: its home page carries the `client_id`, and the canonical links resolve against it. */
  readonly web: string
  /** Where `on.soundcloud.com/<code>` short links are asked (one 302 to the page). */
  readonly short: string
  /** The page's own scripts: only these are read for the `client_id` (never another host's). */
  readonly assetHost: string
  /** Entries per listing page (the web app asks for 20; DataDome flagged 200 for yt-dlp users, #15660). */
  readonly pageSize: number
}

/** O(1) each. */
export const DEFAULT_ENDPOINTS: SoundcloudEndpoints = {
  api: 'https://api-v2.soundcloud.com',
  web: 'https://soundcloud.com',
  short: 'https://on.soundcloud.com',
  assetHost: 'https://a-v2.sndcdn.com',
  pageSize: 50,
}

/** The web app, for the links handed back (entries, playlists). */
export const SOUNDCLOUD_ORIGIN = 'https://soundcloud.com'

/** Track ids per `/tracks?ids=` request (51 is a 400). */
export const IDS_PER_REQUEST = 50

/** The hydration's api client: free (it comes with the home page), but flagged `isExpiring`. */
export const HYDRATION_CLIENT_ID =
  /"hydratable"\s*:\s*"apiClient"\s*,\s*"data"\s*:\s*\{\s*"id"\s*:\s*"([0-9A-Za-z]{32})"/
/**
 * The bundle's: stable (`client_is_expiring:!1`), in the last script. Written
 * `client_id:"…"` today (2026-10-27, `assets/55-*.js`); a minifier's
 * `client_id:'…'` or a quoted key (`"client_id":"…"`) is the same id.
 */
export const BUNDLE_CLIENT_ID = /["']?client_id["']?\s*:\s*["']([0-9A-Za-z]{32})["']/
/** The page's scripts, in page order. */
export const SCRIPT_SRC = /<script[^>]+src="([^"]+)"/g
/** The longest match of BUNDLE_CLIENT_ID plus slack: what a streamed scan keeps between chunks. */
export const BUNDLE_OVERLAP = 96

/**
 * Presets in the order they are taken (the first a track has wins), clear
 * HLS AAC first: on every track since 2024 the only clear formats are
 * `aac_160k` and `aac_96k` over HLS (fMP4); MP3 and Opus are left on old
 * (legacy) tracks only. `aac_256k` (Go+, `quality: "hq"`) needs a subscriber
 * session and is never asked for. `abr_*` is a master playlist that answers 404
 * (yt-dlp skips it as broken too).
 */
export const PRESET_ORDER: readonly string[] = ['aac_160k', 'aac_96k', 'mp3_', 'opus_']
