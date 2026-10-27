/**
 * Master playlist variants as the shared `Rendition`, so `rankRenditions` decides exactly as it does
 * for every other native source (H.264 first for mp4, highest resolution within `maxHeight` by short
 * side, the smallest for audio). Pure; v (variants) is a handful, so O(v log v) is the whole cost.
 */
import {
  audioChoices,
  type Rendition,
  rankRenditions,
  renditionChoices,
  type VideoCodec,
} from '../../sources/renditions.js'
import type {FormatChoice, FormatProfile} from '../../types.js'
import {HlsError} from './errors.js'
import type {HlsAudioTrack, HlsMasterPlaylist, HlsVariant} from './playlist.js'

export type VariantChoice = {
  readonly variant: HlsVariant
  /** The demuxed audio track to download with it (EXT-X-MEDIA with URI), when the variant has one. */
  readonly audio?: HlsAudioTrack | undefined
  /** The other acceptable variants, best first: tried when the chosen one's playlist refuses. */
  readonly fallbacks: readonly HlsVariant[]
  /** Bytes forecast: (AVERAGE-BANDWIDTH ?? BANDWIDTH) × duration / 8, when the duration is known. */
  readonly estimatedBytes?: number | undefined
}

const AUDIO_CODEC = /^(?:mp4a|opus|mp3|mp4a\.40|ac-3|ec-3|fLaC|flac|vorbis|alac)/i

function videoCodecOf(codecs: readonly string[]): VideoCodec | 'none' | undefined {
  if (codecs.length === 0) return undefined
  for (const c of codecs) {
    const lower = c.toLowerCase()
    if (lower.startsWith('avc1') || lower.startsWith('avc3')) return 'h264'
    if (lower.startsWith('hvc1') || lower.startsWith('hev1')) return 'h265'
    if (lower.startsWith('av01')) return 'av1'
  }
  // only audio codecs → an audio-only variant; an unknown video codec (vp09, dvh1…) → not offered
  return codecs.every(c => AUDIO_CODEC.test(c)) ? 'none' : undefined
}

const isAudioOnly = (v: HlsVariant): boolean =>
  v.height === undefined && v.width === undefined && (v.codecs.length === 0 || videoCodecOf(v.codecs) === 'none')

const carriesAudio = (v: HlsVariant): boolean =>
  v.codecs.length === 0 || v.audioGroup !== undefined || v.codecs.some(c => AUDIO_CODEC.test(c))

const bitrateOf = (v: HlsVariant): number => v.averageBandwidth ?? v.bandwidth

/**
 * Variants as renditions: codec from CODECS (avc1 → h264, hvc1/hev1 → h265, av01 → av1; a variant
 * without CODECS but with a RESOLUTION is taken as H.264; other video codecs are left out), resolution =
 * short side of RESOLUTION, bitrate = AVERAGE-BANDWIDTH ?? BANDWIDTH, urls = [uri], bytes = bitrate ×
 * duration / 8 when the duration is given. Audio-only variants are not renditions (see `chooseVariant`).
 * O(v) for v variants.
 */
export function variantRenditions(master: HlsMasterPlaylist, duration?: number | undefined): Rendition[] {
  const out: Rendition[] = []
  for (const v of master.variants) {
    if (isAudioOnly(v) || v.width === undefined || v.height === undefined) continue
    const codec = videoCodecOf(v.codecs) ?? (v.codecs.length === 0 ? 'h264' : undefined)
    if (codec === undefined || codec === 'none') continue
    const bitrate = bitrateOf(v)
    out.push({
      codec,
      width: v.width,
      height: v.height,
      resolution: Math.min(v.width, v.height),
      bitrate,
      bytes: duration && bitrate ? Math.ceil((bitrate * duration) / 8) : undefined,
      urls: [v.uri],
    })
  }
  return out
}

/** The track of a variant's audio group to download beside it: DEFAULT=YES, else the first; only one with its own URI. */
function audioTrackOf(master: HlsMasterPlaylist, v: HlsVariant): HlsAudioTrack | undefined {
  if (!v.audioGroup) return undefined
  const group = master.audio.get(v.audioGroup)
  if (!group || group.length === 0) return undefined
  const track = group.find(t => t.isDefault) ?? group[0]
  return track?.uri ? track : undefined
}

const estimate = (v: HlsVariant, duration: number | undefined): number | undefined =>
  duration && bitrateOf(v) ? Math.ceil((bitrateOf(v) * duration) / 8) : undefined

/**
 * The variant for a profile:
 *  - video: `rankRenditions(variantRenditions(master), profile)[0]` (cap by short side, H.264 first for
 *    mp4); its audio group's default track when that track has its own URI;
 *  - audio: an audio-only variant when there is one (Twitch "Audio_Only"), the lowest first; else a
 *    demuxed audio track, downloaded alone as the main track (no video bytes at all); else the
 *    lowest-bandwidth variant that carries audio (the engine extracts the track).
 * Throws HlsError('empty') when no variant is usable. O(v log v), v is a handful.
 */
export function chooseVariant(
  master: HlsMasterPlaylist,
  profile: FormatProfile,
  duration?: number | undefined,
): VariantChoice {
  if (profile.kind === 'audio') {
    const audioOnly = master.variants.filter(isAudioOnly).sort((a, b) => bitrateOf(a) - bitrateOf(b))
    const withAudio = master.variants.filter(carriesAudio).sort((a, b) => bitrateOf(a) - bitrateOf(b))
    const [first, ...rest] = audioOnly
    if (first) return {variant: first, fallbacks: rest, estimatedBytes: estimate(first, duration)}
    const lowest = withAudio[0]
    const track = lowest && audioTrackOf(master, lowest)
    if (lowest && track?.uri) {
      const variant: HlsVariant = {
        uri: track.uri,
        bandwidth: 0,
        codecs: lowest.codecs.filter(c => AUDIO_CODEC.test(c)),
        name: track.name,
      }
      return {variant, fallbacks: []}
    }
    const [low, ...others] = withAudio
    if (low) return {variant: low, fallbacks: others, estimatedBytes: estimate(low, duration)}
    throw new HlsError('empty', 'The playlist has no variant with audio.')
  }
  const byUri = new Map<string, HlsVariant>()
  for (const v of master.variants) byUri.set(v.uri, v)
  const ranked = rankRenditions(variantRenditions(master), profile)
  const picked: HlsVariant[] = []
  for (const r of ranked) {
    const v = r.urls[0] === undefined ? undefined : byUri.get(r.urls[0])
    if (v) picked.push(v)
  }
  const [best, ...fallbacks] = picked
  if (!best) throw new HlsError('empty', 'The playlist has no video variant this engine can use.')
  return {variant: best, audio: audioTrackOf(master, best), fallbacks, estimatedBytes: estimate(best, duration)}
}

/** Format choices for `analyze`: `renditionChoices(variantRenditions(master), duration)`, or the audio choices alone. */
export function variantChoices(master: HlsMasterPlaylist, duration: number | undefined): FormatChoice[] {
  const renditions = variantRenditions(master, duration)
  if (renditions.length > 0) return renditionChoices(renditions, duration)
  return master.variants.some(carriesAudio) ? audioChoices(duration) : []
}
