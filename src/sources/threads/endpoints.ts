/**
 * Where Threads' own web client gets its data, as this module uses it.
 * Everything site-specific that is not a key of the JSON lives here, so a
 * change on Threads' side is a change in one file — and a host can override
 * the query names and ids (`ThreadsOptions.queries`) without waiting for a
 * release.
 *
 * Verified live on 2026-10-26 (anonymous, desktop Chrome user agent, from
 * Mexico; samples in `.local/threads/`, served by test/helpers/fake-threads.ts):
 *  - a post page or a profile page is served with its data only to a page
 *    load (`Sec-Fetch-Mode: navigate`); asked as Node's fetch asks
 *    (`cors`), it is a gating shell with no data. Hence `navigationFetch`;
 *  - the page embeds its queries' results as Relay preloaders
 *    (`adp_<QueryName>RelayPreloader_<hash>` → `__bbox.result`), the query
 *    ids and variables its client sent (`queryID`, `variables`, `queryName`),
 *    and the LSD token its client echoes (`["LSD",[],{"token":…}]`);
 *  - the profile's next pages: `POST /api/graphql` with the page's LSD, the
 *    threads tab's `doc_id` and its variables plus `first` / `after`,
 *    10 threads a page (the server caps `first` at ~15). The first cursor is
 *    GraphQL's own: the page's (base64-wrapped) cursor is ignored by the site.
 */

export const THREADS_ORIGIN = 'https://www.threads.com'

/** The Barcelona (Threads) web app's id, sent as X-IG-App-ID (also in the page as APP_ID). */
export const APP_ID = '238260118697367'
/** Where the web client sends its queries (with the page's LSD token). */
export const API_GRAPHQL = '/api/graphql'

export type ThreadsQueries = {
  /** The post page's preloaded query → `data.media`, the post (a v1 item). */
  readonly post: string
  /** The profile page's preloaded query → `data.user`. */
  readonly profile: string
  /** The profile's threads tab → `data.mediaData.edges[].node.thread_items[].post` + `page_info`. */
  readonly threadsTab: string
  /**
   * The threads tab's `doc_id` when the page names none. The page's own is
   * used otherwise, unless a host sets this through `ThreadsOptions.queries`
   * (then the host's wins).
   */
  readonly threadsTabId: string
}

/** The web client's query names and ids when this was written. */
export const DEFAULT_QUERIES: ThreadsQueries = {
  post: 'BarcelonaPostPageTargetQuery',
  profile: 'BarcelonaProfilePageDirectQuery',
  threadsTab: 'BarcelonaProfileThreadsTabDirectQuery',
  threadsTabId: '29174122042225760',
}

/** Threads per listing page: what the web client asks for. */
export const PAGE_SIZE = 10

/**
 * The threads tab's variables when the page names none (only `userID` is
 * filled in): the Relay providers its client sent on 2026-10-26, logged out.
 */
export const DEFAULT_TAB_VARIABLES: Readonly<Record<string, unknown>> = {
  allow_page_info_for_lox_user: true,
  __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
  __relay_internal__pv__BarcelonaShouldFetchPostAuthorFullNamerelayprovider: false,
  __relay_internal__pv__BarcelonaHasProfileSelfReplyContextrelayprovider: false,
  __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
  __relay_internal__pv__BarcelonaHasBestOfThreadsrelayprovider: true,
  __relay_internal__pv__BarcelonaHasCommunitiesrelayprovider: true,
}
