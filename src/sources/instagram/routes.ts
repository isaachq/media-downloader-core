/**
 * What the Instagram source has learned about its own ways in, on this network:
 * how well each route (and each query id inside a route) has been answering,
 * and the query ids and token Instagram's own pages name right now.
 *
 * Nothing here is a copy of another project's bookkeeping: it is the smallest
 * state that lets the source (a) stop asking a route that just refused, without
 * cooling down the whole network, (b) try first what has been working, and
 * (c) forgive a route after a while, so one bad minute doesn't bury it.
 */

/** A route that refused is skipped for this long (doubling per refusal in a row, capped). */
const ROUTE_COOLDOWN_MS = 60_000
const MAX_ROUTE_COOLDOWN_MS = 30 * 60_000
/** Half-life of what a score remembers: after it, a route is halfway back to the prior. */
const HALF_LIFE_MS = 30 * 60_000
/** A route nobody has tried yet, or one forgiven by time. */
const PRIOR = 0.5
/** Weight of the newest outcome. */
const ALPHA = 0.3

type Health = {score: number; at: number; coolUntil: number; refusals: number}

/**
 * A score per key in [0, 1] that decays back to PRIOR with HALF_LIFE_MS, plus
 * a cool-down per key. Decay is applied lazily on read: O(1) per read and per
 * update, O(K) memory for K keys (a handful of routes and query ids).
 */
export class RouteHealth {
  readonly #state = new Map<string, Health>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** The key's score now: the stored one, pulled toward PRIOR by the time since. O(1). */
  score(key: string): number {
    const health = this.#state.get(key)
    if (!health) return PRIOR
    const decay = 2 ** (-(this.#now() - health.at) / HALF_LIFE_MS)
    return PRIOR + (health.score - PRIOR) * decay
  }

  /** Milliseconds the key still sits out (0 when it may be asked). O(1). */
  coolingDownMs(key: string): number {
    const health = this.#state.get(key)
    return health ? Math.max(0, health.coolUntil - this.#now()) : 0
  }

  succeeded(key: string): void {
    this.#update(key, 1)
    const health = this.#state.get(key)!
    health.refusals = 0
    health.coolUntil = 0
  }

  /** A failure that says nothing about the network (a changed page, a query id gone stale). */
  failed(key: string): void {
    this.#update(key, 0)
  }

  /** The route refused (login page, 401 / 403 / 429): it sits out a while; the others go on. */
  refused(key: string): number {
    this.#update(key, 0)
    const health = this.#state.get(key)!
    const wait = Math.min(MAX_ROUTE_COOLDOWN_MS, ROUTE_COOLDOWN_MS * 2 ** health.refusals)
    health.refusals++
    health.coolUntil = this.#now() + wait
    return wait
  }

  /**
   * `items` best first: those not cooling down by score (ties keep their given
   * order, which is the cheapest-first default), then those cooling down, the
   * soonest back first. O(R log R) for R items — R is at most a handful.
   */
  order<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
    const ranked = items.map((item, position) => {
      const key = keyOf(item)
      return {item, position, cooling: this.coolingDownMs(key), score: this.score(key)}
    })
    ranked.sort((a, b) => {
      if (a.cooling > 0 !== b.cooling > 0) return a.cooling > 0 ? 1 : -1
      if (a.cooling > 0) return a.cooling - b.cooling
      // a clear difference decides; near-equal scores keep the default order
      if (Math.abs(a.score - b.score) > 0.05) return b.score - a.score
      return a.position - b.position
    })
    return ranked.map(entry => entry.item)
  }

  #update(key: string, outcome: 0 | 1): void {
    const now = this.#now()
    const current = this.score(key)
    const previous = this.#state.get(key)
    this.#state.set(key, {
      score: current + ALPHA * (outcome - current),
      at: now,
      coolUntil: previous?.coolUntil ?? 0,
      refusals: previous?.refusals ?? 0,
    })
  }
}

/** Query ids a page names are trusted this long; then the built-in list answers again until a page names them anew. */
const DISCOVERED_TTL_MS = 24 * 60 * 60_000
/** The page's LSD token (the anonymous web client's request token) is short-lived. */
const LSD_TTL_MS = 30 * 60_000

/**
 * The query ids Instagram's own post page preloads (`expectedPreloaders`:
 * `queryName` → `queryID`), and the page's LSD token, read from a page the
 * source fetched anyway. Instagram rotates query ids; reading them by name
 * from the page that uses them keeps the source on the current ones without a
 * release. One pass over the page: O(H) for H bytes, once per page read;
 * lookups O(1).
 */
export class QueryBook {
  readonly #ids = new Map<string, {id: string; at: number}>()
  #lsd: {token: string; at: number} | undefined
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Learn what `html` names. Returns how many query ids it named. */
  learn(html: string): number {
    const now = this.#now()
    let named = 0
    for (const match of html.matchAll(PRELOADER)) {
      this.#ids.set(match[2]!, {id: match[1]!, at: now})
      named++
    }
    const lsd = LSD.exec(html)?.[1]
    if (lsd) this.#lsd = {token: lsd, at: now}
    return named
  }

  /** The query id the page last named for `name`, while fresh. */
  id(name: string): string | undefined {
    const known = this.#ids.get(name)
    return known && this.#now() - known.at < DISCOVERED_TTL_MS ? known.id : undefined
  }

  get lsd(): string | undefined {
    return this.#lsd && this.#now() - this.#lsd.at < LSD_TTL_MS ? this.#lsd.token : undefined
  }
}

/** `{"…","queryID":"<digits>","variables":{…},"queryName":"<Name>"}` — variables hold no nested braces here. */
const PRELOADER = /"queryID":"(\d{6,25})","variables":\{[^{}]*\},"queryName":"(\w{1,120})"/g
const LSD = /\["LSD",\[\],\{"token":"([\w-]{8,64})"/

/**
 * The CDN's own expiry of a media link: the `oe` query parameter, unix seconds
 * in hex. Undefined when the link has none. O(L) for the link's length.
 */
export function linkExpiry(url: string): number | undefined {
  const hex = /[?&]oe=([0-9A-Fa-f]{6,10})(?:&|$)/.exec(url)?.[1]
  return hex ? Number.parseInt(hex, 16) * 1000 : undefined
}
