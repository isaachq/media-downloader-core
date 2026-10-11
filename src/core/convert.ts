import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {type Executable, invoke} from '../binaries/executable.js'
import type {VideoContainer} from '../types.js'
import {type Option, toArgv} from './argv.js'
import {cancelledError, DownloadError} from './errors.js'
import {VIDEO_RULES} from './formats.js'
import {ffmpegProgressReader, lastLines} from './process.js'
import {codecMismatch, ffprobe, summarizeProbe} from './validate.js'

type Transcodable = Exclude<VideoContainer, 'mkv'>

const VIDEO_ENCODERS: Readonly<Record<Transcodable, readonly Option[]>> = {
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
}

const AUDIO_ENCODERS: Readonly<Record<Transcodable, readonly Option[]>> = {
  mp4: [
    ['-c:a', 'aac'],
    ['-b:a', '192k'],
  ],
  webm: [
    ['-c:a', 'libopus'],
    ['-b:a', '160k'],
  ],
}

export type ConvertOptions = {
  readonly ffmpeg: Executable
  readonly ffprobe: Executable
  readonly input: string
  readonly container: VideoContainer
  readonly expectAudio: boolean
  readonly threads: number
  readonly signal?: AbortSignal | undefined
  /** Called only when a conversion is actually needed. */
  readonly onStart?: (() => void) | undefined
  readonly onProgress?: ((fraction: number) => void) | undefined
}

/**
 * Make a downloaded video match exactly the container and codecs its
 * profile promises. Compliant streams are copied bit for bit; only the
 * offending stream is re-encoded. Returns the path of the compliant file —
 * the input itself when nothing had to change.
 */
export async function ensureContainer(opts: ConvertOptions): Promise<string> {
  if (opts.container === 'mkv') return opts.input // mkv holds any codec
  const container: Transcodable = opts.container

  const rules = VIDEO_RULES[container]
  const summary = summarizeProbe(await ffprobe(opts.ffprobe, opts.input, opts.signal))
  const mismatch = codecMismatch(summary, rules, opts.expectAudio)
  const rightExtension = path.extname(opts.input).slice(1).toLowerCase() === rules.ext
  if (!mismatch.video && !mismatch.audio && !mismatch.container && rightExtension) return opts.input

  opts.onStart?.()
  const stem = path.basename(opts.input, path.extname(opts.input))
  const output = path.join(path.dirname(opts.input), `${stem}.converted.${rules.ext}`)
  const argv = toArgv([
    ['-hide_banner'],
    ['-nostdin'],
    ['-y'],
    ['-v', 'error'],
    ['-threads', String(Math.max(1, opts.threads))],
    ['-i', opts.input],
    ['-map', '0:V:0'],
    ['-map', '0:a:0?'],
    ['-map_metadata', '0'],
    ...(mismatch.video ? VIDEO_ENCODERS[container] : [['-c:v', 'copy'] as const]),
    ...(mismatch.audio ? AUDIO_ENCODERS[container] : [['-c:a', 'copy'] as const]),
    container === 'mp4' && ['-movflags', '+faststart'],
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
