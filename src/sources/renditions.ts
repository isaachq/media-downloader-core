import type {AudioContainer, FormatChoice, FormatProfile, ProcessingKind, VideoContainer} from '../types.js'

/**
 * Encodings of one video as native sources see them — a few progressive MP4
 * files per post (TikTok, Instagram and Facebook all serve them that way) —
 * and the choices the engine offers for them. Shared by every native source,
 * so the ranking (H.264 first for MP4, highest resolution within the cap…)
 * is the same wherever a post comes from.
 */

export type VideoCodec = 'h264' | 'h265' | 'av1'

/** Order at equal resolution outside mp4's H.264-first rule: H.265, then AV1, then H.264. */
const CODEC_ORDER: Readonly<Record<VideoCodec, number>> = {h265: 0, av1: 1, h264: 2}

/** One encoding of a post's video. */
export type Rendition = {
  readonly codec: VideoCodec
  readonly width: number
  readonly height: number
  /** Short side — what "720p" means for a vertical video too. */
  readonly resolution: number
  readonly bitrate: number
  readonly bytes?: number | undefined
  /** Mirrors of the same file, best first. */
  readonly urls: readonly string[]
  /**
   * A video-only stream (DASH) and the audio stream that goes with it: both
   * are fetched and muxed into one file (a stream copy, nothing re-encoded).
   */
  readonly audio?: {readonly urls: readonly string[]; readonly bitrate: number} | undefined
}

/**
 * Which encoding to fetch for a profile, best first (the rest are fallbacks
 * when a mirror refuses or a file comes without sound):
 *  - audio: the smallest file — the soundtrack is the same in all of them;
 *  - mp4:   H.264 first (plays everywhere: car stereos, TVs, old phones),
 *           highest resolution within the cap; H.265 / AV1 only as a fallback;
 *  - mkv / webm: highest resolution, H.265 before AV1 before H.264 at equal size.
 * O(r log r) for r renditions (a handful).
 */
export function rankRenditions(renditions: readonly Rendition[], profile: FormatProfile): Rendition[] {
  const size = (r: Rendition) => r.bytes ?? r.bitrate
  if (profile.kind === 'audio') return [...renditions].sort((a, b) => size(a) - size(b))

  const cap = profile.maxHeight ?? Number.POSITIVE_INFINITY
  const within = renditions.filter(r => r.resolution <= cap)
  // nothing small enough: the smallest there is
  const pool = within.length ? within : [...renditions].sort((a, b) => a.resolution - b.resolution).slice(0, 1)
  const h264First = profile.container === 'mp4'
  return pool.sort((a, b) => {
    if (h264First && a.codec !== b.codec) return a.codec === 'h264' ? -1 : 1
    if (a.resolution !== b.resolution) return b.resolution - a.resolution
    if (a.codec !== b.codec) return CODEC_ORDER[a.codec] - CODEC_ORDER[b.codec]
    return b.bitrate - a.bitrate
  })
}

/** Audio a container ends up with after extraction (bits/s), for size estimates. */
export const AUDIO_RATE: Readonly<Record<AudioContainer, number>> = {
  m4a: 130_000,
  mp3: 260_000,
  opus: 160_000,
  flac: 1_000_000,
  wav: 1_536_000,
}

export const VIDEO_CONTAINERS: readonly VideoContainer[] = ['mp4', 'webm', 'mkv']

/** The audio choices of anything with a soundtrack `duration` seconds long. */
export function audioChoices(duration: number | undefined): FormatChoice[] {
  return (Object.keys(AUDIO_RATE) as AudioContainer[]).map(
    container =>
      ({
        profile: {kind: 'audio', container},
        label: `Audio · ${container.toUpperCase()}`,
        estimatedBytes: duration ? Math.ceil((AUDIO_RATE[container] * duration) / 8) : undefined,
        requiresConversion: true,
        processingKind: 'extract',
      }) satisfies FormatChoice,
  )
}

/**
 * Format choices for one video from its encodings, with exact sizes when the
 * site reports them (no estimating from bitrates). Empty without encodings.
 */
export function renditionChoices(renditions: readonly Rendition[], duration: number | undefined): FormatChoice[] {
  if (renditions.length === 0) return []
  const resolutions = [...new Set(renditions.map(r => r.resolution))].sort((a, b) => b - a)
  const video = VIDEO_CONTAINERS.flatMap(container =>
    resolutions.map(resolution => {
      const profile: FormatProfile = {kind: 'video', container, maxHeight: resolution}
      const best = rankRenditions(renditions, profile)[0]
      const kind: ProcessingKind =
        container === 'webm' || (container === 'mp4' && best?.codec !== 'h264')
          ? 'transcode'
          : container === 'mkv'
            ? 'remux'
            : 'none'
      return {
        profile,
        label: `${resolution}p · ${container.toUpperCase()}${best?.codec === 'h265' ? ' · H.265' : best?.codec === 'av1' ? ' · AV1' : ''}`,
        estimatedBytes: best?.bytes,
        requiresConversion: kind !== 'none',
        processingKind: kind,
      } satisfies FormatChoice
    }),
  )
  return [...video, ...audioChoices(duration)]
}
