/**
 * A different request shape for each try of one url, and nothing else.
 *
 * `n` is one post. `variantFor` runs once per try, and a post gets at most
 * five anonymous tries: O(1) time (one pass over a fixed route list and the
 * url's characters) and O(1) memory. The function keeps no map and no score.
 * The same url and the same attempt always return the same variant.
 */

/** Anonymous tries of one public post before the user's session is asked for. */
export const ANONYMOUS_ATTEMPTS = 5
/** Tries with the user's session, after the anonymous ones could not read it. */
export const SESSION_ATTEMPTS = 3
/** How long to tell the caller to wait once those session tries are spent, in seconds. */
export const SESSION_EXHAUSTED_SECONDS = 5 * 60

/**
 * Five fixed languages, one per anonymous try. Attempt 1 keeps the language
 * the post page already sent. Not a list of user agents.
 */
const ACCEPT_LANGUAGE = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'es-MX,es;q=0.9,en;q=0.8',
  'pt-BR,pt;q=0.9,en;q=0.8',
  'fr-FR,fr;q=0.9,en;q=0.8',
] as const

/** The pause between two tries of the same post: 300 to 800 ms. Tests pass `random`. */
const PAUSE_MIN_MS = 300
const PAUSE_SPAN_MS = 500

export interface RetryVariant {
  readonly id: string
  readonly attempt: number
  /** Secondary headers only. The source keeps each route's own required headers. */
  readonly headers: Readonly<Record<string, string>>
  /** `routes`, rotated left by `attempt - 1`. Attempt 1 is `routes` as given. */
  readonly routeOrder: readonly string[]
}

/**
 * The variant for this url and this attempt (1-based). `routes` is the
 * source's own list, cheapest first; it is not stored. O(1): the list is a
 * handful of doors and the url is one link.
 */
export function variantFor(url: string, attempt: number, routes: readonly string[]): RetryVariant {
  const index = Math.max(0, attempt - 1)
  return {
    id: fnv1a32(`${url}\n${attempt}`).toString(36),
    attempt,
    headers: {'Accept-Language': ACCEPT_LANGUAGE[index % ACCEPT_LANGUAGE.length] ?? 'en-US,en;q=0.9'},
    routeOrder: rotate(routes, index),
  }
}

/** Milliseconds to wait before the next try. `random` in [0, 1). O(1). */
export function betweenAttemptsMs(random: () => number = Math.random): number {
  const roll = random()
  const unit = roll < 0 ? 0 : roll > 1 ? 1 : roll
  return PAUSE_MIN_MS + Math.floor(unit * (PAUSE_SPAN_MS + 1))
}

/** FNV-1a, 32 bits. One pass over the string: O(length), and a url's length is bounded. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Left rotate by `by` places. `routes` has a fixed handful of entries: O(1). */
function rotate(routes: readonly string[], by: number): readonly string[] {
  const count = routes.length
  if (count === 0) return []
  const shift = by % count
  if (shift === 0) return routes.slice()
  const order = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    const route = routes[(i + shift) % count]
    if (route !== undefined) order[i] = route
  }
  return order
}
