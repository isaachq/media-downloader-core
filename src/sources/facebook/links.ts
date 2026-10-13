/**
 * Facebook urls in all their shapes, reduced to what they point at:
 *   /watch/?v=<id>  /watch/live/?v=<id>  /video.php?v=<id>  /videos/<id>
 *   /<page>/videos/<id>/  /<page>/videos/<slug>/<id>/  /reel/<id>  /<page>/reels/<id>   → video
 *   /<page>/posts/<id>  /story.php?story_fbid=<id>&id=…  /permalink.php?story_fbid=…   → post (its video)
 *   /<page>  /<page>/videos  /<page>/reels  /profile.php?id=<id>                      → profile (its videos)
 *   /stories/<bucket>/  /stories/<bucket>/<card>/                                      → stories
 *   fb.watch/<x>  /share/v/<x>  /share/r/<x>  /share/p/<x>  /share/<x>                → short link (a redirect)
 */
export type FacebookLink =
  | {readonly kind: 'video'; readonly id: string; readonly page?: string | undefined}
  | {readonly kind: 'post'; readonly id: string; readonly page?: string | undefined}
  | {readonly kind: 'profile'; readonly page: string}
  | {readonly kind: 'stories'; readonly bucket: string; readonly card?: string | undefined}
  | {readonly kind: 'short'; readonly url: string}

const ID = /^\d{5,25}$/
const SLUG = /^[\w.-]{1,80}$/
/** First path segments that are not page names. */
const RESERVED = new Set([
  'watch',
  'reel',
  'reels',
  'videos',
  'video.php',
  'story.php',
  'permalink.php',
  'profile.php',
  'photo',
  'photo.php',
  'photos',
  'stories',
  'share',
  'login',
  'login.php',
  'checkpoint',
  'groups',
  'events',
  'marketplace',
  'gaming',
  'games',
  'pages',
  'people',
  'places',
  'help',
  'settings',
  'privacy',
  'policies',
  'legal',
  'business',
  'ads',
  'about',
  'dialog',
  'plugins',
  'v2.0',
  'hashtag',
  'search',
  'notifications',
  'messages',
  'friends',
  'bookmarks',
  'home.php',
  'recover',
  'r.php',
  'l.php',
  'ajax',
  'api',
])

export function isFacebookHost(host: string): boolean {
  return (
    host === 'facebook.com' ||
    host.endsWith('.facebook.com') ||
    host === 'fb.com' ||
    host.endsWith('.fb.com') ||
    host === 'fb.watch' ||
    host === 'fb.gg'
  )
}

/** What a url points at, or undefined when it isn't a Facebook url this module understands. */
export function parseFacebookLink(raw: string, extraHost?: string): FacebookLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (!isFacebookHost(host) && host !== extraHost) return undefined
  if (host === 'fb.watch') return url.pathname.length > 1 ? {kind: 'short', url: url.href} : undefined
  const parts = url.pathname.split('/').filter(Boolean)
  const [first, second, third] = parts
  const query = url.searchParams

  if (first === 'share') return second ? {kind: 'short', url: url.href} : undefined
  if (first === 'watch') {
    const id = query.get('v')
    return id && ID.test(id) ? {kind: 'video', id} : undefined
  }
  if (first === 'video.php') {
    const id = query.get('v')
    return id && ID.test(id) ? {kind: 'video', id} : undefined
  }
  if (first === 'story.php' || first === 'permalink.php') {
    const id = query.get('story_fbid')
    const page = query.get('id') ?? undefined
    return id && ID.test(id) ? {kind: 'post', id, page} : undefined
  }
  if (first === 'profile.php') {
    const id = query.get('id')
    return id && ID.test(id) ? {kind: 'profile', page: id} : undefined
  }
  if (first === 'reel' || first === 'videos') return second && ID.test(second) ? {kind: 'video', id: second} : undefined
  if (first === 'stories') {
    if (!second || !ID.test(second)) return undefined
    return third
      ? ID.test(third)
        ? {kind: 'stories', bucket: second, card: third}
        : undefined
      : {kind: 'stories', bucket: second}
  }
  if (!first || RESERVED.has(first) || !SLUG.test(first)) return undefined
  if (!second || ((second === 'videos' || second === 'reels') && !third)) return {kind: 'profile', page: first}
  if (second === 'videos' || second === 'reels') {
    // /<page>/videos/<id>  or  /<page>/videos/<slug>/<id>
    const last = parts[parts.length - 1]!
    return ID.test(last) ? {kind: 'video', id: last, page: first} : undefined
  }
  // /<page>/posts/<id>  or  /<page>/posts/<pfbid…>
  if (second === 'posts' && third) return {kind: 'post', id: third, page: first}
  return undefined
}

export function videoUrl(origin: string, id: string): string {
  return `${origin}/watch/?v=${id}`
}

export function profileVideosUrl(origin: string, page: string): string {
  return ID.test(page) ? `${origin}/profile.php?id=${page}&sk=videos` : `${origin}/${page}/videos/`
}

export function profileUrl(origin: string, page: string): string {
  return ID.test(page) ? `${origin}/profile.php?id=${page}` : `${origin}/${page}/`
}

export function postUrl(origin: string, id: string, page?: string): string {
  return page && !ID.test(page) ? `${origin}/${page}/posts/${id}` : `${origin}/${id}`
}

export function storiesUrl(origin: string, bucket: string, card?: string): string {
  return card ? `${origin}/stories/${bucket}/${card}/` : `${origin}/stories/${bucket}/`
}

/** A listing url (a profile's videos, stories): batches cap these unless told otherwise. */
export function isFacebookListing(url: string): boolean {
  const kind = parseFacebookLink(url)?.kind
  return kind === 'profile' || kind === 'stories'
}
