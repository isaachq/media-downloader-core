import type {AudioContainer, AudioProfile, FormatChoice, FormatProfile, VideoContainer, VideoProfile} from '../types.js'
import {formatBytes} from '../util/units.js'
import {type Option, toArgv} from './argv.js'

// ─── Codec rules ────────────────────────────────────────────────────────────
// What a finished file may contain for each target, as ffprobe `codec_name`s.
// The validator rejects anything else; the converter uses the same table to
// decide which streams must be re-encoded.

export type CodecRules = {
  /** Extension of the final file. */
  readonly ext: string
  /** One of these must appear in ffprobe's comma-separated format_name. */
  readonly formatNames: readonly string[]
  /** undefined = no video stream allowed (audio files). [] = any codec. */
  readonly video?: readonly string[] | undefined
  /** [] = any codec. */
  readonly audio: readonly string[]
}

export const VIDEO_CONTAINERS: readonly VideoContainer[] = ['mp4', 'webm', 'mkv']
export const AUDIO_CONTAINERS: readonly AudioContainer[] = ['m4a', 'mp3', 'opus', 'flac', 'wav']

export const VIDEO_RULES: Readonly<Record<VideoContainer, CodecRules>> = {
  // H.264 + AAC in MP4 is the only combination every macOS / Windows / iOS /
  // Android / TV player decodes natively
  mp4: {ext: 'mp4', formatNames: ['mp4', 'mov'], video: ['h264'], audio: ['aac']},
  webm: {ext: 'webm', formatNames: ['webm', 'matroska'], video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis']},
  mkv: {ext: 'mkv', formatNames: ['matroska'], video: [], audio: []},
}

export const AUDIO_RULES: Readonly<Record<AudioContainer, CodecRules>> = {
  m4a: {ext: 'm4a', formatNames: ['mp4', 'mov', 'm4a'], audio: ['aac']},
  mp3: {ext: 'mp3', formatNames: ['mp3'], audio: ['mp3']},
  opus: {ext: 'opus', formatNames: ['ogg'], audio: ['opus']},
  flac: {ext: 'flac', formatNames: ['flac'], audio: ['flac']},
  wav: {ext: 'wav', formatNames: ['wav'], audio: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le']},
}

export function rulesFor(profile: FormatProfile): CodecRules {
  return profile.kind === 'video' ? VIDEO_RULES[profile.container] : AUDIO_RULES[profile.container]
}

/** yt-dlp vcodec / acodec strings → ffprobe codec_name. */
export function normalizeCodec(codec: string | null | undefined): string | undefined {
  if (!codec || codec === 'none') return undefined
  const c = codec.toLowerCase()
  if (c.startsWith('avc') || c.startsWith('h264')) return 'h264'
  if (c.startsWith('hvc') || c.startsWith('hev') || c.startsWith('h265')) return 'hevc'
  if (c.startsWith('av01') || c === 'av1') return 'av1'
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'vp9'
  if (c.startsWith('vp8')) return 'vp8'
  if (c.startsWith('mp4a') || c === 'aac') return 'aac'
  if (c.startsWith('opus')) return 'opus'
  if (c.startsWith('vorbis')) return 'vorbis'
  if (c.startsWith('mp3')) return 'mp3'
  if (c.startsWith('flac')) return 'flac'
  return c.split('.', 1)[0]
}

export function codecAllowed(allowed: readonly string[] | undefined, codec: string | undefined): boolean {
  if (allowed === undefined) return codec === undefined
  if (codec === undefined) return false
  return allowed.length === 0 || allowed.includes(codec)
}

// ─── Runtime validation of untrusted input (e.g. from an Electron renderer) ─

const AUDIO_QUALITY = /^(?:10|\d|\d{2,4}[kK])$/

/** Returns an error message, or undefined when the profile is valid. */
export function profileProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return 'Profile must be an object.'
  const p = value as Record<string, unknown>
  if (p['kind'] === 'video') {
    if (!VIDEO_CONTAINERS.includes(p['container'] as VideoContainer))
      return `Unknown video container: ${String(p['container'])}.`
    const h = p['maxHeight']
    if (h !== undefined && !(Number.isInteger(h) && (h as number) > 0 && (h as number) <= 8640)) {
      return `Invalid maxHeight: ${String(h)}.`
    }
    return undefined
  }
  if (p['kind'] === 'audio') {
    if (!AUDIO_CONTAINERS.includes(p['container'] as AudioContainer))
      return `Unknown audio container: ${String(p['container'])}.`
    const q = p['quality']
    if (q !== undefined && !(typeof q === 'string' && AUDIO_QUALITY.test(q)))
      return `Invalid audio quality: ${String(q)}.`
    return undefined
  }
  return `Unknown profile kind: ${String(p['kind'])}.`
}

// ─── yt-dlp format selectors ────────────────────────────────────────────────
// Each selector tries the native codecs first, then falls back to "best
// available", in which case the converter fixes the codecs afterwards. A
// profile never fails just because a site doesn't offer, say, H.264.

const heightFilter = (maxHeight: number | undefined) => (maxHeight ? `[height<=${maxHeight}]` : '')

export function videoSelector(profile: VideoProfile): string {
  const h = heightFilter(profile.maxHeight)
  switch (profile.container) {
    case 'mp4':
      return [
        `bv*[vcodec^=avc1]${h}+ba[acodec^=mp4a]`,
        `b[vcodec^=avc1][acodec^=mp4a]${h}`,
        `bv*[vcodec^=avc1]${h}+ba`,
        `bv*${h}+ba`,
        `b${h}`,
        'bv*+ba/b',
      ].join('/')
    case 'webm':
      return [
        `bv*[ext=webm]${h}+ba[ext=webm]`,
        `b[ext=webm]${h}`,
        `bv*[vcodec~='^(vp0?9|vp8|av01)']${h}+ba`,
        `bv*${h}+ba`,
        `b${h}`,
        'bv*+ba/b',
      ].join('/')
    case 'mkv':
      return [`bv*${h}+ba`, `b${h}`, 'bv*+ba/b'].join('/')
  }
}

export function audioSelector(profile: AudioProfile): string {
  switch (profile.container) {
    case 'm4a':
      return 'ba[acodec^=mp4a]/ba/b' // AAC source → stream copy, no generation loss
    case 'opus':
      return 'ba[acodec^=opus]/ba/b'
    default:
      return 'ba/b'
  }
}

/** yt-dlp options that select and shape the download for a profile. */
export function profileOptions(profile: FormatProfile): Option[] {
  if (profile.kind === 'video') {
    // when the fallback picked streams mp4/webm can't hold, yt-dlp merges into
    // mkv and the converter produces the requested container afterwards
    const merge = profile.container === 'mkv' ? 'mkv' : `${profile.container}/mkv`
    return [
      ['--format', videoSelector(profile)],
      ['--merge-output-format', merge],
    ]
  }
  return [
    ['--format', audioSelector(profile)],
    ['--extract-audio'],
    ['--audio-format', profile.container],
    ['--audio-quality', profile.quality ?? '0'],
    // ID3v2.4 (the default) is unreadable for many car stereos and older players:
    // write v2.3 plus a v1 fallback when the tags are embedded
    ...(profile.container === 'mp3'
      ? [['--postprocessor-args', 'Metadata+ffmpeg_o:-id3v2_version 3 -write_id3v1 1'] as Option]
      : []),
  ]
}

export const profileArgs = (profile: FormatProfile): string[] => toArgv(profileOptions(profile))

export function profileKey(profile: FormatProfile): string {
  return profile.kind === 'video'
    ? `video:${profile.container}:${profile.maxHeight ?? 'best'}`
    : `audio:${profile.container}:${profile.quality ?? '0'}`
}

const VIDEO_NAMES: Readonly<Record<VideoContainer, string>> = {
  mp4: 'MP4 · H.264/AAC',
  webm: 'WebM · VP9/AV1 + Opus',
  mkv: 'MKV · best quality',
}

const AUDIO_NAMES: Readonly<Record<AudioContainer, string>> = {
  m4a: 'M4A · AAC',
  mp3: 'MP3',
  opus: 'Opus',
  flac: 'FLAC',
  wav: 'WAV',
}

export function profileLabel(profile: FormatProfile): string {
  if (profile.kind === 'audio') return `Audio · ${AUDIO_NAMES[profile.container]}`
  return `${profile.maxHeight ? `${profile.maxHeight}p` : 'Best'} · ${VIDEO_NAMES[profile.container]}`
}

// ─── Choices for a UI ───────────────────────────────────────────────────────

/** The subset of a yt-dlp format entry this module reads. */
export type RawFormat = {
  readonly format_id: string
  readonly ext?: string | null
  readonly vcodec?: string | null
  readonly acodec?: string | null
  readonly height?: number | null
  readonly abr?: number | null
  readonly tbr?: number | null
  readonly filesize?: number | null
  readonly filesize_approx?: number | null
}

const PLAYLIST_HEIGHTS: readonly number[] = [2160, 1440, 1080, 720, 480, 360]

/**
 * Bytes of one stream: the size the site reports, else its average bitrate
 * (`tbr`, kbit/s) × the duration. YouTube omits sizes for many streams but
 * always reports bitrates, so the second form is what keeps estimates real.
 */
function sizeOf(f: RawFormat | undefined, duration: number | undefined): number | undefined {
  if (!f) return undefined
  const reported = f.filesize ?? f.filesize_approx
  if (reported) return reported
  return f.tbr && duration ? Math.ceil((f.tbr * 1000 * duration) / 8) : undefined
}

/**
 * Containers that are always encoded locally land at the encoder's bitrate,
 * not the source's (bits/s): MP3 at VBR quality 0 averages ~245 kb/s, FLAC of
 * 48 kHz stereo music ~900 kb/s, WAV is 48 kHz × 16 bit × 2 channels.
 * Rounded up — a disk check must not under-count.
 */
const ENCODED_AUDIO_BITRATE: Readonly<Partial<Record<AudioContainer, number>>> = {
  mp3: 260_000,
  flac: 1_000_000,
  wav: 1_536_000,
}
const isStoryboard = (f: RawFormat) => f.format_id.startsWith('sb') || f.ext === 'mhtml'
const videoRank = (f: RawFormat) => f.tbr ?? 0
const audioRank = (f: RawFormat) => f.abr ?? f.tbr ?? 0

/**
 * The formats of one video, indexed in a single pass: for every resolution
 * the best stream of each video codec, and the best audio-only stream of
 * each audio codec. Every choice is then a couple of map lookups instead of
 * a re-scan of the format list.
 */
export type FormatCatalog = {
  /** height → codec → best stream (may be muxed with audio). */
  readonly video: ReadonlyMap<number, ReadonlyMap<string, RawFormat>>
  /** codec → best audio-only stream. */
  readonly audio: ReadonlyMap<string, RawFormat>
  /** Any stream (audio-only or muxed) carries audio. */
  readonly hasAudio: boolean
}

function keepBest(map: Map<string, RawFormat>, codec: string, format: RawFormat, rank: (f: RawFormat) => number) {
  const current = map.get(codec)
  if (!current || rank(format) > rank(current)) map.set(codec, format)
}

export function catalogFormats(formats: readonly RawFormat[]): FormatCatalog {
  const video = new Map<number, Map<string, RawFormat>>()
  const audio = new Map<string, RawFormat>()
  let hasAudio = false
  for (const format of formats) {
    if (isStoryboard(format)) continue
    const vcodec = normalizeCodec(format.vcodec)
    const acodec = normalizeCodec(format.acodec)
    const height = format.height ?? 0
    hasAudio ||= acodec !== undefined
    if (vcodec && height > 0) {
      const byCodec = video.get(height) ?? new Map<string, RawFormat>()
      if (byCodec.size === 0) video.set(height, byCodec)
      keepBest(byCodec, vcodec, format, videoRank)
    } else if (acodec) {
      keepBest(audio, acodec, format, audioRank)
    }
  }
  return {video, audio, hasAudio}
}

/** Best stream whose codec the rules allow, else the best of any codec (to be converted). */
function pick(
  byCodec: ReadonlyMap<string, RawFormat>,
  allowed: readonly string[] | undefined,
  rank: (f: RawFormat) => number,
): {readonly format: RawFormat; readonly native: boolean} | undefined {
  let native: RawFormat | undefined
  let any: RawFormat | undefined
  for (const [codec, format] of byCodec) {
    if (!any || rank(format) > rank(any)) any = format
    if (codecAllowed(allowed, codec) && (!native || rank(format) > rank(native))) native = format
  }
  if (native) return {format: native, native: true}
  return any && {format: any, native: false}
}

const choice = (profile: FormatProfile, requiresConversion: boolean, estimatedBytes?: number): FormatChoice => ({
  profile,
  label: `${profileLabel(profile)}${estimatedBytes ? ` · ~${formatBytes(estimatedBytes)}` : ''}`,
  estimatedBytes,
  requiresConversion,
})

/** Profiles for a playlist — the formats of each entry are unknown until it downloads. */
export function genericChoices(): FormatChoice[] {
  // YouTube serves H.264 up to 1080p; a higher mp4 would always mean transcoding
  const heightsFor = (container: VideoContainer) =>
    container === 'mp4' ? PLAYLIST_HEIGHTS.filter(h => h <= 1080) : PLAYLIST_HEIGHTS
  const video = VIDEO_CONTAINERS.flatMap(container =>
    heightsFor(container).map(maxHeight => choice({kind: 'video', container, maxHeight}, false)),
  )
  const audio = AUDIO_CONTAINERS.map(container => choice({kind: 'audio', container}, false))
  return [...video, ...audio]
}

function videoChoice(
  catalog: FormatCatalog,
  container: VideoContainer,
  height: number,
  duration: number | undefined,
): FormatChoice | undefined {
  const rules = VIDEO_RULES[container]
  const byCodec = catalog.video.get(height)
  const video = byCodec && pick(byCodec, rules.video, videoRank)
  if (!video) return undefined

  // a muxed stream brings its own audio; otherwise pair it with the best compatible audio
  const muxedCodec = normalizeCodec(video.format.acodec)
  const audio = muxedCodec ? undefined : pick(catalog.audio, rules.audio, audioRank)
  const audioNative = muxedCodec ? codecAllowed(rules.audio, muxedCodec) : (audio?.native ?? true)

  // estimate only when the video size is known — the audio alone would mislead
  const videoBytes = sizeOf(video.format, duration)
  const bytes = videoBytes === undefined ? undefined : videoBytes + (sizeOf(audio?.format, duration) ?? 0)
  return choice({kind: 'video', container, maxHeight: height}, !video.native || !audioNative, bytes)
}

function audioChoice(catalog: FormatCatalog, container: AudioContainer, duration: number | undefined): FormatChoice {
  const source = pick(catalog.audio, AUDIO_RULES[container].audio, audioRank)
  // only m4a / opus can be stream-copied; mp3, flac and wav are always encoded,
  // which is cheap for audio and therefore not flagged as a conversion
  const copyable = container === 'm4a' || container === 'opus'
  const encoded = ENCODED_AUDIO_BITRATE[container]
  const bytes = encoded ? duration && Math.ceil((encoded * duration) / 8) : sizeOf(source?.format, duration)
  return choice({kind: 'audio', container}, copyable && !source?.native, bytes || undefined)
}

/**
 * Concrete choices for one video: every resolution it offers × every video
 * container, then every audio container — each with a size estimate and
 * whether the target codecs require a local conversion. `duration` (seconds)
 * turns bitrates into sizes when the site reports none.
 */
export function planChoices(formats: readonly RawFormat[], duration?: number): FormatChoice[] {
  const catalog = catalogFormats(formats)
  const heights = [...catalog.video.keys()].sort((a, b) => b - a)
  const unknown = formats.length === 0 // no metadata at all (some sites): let yt-dlp decide

  const video = VIDEO_CONTAINERS.flatMap(container =>
    heights.flatMap(height => videoChoice(catalog, container, height, duration) ?? []),
  )
  const fallback = unknown ? [choice({kind: 'video', container: 'mp4'}, false)] : []
  const audio =
    catalog.hasAudio || unknown ? AUDIO_CONTAINERS.map(container => audioChoice(catalog, container, duration)) : []
  return [...video, ...fallback, ...audio]
}
