import type {RunResult} from '../core/process.js'
import {type Executable, invoke} from './executable.js'

/** Each inner list is "any of": e.g. AV1 decodes with the native decoder or libdav1d. */
type Requirement = readonly (readonly string[])[]

/** What the format profiles need from ffmpeg — conversion, validation and yt-dlp post-processing. */
export const FFMPEG_REQUIREMENTS = {
  encoders: [['libx264'], ['aac'], ['libvpx-vp9'], ['libopus'], ['libmp3lame'], ['flac'], ['pcm_s16le']],
  decoders: [
    ['h264'],
    ['hevc'],
    ['vp9', 'libvpx-vp9'],
    ['av1', 'libdav1d', 'libaom-av1'],
    ['aac'],
    ['opus', 'libopus'],
    ['mp3', 'mp3float'],
    ['vorbis'],
    ['flac'],
  ],
  muxers: [['mp4'], ['ipod'], ['webm'], ['matroska'], ['ogg'], ['mp3'], ['flac'], ['wav'], ['null']],
} as const satisfies Record<string, Requirement>

export type CapabilityKind = keyof typeof FFMPEG_REQUIREMENTS

export type FfmpegCapabilities = {
  readonly version: string
  /** Requirements not met, by kind — empty lists mean the build is fully capable. */
  readonly missing: Readonly<Record<CapabilityKind, readonly string[]>>
}

/**
 * Names listed by `ffmpeg -encoders | -decoders | -muxers`: every row after
 * the "---" separator is "<flags> <name> <description>".
 */
export function parseCodecList(output: string): Set<string> {
  const names = new Set<string>()
  let table = false
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!table) {
      table = trimmed.startsWith('--')
      continue
    }
    const name = trimmed.split(/\s+/, 2)[1]
    if (name) names.add(name)
  }
  return names
}

/** "ffmpeg version 9.0.2 Copyright…" → "9.0.2" (also handles ffprobe and git builds). */
export function parseFfmpegVersion(output: string): string | undefined {
  return /\bversion\s+(\S+)/.exec(output)?.[1]
}

const unmet = (available: ReadonlySet<string>, requirement: Requirement): string[] =>
  requirement.filter(anyOf => !anyOf.some(name => available.has(name))).map(anyOf => anyOf.join('|'))

/** Probe what an ffmpeg build supports. The three listings run in parallel. */
export async function inspectFfmpeg(ffmpeg: Executable, signal?: AbortSignal): Promise<FfmpegCapabilities | undefined> {
  const list = (flag: string) => invoke(ffmpeg, ['-hide_banner', flag], {signal, timeoutMs: 120_000})
  let listings: Awaited<ReturnType<typeof list>>[]
  try {
    listings = await Promise.all([list('-version'), list('-encoders'), list('-decoders'), list('-muxers')])
  } catch {
    return undefined // the binary can't be started
  }
  const [version, encoders, decoders, muxers] = listings as [RunResult, RunResult, RunResult, RunResult]
  if (listings.some(result => result.code !== 0)) return undefined
  return {
    version: parseFfmpegVersion(version.stdout) ?? 'unknown',
    missing: {
      encoders: unmet(parseCodecList(encoders.stdout), FFMPEG_REQUIREMENTS.encoders),
      decoders: unmet(parseCodecList(decoders.stdout), FFMPEG_REQUIREMENTS.decoders),
      muxers: unmet(parseCodecList(muxers.stdout), FFMPEG_REQUIREMENTS.muxers),
    },
  }
}

export const isFullyCapable = (caps: FfmpegCapabilities): boolean =>
  caps.missing.encoders.length + caps.missing.decoders.length + caps.missing.muxers.length === 0
