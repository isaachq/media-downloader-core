/**
 * Where Snapchat's public web pages are, as this module reads them.
 * Everything site-specific that is not a key of the page's JSON lives here,
 * so a change on Snapchat's side is a change in one file, and a host can
 * override any entry (`SnapchatOptions.endpoints`) without waiting for a
 * release.
 *
 * Verified live on 2026-10-26 (anonymous, desktop Chrome user agent, from
 * Mexico; samples in `.local/snapchat/`, served by test/helpers/fake-snapchat.ts):
 *  - every public page is a Next.js page with its data in
 *    `<script id="__NEXT_DATA__" type="application/json">`; the build ids
 *    change often and are irrelevant (the HTML is read, never `_next/data`,
 *    which answers 404);
 *  - the routes moved once already (`/add/<u>` → `/@<u>` in 2025): the old
 *    ones answer a 308 to the new ones, `story.snapchat.com/s/<u>` a 301 to
 *    `/add/<u>`, `/spotlight/<id>` a 301 to `/@<creator>/spotlight/<id>`.
 */

export type SnapchatEndpoints = {
  /** The site's pages. */
  readonly origin: string
  /** What opens the page's data script (located with indexOf, never a regular expression over the page). */
  readonly nextDataMarker: string
  /** A public profile: its live story, curated highlights and spotlights. */
  readonly profilePath: (user: string) => string
  /** One snap of a live story (a profile page that names the snap). */
  readonly snapPath: (user: string, snapId: string) => string
  /** One curated highlight. */
  readonly highlightPath: (user: string, highlightId: string) => string
  /** One spotlight; without the creator Snapchat redirects to the page with it. */
  readonly spotlightPath: (id: string, user?: string) => string
  /** A short link on the main host (`snapchat.com/t/<code>`). */
  readonly shortPath: (code: string) => string
}

export const SNAPCHAT_ORIGIN = 'https://www.snapchat.com'

const at = (user: string) => `/@${encodeURIComponent(user)}`

/** O(1) string construction each. */
export const DEFAULT_ENDPOINTS: SnapchatEndpoints = {
  origin: SNAPCHAT_ORIGIN,
  nextDataMarker: 'id="__NEXT_DATA__"',
  profilePath: user => at(user),
  snapPath: (user, snapId) => `${at(user)}/${encodeURIComponent(snapId)}`,
  highlightPath: (user, highlightId) => `${at(user)}/highlight/${encodeURIComponent(highlightId)}`,
  spotlightPath: (id, user) => `${user ? at(user) : ''}/spotlight/${encodeURIComponent(id)}`,
  shortPath: code => `/t/${encodeURIComponent(code)}`,
}
