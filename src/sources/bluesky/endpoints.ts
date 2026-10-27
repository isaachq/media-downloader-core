/**
 * Where Bluesky's public data lives, as this module reads it. Everything
 * site-specific that is not a key of the JSON lives here, so a change on
 * Bluesky's side is a change in one file, and a host can override any entry
 * (`BlueskyOptions.endpoints`) without waiting for a release.
 *
 * Verified live on 2026-10-26 (anonymous, from Mexico; samples in
 * `.local/bluesky/`, served by test/helpers/fake-bluesky.ts):
 *  - the AppView (`public.api.bsky.app`) answers every read here without a
 *    session: getPostThread (a handle works in the at-uri), getPosts (25
 *    at-uris a request, DIDs only: a handle in one is a 500), getProfile,
 *    getAuthorFeed (100 a page at most, an ISO cursor, no `cursor` key on
 *    the last page) and resolveHandle. No rate limit headers;
 *  - a file's original bytes are a blob on the author's own server (PDS):
 *    `com.atproto.sync.getBlob?did=&cid=`, its address in the DID document
 *    (plc.directory for did:plc, `/.well-known/did.json` for did:web). A PDS
 *    allows 3000 requests per 5 minutes per IP (`ratelimit-*` headers) and
 *    ignores Range (a 200 with the whole body);
 *  - the image CDN's `feed_fullsize` is a WebP re-encode (115 KB for a 1.6 MB
 *    JPEG): only the fallback when the PDS can't answer.
 */

export type BlueskyEndpoints = {
  /** The public AppView: posts, profiles, feeds, handles. */
  readonly appView: string
  /** The did:plc directory. */
  readonly plc: string
  /** A did:web's document (`did:web:<host>` → its well-known DID document). */
  readonly didWebDocument: (host: string) => string
  /** A picture's full-size re-encode on the CDN, when the author's PDS can't give the original. */
  readonly imageCdn: (did: string, cid: string) => string
  /** getAuthorFeed's filter for a profile: the author's own posts with a picture or a video (replies included). */
  readonly feedFilter: string
}

/** O(1) string construction each. */
export const DEFAULT_ENDPOINTS: BlueskyEndpoints = {
  appView: 'https://public.api.bsky.app',
  plc: 'https://plc.directory',
  didWebDocument: host => `https://${host}/.well-known/did.json`,
  imageCdn: (did, cid) => `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`,
  feedFilter: 'posts_with_media',
}

/** The web app, for the links handed back (entries, playlists). */
export const BLUESKY_ORIGIN = 'https://bsky.app'

export const XRPC = {
  postThread: 'app.bsky.feed.getPostThread',
  posts: 'app.bsky.feed.getPosts',
  authorFeed: 'app.bsky.feed.getAuthorFeed',
  profile: 'app.bsky.actor.getProfile',
  resolveHandle: 'com.atproto.identity.resolveHandle',
  blob: 'com.atproto.sync.getBlob',
} as const

/** getAuthorFeed's page size (its maximum: 101 is a 400). */
export const FEED_PAGE = 100
/** getPosts' at-uris per request (the lexicon's maximum). */
export const POSTS_PER_REQUEST = 25
/** The self-label an account sets to stay hidden from signed-out visitors (the web app honours it; so does this). */
export const NO_UNAUTHENTICATED = '!no-unauthenticated'
