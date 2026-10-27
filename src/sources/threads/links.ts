/**
 * Threads urls in all their shapes, reduced to what they point at:
 *   /@<user>/post/<code>  /@<user>/post/<code>/media  /t/<code>        → post
 *   /@<user>  /@<user>/media  /@<user>/replies  /@<user>/reposts       → profile (its threads)
 * on www.threads.com, threads.com and the old threads.net (which answers a 301
 * to threads.com). No request: everything is in the link. O(L) for its length.
 */
export type ThreadsLink =
  | {readonly kind: 'post'; readonly code: string; readonly user?: string | undefined}
  | {readonly kind: 'profile'; readonly user: string}

/** Public codes are 11 characters; a private account's are longer (40 and more). */
const CODE = /^[A-Za-z0-9_-]{5,80}$/
const USER = /^[\w.]{1,30}$/
/** Tabs of a profile page: each is read as the profile's threads. */
const PROFILE_TABS: ReadonlySet<string> = new Set(['media', 'replies', 'reposts', 'threads'])

export function isThreadsHost(host: string): boolean {
  return (
    host === 'threads.com' || host.endsWith('.threads.com') || host === 'threads.net' || host.endsWith('.threads.net')
  )
}

/** What a url points at, or undefined when it isn't a Threads url this module understands. */
export function parseThreadsLink(raw: string, extraHost?: string): ThreadsLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const host = url.hostname.toLowerCase()
  if (!isThreadsHost(host) && host !== extraHost) return undefined
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  const [first, second, third, fourth] = path.split('/').filter(Boolean)
  if (!first) return undefined
  if (first === 't') return second && CODE.test(second) && !third ? {kind: 'post', code: second} : undefined
  if (!first.startsWith('@')) return undefined
  const user = first.slice(1)
  if (!USER.test(user)) return undefined
  if (!second) return {kind: 'profile', user}
  if (PROFILE_TABS.has(second) && !third) return {kind: 'profile', user}
  if (second === 'post' && third && CODE.test(third) && (fourth === undefined || fourth === 'media')) {
    return {kind: 'post', code: third, user}
  }
  return undefined
}

/** The canonical link of a post (the one the site redirects every other shape to). */
export function postUrl(origin: string, code: string, user?: string): string {
  return user ? `${origin}/@${user}/post/${code}` : `${origin}/t/${code}`
}

export function profileUrl(origin: string, user: string): string {
  return `${origin}/@${user}`
}

/** A listing url (a profile): batches cap these unless told otherwise. */
export function isThreadsListing(url: string): boolean {
  return parseThreadsLink(url)?.kind === 'profile'
}
