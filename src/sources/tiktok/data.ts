import type {Rendition, VideoCodec} from '../renditions.js'
import {TikTokError} from './errors.js'

// ─── Page data ──────────────────────────────────────────────────────────────

const DATA_SCRIPT = 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__"'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/**
 * The reflow page keeps the post out of `__UNIVERSAL_DATA` and puts it in a
 * second script, `#api-data`, as `{videoDetail: {itemInfo: {itemStruct}}}`.
 * Undefined when that script is absent or unreadable.
 */
export function readApiData(html: string): Json | undefined {
  const marker = html.indexOf('id="api-data"')
  if (marker === -1) return undefined
  const start = html.indexOf('>', marker) + 1
  const end = html.indexOf('</script>', start)
  if (start <= 0 || end === -1) return undefined
  try {
    const data: unknown = JSON.parse(html.slice(start, end))
    if (!isObject(data)) return undefined
    const detail = data['videoDetail']
    return isObject(detail) ? detail : undefined
  } catch {
    return undefined
  }
}

/**
 * The universal-script scope, with `#api-data`'s video detail filled in when
 * the universal script is a shell. One pass over the HTML already downloaded.
 */
export function pageScope(html: string): Json {
  const scope = readPageData(html)
  if (embeddedDetail(scope)) return scope
  const detail = readApiData(html)
  return detail ? {...scope, 'webapp.video-detail': detail} : scope
}

/**
 * The JSON TikTok embeds in every page for its own front end — found with
 * two `indexOf`s, no HTML parser. A page without it is a verification page,
 * a login wall or a new page layout, told apart so callers can react.
 */
export function readPageData(html: string): Json {
  const marker = html.indexOf(DATA_SCRIPT)
  if (marker === -1) {
    if (/_wafchallengeid|please wait|captcha|verify to continue/i.test(html)) {
      throw new TikTokError('challenge', 'TikTok answered with a verification page.')
    }
    if (/\/login\b/.test(html) && html.length < 50_000) {
      throw new TikTokError('challenge', 'TikTok asked to log in.')
    }
    throw new TikTokError('format-changed', 'TikTok page without its data script.')
  }
  const start = html.indexOf('>', marker) + 1
  const end = html.indexOf('</script>', start)
  try {
    const data: unknown = JSON.parse(html.slice(start, end))
    const scope = isObject(data) ? data['__DEFAULT_SCOPE__'] : undefined
    if (!isObject(scope)) throw new Error('no __DEFAULT_SCOPE__')
    return scope
  } catch (error) {
    throw new TikTokError('format-changed', `Unreadable TikTok page data: ${String(error)}`)
  }
}

/** TikTok status codes inside page data and API answers. */
function checkStatus(status: unknown, message: unknown): void {
  const code = num(status) ?? 0
  if (code === 0) return
  const why = text(message) ?? ''
  if (code === 10216 || code === 10222 || /private|self_see/i.test(why)) {
    throw new TikTokError('private', 'This post or account is private.')
  }
  if (code === 10204 || code === 10221 || code === 10202 || /not.?exist|removed|deleted/i.test(why)) {
    throw new TikTokError('removed', 'This post or account no longer exists.')
  }
  throw new TikTokError('refused', `TikTok status ${code}${why ? `: ${why}` : ''}.`)
}

// ─── Model ──────────────────────────────────────────────────────────────────

// Encodings are the shared model of every native source (../renditions.ts).
export type {Rendition, VideoCodec} from '../renditions.js'

export type TikTokPost = {
  readonly id: string
  readonly description: string
  readonly author: string
  readonly authorName?: string | undefined
  /** Unix seconds. */
  readonly createdAt?: number | undefined
  readonly duration?: number | undefined
  readonly cover?: string | undefined
  readonly renditions: readonly Rendition[]
  readonly music?:
    | {readonly url?: string | undefined; readonly title?: string | undefined; readonly duration?: number | undefined}
    | undefined
  readonly photoPost: boolean
  /** A photo post's images, in order (empty for a video). */
  readonly images: readonly SlideImage[]
  readonly privateItem: boolean
  /** Pinned to the top of the profile: listed first whatever its date. */
  readonly pinned: boolean
}

/** One image of a photo post: mirrors of the same file, best first. */
export type SlideImage = {readonly urls: readonly string[]; readonly width: number; readonly height: number}

function imagesOf(post: Json | undefined): SlideImage[] {
  const list = post && Array.isArray(post['images']) ? post['images'] : []
  const images: SlideImage[] = []
  for (const image of list) {
    if (!isObject(image)) continue
    const address = isObject(image['imageURL']) ? image['imageURL'] : {}
    const urls = usableUrls(address['urlList'])
    if (urls.length === 0) continue
    images.push({urls, width: num(image['imageWidth']) ?? 0, height: num(image['imageHeight']) ?? 0})
  }
  return images
}

export type TikTokUser = {
  readonly id: string
  readonly user: string
  readonly name?: string | undefined
  readonly secUid: string
  readonly videoCount?: number | undefined
  readonly privateAccount: boolean
}

function codecOf(value: unknown): VideoCodec | undefined {
  const name = (text(value) ?? '').toLowerCase()
  if (name.includes('264')) return 'h264'
  // bytevc1 is TikTok's name for H.265; bytevc2 (H.266) has no common decoder: skipped
  if (name.includes('265') || name.includes('hvc') || name.includes('hevc') || name.includes('bytevc1')) return 'h265'
  return undefined
}

/** Drop the www.tiktok.com/aweme/v1/play redirector: it answers differently from the CDN mirrors. */
const usableUrls = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u) && !u.includes('/aweme/v1/play'))
    : []

function renditionsOf(video: Json): Rendition[] {
  const found: Rendition[] = []
  if (Array.isArray(video['bitrateInfo'])) {
    for (const entry of video['bitrateInfo']) {
      if (!isObject(entry) || !isObject(entry['PlayAddr'])) continue
      const play = entry['PlayAddr']
      const codec = codecOf(entry['CodecType'])
      const urls = usableUrls(play['UrlList'])
      const width = num(play['Width']) ?? 0
      const height = num(play['Height']) ?? 0
      if (!codec || urls.length === 0) continue
      found.push({
        codec,
        width,
        height,
        resolution: Math.min(width, height) || Math.max(width, height),
        bitrate: num(entry['Bitrate']) ?? 0,
        bytes: num(play['DataSize']),
        urls,
      })
    }
  }
  // older posts only carry the player address
  const play = text(video['playAddr'])
  if (found.length === 0 && play) {
    const width = num(video['width']) ?? 0
    const height = num(video['height']) ?? 0
    found.push({
      codec: codecOf(video['codecType']) ?? 'h264',
      width,
      height,
      resolution: Math.min(width, height) || Math.max(width, height),
      bitrate: num(video['bitrate']) ?? 0,
      urls: [play],
    })
  }
  return found
}

/** A post from a video page or a profile listing. Throws 'format-changed' when the essentials are missing. */
export function readPost(raw: unknown): TikTokPost {
  if (!isObject(raw) || !text(raw['id'])) throw new TikTokError('format-changed', 'TikTok post without an id.')
  const author = isObject(raw['author']) ? raw['author'] : {}
  const video = isObject(raw['video']) ? raw['video'] : {}
  const music = isObject(raw['music']) ? raw['music'] : undefined
  return {
    id: text(raw['id'])!,
    description: text(raw['desc']) ?? '',
    author: text(author['uniqueId']) ?? '',
    authorName: text(author['nickname']),
    createdAt: num(raw['createTime']),
    duration: num(video['duration']) || undefined,
    cover: text(video['cover']) ?? text(video['originCover']),
    renditions: renditionsOf(video),
    music: music && {url: text(music['playUrl']), title: text(music['title']), duration: num(music['duration'])},
    photoPost: isObject(raw['imagePost']),
    images: imagesOf(isObject(raw['imagePost']) ? raw['imagePost'] : undefined),
    privateItem: raw['privateItem'] === true || raw['secret'] === true,
    pinned: raw['isPinnedItem'] === true,
  }
}

const DETAIL_KEYS = ['webapp.video-detail', 'webapp.reflow.video.detail'] as const

function embeddedDetail(scope: Json): Json | undefined {
  for (const key of DETAIL_KEYS) {
    const value = scope[key]
    if (isObject(value)) return value
  }
  return undefined
}

/**
 * The post on a video page. The web app embeds it as `webapp.video-detail`
 * (or the reflow key). A page that parsed but has neither is not a new layout
 * by itself: callers can follow `canonicalUrl` or the item api.
 */
export function postFromPage(scope: unknown): TikTokPost {
  if (!isObject(scope)) throw new TikTokError('format-changed', 'TikTok video page without video details.')
  const detail = embeddedDetail(scope)
  if (!detail) throw new TikTokError('format-changed', 'TikTok video page without video details.')
  return postFromDetail(detail)
}

/** The post from `webapp.video-detail` or from `/api/item/detail/`, same shape. */
export function postFromDetail(detail: unknown): TikTokPost {
  if (!isObject(detail)) throw new TikTokError('format-changed', 'TikTok video page without video details.')
  checkStatus(detail['statusCode'], detail['statusMsg'])
  const info = isObject(detail['itemInfo']) ? detail['itemInfo'] : undefined
  return readPost(info?.['itemStruct'])
}

/** Canonical url TikTok puts on a page that did not embed the post (`seo.abtest`). */
export function canonicalUrl(scope: unknown): string | undefined {
  if (!isObject(scope)) return undefined
  const seo = scope['seo.abtest']
  if (!isObject(seo)) return undefined
  return text(seo['canonical'])
}

/** The account on a profile page (`webapp.user-detail`). */
export function userFromPage(scope: Json): TikTokUser {
  const detail = scope['webapp.user-detail']
  if (!isObject(detail)) throw new TikTokError('format-changed', 'TikTok profile page without user details.')
  checkStatus(detail['statusCode'], detail['statusMsg'])
  const info = isObject(detail['userInfo']) ? detail['userInfo'] : {}
  const user = isObject(info['user']) ? info['user'] : {}
  const stats = isObject(info['stats']) ? info['stats'] : {}
  const secUid = text(user['secUid'])
  if (!secUid) throw new TikTokError('format-changed', 'TikTok profile without its secUid.')
  return {
    id: text(user['id']) ?? secUid,
    user: text(user['uniqueId']) ?? '',
    name: text(user['nickname']),
    secUid,
    videoCount: num(stats['videoCount']),
    privateAccount: user['privateAccount'] === true,
  }
}

/** One page of the profile listing API. */
export function readListPage(raw: unknown): {readonly posts: unknown[]; readonly more: boolean} {
  if (!isObject(raw)) throw new TikTokError('refused', 'TikTok listing answered with no data.')
  checkStatus(raw['statusCode'] ?? raw['status_code'], raw['status_msg'])
  const posts = Array.isArray(raw['itemList']) ? raw['itemList'] : []
  return {posts, more: raw['hasMorePrevious'] === true || raw['hasMore'] === true}
}
