import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {type Executable, invoke} from '../binaries/executable.js'
import type {
  MessageParams,
  StreamInfo,
  ValidationIssue,
  ValidationIssueCode,
  ValidationLevel,
  ValidationReport,
} from '../types.js'
import {toArgv} from './argv.js'
import {cancelledError} from './errors.js'
import {type CodecRules, codecAllowed} from './formats.js'
import {ffmpegProgressReader, lastLines} from './process.js'

type ProbeStream = {
  readonly codec_type?: string
  readonly codec_name?: string
  readonly width?: number
  readonly height?: number
  readonly avg_frame_rate?: string
  readonly channels?: number
  readonly sample_rate?: string
  readonly bit_rate?: string
  readonly duration?: string
  readonly disposition?: {readonly attached_pic?: number}
}

export type ProbeData = {
  readonly format?: {readonly format_name?: string; readonly duration?: string}
  readonly streams?: readonly ProbeStream[]
}

export type ProbeSummary = {
  readonly container: string
  readonly duration?: number | undefined
  /** Main video stream; cover art / thumbnails are excluded. */
  readonly video?: ProbeStream | undefined
  readonly audio?: ProbeStream | undefined
}

export class ProbeError extends Error {
  override readonly name = 'ProbeError'
}

export async function ffprobe(ffprobePath: Executable, file: string, signal?: AbortSignal): Promise<ProbeData> {
  const result = await invoke(ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
    signal,
    timeoutMs: 120_000,
  })
  if (result.aborted) throw cancelledError()
  if (result.code !== 0) {
    throw new ProbeError(`ffprobe could not read the file: ${lastLines(result.stderr, 3) || `exit ${result.code}`}`)
  }
  try {
    return JSON.parse(result.stdout) as ProbeData
  } catch {
    throw new ProbeError('ffprobe returned unreadable output.')
  }
}

/** ffprobe reports numbers as strings, and "N/A" when unknown. */
function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function frameRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined
  const [num, den] = rate.split('/').map(Number)
  if (!num || !den) return undefined
  return Math.round((num / den) * 100) / 100
}

export function summarizeProbe(data: ProbeData): ProbeSummary {
  const streams = data.streams ?? []
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find(s => s.codec_type === 'audio')
  return {
    container: data.format?.format_name ?? 'unknown',
    duration: toNumber(data.format?.duration) ?? toNumber(video?.duration) ?? toNumber(audio?.duration),
    video,
    audio,
  }
}

export type CodecMismatch = {
  readonly container: boolean
  readonly video: boolean
  readonly audio: boolean
  readonly missingVideo: boolean
  readonly missingAudio: boolean
  readonly unexpectedVideo: boolean
}

/** Which parts of a file break the rules — shared by the validator and the converter. */
export function codecMismatch(summary: ProbeSummary, rules: CodecRules, expectAudio: boolean): CodecMismatch {
  return {
    container: !summary.container.split(',').some(name => rules.formatNames.includes(name)),
    video:
      rules.video !== undefined && summary.video !== undefined && !codecAllowed(rules.video, summary.video.codec_name),
    audio: summary.audio !== undefined && !codecAllowed(rules.audio, summary.audio.codec_name),
    missingVideo: rules.video !== undefined && summary.video === undefined,
    missingAudio: expectAudio && summary.audio === undefined,
    unexpectedVideo: rules.video === undefined && summary.video !== undefined,
  }
}

/** Muxers round and tracks rarely end on the same frame: accept max(3 s, 2%). */
export function durationTolerance(seconds: number): number {
  return Math.max(3, seconds * 0.02)
}

export type ValidateOptions = {
  readonly ffmpeg: Executable
  readonly ffprobe: Executable
  readonly file: string
  readonly rules: CodecRules
  readonly level: ValidationLevel
  /** Duration announced by the site, in seconds. */
  readonly expectedDuration?: number | undefined
  /** Whether the source had audio — some clips (GIF-like posts) legitimately don't. */
  readonly expectAudio: boolean
  /** Decoder threads, so simultaneous validations stay inside the CPU budget. */
  readonly threads: number
  readonly signal?: AbortSignal | undefined
  readonly onProgress?: ((fraction: number) => void) | undefined
}

const issue = (code: ValidationIssueCode, message: string, params?: MessageParams): ValidationIssue =>
  params ? {code, message, params} : {code, message}

const round = (n: number) => Math.round(n * 10) / 10

function streamInfo(stream: ProbeStream | undefined): StreamInfo | undefined {
  if (!stream) return undefined
  return {
    codec: stream.codec_name ?? 'unknown',
    width: stream.width,
    height: stream.height,
    fps: frameRate(stream.avg_frame_rate),
    channels: stream.channels,
    sampleRate: toNumber(stream.sample_rate),
    bitrate: toNumber(stream.bit_rate),
  }
}

/**
 * Prove a file is complete and playable:
 *  1. it exists and is not empty;
 *  2. ffprobe parses it, and container / codecs are the ones promised;
 *  3. its duration matches the one announced by the site;
 *  4. every packet can be read (quick) or every frame decoded (full) without
 *     a single error, all the way to the end of the timeline.
 */
export async function validateFile(opts: ValidateOptions): Promise<ValidationReport> {
  const stat = await fs.stat(opts.file).catch(() => undefined)
  const base = {
    level: opts.level,
    container: 'unknown',
    sizeBytes: stat?.size ?? 0,
    expectedDuration: opts.expectedDuration,
  }

  if (!stat?.isFile()) return {...base, ok: false, issues: [issue('file-missing', 'The file does not exist.')]}
  if (stat.size === 0) return {...base, ok: false, issues: [issue('file-empty', 'The file is empty.')]}
  if (opts.level === 'none') return {...base, ok: true, issues: []}

  let summary: ProbeSummary
  try {
    summary = summarizeProbe(await ffprobe(opts.ffprobe, opts.file, opts.signal))
  } catch (error) {
    if (!(error instanceof ProbeError)) throw error
    return {...base, ok: false, issues: [issue('probe-failed', error.message)]}
  }

  const issues = structuralIssues(summary, opts)
  const report = {
    ...base,
    container: summary.container,
    duration: summary.duration,
    video: streamInfo(summary.video),
    audio: streamInfo(summary.audio),
  }
  // reading a structurally broken file further proves nothing
  if (issues.length > 0) return {...report, ok: false, issues}

  const decoded = await readThrough(opts, summary.duration ?? 0)
  issues.push(...decoded.issues)
  const total = summary.duration ?? 0
  if (decoded.reached !== undefined && total - decoded.reached > durationTolerance(total)) {
    issues.push(
      issue('incomplete-decode', `Only ${round(decoded.reached)} s of ${round(total)} s could be read.`, {
        reached: round(decoded.reached),
        total: round(total),
      }),
    )
  }
  return {...report, decodedDuration: decoded.reached, ok: issues.length === 0, issues}
}

function structuralIssues(summary: ProbeSummary, opts: ValidateOptions): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const m = codecMismatch(summary, opts.rules, opts.expectAudio)
  const videoCodec = summary.video?.codec_name ?? 'unknown'
  const audioCodec = summary.audio?.codec_name ?? 'unknown'

  if (m.container) {
    issues.push(
      issue('unexpected-container', `Unexpected container: ${summary.container}.`, {container: summary.container}),
    )
  }
  if (m.missingVideo) issues.push(issue('missing-video', 'The file has no video track.'))
  if (m.missingAudio) issues.push(issue('missing-audio', 'The file has no audio track.'))
  if (m.unexpectedVideo) {
    issues.push(
      issue('unexpected-video', `Expected audio only, found a video track (${videoCodec}).`, {codec: videoCodec}),
    )
  }
  if (m.video) {
    issues.push(
      issue('unexpected-video-codec', `Video codec ${videoCodec} does not match the profile.`, {codec: videoCodec}),
    )
  }
  if (m.audio) {
    issues.push(
      issue('unexpected-audio-codec', `Audio codec ${audioCodec} does not match the profile.`, {codec: audioCodec}),
    )
  }

  const actual = summary.duration
  const expected = opts.expectedDuration
  if (!actual || actual <= 0) {
    issues.push(issue('unknown-duration', 'The duration could not be determined.'))
  } else if (expected && expected > 0 && Math.abs(actual - expected) > durationTolerance(expected)) {
    issues.push(
      issue('duration-mismatch', `Duration is ${round(actual)} s, expected ${round(expected)} s.`, {
        actual: round(actual),
        expected: round(expected),
      }),
    )
  }
  return issues
}

/**
 * Run ffmpeg over the whole file into the null muxer. 'full' decodes every
 * frame (catches bitstream corruption); 'quick' only demuxes (catches
 * truncation and container damage, ~50× faster).
 */
async function readThrough(opts: ValidateOptions, total: number) {
  const argv = toArgv([
    ['-hide_banner'],
    ['-nostdin'],
    ['-v', 'error'],
    ['-xerror'],
    ['-threads', String(Math.max(1, opts.threads))],
    ['-i', opts.file],
    // V = real video only: cover art in an mp3 / m4a is a picture, not a track
    ['-map', '0:V?'],
    ['-map', '0:a?'],
    opts.level === 'quick' && ['-c', 'copy'],
    ['-progress', 'pipe:1'],
    ['-nostats'],
    ['-f', 'null'],
  ])
  argv.push('-') // the null muxer still needs an output name

  let reached: number | undefined
  const result = await invoke(opts.ffmpeg, argv, {
    signal: opts.signal,
    collectStdout: false,
    onStdoutLine: ffmpegProgressReader(seconds => {
      reached = seconds
      if (total > 0) opts.onProgress?.(Math.min(1, seconds / total))
    }),
  })
  if (result.aborted) throw cancelledError()

  const issues: ValidationIssue[] = []
  const errors = lastLines(result.stderr, 5)
  if (result.code !== 0) {
    issues.push(issue('decode-failed', `Decoding failed: ${errors || `ffmpeg exit ${result.code}`}`, {details: errors}))
  } else if (errors) {
    issues.push(issue('decode-errors', `Decoder reported errors: ${errors}`, {details: errors}))
  }
  return {reached, issues}
}

/**
 * A folder of finished files (a slideshow's images and soundtrack): each
 * file present and non-empty, and — unless the check is off — readable by
 * ffprobe with a picture or a sound in it. A few files are probed at once.
 */
export async function validateBundle(opts: {
  readonly ffprobe: Executable
  readonly dir: string
  readonly level: ValidationLevel
  readonly signal?: AbortSignal | undefined
}): Promise<ValidationReport> {
  const names = (await fs.readdir(opts.dir).catch(() => [] as string[])).sort()
  const issues: ValidationIssue[] = []
  let sizeBytes = 0
  if (names.length === 0) issues.push(issue('file-missing', 'The folder holds no file.'))
  let next = 0
  const worker = async () => {
    for (let i = next++; i < names.length; i = next++) {
      if (opts.signal?.aborted) throw cancelledError()
      const file = path.join(opts.dir, names[i]!)
      const size = (await fs.stat(file).catch(() => undefined))?.size ?? 0
      sizeBytes += size
      if (size === 0) {
        issues.push(issue('file-empty', `${names[i]} is empty.`))
        continue
      }
      if (opts.level === 'none') continue
      try {
        const summary = summarizeProbe(await ffprobe(opts.ffprobe, file, opts.signal))
        if (!summary.video && !summary.audio)
          issues.push(issue('probe-failed', `${names[i]} holds no picture or sound.`))
      } catch (error) {
        if (opts.signal?.aborted) throw cancelledError()
        issues.push(
          issue(
            'probe-failed',
            `${names[i]} could not be read: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(4, names.length)}, worker))
  return {level: opts.level, ok: issues.length === 0, container: 'folder', sizeBytes, issues}
}
