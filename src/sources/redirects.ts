/** Hops a share link may take before it is given up on: apps chain a tracker or two, never more. */
export const MAX_HOPS = 5

/** Query parameters a login / consent page carries the page it was asked for in. */
const RETURN_PARAMS = ['next', 'redirect_url', 'redirect', 'u', 'url'] as const

export type Followed<T> =
  | {readonly ok: true; readonly link: T; readonly resolvedUrl: string; readonly hops: number}
  | {readonly ok: false; readonly reason: 'dead-end' | 'loop'; readonly resolvedUrl: string; readonly hops: number}

/**
 * Follow a share link's redirects (opaque mobile links: fb.watch, /share/r/,
 * vm.tiktok.com…) until one lands on a link `parse` resolves (a post, a
 * profile: anything but another short link). At most MAX_HOPS requests, each
 * url once (a loop is named as such). A hop to a login or consent page is read for the page it
 * was asked for (`?next=…`): an anonymous visitor's share link often goes
 * there first, and the post it names is still public.
 *
 * `hop` makes one request without following and returns its Location (or
 * undefined: not a redirect). `maxHops` caps the requests below MAX_HOPS for a
 * site whose share links are known to be short. O(hops) requests, O(hops) memory.
 */
export async function followShortLink<T>(
  start: string,
  hop: (url: string) => Promise<string | undefined>,
  parse: (url: string) => T | undefined,
  maxHops = MAX_HOPS,
): Promise<Followed<T>> {
  const seen = new Set<string>([start])
  let url = start
  const cap = Math.min(maxHops, MAX_HOPS)
  for (let hops = 1; hops <= cap; hops++) {
    const location = await hop(url)
    if (!location) return {ok: false, reason: 'dead-end', resolvedUrl: url, hops}
    const target = new URL(location, url).href
    for (const candidate of [target, returnUrlOf(target)]) {
      if (!candidate) continue
      const link = parse(candidate)
      if (link !== undefined) return {ok: true, link, resolvedUrl: candidate, hops}
    }
    if (seen.has(target)) return {ok: false, reason: 'loop', resolvedUrl: target, hops}
    seen.add(target)
    url = target
  }
  return {ok: false, reason: 'loop', resolvedUrl: url, hops: cap}
}

/** The page a login / consent redirect was asked for, when it says (`/login/?next=https%3A…`). */
export function returnUrlOf(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  for (const name of RETURN_PARAMS) {
    const value = parsed.searchParams.get(name)
    if (!value) continue
    try {
      // relative (`next=/reel/1/`) or absolute; only http(s)
      const target = new URL(value, parsed.origin)
      if (target.protocol === 'https:' || target.protocol === 'http:') return target.href
    } catch {}
  }
  return undefined
}

/** The message of a link that could not be resolved, by why. */
export function unresolvedMessage(reason: 'dead-end' | 'loop'): string {
  return reason === 'loop'
    ? 'This short link goes round in circles (a redirect loop).'
    : 'This short link leads nowhere.'
}

/** A parsed link unless it is another short link (one more hop to go). */
export function resolved<T extends {readonly kind: string}>(
  link: T | undefined,
): Exclude<T, {kind: 'short'}> | undefined {
  return link && link.kind !== 'short' ? (link as Exclude<T, {kind: 'short'}>) : undefined
}
