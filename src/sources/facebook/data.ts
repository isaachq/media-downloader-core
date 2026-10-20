import {MetaError} from '../meta/errors.js'
import type {CursorPage} from '../meta/listing.js'
import type {MetaImage, MetaMedia, MetaPost, MetaVideo} from '../meta/post.js'
import {dig, findAllWithKey, isObject, type Json, jsonScripts, list, num, text, unescapeHtml} from '../meta/relay.js'
import type {Rendition} from '../renditions.js'
import {videoUrl} from './links.js'

/**
 * Facebook's data as its pages embed it (Relay payloads in `data-sjs`
 * scripts), reduced to MetaPost. A video is spread over several objects of
 * the payload that share its id — one with the media urls, one with its
 * title, one with the owner — so the readers merge every object with the
 * same id before reading it. No HTML parsing anywhere.
 */

export const PUBLIC_ORIGIN = 'https://www.facebook.com'

/** Keys an object carries when it is (part of) a video with media urls. */
const MEDIA_KEYS = [
  'playable_url',
  'playable_url_quality_hd',
  'browser_native_sd_url',
  'browser_native_hd_url',
  'videoDeliveryLegacyFields',
  'videoDeliveryResponseFragment',
  'dash_manifest_xml_string',
] as const

// ─── Walls ──────────────────────────────────────────────────────────────────

/** A login wall, a checkpoint, or a "content isn't available" page, as the engine's problems. */
export function checkWall(page: {readonly html: string; readonly url: string}): void {
  if (/\/login\/?(\?|$)|\/login\.php/.test(page.url)) throw new MetaError('challenge', 'Facebook asked to log in.')
  if (/\/checkpoint\//.test(page.url) || /"checkpoint_required"|\/checkpoint\/\d+/.test(page.html)) {
    throw new MetaError('challenge', 'Facebook asks for a verification.')
  }
  if (
    /content isn't available right now|isn't available anymore|This page isn't available|removed by the owner/i.test(
      page.html,
    )
  ) {
    throw new MetaError('removed', 'This Facebook content is no longer available (removed, private, or restricted).')
  }
  if (/"login_form"|id="login_form"|name="login"/.test(page.html) && jsonScripts(page.html).length < 3) {
    throw new MetaError('challenge', 'Facebook asked to log in.')
  }
}

/** The page's `fb_dtsg` and `lsd` tokens, which its own GraphQL requests must carry. */
export function pageTokens(html: string): {readonly dtsg?: string | undefined; readonly lsd?: string | undefined} {
  const dtsg =
    /"DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ?? /"dtsg":\{"token":"([^"]+)"/.exec(html)?.[1]
  const lsd = /"LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1]
  return {dtsg, lsd}
}

// ─── Video nodes ────────────────────────────────────────────────────────────

const isVideoLike = (node: Json): boolean =>
  node['__typename'] === 'Video' || MEDIA_KEYS.some(key => key in node) || typeof node['videoId'] === 'string'

const idOf = (node: Json): string | undefined => text(node['videoId']) ?? text(node['video_id']) ?? text(node['id'])

/**
 * Every video of the payload, each as one object merging all the objects that
 * share its id (first value wins per key). Order: first seen first.
 */
export function videoNodes(scripts: readonly unknown[]): Map<string, Json> {
  const merged = new Map<string, Json>()
  const candidates = [
    ...findAllWithKey(scripts, 'id'),
    ...findAllWithKey(scripts, 'videoId'),
    ...findAllWithKey(scripts, 'video_id'),
  ]
  for (const node of candidates) {
    if (!isVideoLike(node)) continue
    const id = idOf(node)
    if (!id || !/^\d+$/.test(id)) continue
    const into = merged.get(id)
    if (!into) merged.set(id, {...node})
    else for (const [key, value] of Object.entries(node)) if (into[key] === undefined) into[key] = value
  }
  return merged
}

function pushUrl(found: Rendition[], seen: Set<string>, url: unknown, hd: boolean, width: number, height: number) {
  const href = text(url) && unescapeHtml(text(url)!)
  if (!href || !/^https?:\/\//.test(href) || seen.has(href)) return
  seen.add(href)
  const short = Math.min(width, height) || Math.max(width, height)
  // Facebook names qualities, not sizes: HD is the video's own size (720p when unknown), SD a 360p-class copy
  const resolution = hd ? short || 720 : short ? Math.min(short, 360) : 360
  const w = hd ? width : 0
  const h = hd ? height : 0
  found.push({codec: 'h264', width: w, height: h, resolution, bitrate: hd ? 2 : 1, urls: [href]})
}

/**
 * The encodings of a video node: the progressive files, HD first; without any,
 * its DASH manifest's video streams, each paired with the best audio stream
 * (a phone has no yt-dlp to hand a DASH-only video to).
 */
export function renditionsOf(node: Json): Rendition[] {
  const progressive = progressiveOf(node)
  if (progressive.length > 0) return progressive
  const legacy = isObject(node['videoDeliveryLegacyFields']) ? node['videoDeliveryLegacyFields'] : {}
  const manifest =
    text(node['dash_manifest_xml_string']) ??
    text(legacy['dash_manifest_xml_string']) ??
    text(node['dash_manifest']) ??
    text(legacy['dash_manifest']) ??
    list(dig(node, 'videoDeliveryResponseFragment', 'videoDeliveryResponseResult', 'dash_manifests'))
      .map(entry => (isObject(entry) ? text(entry['manifest_xml']) : undefined))
      .find(Boolean)
  return manifest ? dashRenditions(manifest) : []
}

const REPRESENTATION = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g
const BASE_URL = /<BaseURL>([^<]+)<\/BaseURL>/
/** The attributes read, each pattern compiled once. */
const ATTRIBUTES = {
  codecs: /\bcodecs="([^"]*)"/,
  mimeType: /\bmimeType="([^"]*)"/,
  bandwidth: /\bbandwidth="([^"]*)"/,
  width: /\bwidth="([^"]*)"/,
  height: /\bheight="([^"]*)"/,
} as const
const AUDIO_CODEC = /^(?:mp4a|opus|ac-3|ec-3)/
const H264 = /^avc1/
const H265 = /^(?:hvc1|hev1)/
const attribute = (attrs: string, name: keyof typeof ATTRIBUTES): string | undefined =>
  ATTRIBUTES[name].exec(attrs)?.[1]

/**
 * A DASH manifest's streams as renditions: every H.264 / H.265 video stream
 * (its whole file, BaseURL) with the highest-bitrate audio stream. One pass
 * over the manifest, linear patterns (no backtracking): O(n) for n bytes.
 * Other codecs (AV1, VP9) are left out: the engine's MP4 promise is H.264
 * first, H.265 at most. No audio stream: none either (a silent file is not
 * what a video post is).
 */
export function dashRenditions(manifest: string): Rendition[] {
  const videos: Rendition[] = []
  let audio: {urls: string[]; bitrate: number} | undefined
  for (const [, attrs = '', body = ''] of manifest.matchAll(REPRESENTATION)) {
    const url = BASE_URL.exec(body)?.[1]
    if (!url) continue
    const href = unescapeHtml(url.trim())
    const codecs = attribute(attrs, 'codecs') ?? ''
    const mime = attribute(attrs, 'mimeType') ?? ''
    const bitrate = Number(attribute(attrs, 'bandwidth')) || 0
    if (mime.startsWith('audio/') || AUDIO_CODEC.test(codecs)) {
      if (!audio || bitrate > audio.bitrate) audio = {urls: [href], bitrate}
      continue
    }
    const codec = H264.test(codecs) ? 'h264' : H265.test(codecs) ? 'h265' : undefined
    if (!codec) continue
    const width = Number(attribute(attrs, 'width')) || 0
    const height = Number(attribute(attrs, 'height')) || 0
    videos.push({
      codec,
      width,
      height,
      resolution: Math.min(width, height) || Math.max(width, height),
      bitrate,
      urls: [href],
    })
  }
  if (!audio) return []
  const sound = audio
  return videos.map(video => ({...video, audio: sound}))
}

/** The progressive encodings of a video node: HD first. */
function progressiveOf(node: Json): Rendition[] {
  const width = num(node['original_width']) ?? num(node['width']) ?? 0
  const height = num(node['original_height']) ?? num(node['height']) ?? 0
  const found: Rendition[] = []
  const seen = new Set<string>()
  const legacy = isObject(node['videoDeliveryLegacyFields']) ? node['videoDeliveryLegacyFields'] : {}
  for (const source of [node, legacy]) {
    pushUrl(found, seen, source['browser_native_hd_url'], true, width, height)
    pushUrl(found, seen, source['playable_url_quality_hd'], true, width, height)
  }
  for (const entry of list(
    dig(node, 'videoDeliveryResponseFragment', 'videoDeliveryResponseResult', 'progressive_urls'),
  )) {
    if (!isObject(entry)) continue
    const hd = /hd/i.test(text(dig(entry, 'metadata', 'quality')) ?? '')
    pushUrl(found, seen, entry['progressive_url'], hd, width, height)
  }
  for (const source of [node, legacy]) {
    pushUrl(found, seen, source['browser_native_sd_url'], false, width, height)
    pushUrl(found, seen, source['playable_url'], false, width, height)
  }
  return found
}

const ownerOf = (node: Json): {readonly handle: string; readonly name?: string | undefined} => {
  const owner = isObject(node['owner']) ? node['owner'] : isObject(node['video_owner']) ? node['video_owner'] : {}
  const url = text(owner['url']) ?? text(owner['profile_url'])
  let handle = ''
  if (url) {
    try {
      const parsed = new URL(url)
      handle = parsed.searchParams.get('id') ?? parsed.pathname.split('/').filter(Boolean)[0] ?? ''
    } catch {
      // not a url
    }
  }
  return {handle: handle || text(owner['id']) || '', name: text(owner['name'])}
}

const titleOfNode = (node: Json): string =>
  text(dig(node, 'title', 'text')) ??
  text(node['name']) ??
  text(dig(node, 'savable_description', 'text')) ??
  text(dig(node, 'message', 'text')) ??
  ''

const thumbnailOf = (node: Json): string | undefined =>
  text(dig(node, 'preferred_thumbnail', 'image', 'uri')) ??
  text(dig(node, 'thumbnailImage', 'uri')) ??
  text(dig(node, 'image', 'uri')) ??
  text(node['thumbnail_url'])

/** A post from a (merged) video node. */
export function readVideoNode(node: Json, fallbackId?: string): MetaPost {
  const id = idOf(node) ?? fallbackId
  if (!id) throw new MetaError('format-changed', 'Facebook video without an id.')
  const owner = ownerOf(node)
  const width = num(node['original_width']) ?? num(node['width']) ?? 0
  const height = num(node['original_height']) ?? num(node['height']) ?? 0
  const ms = num(node['playable_duration_in_ms'])
  const duration = (ms !== undefined ? ms / 1000 : undefined) ?? num(node['length_in_second']) ?? undefined
  const video: MetaVideo = {
    kind: 'video',
    id,
    renditions: renditionsOf(node),
    duration: duration || undefined,
    width,
    height,
    cover: thumbnailOf(node),
  }
  return {
    id,
    url: text(node['permalink_url']) ?? videoUrl(PUBLIC_ORIGIN, id),
    caption: titleOfNode(node),
    author: owner.handle,
    authorName: owner.name,
    createdAt: num(node['publish_time']) ?? num(node['creation_time']) ?? num(node['created_time']),
    items: [video],
    cover: video.cover,
    pinned: node['is_pinned'] === true,
  }
}

/**
 * A video page: the video the url names (or the page's first with media).
 * A page without any video is told apart: a login wall or checkpoint, a
 * removed video, or a layout this module doesn't know.
 */
/** Where a video node carries its media, every shape (progressive urls, DASH). */
const MEDIA_FIELDS = [
  'playable_url',
  'playable_url_quality_hd',
  'browser_native_sd_url',
  'browser_native_hd_url',
  'dash_manifest_xml_string',
  'dash_manifest_url',
] as const
const isEmptyMedia = (value: unknown): boolean => value === null || value === undefined || value === ''

export function readVideoPage(page: {readonly html: string; readonly url: string}, id?: string): MetaPost {
  checkWall(page)
  const nodes = videoNodes(jsonScripts(page.html))
  const chosen = (id && nodes.get(id)) || [...nodes.values()].find(node => renditionsOf(node).length > 0)
  if (!chosen) {
    // the page Facebook serves a visitor it won't show the video to: the "video not found" root with
    // its login form preloaded, no media anywhere (October 2026: every video page, without a session)
    if (/VideoHomeVideoNotFoundRootQuery/.test(page.html)) {
      throw new MetaError(
        'login-required',
        'Facebook shows this video to signed-in accounts only: use a signed-in Facebook session (cookies).',
      )
    }
    if (nodes.size === 0 && /login/i.test(page.html) && page.html.length < 300_000) {
      throw new MetaError('challenge', 'Facebook asked to log in.')
    }
    throw new MetaError('format-changed', 'Facebook video page without its media data.')
  }
  const post = readVideoNode(chosen, id)
  if (post.items[0]!.kind === 'video' && post.items[0]!.renditions.length === 0) {
    // every media field there and empty: Facebook itself plays nothing to this visitor ("We're having
    // trouble playing this video") — a video kept for signed-in sessions, or no longer playable
    if (MEDIA_FIELDS.some(key => key in chosen) && MEDIA_FIELDS.every(key => isEmptyMedia(chosen[key]))) {
      throw new MetaError(
        'no-media',
        'Facebook plays nothing for this video to a visitor without a session: it may need a signed-in Facebook session, or it no longer plays.',
      )
    }
    throw new MetaError(
      'format-changed',
      'Facebook video page without an encoding to download (no MP4, no H.264 DASH).',
    )
  }
  return post
}

// ─── Listings ───────────────────────────────────────────────────────────────

export type VideoListing = CursorPage<MetaPost> & {
  /** The Relay node whose connection was read: what the next page is asked for. */
  readonly collectionId?: string | undefined
}

/**
 * The videos a profile's Videos tab shows at first, in page order, and the
 * cursor of the rest. Nodes typed `Video` with a numeric id; the connection
 * (`edges` + `page_info`) they sit in gives the cursor and its owner's id.
 */
export function readVideoListing(page: {readonly html: string; readonly url: string}): VideoListing {
  checkWall(page)
  const scripts = jsonScripts(page.html)
  const items: MetaPost[] = []
  const seen = new Set<string>()
  for (const node of videoNodes(scripts).values()) {
    if (node['__typename'] !== 'Video') continue
    const post = readVideoNode(node)
    if (seen.has(post.id)) continue
    seen.add(post.id)
    items.push(post)
  }
  let next: string | undefined
  let collectionId: string | undefined
  for (const connection of findAllWithKey(scripts, 'page_info')) {
    const holdsVideos = list(connection['edges']).some(edge => {
      const node = isObject(edge) ? edge['node'] : undefined
      const inner = isObject(node) && isObject(node['node']) ? node['node'] : node
      return isObject(inner) && inner['__typename'] === 'Video'
    })
    if (!holdsVideos) continue
    const info = isObject(connection['page_info']) ? connection['page_info'] : {}
    next = info['has_next_page'] === true ? text(info['end_cursor']) : undefined
    collectionId = text(connection['id']) ?? ownerIdOf(scripts, connection)
    break
  }
  return {items, next, collectionId}
}

/** The id of the object holding `connection` as one of its values. */
function ownerIdOf(scripts: readonly unknown[], connection: Json): string | undefined {
  for (const holder of findAllWithKey(scripts, 'id')) {
    if (Object.values(holder).includes(connection)) return text(holder['id'])
  }
  return undefined
}

/** A page of the videos collection, as the pagination query answers it. */
export function readListingPage(json: unknown): CursorPage<MetaPost> {
  if (isObject(json) && Array.isArray(json['errors']) && json['errors'].length > 0) {
    const first = json['errors'][0]
    const message = isObject(first) ? (text(first['message']) ?? text(first['summary'])) : undefined
    if (/login|logged/i.test(message ?? '')) throw new MetaError('login-required', 'Facebook asks to sign in for this.')
    throw new MetaError('format-changed', `Facebook listing query failed: ${message ?? 'error'}.`)
  }
  for (const connection of findAllWithKey([json], 'page_info')) {
    const items: MetaPost[] = []
    for (const edge of list(connection['edges'])) {
      const node = isObject(edge) ? edge['node'] : undefined
      const inner = isObject(node) && isObject(node['node']) ? node['node'] : node
      if (isObject(inner) && inner['__typename'] === 'Video') items.push(readVideoNode(inner))
    }
    if (items.length === 0 && list(connection['edges']).length > 0) continue
    const info = isObject(connection['page_info']) ? connection['page_info'] : {}
    return {items, next: info['has_next_page'] === true ? text(info['end_cursor']) : undefined}
  }
  throw new MetaError('format-changed', 'Facebook listing page without its connection.')
}

// ─── Stories ────────────────────────────────────────────────────────────────

/**
 * The cards of a stories bucket: each an attachment whose media is a Video
 * (with its urls) or a Photo (its image). Signed-in sessions only; a page
 * that shows none to this session is a login wall.
 */
export function readStoriesPage(page: {readonly html: string; readonly url: string}, bucket: string): MetaPost[] {
  checkWall(page)
  const scripts = jsonScripts(page.html)
  const posts: MetaPost[] = []
  const seen = new Set<string>()
  for (const card of findAllWithKey(scripts, 'attachments')) {
    const createdAt = num(card['creation_time'])
    const expiresAt = num(card['expiration_time'])
    const cardId = text(card['id'])
    const owner = ownerOf(card)
    for (const attachment of list(card['attachments'])) {
      const media = isObject(attachment) && isObject(attachment['media']) ? attachment['media'] : undefined
      if (!media) continue
      const id = text(media['id'])
      if (!id || seen.has(id)) continue
      let item: MetaMedia | undefined
      if (media['__typename'] === 'Video' || MEDIA_KEYS.some(key => key in media)) {
        const renditions = renditionsOf(media)
        const ms = num(media['playable_duration_in_ms'])
        item = {
          kind: 'video',
          id,
          renditions,
          duration: ms !== undefined ? ms / 1000 : num(media['length_in_second']),
          width: num(media['original_width']) ?? num(media['width']) ?? 0,
          height: num(media['original_height']) ?? num(media['height']) ?? 0,
          cover: thumbnailOf(media),
        }
      } else if (media['__typename'] === 'Photo' || isObject(media['image'])) {
        const uri = text(dig(media, 'image', 'uri')) ?? text(dig(media, 'viewer_image', 'uri'))
        if (!uri) continue
        const image: MetaImage = {
          kind: 'image',
          id,
          urls: [unescapeHtml(uri)],
          width: num(dig(media, 'image', 'width')) ?? num(media['width']) ?? 0,
          height: num(dig(media, 'image', 'height')) ?? num(media['height']) ?? 0,
        }
        item = image
      }
      if (!item) continue
      seen.add(id)
      posts.push({
        id,
        url: `${PUBLIC_ORIGIN}/stories/${bucket}/${cardId && /^\d+$/.test(cardId) ? cardId : id}/`,
        caption: text(dig(card, 'message', 'text')) ?? '',
        author: owner.handle || bucket,
        authorName: owner.name,
        createdAt,
        expiresAt,
        items: [item],
        cover: item.kind === 'video' ? item.cover : item.urls[0],
        pinned: false,
        story: true,
      })
    }
  }
  return posts
}
