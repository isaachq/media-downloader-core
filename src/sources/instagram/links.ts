/**
 * Instagram urls in all their shapes, reduced to what they point at:
 *   /p/<code>/  /reel/<code>/  /reels/<code>/  /tv/<code>/  /<user>/p|reel|reels|tv/<code>/   → post
 *   /<user>/  /<user>/reels/                                                   → profile
 *   /stories/<user>/  /stories/<user>/<id>/                                     → stories (one item with an id)
 *   /stories/highlights/<id>/  /s/<token>?story_media_id=…                      → highlight
 *   /share/<x>  /share/p/<x>  /share/reel/<x>                                   → short link (a redirect)
 */
export type InstagramLink =
  | {readonly kind: 'post'; readonly code: string; readonly user?: string | undefined}
  | {readonly kind: 'profile'; readonly user: string}
  | {readonly kind: 'stories'; readonly user: string; readonly id?: string | undefined}
  | {readonly kind: 'highlight'; readonly id: string}
  | {readonly kind: 'short'; readonly url: string}

const CODE = /^[A-Za-z0-9_-]{5,40}$/
const USER = /^[\w.]{1,30}$/
const ID = /^\d{1,25}$/
/** First path segments that are not user names. */
const RESERVED = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'explore',
  'accounts',
  'direct',
  'about',
  'developer',
  'legal',
  'api',
  'graphql',
  'challenge',
  'share',
  's',
  'web',
  'static',
  'oauth',
  'privacy',
  'terms',
  'emails',
  'nametag',
  'ar',
  'lite',
  'embed.js',
])

export function isInstagramHost(host: string): boolean {
  return host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am'
}

/** What a url points at, or undefined when it isn't an Instagram url this module understands. */
export function parseInstagramLink(raw: string, extraHost?: string): InstagramLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (!isInstagramHost(host) && host !== extraHost) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  const [first, second, third] = parts
  if (!first) return undefined

  if (first === 'share') return parts.length >= 2 ? {kind: 'short', url: url.href} : undefined
  if (first === 's') {
    const id = url.searchParams.get('story_media_id')?.split('_', 1)[0]
    return second && id && ID.test(id) ? {kind: 'highlight', id} : second ? {kind: 'short', url: url.href} : undefined
  }
  if (first === 'p' || first === 'reel' || first === 'reels' || first === 'tv') {
    return second && CODE.test(second) ? {kind: 'post', code: second} : undefined
  }
  if (first === 'stories') {
    if (second === 'highlights') return third && ID.test(third) ? {kind: 'highlight', id: third} : undefined
    if (!second || !USER.test(second)) return undefined
    return third
      ? ID.test(third)
        ? {kind: 'stories', user: second, id: third}
        : undefined
      : {kind: 'stories', user: second}
  }
  if (RESERVED.has(first) || !USER.test(first)) return undefined
  if (!second || (second === 'reels' && !third) || second === 'feed') return {kind: 'profile', user: first}
  if ((second === 'p' || second === 'reel' || second === 'reels' || second === 'tv') && third && CODE.test(third))
    return {kind: 'post', code: third, user: first}
  return undefined
}

export function postUrl(origin: string, code: string): string {
  return `${origin}/p/${code}/`
}

export function profileUrl(origin: string, user: string): string {
  return `${origin}/${user}/`
}

export function storiesUrl(origin: string, user: string, id?: string): string {
  return id ? `${origin}/stories/${user}/${id}/` : `${origin}/stories/${user}/`
}

export function highlightUrl(origin: string, id: string): string {
  return `${origin}/stories/highlights/${id}/`
}

/** A listing url (a profile, stories, a highlight): batches cap these unless told otherwise. */
export function isInstagramListing(url: string): boolean {
  const kind = parseInstagramLink(url)?.kind
  return kind === 'profile' || kind === 'stories' || kind === 'highlight'
}
