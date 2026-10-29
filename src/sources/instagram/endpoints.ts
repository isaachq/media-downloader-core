/**
 * Where Instagram's own web client gets its data, as this module uses it.
 * Everything site-specific that is not a page url lives here, so a change on
 * Instagram's side is a change in one file — and a host can override the
 * query ids (`InstagramOptions.queries`) without waiting for a release.
 *
 * Status of each entry when this was written (October 2026 build, from the
 * web client and yt-dlp's extractor; NOT re-verified against the live site
 * from this build — the local fake in test/helpers/fake-instagram.ts serves
 * exactly these shapes):
 *  - APP_ID, PROFILE_INFO, REELS_MEDIA, USER_FEED: the private web API, stable for years.
 *  - GRAPHQL + the query ids: the Relay "doc_id" queries the web client sends;
 *    Instagram rotates these now and then. A query that stops answering makes
 *    the source fall back to yt-dlp ('format-changed'), never fail silently.
 */

/** The web client's application id, sent as X-IG-App-ID on every API call. */
export const APP_ID = '936619743392459'
export const ASBD_ID = '129477'

/**
 * The anonymous routes to one public post, tried before the web client's
 * query (what yt-dlp, cobalt, gallery-dl, and Instaloader read):
 *  - `/p/<code>/embed/captioned/`: the embed page, the post as `contextJSON`
 *    → `gql_data.shortcode_media` (a GraphQL node);
 *  - the web client's `web_info` query (`POST /graphql/query`, a query id from
 *    `WEB_INFO_QUERIES` → `xdt_api__v1__media__shortcode__web_info.items`, a v1
 *    item in ~15 KB of JSON): answers without a session for public posts;
 *  - the post page a logged-out visitor gets, which also names the query ids
 *    its own client preloads right now (see QueryBook);
 *  - the logged-out post query (`POST /api/graphql`, the page's LSD token and
 *    the query id the page named → `xig_polaris_media.if_not_gated_logged_out`);
 *  - `<API_ORIGIN>/api/v1/media/<pk>/info/`: the Android app's API, which
 *    answers anonymously for public posts when asked as the app (a v1 item).
 *
 * Time Complexity: O(1) string construction.
 * Space Complexity: O(1) allocation.
 */
export const EMBED_PATH = (code: string): string => `/p/${code}/embed/captioned/`
/**
 * Query ids of the web client's `web_info` query that answer without a session
 * (verified 2026-10-20 on a public photo post): tried in order, the next when
 * one stops answering. A host can put its own first (`InstagramOptions.queries.webInfo`).
 */
export const WEB_INFO_QUERIES: readonly string[] = ['27128499623469141', '24368985919464652']
/** The logged-out post query a post page preloads, by the name the page gives it. */
export const LOGGED_OUT_POST_QUERY = 'PolarisLoggedOutDesktopWWWPostRootContentQuery'
/** Where the logged-out client sends its queries (with the page's LSD token). */
export const API_GRAPHQL = '/api/graphql'
/** `?url=<post url>` → whether a public post exists (author, id), in a few KB: a probe, never the media. */
export const OEMBED = '/api/v1/oembed/'
export const API_ORIGIN = 'https://i.instagram.com'
export const MEDIA_INFO = (pk: string): string => `/api/v1/media/${pk}/info/`
/** The Android app, as cobalt and gallery-dl present themselves to its API. */
export const APP_USER_AGENT =
  'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_US; 458229237)'

/** `?username=<user>` → the account, its counts and its first posts. */
export const PROFILE_INFO = '/api/v1/users/web_profile_info/'
/** `?reel_ids=<user id>` (or `highlight:<id>`) → the current stories. Signed-in sessions only. */
export const REELS_MEDIA = '/api/v1/feed/reels_media/'
/** Highlights tray: lists all highlights of a user. Signed-in sessions only. */
export const HIGHLIGHTS_TRAY = (userId: string): string => `/api/v1/highlights/${userId}/highlights_tray/`
/** `/api/v1/feed/user/<user id>/?count=12&max_id=<cursor>` → a page of posts. Signed-in sessions only. */
export const USER_FEED = '/api/v1/feed/user/'
/** `POST doc_id=…&variables=…` → a Relay query result. */
export const GRAPHQL = '/graphql/query'

export type InstagramQueries = {
  /** One post by shortcode → `data.xdt_shortcode_media` (asks a session nowadays: tried last). */
  readonly post: string
  /** A `web_info` query id to try before the built-in ones (WEB_INFO_QUERIES). */
  readonly webInfo?: string | undefined
  /** A profile's posts, first page → `data.xdt_api__v1__feed__user_timeline_graphql_connection`. */
  readonly profilePosts: string
  /** The next pages of the same connection (`after`, `first`). */
  readonly profilePostsPage: string
}

/** The web client's query ids when this was written. */
export const DEFAULT_QUERIES: InstagramQueries = {
  post: '8845758582119845',
  profilePosts: '9310670392322965',
  profilePostsPage: '7898261790222653',
}

/** Posts per listing page: what the web client asks for. */
export const PAGE_SIZE = 12
