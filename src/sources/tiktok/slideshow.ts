import type {Executable} from '../../binaries/executable.js'
import type {Option} from '../../core/argv.js'
import {runFfmpeg} from '../../core/convert.js'
import type {SlideshowOptions} from '../../types.js'

export const DEFAULT_SLIDESHOW: SlideshowOptions = {mode: 'video', secondsPerImage: 3}
const MIN_SECONDS = 1
const MAX_SECONDS = 30
/** Longest side of a slideshow video: TikTok's own 1080 × 1920 frame. */
const MAX_SIDE = 1920

/** Options from a caller (an IPC boundary, a saved setting), made valid. */
export function slideshowOptions(raw: unknown): SlideshowOptions {
  const value = typeof raw === 'object' && raw !== null ? (raw as Partial<SlideshowOptions>) : {}
  const mode = value.mode === 'images' || value.mode === 'images-audio' ? value.mode : 'video'
  const seconds = Number(value.secondsPerImage)
  return {
    mode,
    secondsPerImage: Number.isFinite(seconds)
      ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, seconds))
      : DEFAULT_SLIDESHOW.secondsPerImage,
  }
}

/**
 * The frame of a slideshow video: the first image's shape, at most
 * 1920 px on its longest side, both sides even (H.264 4:2:0 needs that).
 * Other images are fitted inside it, letterboxed — never stretched.
 */
export function slideshowFrame(images: ReadonlyArray<{readonly width: number; readonly height: number}>): {
  readonly width: number
  readonly height: number
} {
  const first = images.find(image => image.width > 0 && image.height > 0) ?? {width: 1080, height: 1920}
  const scale = Math.min(1, MAX_SIDE / Math.max(first.width, first.height))
  const even = (n: number) => Math.max(2, 2 * Math.round((n * scale) / 2))
  return {width: even(first.width), height: even(first.height)}
}

/**
 * ffmpeg's options for a slideshow, after its first input (the first image).
 * Each image is its own input (looped for its seconds) and is fitted to the
 * frame on its own before they are joined: one filter chain per image, so
 * images of different sizes never make ffmpeg rebuild the graph mid-stream
 * (which drops the timeline before the change). The soundtrack is cut at the
 * end, or padded with silence when shorter. JPEGs are full-range: the output
 * is limited (TV) range 4:2:0, what every player, TV and car stereo expects.
 */
export function slideshowArgs(opts: {
  readonly images: readonly string[]
  readonly frame: {readonly width: number; readonly height: number}
  readonly audio?: string | undefined
  readonly secondsPerImage: number
}): {readonly first: readonly Option[]; readonly rest: readonly Option[]} {
  const {width, height} = opts.frame
  const still = (): Option[] => [
    ['-loop', '1'],
    ['-framerate', '30'],
    ['-t', String(opts.secondsPerImage)],
  ]
  const fit = (i: number) =>
    `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:out_range=tv,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${i}]`
  const count = opts.images.length
  const chains = opts.images.map((_, i) => fit(i))
  const joined = `${opts.images.map((_, i) => `[v${i}]`).join('')}concat=n=${count}:v=1:a=0[v]`
  const graph = [...chains, joined, ...(opts.audio ? [`[${count}:a]apad[a]`] : [])].join(';')
  return {
    first: still(),
    rest: [
      ...opts.images.slice(1).flatMap((image): Option[] => [...still(), ['-i', image]]),
      ...(opts.audio ? ([['-i', opts.audio]] as const) : []),
      ['-filter_complex', graph],
      ['-map', '[v]'],
      ...(opts.audio ? ([['-map', '[a]']] as const) : []),
      ['-c:v', 'libx264'],
      ['-pix_fmt', 'yuv420p'],
      ['-color_range', 'tv'],
      ['-preset', 'veryfast'],
      ['-tune', 'stillimage'],
      ['-crf', '20'],
      ...(opts.audio
        ? ([
            ['-c:a', 'aac'],
            ['-b:a', '160k'],
          ] as const)
        : []),
      ['-t', String(count * opts.secondsPerImage)],
      ['-movflags', '+faststart'],
    ],
  }
}

/** An MP4 (H.264 / AAC) showing each image `secondsPerImage`, over the soundtrack — or silent without one. */
export async function buildSlideshowVideo(opts: {
  readonly ffmpeg: Executable
  readonly images: readonly string[]
  readonly frame: {readonly width: number; readonly height: number}
  readonly audio?: string | undefined
  readonly secondsPerImage: number
  readonly output: string
  readonly threads: number
  readonly signal?: AbortSignal | undefined
  readonly onProgress?: ((fraction: number) => void) | undefined
}): Promise<{readonly duration: number}> {
  if (opts.images.length === 0) throw new Error('A slideshow needs at least one image.')
  const duration = opts.images.length * opts.secondsPerImage
  const args = slideshowArgs(opts)
  await runFfmpeg(
    {
      ffmpeg: opts.ffmpeg,
      input: opts.images[0]!,
      inputOptions: args.first,
      threads: opts.threads,
      signal: opts.signal,
      onProgress: opts.onProgress,
    },
    opts.output,
    args.rest,
    duration,
  )
  return {duration}
}
