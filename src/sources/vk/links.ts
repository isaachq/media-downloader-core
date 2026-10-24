/**
 * VK urls in all their shapes, reduced to what they point at:
 *   /video<oid>_<id>  /clip<oid>_<id>  /video<oid>_<id>_<key>  (…?list=<key>)       → video
 *   any page ?z=video<oid>_<id>[/<key>]  (a wall post, a profile, a feed)         → video
 *   /video_ext.php?oid=<oid>&id=<id>[&hash=…]  (the embedded player)               → video
 *   /video/playlist/<oid>_<album>  /playlist/<oid>_<album>  (vkvideo.ru)          → playlist (an album)
 *   /videos<oid>  /videos<oid>?section=album_<album>                              → playlist (all / an album)
 *   vk.cc/<x>  (a short link: a redirect, often through /away.php?to=…)           → short
 * on vk.com, m.vk.com, vk.ru, m.vk.ru, vkontakte.ru, vkvideo.ru, m.vkvideo.ru.
 * Owner ids are signed: negative for a community, positive for a user.
 * O(n) in the url's length: one URL parse and a few anchored patterns.
 */
export type VkLink =
  | {
      readonly kind: 'video'
      readonly oid: string
      readonly id: string
      /** The access key a hidden video's link carries (`?list=`, `_<key>`, `?z=…/<key>`). */
      readonly list?: string | undefined
      /** The embedded player's `hash` (an embed of a hidden video: read through the embed page). */
      readonly hash?: string | undefined
      readonly clip?: boolean | undefined
    }
  | {
      readonly kind: 'playlist'
      readonly oid: string
      /** `all` (every video of the owner) or an album id (may be negative: VK's own sections). */
      readonly album: string
    }
  | {readonly kind: 'short'; readonly url: string}

const VK_HOSTS: ReadonlySet<string> = new Set([
  'vk.com',
  'www.vk.com',
  'm.vk.com',
  'vk.ru',
  'www.vk.ru',
  'm.vk.ru',
  'vkontakte.ru',
  'www.vkontakte.ru',
  'm.vkontakte.ru',
  'vkvideo.ru',
  'www.vkvideo.ru',
  'm.vkvideo.ru',
])
const SHORT_HOSTS: ReadonlySet<string> = new Set(['vk.cc', 'www.vk.cc'])

const OWNER = '-?\\d{1,12}'
const ID = '\\d{1,12}'
/** `video-1_2`, `clip-1_2`, `video-1_2_abcdef` (with the access key); anchored, no backtracking. */
const VIDEO_PATH = new RegExp(`^/(video|clip)(${OWNER})_(${ID})(?:_([0-9a-f]{4,40}))?/?$`)
/** The `z` parameter: `video-1_2`, `video-1_2/abcdef`, `video-1_2/pl_-1_3`, `clip-1_2`. */
const Z_VALUE = new RegExp(`^(video|clip)(${OWNER})_(${ID})(?:/([\\w-]{1,80}))?`)
const PLAYLIST_PATH = new RegExp(`^/(?:video/)?playlist/(${OWNER})_(-?${ID})/?$`)
const VIDEOS_PATH = new RegExp(`^/videos(${OWNER})/?$`)
const ALBUM_SECTION = new RegExp(`^album_(-?${ID})$`)
const OWNER_ONLY = new RegExp(`^${OWNER}$`)
const ID_ONLY = new RegExp(`^${ID}$`)
const ACCESS_KEY = /^(?:[0-9a-f]{4,40}|ln-[\da-zA-Z]{1,40})$/
const EMBED_HASH = /^[0-9a-f]{4,40}$/

export function isVkHost(host: string): boolean {
  return VK_HOSTS.has(host) || SHORT_HOSTS.has(host)
}

/** What a url points at, or undefined when it isn't a VK url this module understands. */
export function parseVkLink(raw: string, extraHost?: string): VkLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (SHORT_HOSTS.has(host)) return url.pathname.length > 1 ? {kind: 'short', url: url.href} : undefined
  if (!VK_HOSTS.has(host) && host !== extraHost) return undefined
  const query = url.searchParams
  const path = url.pathname

  // a video opened over another page (a wall post, a profile): the page is beside the point
  const z = query.get('z')
  if (z) {
    const match = Z_VALUE.exec(z)
    if (match) {
      const key = match[4] && ACCESS_KEY.test(match[4]) ? match[4] : undefined
      return video(match[1]!, match[2]!, match[3]!, key)
    }
  }
  // VK's own redirect page (where vk.cc links lead): the link it sends to
  if (path === '/away.php') {
    const to = query.get('to')
    return to && to !== raw ? parseVkLink(to, extraHost) : undefined
  }
  if (path === '/video_ext.php') {
    const oid = query.get('oid')
    const id = query.get('id')
    if (!oid || !id || !OWNER_ONLY.test(oid) || !ID_ONLY.test(id)) return undefined
    const hash = query.get('hash')
    return {kind: 'video', oid, id, ...(hash && EMBED_HASH.test(hash) && {hash})}
  }
  const direct = VIDEO_PATH.exec(path)
  if (direct) {
    const list = query.get('list')
    const key = direct[4] ?? (list && ACCESS_KEY.test(list) ? list : undefined)
    return video(direct[1]!, direct[2]!, direct[3]!, key)
  }
  const playlist = PLAYLIST_PATH.exec(path)
  if (playlist) return {kind: 'playlist', oid: playlist[1]!, album: playlist[2]!}
  const videos = VIDEOS_PATH.exec(path)
  if (videos) {
    const section = query.get('section')
    const album = section ? ALBUM_SECTION.exec(section)?.[1] : undefined
    // other sections (uploaded, playlists…) read as every video of the owner
    return {kind: 'playlist', oid: videos[1]!, album: album ?? 'all'}
  }
  return undefined
}

function video(kind: string, oid: string, id: string, list: string | undefined): VkLink {
  return {kind: 'video', oid, id, ...(list && {list}), ...(kind === 'clip' && {clip: true})}
}

/** The canonical page of a video (or a clip). */
export function videoUrl(origin: string, oid: string, id: string, clip = false): string {
  return `${origin}/${clip ? 'clip' : 'video'}${oid}_${id}`
}

/**
 * A url that reads as `link` again (parseVkLink round-trips it): the video's
 * page with its access key (`?list=`), or the embed with its hash. What the
 * engine queues and retries: a hidden video's key must survive it. O(1).
 */
export function linkUrl(
  origin: string,
  link: {
    readonly oid: string
    readonly id: string
    readonly list?: string | undefined
    readonly hash?: string | undefined
    readonly clip?: boolean | undefined
  },
): string {
  if (link.hash) return `${origin}/video_ext.php?oid=${link.oid}&id=${link.id}&hash=${link.hash}`
  const page = videoUrl(origin, link.oid, link.id, link.clip)
  return link.list ? `${page}?list=${encodeURIComponent(link.list)}` : page
}

/** The canonical page of a listing: an album, or every video of the owner. */
export function playlistUrl(origin: string, oid: string, album: string): string {
  return album === 'all' ? `${origin}/videos${oid}` : `${origin}/video/playlist/${oid}_${album}`
}

/** A listing url (an album, an owner's videos): batches cap these unless told otherwise. */
export function isVkListing(url: string): boolean {
  return parseVkLink(url)?.kind === 'playlist'
}
