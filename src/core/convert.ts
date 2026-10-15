import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {type Executable, invoke} from '../binaries/executable.js'
import type {AudioContainer, ProcessingKind, VideoContainer} from '../types.js'
import {type Option, toArgv} from './argv.js'
import {cancelledError, DownloadError} from './errors.js'
import {isBundleVideo, VIDEO_RULES} from './formats.js'
import {ffmpegProgressReader, lastLines} from './process.js'
import {codecMismatch, ffprobe, summarizeProbe} from './validate.js'

const VIDEO_ENCODERS: Readonly<Record<VideoContainer, readonly Option[]>> = {
  // 8-bit 4:2:0 High profile: what every hardware decoder (phones, TVs, QuickTime) accepts
  mp4: [
    ['-c:v', 'libx264'],
    ['-preset', 'veryfast'],
    ['-crf', '20'],
    ['-pix_fmt', 'yuv420p'],
    ['-profile:v', 'high'],
  ],
  webm: [
    ['-c:v', 'libvpx-vp9'],
    ['-crf', '32'],
    ['-b:v', '0'],
    ['-deadline', 'realtime'],
    ['-cpu-used', '8'],
    ['-row-mt', '1'],
  ],
  mkv: [
    ['-c:v', 'libx264'],
    ['-preset', 'veryfast'],
    ['-crf', '20'],
    ['-pix_fmt', 'yuv420p'],
  ],
}

const AUDIO_ENCODERS: Readonly<Record<VideoContainer, readonly Option[]>> = {
  mp4: [
    ['-c:a', 'aac'],
    ['-b:a', '192k'],
  ],
  webm: [
    ['-c:a', 'libopus'],
    ['-b:a', '160k'],
  ],
  mkv: [['-c:a', 'copy']],
}

export type ConvertOptions = {
  readonly ffmpeg: Executable
  readonly ffprobe: Executable
  readonly input: string
  readonly container: VideoContainer
  readonly maxHeight?: number | undefined
  readonly expectAudio: boolean
  readonly threads: number
  readonly signal?: AbortSignal | undefined
  /** Called only when a conversion is actually needed. */
  readonly onStart?: (() => void) | undefined
  readonly onProgress?: ((fraction: number) => void) | undefined
  readonly onKind?: ((kind: ProcessingKind) => void) | undefined
}

/**
 * Make a downloaded video match exactly the container, codecs and resolution
 * cap its profile promises. Compliant streams are copied bit for bit; only
 * offending streams or streams needing downscaling are re-encoded.
 * Returns the path of the compliant file — the input itself when nothing had to change.
 */
export async function ensureContainer(opts: ConvertOptions): Promise<string> {
  const container = opts.container
  const rules = VIDEO_RULES[container]
  const summary = summarizeProbe(await ffprobe(opts.ffprobe, opts.input, opts.signal))
  const mismatch = codecMismatch(summary, rules, opts.expectAudio)
  const rightContainer = summary.container.split(',').some(name => rules.formatNames.includes(name))
  const rightExtension = path.extname(opts.input).slice(1).toLowerCase() === rules.ext

  const currentWidth = summary.video?.width ?? 0
  const currentHeight = summary.video?.height ?? 0
  const currentRes = currentWidth > 0 && currentHeight > 0 ? Math.min(currentWidth, currentHeight) : currentHeight
  const exceedsMaxHeight = opts.maxHeight !== undefined && currentRes > 0 && currentRes > opts.maxHeight

  // If already fully compliant in container, extension, codecs and resolution: untouched.
  if (!mismatch.video && !mismatch.audio && rightContainer && rightExtension && !exceedsMaxHeight) {
    opts.onKind?.('none')
    return opts.input
  }

  // Determine processing kind: transcode if video/audio must be re-encoded or scaled down, else remux.
  const needsVideoTranscode = mismatch.video || exceedsMaxHeight
  const needsAudioTranscode = mismatch.audio
  const kind: ProcessingKind = needsVideoTranscode || needsAudioTranscode ? 'transcode' : 'remux'
  opts.onKind?.(kind)
  opts.onStart?.()

  const stem = path.basename(opts.input, path.extname(opts.input))
  const output = path.join(path.dirname(opts.input), `${stem}.converted.${rules.ext}`)

  // Scale filter when height exceeds cap, or ensure even dimensions for encoder
  let videoFilter: Option[] = []
  if (exceedsMaxHeight && opts.maxHeight) {
    let targetShort = Math.min(opts.maxHeight, currentRes)
    if (targetShort % 2 !== 0) targetShort -= 1
    const filter = currentWidth >= currentHeight ? `scale=-2:${targetShort}` : `scale=${targetShort}:-2`
    videoFilter = [['-vf', filter]]
  } else if (needsVideoTranscode) {
    videoFilter = [['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']]
  }

  const videoArgs: readonly Option[] = needsVideoTranscode
    ? [...VIDEO_ENCODERS[container], ...videoFilter]
    : [['-c:v', 'copy']]

  const audioArgs: readonly Option[] = needsAudioTranscode ? AUDIO_ENCODERS[container] : [['-c:a', 'copy']]

  const argv = toArgv([
    ['-hide_banner'],
    ['-nostdin'],
    ['-y'],
    ['-v', 'error'],
    ['-threads', String(Math.max(1, opts.threads))],
    ['-fflags', '+genpts'],
    ['-i', opts.input],
    ['-map', '0:V:0'],
    ['-map', '0:a?'],
    // subtitles ride along only where any text codec can (Matroska); an mp4
    // or webm would need them re-encoded, and ffmpeg refuses the copy outright
    container === 'mkv' && ['-map', '0:s?'],
    ['-map_metadata', '0'],
    ...videoArgs,
    ...audioArgs,
    container === 'mp4' && ['-movflags', '+faststart'],
    ['-avoid_negative_ts', 'make_zero'],
    ['-progress', 'pipe:1'],
    ['-nostats'],
  ])
  argv.push(output)

  const total = summary.duration ?? 0
  const result = await invoke(opts.ffmpeg, argv, {
    signal: opts.signal,
    collectStdout: false,
    onStdoutLine: ffmpegProgressReader(seconds => {
      if (total > 0) opts.onProgress?.(Math.min(1, seconds / total))
    }),
  })

  if (result.aborted || result.code !== 0) {
    await fs.rm(output, {force: true})
    if (result.aborted) throw cancelledError()
    throw new DownloadError(
      'conversion',
      `Could not convert to ${container.toUpperCase()}.`,
      lastLines(result.stderr) || `ffmpeg exit ${result.code}`,
      {container},
    )
  }
  await fs.rm(opts.input, {force: true})
  return output
}

// ─── A bundle's videos (a carousel kept as a folder) ───────────────────────

/**
 * A carousel downloaded as a folder: each of its videos made to match the
 * profile (container, codecs, resolution cap), in place and under its own
 * name; its pictures untouched. Returns how many were converted — 0 when
 * every video already complied, as the plan's "original bundle".
 */
export async function convertBundle(opts: {
  readonly ffmpeg: Executable
  readonly ffprobe: Executable
  readonly dir: string
  readonly container: VideoContainer
  readonly maxHeight?: number | undefined
  readonly threads: number
  readonly signal?: AbortSignal | undefined
  readonly onProgress?: ((fraction: number) => void) | undefined
}): Promise<number> {
  const names = (await fs.readdir(opts.dir)).filter(isBundleVideo).sort()
  let converted = 0
  for (const [index, name] of names.entries()) {
    const input = path.join(opts.dir, name)
    const output = await ensureContainer({
      ffmpeg: opts.ffmpeg,
      ffprobe: opts.ffprobe,
      input,
      container: opts.container,
      maxHeight: opts.maxHeight,
      // a carousel's clip may well be silent: no stream is demanded, only what is there must comply
      expectAudio: false,
      threads: opts.threads,
      signal: opts.signal,
      onProgress: fraction => opts.onProgress?.((index + fraction) / names.length),
    })
    if (output !== input) {
      converted++
      // `<stem>.converted.<ext>` → `<stem>.<ext>`: the item keeps its place in the carousel's order
      const stem = path.basename(name, path.extname(name))
      await fs.rename(output, path.join(opts.dir, `${stem}${path.extname(output)}`))
    }
    opts.onProgress?.((index + 1) / names.length)
  }
  return converted
}

// ─── Audio from a video (sources that only deliver video files) ────────────

/** Tags written into a finished file. */
export type MediaTags = {
  readonly title?: string | undefined
  readonly artist?: string | undefined
  readonly date?: string | undefined
  readonly comment?: string | undefined
}

const tagArgs = (tags: MediaTags | undefined): Option[] =>
  Object.entries(tags ?? {}).flatMap(([key, value]) =>
    typeof value === 'string' && value ? [['-metadata', `${key}=${value}`] as Option] : [],
  )

// per target: [extension, encoder args] — m4a copies AAC untouched (no generation loss)
const AUDIO_TARGETS: Readonly<Record<AudioContainer, {readonly ext: string; readonly args: readonly Option[]}>> = {
  m4a: {
    ext: 'm4a',
    args: [
      ['-c:a', 'copy'],
      ['-movflags', '+faststart'],
    ],
  },
  mp3: {
    ext: 'mp3',
    // VBR ~245 kb/s; ID3v2.3 + v1: the tag versions car stereos and old players read
    args: [
      ['-c:a', 'libmp3lame'],
      ['-q:a', '0'],
      ['-id3v2_version', '3'],
      ['-write_id3v1', '1'],
    ],
  },
  opus: {
    ext: 'opus',
    args: [
      ['-c:a', 'libopus'],
      ['-b:a', '160k'],
    ],
  },
  flac: {ext: 'flac', args: [['-c:a', 'flac']]},
  wav: {ext: 'wav', args: [['-c:a', 'pcm_s16le']]},
}

/**
 * The soundtrack of a video file as `container`, tagged — one ffmpeg pass.
 * An m4a target re-encodes only when the source audio isn't AAC.
 */
export async function extractAudio(opts: {
  readonly ffmpeg: Executable
  readonly ffprobe: Executable
  readonly input: string
  readonly container: AudioContainer
  readonly tags?: MediaTags | undefined
  readonly threads: number
  readonly signal?: AbortSignal | undefined
  readonly onProgress?: ((fraction: number) => void) | undefined
}): Promise<string> {
  const summary = summarizeProbe(await ffprobe(opts.ffprobe, opts.input, opts.signal))
  if (!summary.audio) {
    throw new DownloadError(
      'unavailable',
      'The downloaded file has no sound to extract.',
      undefined,
      undefined,
      'format-unavailable',
    )
  }
  const target = AUDIO_TARGETS[opts.container]
  let args = target.args
  if (opts.container === 'm4a' && summary.audio.codec_name !== 'aac') {
    args = [
      ['-c:a', 'aac'],
      ['-b:a', '192k'],
      ['-movflags', '+faststart'],
    ]
  } else if (opts.container === 'opus' && summary.audio.codec_name === 'opus') {
    args = [['-c:a', 'copy']]
  }
  const stem = path.basename(opts.input, path.extname(opts.input))
  const output = path.join(path.dirname(opts.input), `${stem}.audio.${target.ext}`)
  await runFfmpeg(opts, output, [['-map', '0:a:0'], ['-vn'], ['-sn'], ...args, ...tagArgs(opts.tags)], summary.duration)
  await fs.rm(opts.input, {force: true})
  return output
}

/** Write tags into a finished file without re-encoding (a stream copy). */
export async function writeTags(opts: {
  readonly ffmpeg: Executable
  readonly input: string
  readonly tags: MediaTags
  readonly signal?: AbortSignal | undefined
}): Promise<string> {
  const ext = path.extname(opts.input)
  const output = `${opts.input.slice(0, -ext.length)}.tagged${ext}`
  const mp4 = /^\.(mp4|m4a|mov)$/i.test(ext)
  await runFfmpeg({...opts, threads: 1}, output, [
    ['-map', '0'],
    ['-c', 'copy'],
    ...tagArgs(opts.tags),
    ...(mp4 ? [['-movflags', '+faststart'] as Option] : []),
  ])
  await fs.rm(opts.input, {force: true})
  return output
}

/**
 * One ffmpeg run into `output`, with progress against `duration`; a failed or
 * cancelled run leaves no partial output behind. `inputOptions` go before the
 * first input (e.g. its format); more inputs can follow in `options`.
 */
export async function runFfmpeg(
  opts: {
    readonly ffmpeg: Executable
    readonly input: string
    readonly threads: number
    readonly signal?: AbortSignal | undefined
    readonly onProgress?: ((fraction: number) => void) | undefined
    readonly inputOptions?: readonly Option[] | undefined
  },
  output: string,
  options: readonly Option[],
  duration?: number,
): Promise<void> {
  const argv = toArgv([
    ['-hide_banner'],
    ['-nostdin'],
    ['-y'],
    ['-v', 'error'],
    ['-threads', String(Math.max(1, opts.threads))],
    ...(opts.inputOptions ?? []),
    ['-i', opts.input],
    ...options,
    ['-progress', 'pipe:1'],
    ['-nostats'],
  ])
  argv.push(output)
  const result = await invoke(opts.ffmpeg, argv, {
    signal: opts.signal,
    collectStdout: false,
    onStdoutLine: ffmpegProgressReader(seconds => {
      if (duration && duration > 0) opts.onProgress?.(Math.min(1, seconds / duration))
    }),
  })
  if (result.aborted || result.code !== 0) {
    await fs.rm(output, {force: true})
    if (result.aborted) throw cancelledError()
    throw new DownloadError(
      'conversion',
      `ffmpeg could not write ${path.basename(output)}.`,
      lastLines(result.stderr) || `ffmpeg exit ${result.code}`,
    )
  }
}
