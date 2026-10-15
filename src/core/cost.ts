import type {FormatChoice, FormatProfile, JobTier, ProcessingKind} from '../types.js'

/**
 * How much of the ⌊CPUs/2⌋ capacity a job occupies while it runs. A pool of
 * capacity 6 (12 CPUs) runs six normal jobs, four long ones (N/3) or three
 * heavy ones (N/4) — or any mix that fits.
 */
export const TIER_WEIGHT: Readonly<Record<JobTier, number>> = {normal: 1, long: 1.5, heavy: 2}

export type CostInput = {
  readonly profile: FormatProfile
  /** Seconds. */
  readonly duration?: number | undefined
  readonly requiresConversion?: boolean | undefined
  readonly processingKind?: ProcessingKind | undefined
}

/**
 * Classify a job by the resources it will need:
 *   normal — under `longMinutes` (default 30), or any audio download;
 *   long   — a video of `longMinutes` or more: big files, long validation;
 *   heavy  — a long video that is also 1440p+ (or uncapped) or needs a local
 *            transcoding conversion: CPU-bound for minutes to hours.
 * Audio stays normal: even a 2-hour podcast is ~100 MB and decodes in seconds.
 */
export function jobTier(input: CostInput, longMinutes = 30): JobTier {
  if (input.profile.kind === 'audio') return 'normal'
  const long = (input.duration ?? 0) >= longMinutes * 60
  if (!long) return 'normal'
  const height = input.profile.maxHeight ?? Number.POSITIVE_INFINITY
  const isHeavyConversion =
    input.processingKind !== undefined ? input.processingKind === 'transcode' : (input.requiresConversion ?? false)
  return isHeavyConversion || height >= 1440 ? 'heavy' : 'long'
}

/**
 * Typical bitrates (bits/s) by height, used when a site doesn't report
 * sizes. Deliberately on the high side: a disk-space check must not
 * under-count.
 */
const VIDEO_BITRATE: ReadonlyArray<readonly [maxHeight: number, bitsPerSecond: number]> = [
  [360, 1_000_000],
  [480, 1_800_000],
  [720, 3_500_000],
  [1080, 6_000_000],
  [1440, 12_000_000],
  [2160, 25_000_000],
  [Number.POSITIVE_INFINITY, 50_000_000],
]
const AUDIO_BITRATE = 320_000

/**
 * Expected size of the final file: the site's figure for the choice that
 * matches the profile when known, else duration × a typical bitrate.
 * Undefined only when neither a size nor a duration is known.
 */
export function estimateBytes(
  profile: FormatProfile,
  choices: readonly FormatChoice[],
  duration: number | undefined,
): number | undefined {
  const reported = matchingChoice(profile, choices)?.estimatedBytes
  if (reported) return reported
  if (!duration) return undefined
  if (profile.kind === 'audio') return Math.ceil((duration * AUDIO_BITRATE) / 8)
  const height = profile.maxHeight ?? Number.POSITIVE_INFINITY
  const bitrate = VIDEO_BITRATE.find(([max]) => height <= max)![1]
  return Math.ceil((duration * (bitrate + AUDIO_BITRATE)) / 8)
}

/** The concrete choice a profile will resolve to: same container, the highest height within its cap. */
export function matchingChoice(profile: FormatProfile, choices: readonly FormatChoice[]): FormatChoice | undefined {
  let best: FormatChoice | undefined
  for (const choice of choices) {
    const p = choice.profile
    if (p.kind !== profile.kind || p.container !== profile.container) continue
    if (p.kind === 'audio') return choice
    if (profile.kind === 'video' && profile.maxHeight !== undefined && (p.maxHeight ?? 0) > profile.maxHeight) continue
    const bestHeight = best?.profile.kind === 'video' ? (best.profile.maxHeight ?? 0) : -1
    if ((p.maxHeight ?? 0) > bestHeight) best = choice
  }
  return best
}

/** Peak disk a running job needs: parts + merged file, plus one more copy when converting. */
export function peakBytes(estimatedBytes: number, requiresConversion: boolean): number {
  return estimatedBytes * (requiresConversion ? 3 : 2)
}
