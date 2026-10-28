/**
 * SoundCloud urls in all their shapes, reduced to what they point at:
 *   /<user>/<track>[/s-<token>]           (…/recommended, …/likes, …/sets, …/reposts)  → track
 *   /<user>/sets/<set>[/s-<token>]                                                     → set
 *   /<user>  /<user>/tracks                                                            → profile: its tracks
 *   /<user>/likes   /<user>/sets   /<user>/albums                                      → profile: that tab
 *   on.soundcloud.com/<code>                                                           → short (≤ 3 hops)
 *   w.soundcloud.com/player/?url=<a link above>                                        → that link
 * on soundcloud.com, www. and m. (the API answers 404 to m.: links are read
 * back as soundcloud.com). Reposts, followers, comments, stations, search and
 * the API's own urls are not read here. No request: everything is in the
 * link. O(L) for its length.
 */
export type SoundcloudLink =
  | {readonly kind: 'track'; readonly user: string; readonly slug: string; readonly secret?: string | undefined}
  | {readonly kind: 'set'; readonly user: string; readonly slug: string; readonly secret?: string | undefined}
  | {readonly kind: 'profile'; readonly user: string; readonly tab: ProfileTab}
  | {readonly kind: 'short'; readonly url: string}

export type ProfileTab = 'tracks' | 'likes' | 'sets' | 'albums'

const HOSTS: ReadonlySet<string> = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'])
const SHORT_HOST = 'on.soundcloud.com'
const EMBED_HOST = 'w.soundcloud.com'
/** A user's or a track's permalink. */
const PERMALINK = /^[A-Za-z0-9_-]{1,255}$/
/** A private link's token. */
const SECRET = /^s-[A-Za-z0-9]{3,64}$/
const SHORT_CODE = /^[A-Za-z0-9]{4,64}$/
/** First path segments that are the site's own pages, not users. */
const RESERVED: ReadonlySet<string> = new Set([
  'discover',
  'search',
  'stream',
  'you',
  'upload',
  'charts',
  'stations',
  'pages',
  'settings',
  'mobile',
  'jobs',
  'terms-of-use',
  'people',
  'tags',
  'notifications',
  'messages',
  'imprint',
  'popular',
  'logout',
  'signin',
  'signup',
  'connect',
  'pro',
  'go',
  'artists',
  'creators',
  'home',
  'feed',
  'library',
  'playlists',
  'tracks',
  'explore',
  'premium',
  'checkout',
  'oauth',
  'player',
])
/** A profile's tabs read here. */
const TABS: ReadonlySet<string> = new Set(['tracks', 'likes', 'sets', 'albums'])
/** A profile's other pages: not tracks, not read here. */
const OTHER_PAGES: ReadonlySet<string> = new Set([
  'reposts',
  'popular-tracks',
  'followers',
  'following',
  'comments',
  'spotlight',
  'toptracks',
])
/** Pages of one track: the track itself. */
const TRACK_PAGES: ReadonlySet<string> = new Set(['recommended', 'likes', 'sets', 'reposts', 'comments'])

/** What a url points at, or undefined when it isn't a SoundCloud url this module understands. */
export function parseSoundcloudLink(raw: string): SoundcloudLink | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const host = url.hostname.toLowerCase()
  let parts: string[]
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return undefined
  }
  if (host === SHORT_HOST) {
    const [code, ...rest] = parts
    return code && SHORT_CODE.test(code) && rest.length === 0
      ? {kind: 'short', url: `https://${SHORT_HOST}/${code}`}
      : undefined
  }
  if (host === EMBED_HOST) {
    const inner = url.searchParams.get('url')
    if (!inner || parts[0] !== 'player') return undefined
    const link = parseSoundcloudLink(inner)
    if (!link || link.kind === 'short' || link.kind === 'profile') return link
    const secret = link.secret ?? secretOf(url.searchParams.get('secret_token'))
    return secret ? {...link, secret} : link
  }
  if (!HOSTS.has(host)) return undefined
  const [user, second, third, fourth, ...rest] = parts
  if (!user || !PERMALINK.test(user) || RESERVED.has(user.toLowerCase())) return undefined
  if (second === undefined) return {kind: 'profile', user, tab: 'tracks'}
  if (TABS.has(second) && third === undefined) return {kind: 'profile', user, tab: second as ProfileTab}
  if (OTHER_PAGES.has(second)) return undefined
  if (second === 'sets') {
    if (!third || !PERMALINK.test(third) || rest.length > 0) return undefined
    if (fourth === undefined) return {kind: 'set', user, slug: third}
    const secret = secretOf(fourth)
    return secret ? {kind: 'set', user, slug: third, secret} : undefined
  }
  if (!PERMALINK.test(second) || rest.length > 0) return undefined
  if (third === undefined) return {kind: 'track', user, slug: second}
  const secret = secretOf(third)
  if (secret)
    return fourth === undefined || TRACK_PAGES.has(fourth) ? {kind: 'track', user, slug: second, secret} : undefined
  return TRACK_PAGES.has(third) && fourth === undefined ? {kind: 'track', user, slug: second} : undefined
}

const secretOf = (raw: string | null | undefined): string | undefined => (raw && SECRET.test(raw) ? raw : undefined)

/** The page the API resolves: on soundcloud.com, without the query (tracking) or the page's tab. O(L). */
export function canonicalUrl(origin: string, link: Exclude<SoundcloudLink, {kind: 'short'}>): string {
  const base = origin.replace(/\/+$/, '')
  switch (link.kind) {
    case 'track':
      return `${base}/${link.user}/${link.slug}${link.secret ? `/${link.secret}` : ''}`
    case 'set':
      return `${base}/${link.user}/sets/${link.slug}${link.secret ? `/${link.secret}` : ''}`
    case 'profile':
      return `${base}/${link.user}`
  }
}

/** The key a track or a set is known by in memory: `<user>/<slug>`, lower case (permalinks are). O(L). */
export function keyOf(user: string, slug: string): string {
  return `${user.toLowerCase()}/${slug.toLowerCase()}`
}

/** A listing url (a profile or a set): batches cap these unless told otherwise. */
export function isSoundcloudListing(url: string): boolean {
  const kind = parseSoundcloudLink(url)?.kind
  return kind === 'profile' || kind === 'set'
}

/** `<meta http-equiv="refresh" content="0; url=…">`, either attribute order. */
const META_REFRESH = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"'>\s]+)/i
const META_REFRESH_REVERSED = /<meta[^>]+content=["'][^"']*?url=([^"'>\s]+)[^>]*http-equiv=["']?refresh/i
/** `window.location = "…"`, `location.href='…'`, `location.replace("…")`. */
const SCRIPT_LOCATION = /location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*["']([^"']+)["']/

/** Characters of a short link's page read for its redirect: the tag sits in its head. */
export const REDIRECT_PAGE_CHARS = 64 * 1024

/**
 * Where a short link's page sends the browser when it answers 200 instead of
 * a 302: its `<meta refresh>`, else a script's `location`. Only http(s), made
 * absolute against `base`; undefined when the page names neither. O(page),
 * the page cut at REDIRECT_PAGE_CHARS.
 */
export function pageRedirectOf(html: string, base: string): string | undefined {
  const head = html.slice(0, REDIRECT_PAGE_CHARS)
  const raw = (META_REFRESH.exec(head) ?? META_REFRESH_REVERSED.exec(head) ?? SCRIPT_LOCATION.exec(head))?.[1]
  if (!raw) return undefined
  try {
    const target = new URL(raw.replace(/&amp;/g, '&').replace(/\\\//g, '/'), base)
    return target.protocol === 'https:' || target.protocol === 'http:' ? target.href : undefined
  } catch {
    return undefined
  }
}
