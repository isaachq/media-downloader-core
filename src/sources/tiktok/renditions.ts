import type {FormatChoice, VideoContainer} from '../../types.js'
import {audioChoices, rankRenditions, renditionChoices} from '../renditions.js'
import type {TikTokPost} from './data.js'

// The ranking and the choices are shared by every native source (../renditions.ts);
// TikTok keeps its names so hosts and tests see no change.
export {rankRenditions}

/**
 * Format choices for one post, with exact sizes — TikTok reports the byte
 * size of every encoding, so no estimating from bitrates is needed.
 */
export function tiktokChoices(post: TikTokPost): FormatChoice[] {
  return renditionChoices(post.renditions, post.duration)
}

/** Bits per second of a slideshow video: still frames compress far below a filmed clip. */
const SLIDESHOW_RATE = 1_500_000

/**
 * What a photo post (a slideshow) can become: a video in any container —
 * always encoded here, from its images — and, when it has a soundtrack, any
 * audio format. Sizes assume the default 3 s per image.
 */
export function slideshowChoices(post: TikTokPost, secondsPerImage = 3): FormatChoice[] {
  return imagesChoices(post.images, post.music?.duration, secondsPerImage, Boolean(post.music?.url))
}

/**
 * The choices of a set of images (a slideshow, a carousel, a photo): a video
 * in any container, encoded here; audio formats only with a `soundDuration`
 * (a soundtrack to extract). Shared with the other native sources.
 */
export function imagesChoices(
  images: ReadonlyArray<{readonly width: number; readonly height: number}>,
  soundDuration: number | undefined,
  secondsPerImage = 3,
  hasSound = soundDuration !== undefined,
): FormatChoice[] {
  if (images.length === 0) return []
  const seconds = images.length * secondsPerImage
  const height = Math.max(...images.map(image => Math.min(image.width, image.height) || 1080))
  const containers: readonly VideoContainer[] = ['mp4', 'webm', 'mkv']
  const video = containers.map(
    container =>
      ({
        profile: {kind: 'video', container, maxHeight: height},
        label: `Slideshow · ${container.toUpperCase()}`,
        estimatedBytes: Math.ceil((SLIDESHOW_RATE * seconds) / 8),
        requiresConversion: true,
        processingKind: 'transcode',
      }) satisfies FormatChoice,
  )
  return hasSound ? [...video, ...audioChoices(soundDuration)] : video
}
