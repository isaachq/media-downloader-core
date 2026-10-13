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

/** `?username=<user>` → the account, its counts and its first posts. */
export const PROFILE_INFO = '/api/v1/users/web_profile_info/'
/** `?reel_ids=<user id>` (or `highlight:<id>`) → the current stories. Signed-in sessions only. */
export const REELS_MEDIA = '/api/v1/feed/reels_media/'
/** `/api/v1/feed/user/<user id>/?count=12&max_id=<cursor>` → a page of posts. Signed-in sessions only. */
export const USER_FEED = '/api/v1/feed/user/'
/** `POST doc_id=…&variables=…` → a Relay query result. */
export const GRAPHQL = '/graphql/query'

export type InstagramQueries = {
  /** One post by shortcode → `data.xdt_shortcode_media`. */
  readonly post: string
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
