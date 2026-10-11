import type {AudioContainer, FormatChoice, FormatProfile, VideoContainer} from '../../types.js'
import type {Rendition, TikTokPost} from './data.js'

/**
 * Which encoding of a post to fetch for a profile, best first (the rest are
 * fallbacks when a mirror refuses or a file comes without sound):
 *  - audio: the smallest file — the soundtrack is the same in all of them;
 *  - mp4:   H.264 first (plays everywhere: car stereos, TVs, old phones),
 *           highest resolution within the cap; H.265 only as a fallback;
 *  - mkv / webm: highest resolution, H.265 before H.264 at equal size.
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
    if (a.codec !== b.codec) return a.codec === 'h265' ? -1 : 1
    return b.bitrate - a.bitrate
  })
}

// audio a container ends up with after extraction (bits/s), for size estimates
const AUDIO_RATE: Readonly<Record<AudioContainer, number>> = {
  m4a: 130_000,
  mp3: 260_000,
  opus: 160_000,
  flac: 1_000_000,
  wav: 1_536_000,
}

/**
 * Format choices for one post, with exact sizes — TikTok reports the byte
 * size of every encoding, so no estimating from bitrates is needed.
 */
export function tiktokChoices(post: TikTokPost): FormatChoice[] {
  const resolutions = [...new Set(post.renditions.map(r => r.resolution))].sort((a, b) => b - a)
  const containers: readonly VideoContainer[] = ['mp4', 'webm', 'mkv']
  const video = containers.flatMap(container =>
    resolutions.map(resolution => {
      const profile: FormatProfile = {kind: 'video', container, maxHeight: resolution}
      const best = rankRenditions(post.renditions, profile)[0]
      return {
        profile,
        label: `${resolution}p · ${container.toUpperCase()}${best?.codec === 'h265' ? ' · H.265' : ''}`,
        estimatedBytes: best?.bytes,
        // webm always transcodes (VP9 / Opus); mp4 only when no H.264 fits the cap
        requiresConversion: container === 'webm' || (container === 'mp4' && best?.codec !== 'h264'),
      } satisfies FormatChoice
    }),
  )
  const audio = (Object.keys(AUDIO_RATE) as AudioContainer[]).map(
    container =>
      ({
        profile: {kind: 'audio', container},
        label: `Audio · ${container.toUpperCase()}`,
        estimatedBytes: post.duration ? Math.ceil((AUDIO_RATE[container] * post.duration) / 8) : undefined,
        requiresConversion: false,
      }) satisfies FormatChoice,
  )
  return post.renditions.length ? [...video, ...audio] : []
}
