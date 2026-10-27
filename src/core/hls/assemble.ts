/**
 * The single ffmpeg `-c copy` that turns a track's period files (and a demuxed audio track) into one
 * file. Usable on its own: a live recorder finalizes its period files the same way.
 *
 * Cost: one ffmpeg pass, O(bytes), no re-encode; P periods → a P-line concat list (the concat demuxer
 * offsets each period's timestamps, so discontinuities don't give "Non-monotonous DTS"). A single fMP4
 * period with no separate audio needs no ffmpeg at all: it is already a valid fragmented mp4 (renamed).
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {Executable} from '../../binaries/executable.js'
import type {Option} from '../argv.js'
import {runFfmpeg} from '../convert.js'
import {DownloadError} from '../errors.js'
import {HlsError} from './errors.js'
import type {HlsSegmentFormat} from './playlist.js'

export type HlsContainer = 'mp4' | 'm4a' | 'mp3' | 'ogg'

export type AssembleTrack = {
  /** Period files in order. */
  readonly files: readonly string[]
  readonly format: HlsSegmentFormat
  /** Extension of the segments ("ts", "aac", "mp3"…), for packed audio. */
  readonly extension: string
}

export type AssembleOptions = {
  readonly ffmpeg: Executable
  /** Where the output (and a concat list) is written. */
  readonly dir: string
  readonly kind: 'video' | 'audio'
  readonly main: AssembleTrack
  readonly audio?: AssembleTrack | undefined
  /** The variant's CODECS: `mp4a` adds `-bsf:a aac_adtstoasc` for ADTS audio going into mp4 / m4a. */
  readonly codecs?: readonly string[] | undefined
  readonly signal: AbortSignal
  /** Σ EXTINF, for ffmpeg's progress. */
  readonly duration?: number | undefined
  readonly onProgress?: ((fraction: number) => void) | undefined
  /** Output base name, without extension. Default "out". */
  readonly name?: string | undefined
}

/** What an assembled file is, from what came down. */
export function containerFor(kind: 'video' | 'audio', main: AssembleTrack): HlsContainer {
  if (kind === 'video') return 'mp4'
  if (main.format === 'packed-audio') {
    if (main.extension === 'mp3' || main.extension === 'mp2') return 'mp3'
    if (main.extension === 'ogg' || main.extension === 'oga' || main.extension === 'opus') return 'ogg'
  }
  return 'm4a'
}

/** The concat demuxer's list: relative names (the list sits beside the files), quoted. */
async function concatList(dir: string, name: string, files: readonly string[]): Promise<string> {
  const list = path.join(dir, `${name}.concat.txt`)
  const lines = files.map(f => `file '${path.basename(f).replace(/'/g, "'\\''")}'`)
  await fs.writeFile(list, `ffconcat version 1.0\n${lines.join('\n')}\n`)
  return list
}

const ADTS_FORMATS: ReadonlySet<HlsSegmentFormat> = new Set(['ts', 'packed-audio'])

/**
 * Assemble the period files into `<dir>/<name>.<container>` and delete the inputs once it is written.
 * Throws HlsError('assemble') (code `conversion`) when ffmpeg fails, `cancelledError()` on cancel.
 */
export async function assembleHls(opts: AssembleOptions): Promise<{filepath: string; container: HlsContainer}> {
  const {main, audio} = opts
  if (main.files.length === 0) throw new HlsError('empty', 'No media was downloaded (every segment was a gap).')
  const container = containerFor(opts.kind, main)
  const name = opts.name ?? 'out'
  const output = path.join(opts.dir, `${name}.${container}`)
  const inputs = [main, ...(audio && audio.files.length > 0 ? [audio] : [])]

  if (main.files.length === 1 && inputs.length === 1 && main.format === 'fmp4' && main.files[0]) {
    // decision 10: a single fragmented mp4 is handed over as it is
    await fs.rename(main.files[0], output)
    return {filepath: output, container}
  }

  const sources: Array<{input: string; concat: boolean}> = []
  for (const [i, track] of inputs.entries()) {
    const only = track.files.length === 1 ? track.files[0] : undefined
    sources.push(
      only
        ? {input: only, concat: false}
        : {input: await concatList(opts.dir, i === 0 ? 'main' : 'audio', track.files), concat: true},
    )
  }
  const [first, second] = sources
  if (!first) throw new HlsError('empty', 'No media was downloaded.')
  const concatInput: Option[] = [
    ['-f', 'concat'],
    ['-safe', '0'],
  ]
  const aac =
    (opts.codecs ?? []).some(c => c.toLowerCase().startsWith('mp4a')) &&
    inputs.some(t => ADTS_FORMATS.has(t.format)) &&
    (container === 'mp4' || container === 'm4a')
  const options: Option[] = [
    ...(second ? [...(second.concat ? concatInput : []), ['-i', second.input] as Option] : []),
    ...(opts.kind === 'audio'
      ? ([['-map', '0:a:0'], ['-vn']] as Option[])
      : second
        ? ([
            ['-map', '0:v:0'],
            ['-map', '1:a:0'],
          ] as Option[])
        : ([
            ['-map', '0:v:0?'],
            ['-map', '0:a:0?'],
          ] as Option[])),
    ['-dn'],
    ['-sn'],
    ['-c', 'copy'],
    ...(aac ? [['-bsf:a', 'aac_adtstoasc'] as Option] : []),
    ...(container === 'mp4' || container === 'm4a' ? [['-movflags', '+faststart'] as Option] : []),
  ]
  try {
    await runFfmpeg(
      {
        ffmpeg: opts.ffmpeg,
        input: first.input,
        threads: 1,
        signal: opts.signal,
        onProgress: opts.onProgress,
        inputOptions: first.concat ? concatInput : undefined,
      },
      output,
      options,
      opts.duration,
    )
  } catch (error) {
    if (error instanceof DownloadError && error.code === 'conversion') {
      throw new HlsError('assemble', `ffmpeg could not join the HLS segments: ${error.message}`, error.details)
    }
    throw error
  }
  for (const track of inputs) for (const f of track.files) await fs.rm(f, {force: true})
  for (const s of sources) if (s.concat) await fs.rm(s.input, {force: true})
  return {filepath: output, container}
}
