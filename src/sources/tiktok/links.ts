/**
 * TikTok urls in all their shapes, reduced to what they point at:
 *   /@user/video/<id>  /@user/photo/<id>  /embed/v2/<id>  m.tiktok.com/v/<id>.html
 *   /@user                       → profile
 *   vm.tiktok.com/…  vt.tiktok.com/…  /t/…   → short link (resolved by a redirect)
 */
export type TikTokLink =
  | {readonly kind: 'video'; readonly id: string; readonly user?: string | undefined}
  | {readonly kind: 'photo'; readonly id: string; readonly user?: string | undefined}
  | {readonly kind: 'profile'; readonly user: string}
  | {readonly kind: 'short'; readonly url: string}

const SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com'])
const USER = /^@([\w.-]{1,64})$/
const ID = /^\d{6,25}$/

export function isTikTokHost(host: string): boolean {
  return host === 'tiktok.com' || host.endsWith('.tiktok.com')
}

/** What a url points at, or undefined when it isn't a TikTok url this module understands. */
export function parseTikTokLink(raw: string, extraHost?: string): TikTokLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (!isTikTokHost(host) && host !== extraHost) return undefined
  if (SHORT_HOSTS.has(host)) return url.pathname.length > 1 ? {kind: 'short', url: url.href} : undefined

  const parts = url.pathname.split('/').filter(Boolean)
  const [first, second, third] = parts
  if (first === 't' && second) return {kind: 'short', url: url.href}
  if (first === 'embed') {
    const id = second === 'v2' ? third : second
    return id && ID.test(id) ? {kind: 'video', id} : undefined
  }
  if (first === 'v' && second) {
    const id = second.replace(/\.html$/, '')
    return ID.test(id) ? {kind: 'video', id} : undefined
  }
  const user = first ? USER.exec(first)?.[1] : undefined
  if (!user) return undefined
  if (!second) return {kind: 'profile', user}
  if ((second === 'video' || second === 'photo') && third && ID.test(third)) {
    return {kind: second, id: third, user}
  }
  return undefined
}

/** Canonical page of a post; any user name works when the real one is unknown. */
export function postUrl(origin: string, id: string, user?: string): string {
  return `${origin}/@${user || '_'}/video/${id}`
}

export function profileUrl(origin: string, user: string): string {
  return `${origin}/@${user}`
}

/** A profile url (tiktok.com/@user): batches cap these at TIKTOK_PROFILE_DEFAULT_ITEMS unless told otherwise. */
export function isTikTokProfile(url: string): boolean {
  return parseTikTokLink(url)?.kind === 'profile'
}
