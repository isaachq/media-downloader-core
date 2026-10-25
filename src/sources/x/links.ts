/**
 * X (Twitter) urls in all their shapes, reduced to what they point at:
 *   /<user>/status/<id>  /<user>/statuses/<id>  /i/status/<id>  /i/web/status/<id>  /statuses/<id>   → post
 *   …/status/<id>/video/<n>                                                                          → that video only
 *   …/status/<id>/photo/<n>  …/status/<id>/<anything else>  ?s=20&t=…  #!/<user>/status/<id>           → post
 *   /<user>  /<user>/media  /<user>/with_replies…                                                    → profile (not read)
 *   t.co/<x>                                                                                          → short link (a redirect)
 * on x.com, twitter.com and their www / mobile / m / lite hosts, and the embed
 * fixers people share instead (fxtwitter, vxtwitter, fixupx, fixvx).
 */
export type XLink =
  | {
      readonly kind: 'post'
      readonly id: string
      readonly user?: string | undefined
      /** `/video/<n>`: the n-th video of the post (1-based), alone. */
      readonly index?: number | undefined
    }
  | {readonly kind: 'profile'; readonly user: string}
  | {readonly kind: 'short'; readonly url: string}

export const X_ORIGIN = 'https://x.com'

const ID = /^\d{1,20}$/
const USER = /^\w{1,50}$/
const INDEX = /^[1-9]\d{0,1}$/
const SHORT = /^[\w-]{4,30}$/
const SITES = ['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com']
const PREFIXES = ['', 'www.', 'mobile.', 'm.', 'lite.']
const HOSTS: ReadonlySet<string> = new Set(SITES.flatMap(site => PREFIXES.map(prefix => prefix + site)))
/** First path segments that are pages of the site, not accounts. */
const RESERVED = new Set([
  'i',
  'home',
  'explore',
  'search',
  'notifications',
  'messages',
  'settings',
  'login',
  'logout',
  'signup',
  'tos',
  'privacy',
  'intent',
  'share',
  'hashtag',
  'compose',
  'account',
  'download',
  'jobs',
])

export function isXHost(host: string): boolean {
  return HOSTS.has(host)
}

/**
 * What a url points at, or undefined when it isn't an X url this module
 * understands. `extraHost`: tests serve "X" from another host. O(length of the url).
 */
export function parseXLink(raw: string, extraHost?: string): XLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const host = url.hostname.toLowerCase()
  if (host === 't.co') {
    const code = url.pathname.slice(1).replace(/\/$/, '')
    return SHORT.test(code) ? {kind: 'short', url: `https://t.co/${code}`} : undefined
  }
  if (!isXHost(host) && host !== extraHost) return undefined
  // the old web client kept the page in the fragment: twitter.com/#!/<user>/status/<id>
  const path = url.hash.startsWith('#!/') ? url.hash.slice(2) : url.pathname
  const parts = path.split('/').filter(Boolean)
  const [first, second, third, fourth, fifth] = parts
  if (!first) return undefined

  // /i/status/<id>  /i/web/status/<id>
  if (first === 'i') {
    const at = second === 'web' ? 3 : 2
    if (parts[at - 1] !== 'status' || !ID.test(parts[at] ?? '')) return undefined
    return post(parts[at]!, undefined, parts[at + 1], parts[at + 2])
  }
  // /statuses/<id>
  if (first === 'statuses') return second && ID.test(second) ? post(second, undefined, third, fourth) : undefined
  if (RESERVED.has(first) || !USER.test(first)) return undefined
  if (second === 'status' || second === 'statuses') {
    return third && ID.test(third) ? post(third, first, fourth, fifth) : undefined
  }
  return {kind: 'profile', user: first}
}

function post(id: string, user: string | undefined, media?: string, n?: string): XLink {
  const index = media === 'video' && n && INDEX.test(n) ? Number(n) : undefined
  return {kind: 'post', id, ...(user && {user}), ...(index && {index})}
}

/** A post's public page (`/i/status/<id>` when the account isn't known: X redirects it). */
export function postUrl(id: string, user?: string, origin = X_ORIGIN): string {
  return `${origin}/${user ?? 'i'}/status/${id}`
}

/** The page of the n-th video of a post: what each entry of a post with several videos points at. */
export function videoUrl(id: string, user: string | undefined, index: number, origin = X_ORIGIN): string {
  return `${postUrl(id, user, origin)}/video/${index}`
}

/** A profile link (x.com/user): not a post. X's profiles are not read here; a mix list leaves them out as lists. */
export function isXProfile(url: string): boolean {
  return parseXLink(url)?.kind === 'profile'
}
