import type {MediaSummary} from '../../types.js'
import {MetaError} from '../meta/errors.js'
import type {Rendition} from '../renditions.js'
import {postUrl, videoUrl} from './links.js'

/**
 * Reading X posts from the syndication endpoint its embedded-post widget uses
 * (`cdn.syndication.twimg.com/tweet-result`): public, anonymous, plain JSON —
 * no guest token, no GraphQL, no session. What it answered when this was
 * written (October 2026):
 *  - a post: `__typename: 'Tweet'` with `mediaDetails[]`; a video or an
 *    animated GIF has `video_info.variants[]` = progressive MP4s
 *    (`content_type: video/mp4`, a `bitrate`, the size in the url as
 *    `/vid/1280x720/`) plus an HLS playlist; a GIF has one MP4, bitrate 0,
 *    no size in its url (the media's `original_info` has it);
 *  - a video that is a card (ads, "video website" cards): the same media
 *    objects inside `card.binding_values.unified_card` (a JSON string);
 *  - a quote of a post with a video: that post under `quoted_tweet`;
 *  - a deleted post, one of a suspended or protected account, or one X keeps
 *    for signed-in (adult) viewers: `{"__typename":"TweetTombstone"}`;
 *  - an id that never existed: HTTP 404 (an HTML page);
 *  - a request without its token: `{}`.
 */
export const SYNDICATION_ORIGIN = 'https://cdn.syndication.twimg.com'

/**
 * The token the widget sends with each request, from the post id alone
 * (react-tweet's `getToken`): ((id / 1e15) · π) in base 36, zeros and the
 * point removed. O(1).
 */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

export function tweetResultUrl(id: string, origin = SYNDICATION_ORIGIN): string {
  return `${origin}/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`
}

export type XVideo = {
  /** X's media id when the urls tell it (what yt-dlp names the video by); else undefined. */
  readonly mediaId?: string | undefined
  readonly gif: boolean
  readonly renditions: readonly Rendition[]
  /** Seconds (GIFs have none). */
  readonly duration?: number | undefined
  readonly width: number
  readonly height: number
  readonly cover?: string | undefined
}

export type XPost = {
  readonly id: string
  /** The account's handle (screen_name). */
  readonly user: string
  readonly userName?: string | undefined
  /** The post's text, t.co links removed. */
  readonly text: string
  /** Unix seconds. */
  readonly createdAt?: number | undefined
  /** Its videos and GIFs, in order; empty for a post with pictures or text only. */
  readonly videos: readonly XVideo[]
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const changed = (what: string) => new MetaError('format-changed', `X: ${what}`)

/**
 * A tweet-result answer as a post, or the reason it is not one. A post's own
 * videos come first; without any, those of its card, then those of the post
 * it quotes (what the reader sees playing). O(size of the answer).
 */
export function readTweetResult(body: unknown): XPost {
  if (!isObject(body)) throw changed('the post data is not an object.')
  const type = body['__typename']
  if (type === 'TweetTombstone') {
    const said = tombstoneText(body['tombstone'])
    // an empty tombstone is what an age-restricted post gets (yt-dlp: "requires authentication")
    if (!said || SIGNED_IN_ONLY.test(said)) {
      throw new MetaError(
        'login-required',
        `X shows this post to signed-in accounts only (age-restricted or protected)${said ? `: ${said}` : '.'}`,
      )
    }
    throw new MetaError('removed', `X: ${said}`)
  }
  if (type === 'TweetUnavailable') {
    const reason = typeof body['reason'] === 'string' ? body['reason'] : ''
    if (/protected/i.test(reason)) throw new MetaError('private', 'This post is from a protected account.')
    throw new MetaError('removed', `This post is not available${reason ? ` (${reason})` : ''}.`)
  }
  if (type === undefined && Object.keys(body).length === 0) {
    throw changed('the post data came back empty (the request token is no longer accepted).')
  }
  if (type !== 'Tweet') throw changed(`unexpected post data (${String(type)}).`)
  const post = readTweet(body)
  if (post.videos.length > 0) return post
  const quoted = body['quoted_tweet']
  if (isObject(quoted)) {
    try {
      const inner = readTweet(quoted)
      if (inner.videos.length > 0) return inner
    } catch {
      // a quoted post X describes differently: the post itself is still read
    }
  }
  if (withheld(body) || (isObject(quoted) && withheld(quoted))) {
    throw new MetaError('removed', 'X withholds this video (removed after a report, or not shown in this country).')
  }
  // a video this answer leaves out (an external player, a broadcast): not "no video" — another extractor may read it
  if (hidesVideo(body) || (isObject(quoted) && hidesVideo(quoted))) {
    throw new MetaError(
      'other-extractor',
      "X: this post's video is not in X's public post data (a player card, a broadcast or an external player).",
    )
  }
  return post
}

/** Tombstone texts of posts X shows signed-in viewers (the rest — deleted, suspended — are gone for everyone). */
const SIGNED_IN_ONLY = /age[- ]restricted|adult|sensitive|log ?in|sign ?in|limits who can view|protected/i
/** Links to a video X plays itself, somewhere the embed data does not describe. */
const VIDEO_LINK =
  /^https?:\/\/(?:amp\.twimg\.com\/|video\.twimg\.com\/|(?:www\.)?(?:pscp|periscope)\.tv\/|(?:\w+\.)?(?:x|twitter)\.com\/(?:i\/broadcasts\/|i\/videos\/|\w+\/status\/\d+\/video\/))/i
/** Card names that play a video. */
const VIDEO_CARD = /player|amplify|video|broadcast|periscope|live_event/i

/** A video of the post marked unavailable (the media list says so per item). O(media). */
function withheld(tweet: Json): boolean {
  const media = Array.isArray(tweet['mediaDetails']) ? tweet['mediaDetails'] : []
  return media.some(
    item =>
      isObject(item) &&
      (item['type'] === 'video' || item['type'] === 'animated_gif') &&
      isObject(item['ext_media_availability']) &&
      item['ext_media_availability']['status'] === 'Unavailable',
  )
}

/**
 * Signs that a post has a video its answer leaves out: the widget's own
 * `video` object, a player card, a link to a video X hosts. O(size of the post).
 */
function hidesVideo(tweet: Json): boolean {
  if (isObject(tweet['video'])) return true
  const card = tweet['card']
  if (isObject(card)) {
    if (typeof card['name'] === 'string' && VIDEO_CARD.test(card['name']) && card['name'] !== 'unified_card')
      return true
    const unified = isObject(card['binding_values']) ? card['binding_values']['unified_card'] : undefined
    if (isObject(unified) && typeof unified['string_value'] === 'string') {
      try {
        const parsed: unknown = JSON.parse(unified['string_value'])
        if (isObject(parsed) && typeof parsed['type'] === 'string' && /video/i.test(parsed['type'])) return true
      } catch {
        // an unreadable card is no sign either way
      }
    }
  }
  const entities = tweet['entities']
  const urls = isObject(entities) && Array.isArray(entities['urls']) ? entities['urls'] : []
  return urls.some(u => isObject(u) && typeof u['expanded_url'] === 'string' && VIDEO_LINK.test(u['expanded_url']))
}

function readTweet(tweet: Json): XPost {
  const id = tweet['id_str']
  const user = tweet['user']
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw changed('a post without its id.')
  if (!isObject(user) || typeof user['screen_name'] !== 'string') throw changed('a post without its account.')
  const created = Date.parse(typeof tweet['created_at'] === 'string' ? tweet['created_at'] : '')
  const media = tweet['mediaDetails']
  if (media !== undefined && !Array.isArray(media)) throw changed('the media list is not a list.')
  let videos = videosOf(media ?? [])
  if (videos.length === 0) videos = videosOf(cardMedia(tweet['card']))
  return {
    id,
    user: user['screen_name'],
    userName: typeof user['name'] === 'string' && user['name'] ? user['name'] : undefined,
    text: cleanText(typeof tweet['text'] === 'string' ? tweet['text'] : ''),
    createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : undefined,
    videos,
  }
}

/** The videos and GIFs of a media list, in order (pictures skipped). O(media + variants). */
function videosOf(media: readonly unknown[]): XVideo[] {
  const videos: XVideo[] = []
  for (const item of media) {
    if (!isObject(item) || (item['type'] !== 'video' && item['type'] !== 'animated_gif')) continue
    const availability = item['ext_media_availability']
    if (isObject(availability) && availability['status'] === 'Unavailable') continue
    const info = item['video_info']
    if (!isObject(info) || !Array.isArray(info['variants'])) throw changed('a video without its variants.')
    const original = isObject(item['original_info']) ? item['original_info'] : {}
    const width = positive(original['width'])
    const height = positive(original['height'])
    const renditions: Rendition[] = []
    for (const variant of info['variants']) {
      if (!isObject(variant) || variant['content_type'] !== 'video/mp4' || typeof variant['url'] !== 'string') continue
      const url = variant['url']
      const size = /\/(\d{2,5})x(\d{2,5})\//.exec(url)
      const w = size ? Number(size[1]) : width
      const h = size ? Number(size[2]) : height
      renditions.push({
        codec: 'h264',
        width: w,
        height: h,
        resolution: Math.min(w, h) || Math.max(w, h),
        bitrate: positive(variant['bitrate']),
        urls: [url],
      })
    }
    // only the HLS playlist: yt-dlp reads those
    if (renditions.length === 0) throw changed('a video without a progressive MP4.')
    const duration = positive(info['duration_millis'])
    const cover = typeof item['media_url_https'] === 'string' ? item['media_url_https'] : undefined
    const mediaId =
      (typeof item['id_str'] === 'string' && item['id_str']) ||
      /\/(?:ext_tw_video|amplify_video)(?:_thumb)?\/(\d+)\//.exec(`${renditions[0]!.urls[0]} ${cover ?? ''}`)?.[1]
    videos.push({
      mediaId: mediaId || undefined,
      gif: item['type'] === 'animated_gif',
      renditions,
      duration: duration ? duration / 1000 : undefined,
      width: width || renditions[0]!.width,
      height: height || renditions[0]!.height,
      cover,
    })
  }
  return videos
}

/** The media objects of a card (`unified_card`'s `media_entities`), or none. O(size of the card). */
function cardMedia(card: unknown): unknown[] {
  if (!isObject(card) || !isObject(card['binding_values'])) return []
  const unified = card['binding_values']['unified_card']
  if (!isObject(unified) || typeof unified['string_value'] !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(unified['string_value'])
    return isObject(parsed) && isObject(parsed['media_entities']) ? Object.values(parsed['media_entities']) : []
  } catch {
    return []
  }
}

function tombstoneText(tombstone: unknown): string | undefined {
  if (!isObject(tombstone)) return undefined
  const text = tombstone['text']
  const said = isObject(text) ? text['text'] : text
  // "This Post was deleted by the Post author. Learn more": the link's words are not the reason
  const reason = typeof said === 'string' ? said.replace(/\s*Learn more\.?\s*$/i, '').trim() : ''
  return reason || undefined
}

const positive = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0)

const ENTITIES: Readonly<Record<string, string>> = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'"}

/** The text without its t.co links (the media's and the shared pages'), entities decoded. O(length). */
export function cleanText(text: string): string {
  return text
    .replace(/https?:\/\/t\.co\/\w+/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]!)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

/** First line of the text, at most ~90 characters; "X <id>" without text. O(length). */
export function titleOf(post: XPost): string {
  const line = post.text.split('\n', 1)[0]!.trim()
  const short = line.length > 90 ? `${line.slice(0, 90).replace(/\s+\S*$/, '')}…` : line
  return short || `X ${post.id}`
}

/**
 * The id a video goes by — X's media id when known (yt-dlp's id too, so the
 * archive agrees whichever extractor read it), else the post's id, numbered
 * when the post has several. O(1).
 */
export function videoIdOf(post: XPost, index: number): string {
  const video = post.videos[index - 1]
  return video?.mediaId ?? (post.videos.length > 1 ? `${post.id}-${index}` : post.id)
}

/** One video of a post as the engine lists it (`index`: 1-based); of a post with several, its own `/video/<n>` page. */
export function summaryOf(post: XPost, index: number, site: string): MediaSummary {
  const video = post.videos[index - 1]
  const many = post.videos.length > 1
  return {
    id: videoIdOf(post, index),
    url: many ? videoUrl(post.id, post.user, index) : postUrl(post.id, post.user),
    title: many ? `${titleOf(post)} #${index}` : titleOf(post),
    uploader: post.user,
    duration: video?.duration,
    thumbnail: video?.cover,
    publishedAt: post.createdAt,
    extractor: site,
    isLive: false,
  }
}
