/**
 * Where Facebook's own web client gets its data, as this module uses it.
 * Everything site-specific that is not a page url lives here.
 *
 * Status of each entry when this was written (October 2026 build, from the
 * web client and yt-dlp's extractor; NOT re-verified against the live site
 * from this build — the local fake in test/helpers/fake-facebook.ts serves
 * exactly these shapes):
 *  - Video pages embed their video (`playable_url`, `browser_native_*_url`,
 *    `videoDeliveryLegacyFields`, `videoDeliveryResponseFragment`) in
 *    `data-sjs` scripts: the shape yt-dlp reads, stable for years.
 *  - GRAPHQL and the listing query id: the Relay pagination the web client
 *    sends while scrolling a page's Videos tab; it needs the page's `fb_dtsg`
 *    and `lsd` tokens (read from the page) and Facebook rotates the id now and
 *    then. A query that stops answering leaves the listing at what the page
 *    itself showed (`complete: false`), never fails it.
 */

/** `POST fb_dtsg=…&lsd=…&doc_id=…&variables=…` → a Relay query result. */
export const GRAPHQL = '/api/graphql/'

export type FacebookQueries = {
  /** The next page of a profile's videos collection (`cursor`, `count`, `id`). */
  readonly profileVideosPage: string
}

/** The web client's query id when this was written. */
export const DEFAULT_QUERIES: FacebookQueries = {
  profileVideosPage: '8191727517565573',
}

/** Videos per listing page: what the web client asks for while scrolling. */
export const PAGE_SIZE = 8
