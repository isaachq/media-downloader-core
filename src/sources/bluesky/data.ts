import {MetaError} from '../meta/errors.js'
import type {CursorPage} from '../meta/listing.js'
import type {MetaMedia, MetaPost} from '../meta/post.js'
import {dig, isObject, list, num, text} from '../meta/relay.js'
import {BLUESKY_ORIGIN, type BlueskyEndpoints, NO_UNAUTHENTICATED} from './endpoints.js'
import {postUrl, rkeyOfUri} from './links.js'

/**
 * Bluesky's answers, reduced to what a download needs. The media is read from
 * the post's own record (`record.embed`: blob CIDs, media types, sizes),
 * which is what the author published and what the PDS serves; the AppView's
 * view (`post.embed`) adds the CDN links (thumbnails, the full-size
 * re-encode). Embeds are told apart by `$type`, so a new one (the gallery
 * arrived in 2026-06) is noticed instead of misread. O(media of the post).
 */

export type BlueskyImage = {
  readonly kind: 'image'
  readonly cid: string
  readonly mimeType?: string | undefined
  /** The aspect ratio the author's app recorded (usually the uploaded size); 0 when absent. */
  readonly width: number
  readonly height: number
  /** The CDN's full-size re-encode (WebP): the fallback. */
  readonly cdn: string
  readonly thumbnail?: string | undefined
}

export type BlueskyVideo = {
  readonly kind: 'video'
  readonly cid: string
  readonly mimeType?: string | undefined
  /** Bytes, as the record says (the blob's Content-Length is the same). */
  readonly size?: number | undefined
  readonly width: number
  readonly height: number
  /** `presentation: "gif"`: a looping clip, usually silent. */
  readonly gif: boolean
  readonly thumbnail?: string | undefined
  /** The HLS master (360p / 720p re-encodes): not used, see source.ts. */
  readonly playlist?: string | undefined
}

export type BlueskyMedia = BlueskyImage | BlueskyVideo

/** Why a post has nothing of its own to download. */
export type NoMedia = 'text' | 'quote' | 'link'

export type BlueskyPost = {
  readonly uri: string
  readonly rkey: string
  readonly did: string
  readonly handle: string
  readonly authorName?: string | undefined
  readonly text: string
  /** Unix seconds. */
  readonly createdAt?: number | undefined
  readonly media: readonly BlueskyMedia[]
  /** Set when `media` is empty. */
  readonly noMedia?: NoMedia | undefined
  /** Pinned to the top of the profile (a feed's `reasonPin`). */
  readonly pinned: boolean
  /** The author asked to be hidden from signed-out visitors (`!no-unauthenticated`). */
  readonly signInOnly: boolean
}

const IMAGES = 'app.bsky.embed.images'
const GALLERY = 'app.bsky.embed.gallery'
const VIDEO = 'app.bsky.embed.video'
const RECORD_WITH_MEDIA = 'app.bsky.embed.recordWithMedia'
const RECORD = 'app.bsky.embed.record'
const EXTERNAL = 'app.bsky.embed.external'
const REASON_PIN = 'app.bsky.feed.defs#reasonPin'
const REASON_REPOST = 'app.bsky.feed.defs#reasonRepost'
const THREAD_POST = 'app.bsky.feed.defs#threadViewPost'
const THREAD_GONE: ReadonlySet<string> = new Set(['app.bsky.feed.defs#notFoundPost', 'app.bsky.feed.defs#blockedPost'])

/** An embed's `$type` without its `#view` / `#main` part. */
const typeOf = (embed: unknown): string | undefined => text(dig(embed, '$type'))?.split('#', 1)[0]

/** A blob's CID: `ref.$link` (current), or `cid` (the legacy shape). */
function cidOf(blob: unknown): string | undefined {
  return text(dig(blob, 'ref', '$link')) ?? text(dig(blob, 'cid'))
}

/** Whether a set of labels holds `!no-unauthenticated`. O(labels). */
export function signInOnly(labels: unknown): boolean {
  return list(labels).some(label => dig(label, 'val') === NO_UNAUTHENTICATED)
}

const ratio = (value: unknown): {width: number; height: number} => ({
  width: num(dig(value, 'width')) ?? 0,
  height: num(dig(value, 'height')) ?? 0,
})

/** Pictures of an images or gallery record, each with its view's CDN links (same order). O(pictures). */
function pictures(
  items: readonly unknown[],
  views: readonly unknown[],
  did: string,
  endpoints: BlueskyEndpoints,
): BlueskyImage[] {
  const found: BlueskyImage[] = []
  items.forEach((item, i) => {
    const blob = dig(item, 'image')
    const cid = cidOf(blob)
    if (!cid) return
    const view = views[i]
    found.push({
      kind: 'image',
      cid,
      mimeType: text(dig(blob, 'mimeType')),
      ...ratio(dig(item, 'aspectRatio')),
      cdn: text(dig(view, 'fullsize')) ?? endpoints.imageCdn(did, cid),
      thumbnail: text(dig(view, 'thumb')) ?? text(dig(view, 'thumbnail')),
    })
  })
  return found
}

/**
 * The post's own media, by its record embed's type: pictures (images, the
 * gallery), a video, or the media half of a quote with media. A quote's
 * quoted post is someone else's post (its own link downloads it); a link card
 * has no media of the post's own. An embed of another type is a change on
 * Bluesky's side. O(media).
 */
function mediaOf(
  record: unknown,
  view: unknown,
  did: string,
  endpoints: BlueskyEndpoints,
): {media: BlueskyMedia[]; noMedia?: NoMedia} {
  const type = typeOf(record)
  switch (type) {
    case undefined:
      return {media: [], noMedia: 'text'}
    case IMAGES:
    case GALLERY: {
      const field = type === IMAGES ? 'images' : 'items'
      const items = list(dig(record, field))
      const media = pictures(items, list(dig(view, field)), did, endpoints)
      if (media.length === 0 && items.length > 0) {
        throw new MetaError('format-changed', `Bluesky: a ${type} embed without the blobs of its pictures.`)
      }
      return media.length > 0 ? {media} : {media, noMedia: 'text'}
    }
    case VIDEO: {
      const blob = dig(record, 'video')
      const cid = cidOf(blob) ?? text(dig(view, 'cid'))
      if (!cid) throw new MetaError('format-changed', 'Bluesky: a video embed without its blob.')
      return {
        media: [
          {
            kind: 'video',
            cid,
            mimeType: text(dig(blob, 'mimeType')),
            size: num(dig(blob, 'size')),
            ...ratio(dig(record, 'aspectRatio')),
            gif: dig(record, 'presentation') === 'gif',
            thumbnail: text(dig(view, 'thumbnail')),
            playlist: text(dig(view, 'playlist')),
          },
        ],
      }
    }
    case RECORD_WITH_MEDIA: {
      const own = mediaOf(dig(record, 'media'), dig(view, 'media'), did, endpoints)
      return own.media.length > 0 ? own : {media: [], noMedia: 'quote'}
    }
    case RECORD:
      return {media: [], noMedia: 'quote'}
    case EXTERNAL:
      return {media: [], noMedia: 'link'}
    default:
      throw new MetaError('format-changed', `Bluesky: a post embed of a type this library does not read (${type}).`)
  }
}

/** ISO date → unix seconds. */
const unix = (value: unknown): number | undefined => {
  const ms = Date.parse(text(value) ?? '')
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** A post view (`app.bsky.feed.defs#postView`) → the post. O(media). */
export function readPostView(raw: unknown, endpoints: BlueskyEndpoints, pinned = false): BlueskyPost {
  if (!isObject(raw)) throw new MetaError('format-changed', 'Bluesky: a post that is not an object.')
  const uri = text(raw['uri'])
  const author = isObject(raw['author']) ? raw['author'] : undefined
  const did = text(author?.['did'])
  const record = isObject(raw['record']) ? raw['record'] : undefined
  if (!uri || !did || !record)
    throw new MetaError('format-changed', 'Bluesky: a post without its uri, author or record.')
  const {media, noMedia} = mediaOf(record['embed'], raw['embed'], did, endpoints)
  return {
    uri,
    rkey: rkeyOfUri(uri),
    did,
    handle: text(author?.['handle'])?.toLowerCase() ?? did,
    authorName: text(author?.['displayName'])?.trim() || undefined,
    text: text(record['text']) ?? '',
    createdAt: unix(record['createdAt']) ?? unix(raw['indexedAt']),
    media,
    noMedia: media.length === 0 ? (noMedia ?? 'text') : undefined,
    pinned,
    signInOnly: signInOnly(author?.['labels']) || signInOnly(raw['labels']),
  }
}

/** getPostThread's answer → the post; a thread entry for a deleted or blocked post is a gone post. O(media). */
export function readThread(json: unknown, endpoints: BlueskyEndpoints): BlueskyPost {
  const thread = dig(json, 'thread')
  const type = text(dig(thread, '$type'))
  if (type && THREAD_GONE.has(type)) {
    throw new MetaError('removed', 'This Bluesky post was deleted (or its author blocks visitors from it).')
  }
  if (type !== undefined && type !== THREAD_POST) {
    throw new MetaError('format-changed', `Bluesky: a thread of a type this library does not read (${type}).`)
  }
  return readPostView(dig(thread, 'post'), endpoints)
}

/**
 * getPosts' answer → its posts by at-uri (a missing post is simply left out);
 * a post this module can't read fails alone, not the 24 others. O(posts).
 */
export function readPosts(json: unknown, endpoints: BlueskyEndpoints): Map<string, BlueskyPost | MetaError> {
  const posts = dig(json, 'posts')
  if (!Array.isArray(posts)) throw new MetaError('format-changed', 'Bluesky: getPosts answered without its posts.')
  const read = new Map<string, BlueskyPost | MetaError>()
  for (const raw of posts) {
    const uri = text(dig(raw, 'uri'))
    if (!uri) continue
    try {
      read.set(uri, readPostView(raw, endpoints))
    } catch (error) {
      if (!(error instanceof MetaError)) throw error
      read.set(uri, error)
    }
  }
  return read
}

export type BlueskyAccount = {
  readonly did: string
  readonly handle: string
  readonly name?: string | undefined
  /** Every post of the account (text ones included), as the profile says. */
  readonly posts?: number | undefined
  readonly signInOnly: boolean
}

/** getProfile's answer → the account. O(labels). */
export function readProfile(json: unknown): BlueskyAccount {
  if (!isObject(json)) throw new MetaError('format-changed', 'Bluesky: a profile that is not an object.')
  const did = text(json['did'])
  if (!did) throw new MetaError('format-changed', 'Bluesky: a profile without its DID.')
  return {
    did,
    handle: text(json['handle'])?.toLowerCase() ?? did,
    name: text(json['displayName'])?.trim() || undefined,
    posts: num(json['postsCount']),
    signInOnly: signInOnly(json['labels']),
  }
}

/**
 * A page of getAuthorFeed → the account's own posts with media, in order.
 * The pinned post comes first (`reasonPin`, whatever its date, even without
 * media: then left out); a repost (`reasonRepost`) or anyone else's post is
 * not the account's own and is left out too. O(posts of the page).
 */
export function readFeedPage(json: unknown, did: string, endpoints: BlueskyEndpoints): CursorPage<BlueskyPost> {
  const feed = dig(json, 'feed')
  if (!Array.isArray(feed)) throw new MetaError('format-changed', 'Bluesky: an author feed without its feed.')
  const items: BlueskyPost[] = []
  for (const entry of feed) {
    const reason = text(dig(entry, 'reason', '$type'))
    if (reason === REASON_REPOST) continue
    const view = dig(entry, 'post')
    if (dig(view, 'author', 'did') !== did) continue
    const post = readPostView(view, endpoints, reason === REASON_PIN)
    if (post.media.length > 0) items.push(post)
  }
  return {items, next: text(dig(json, 'cursor'))}
}

/** The account's PDS in a DID document (`#atproto_pds`, an http(s) url without its trailing slash). O(services). */
export function readPds(json: unknown): string | undefined {
  for (const service of list(dig(json, 'service'))) {
    const id = text(dig(service, 'id')) ?? ''
    const type = text(dig(service, 'type'))
    if (!id.endsWith('#atproto_pds') && type !== 'AtprotoPersonalDataServer') continue
    const endpoint = text(dig(service, 'serviceEndpoint'))
    if (!endpoint) continue
    try {
      const url = new URL(endpoint)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href.replace(/\/+$/, '')
    } catch {}
  }
  return undefined
}

export type MetaPostOptions = {
  /** Where the author's blobs are; undefined: the CDN only (pictures), nothing for a video. */
  readonly pds?: string | undefined
  /** The PDS is rate limiting this network: the CDN first, the original after. */
  readonly cdnFirst?: boolean | undefined
}

/** The blob url of a CID on a PDS. O(1). */
export function blobUrl(pds: string, did: string, cid: string): string {
  return `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`
}

/**
 * The post in the shape every native source downloads (meta/download.ts): a
 * picture's mirrors are the original blob then the CDN's re-encode (or the
 * other way round while the PDS limits this network); a video's one encoding
 * is its blob, the progressive MP4 Bluesky's video service made. Its size is
 * not in the post (`aspectRatio` is the upload's, not the file's): 0, which
 * no height cap excludes. O(media).
 */
export function toMetaPost(post: BlueskyPost, opts: MetaPostOptions = {}): MetaPost {
  const {pds} = opts
  const items: MetaMedia[] = post.media.map((media, i): MetaMedia => {
    const original = pds ? blobUrl(pds, post.did, media.cid) : undefined
    if (media.kind === 'image') {
      const urls = !original ? [media.cdn] : opts.cdnFirst ? [media.cdn, original] : [original, media.cdn]
      return {kind: 'image', id: `${post.rkey}-${i + 1}`, urls, width: media.width, height: media.height}
    }
    return {
      kind: 'video',
      id: `${post.rkey}-${i + 1}`,
      renditions: original
        ? [{codec: 'h264', width: 0, height: 0, resolution: 0, bitrate: 0, bytes: media.size, urls: [original]}]
        : [],
      width: media.width,
      height: media.height,
      cover: media.thumbnail,
    }
  })
  const first = post.media[0]
  return {
    id: post.rkey,
    url: postUrl(BLUESKY_ORIGIN, post.handle, post.rkey),
    caption: post.text,
    author: post.handle,
    authorName: post.authorName,
    createdAt: post.createdAt,
    items,
    cover: first?.thumbnail,
    pinned: post.pinned,
  }
}

/** Why a post can't be read for a visitor, or has nothing to download; undefined when it has media. */
export function unreadable(post: BlueskyPost): MetaError | undefined {
  if (post.signInOnly) {
    return new MetaError('login-required', `@${post.handle} asks Bluesky to show its posts to signed-in accounts only.`)
  }
  switch (post.noMedia) {
    case undefined:
      return undefined
    case 'quote':
      return new MetaError(
        'no-media',
        'This Bluesky post quotes another post and has no picture or video of its own: the quoted post’s own link downloads that one.',
      )
    case 'link':
      return new MetaError('no-media', 'This Bluesky post is a link card: it has no picture or video of its own.')
    case 'text':
      return new MetaError('no-media', 'This Bluesky post is text only: it has no picture or video to download.')
  }
}
