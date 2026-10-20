import type {FormatChoice, MediaSummary} from '../../types.js'
import type {Rendition} from '../renditions.js'
import {renditionChoices} from '../renditions.js'
import {imagesChoices} from '../tiktok/renditions.js'

/**
 * One post of a Meta site as every reader hands it over, whatever the page or
 * API it came from: a video, a photo, or a carousel of both. Both sites model
 * their media the same way (Instagram's carousel is Facebook's "attachments"),
 * so the download, the choices and the summaries are written once.
 */
export type MetaVideo = {
  readonly kind: 'video'
  readonly id: string
  readonly renditions: readonly Rendition[]
  /** Seconds. */
  readonly duration?: number | undefined
  readonly width: number
  readonly height: number
  readonly cover?: string | undefined
}

export type MetaImage = {
  readonly kind: 'image'
  readonly id: string
  /** Mirrors / sizes of the same picture, best first. */
  readonly urls: readonly string[]
  readonly width: number
  readonly height: number
}

export type MetaMedia = MetaVideo | MetaImage

/** The song a photo post plays (Instagram's music sticker, Facebook's music on a photo). */
export type MetaMusic = {
  readonly url: string
  /** Seconds. */
  readonly duration?: number | undefined
  readonly title?: string | undefined
}

export type MetaPost = {
  readonly id: string
  /** Instagram's shortcode; Facebook has none. */
  readonly code?: string | undefined
  /** Its public page. */
  readonly url: string
  readonly caption: string
  /** The account's handle (username, page slug). */
  readonly author: string
  readonly authorName?: string | undefined
  /** Unix seconds. */
  readonly createdAt?: number | undefined
  /** A story: when it disappears, unix seconds. */
  readonly expiresAt?: number | undefined
  /** One for a video or a photo; several for a carousel, in order. */
  readonly items: readonly MetaMedia[]
  /** A photo or a carousel of photos with a song: what its slideshow plays. */
  readonly music?: MetaMusic | undefined
  readonly cover?: string | undefined
  /** Pinned to the top of the profile: listed first whatever its date. */
  readonly pinned: boolean
  readonly story?: boolean | undefined
}

export type PostShape = 'video' | 'photo' | 'carousel' | 'empty'

export function shapeOf(post: MetaPost): PostShape {
  if (post.items.length === 0) return 'empty'
  if (post.items.length > 1) return 'carousel'
  return post.items[0]!.kind === 'video' ? 'video' : 'photo'
}

export const videosOf = (post: MetaPost): MetaVideo[] => post.items.filter((m): m is MetaVideo => m.kind === 'video')
export const imagesOf = (post: MetaPost): MetaImage[] => post.items.filter((m): m is MetaImage => m.kind === 'image')

/** First line of the caption without trailing hashtags; `${site} ${id}` when there is no caption. */
export function titleOf(post: MetaPost, site: string): string {
  const caption = post.caption
    .split('\n', 1)[0]!
    .replace(/(\s*[#@][^\s#@]+)+\s*$/u, '')
    .trim()
  const short = caption.length > 90 ? `${caption.slice(0, 90).replace(/\s+\S*$/, '')}…` : caption
  if (short) return short
  if (post.story) {
    const when = post.createdAt ? new Date(post.createdAt * 1000).toISOString().slice(0, 16).replace('T', ' ') : post.id
    return `${site} story ${when}`
  }
  return `${site} ${post.id}`
}

export function summaryOf(post: MetaPost, site: string): MediaSummary {
  const shape = shapeOf(post)
  const video = videosOf(post)[0]
  return {
    id: post.id,
    url: post.url,
    title: titleOf(post, site),
    uploader: post.authorName ?? post.author,
    duration: shape === 'video' ? video?.duration : undefined,
    thumbnail: post.cover ?? video?.cover ?? imagesOf(post)[0]?.urls[0],
    publishedAt: post.createdAt,
    // a photo or a carousel is a set of pictures (with videos: a bundle, kept as they are)
    ...(shape !== 'video' &&
      shape !== 'empty' && {
        slideshow: {
          images: post.items.length,
          audio: video !== undefined || post.music !== undefined,
          ...(video && {videos: true}),
        },
      }),
    extractor: site,
    isLive: false,
  }
}

/**
 * What a post can become: a video's encodings as they are; a photo or a
 * carousel of photos as a slideshow video or a folder (over its song, which
 * an audio profile extracts); a carousel with videos as a folder, or the
 * audio of its first video.
 */
export function choicesOf(post: MetaPost, secondsPerImage = 3): FormatChoice[] {
  const shape = shapeOf(post)
  const video = videosOf(post)[0]
  if (shape === 'video' && video) return renditionChoices(video.renditions, video.duration)
  if (shape === 'empty') return []
  const images = post.items.map(item => ({width: item.width, height: item.height}))
  if (video) return imagesChoices(images, video.duration, secondsPerImage, true)
  return imagesChoices(images, post.music?.duration, secondsPerImage, post.music !== undefined)
}
