/**
 * Snapchat urls in all their shapes, reduced to what they point at:
 *   /spotlight/<id>  /@<u>/spotlight/<id>  /add/<u>/spotlight/<id>          → one spotlight (a video)
 *   /@<u>  /add/<u>  story.snapchat.com/s/<u>  story.snapchat.com/@<u>      → a public profile (a playlist)
 *   /@<u>/stories  /@<u>/highlights  /@<u>/spotlights                         → the same profile, one kind of item
 *   /@<u>/<snapId>  /add/<u>/<snapId>  (an id of 20+ characters)             → one snap of the live story
 *   /@<u>/highlight/<id>                                                       → a curated highlight (a playlist)
 *   /@<u>/highlight/<id>/<n>                                                   → its n-th snap (an entry of a listing)
 *   snapchat.com/t/<code>  t.snapchat.com/<code>                               → short link (a redirect)
 * on snapchat.com and its www / m / story / t hosts. A highlight's snaps have
 * no ids of their own on the site: `/<n>` is this library's name for one of
 * them (the web has no page per snap; the highlight's page is what is read).
 * Pure and O(length of the url).
 */
export type SnapchatLink =
  | {readonly kind: 'spotlight'; readonly id: string; readonly user?: string | undefined}
  | {readonly kind: 'profile'; readonly user: string; readonly section?: ProfileSection | undefined}
  | {readonly kind: 'snap'; readonly user: string; readonly id: string}
  | {
      readonly kind: 'highlight'
      readonly user: string
      readonly id: string
      /** One snap of the highlight (1-based), alone. */
      readonly index?: number | undefined
    }
  | {readonly kind: 'short'; readonly url: string}

/** A profile page narrowed to one kind of item (the site serves the same data for each). */
export type ProfileSection = 'stories' | 'highlights' | 'spotlights'

export const SNAPCHAT_PUBLIC_ORIGIN = 'https://www.snapchat.com'

const USER = /^[a-z0-9][\w.-]{0,39}$/i
/** Spotlight and snap ids: url-safe base64, 59 characters when this was written. */
const ID = /^[\w-]{20,200}$/
const HIGHLIGHT = /^[\w-]{8,64}$/
const INDEX = /^[1-9]\d{0,3}$/
const SHORT = /^[\w-]{4,40}$/
const MAIN_HOSTS: ReadonlySet<string> = new Set(['snapchat.com', 'www.snapchat.com', 'm.snapchat.com'])
const SECTIONS: ReadonlySet<string> = new Set(['stories', 'highlights', 'spotlights'])

export function isSnapchatHost(host: string): boolean {
  return MAIN_HOSTS.has(host) || host === 'story.snapchat.com' || host === 't.snapchat.com'
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** What a url points at, or undefined when it isn't a Snapchat url this module understands. */
export function parseSnapchatLink(raw: string): SnapchatLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean).map(decoded)
  const [first, second] = parts
  if (!first) return undefined
  if (host === 't.snapchat.com') {
    return SHORT.test(first) && parts.length === 1 ? {kind: 'short', url: `https://t.snapchat.com/${first}`} : undefined
  }
  if (host === 'story.snapchat.com') {
    if (first === 's') return second && USER.test(second) ? {kind: 'profile', user: second} : undefined
    return first.startsWith('@') ? ofUser(first.slice(1), parts.slice(1)) : undefined
  }
  if (!MAIN_HOSTS.has(host)) return undefined
  if (first === 't') {
    return second && SHORT.test(second) ? {kind: 'short', url: `${SNAPCHAT_PUBLIC_ORIGIN}/t/${second}`} : undefined
  }
  if (first === 'spotlight') return second && ID.test(second) ? {kind: 'spotlight', id: second} : undefined
  if (first === 'add') return second ? ofUser(second, parts.slice(2)) : undefined
  if (first.startsWith('@')) return ofUser(first.slice(1), parts.slice(1))
  return undefined
}

/** What follows an account in the path. */
function ofUser(user: string, rest: readonly string[]): SnapchatLink | undefined {
  if (!USER.test(user)) return undefined
  const [what, id, n] = rest
  if (!what) return {kind: 'profile', user}
  if (what === 'spotlight') return id && ID.test(id) ? {kind: 'spotlight', id, user} : undefined
  if (what === 'highlight') {
    if (!id || !HIGHLIGHT.test(id)) return undefined
    return {kind: 'highlight', user, id, ...(n && INDEX.test(n) && {index: Number(n)})}
  }
  if (SECTIONS.has(what)) return {kind: 'profile', user, section: what as ProfileSection}
  return ID.test(what) && rest.length === 1 ? {kind: 'snap', user, id: what} : undefined
}

/** The public page a link names (what an entry of a listing points at). O(1). */
export function snapchatUrl(link: Exclude<SnapchatLink, {kind: 'short'}>, origin = SNAPCHAT_PUBLIC_ORIGIN): string {
  const at = (user: string) => `${origin}/@${encodeURIComponent(user)}`
  switch (link.kind) {
    case 'spotlight':
      return `${link.user ? at(link.user) : origin}/spotlight/${encodeURIComponent(link.id)}`
    case 'profile':
      return `${at(link.user)}${link.section ? `/${link.section}` : ''}`
    case 'snap':
      return `${at(link.user)}/${encodeURIComponent(link.id)}`
    case 'highlight':
      return `${at(link.user)}/highlight/${encodeURIComponent(link.id)}${link.index ? `/${link.index}` : ''}`
  }
}

/** A profile or a whole highlight: a list, not one item (a mix list takes single items). */
export function isSnapchatListing(url: string): boolean {
  const link = parseSnapchatLink(url)
  return link?.kind === 'profile' || (link?.kind === 'highlight' && link.index === undefined)
}
