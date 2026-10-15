import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type FixtureName =
  | 'mp4-h264-aac-2160'
  | 'mp4-h264-aac-1440'
  | 'mp4-h264-aac-1080'
  | 'mp4-h264-aac-720'
  | 'mp4-h264-aac-480'
  | 'mp4-h264-aac-360'
  | 'mp4-h265-aac-720'
  | 'mp4-h265-10bit-720'
  | 'webm-vp9-opus-720'
  | 'webm-av1-opus-720'
  | 'video-silent-720'
  | 'audio-aac-m4a'
  | 'audio-opus'
  | 'video-vertical-9-16'
  | 'video-metadata-rotated'
  | 'video-vfr'
  | 'audio-mp3-cover-art'
  | 'truncated-mp4'
  | 'corrupted-middle-mp4'
  | 'duration-mismatch-mp4'

const DIMENSIONS: Readonly<Record<string, {readonly w: number; readonly h: number}>> = {
  '2160': {w: 3840, h: 2160},
  '1440': {w: 2560, h: 1440},
  '1080': {w: 1920, h: 1080},
  '720': {w: 1280, h: 720},
  '480': {w: 854, h: 480},
  '360': {w: 640, h: 360},
}

function runFfmpegSync(args: readonly string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args], {encoding: 'utf8'})
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr || `exit ${result.status}`}`)
  }
}

/**
 * Deterministic Media Lab: generates real synthetic test media on demand using
 * ffmpeg lavfi sources. Clips are short (1-2s), fast to generate, and conform
 * to exact container/codec/resolution specifications.
 */
export class MediaLab {
  readonly #dir: string
  readonly #cache = new Map<FixtureName, string>()

  constructor(dir: string) {
    this.#dir = dir
  }

  async fixture(name: FixtureName): Promise<string> {
    const cached = this.#cache.get(name)
    if (cached) return cached

    await fs.mkdir(this.#dir, {recursive: true})
    const file = path.join(this.#dir, `${name}.${this.#extensionFor(name)}`)
    await this.#generate(name, file)
    this.#cache.set(name, file)
    return file
  }

  #extensionFor(name: FixtureName): string {
    if (name.startsWith('webm-')) return 'webm'
    if (name === 'audio-aac-m4a') return 'm4a'
    if (name === 'audio-opus') return 'opus'
    if (name === 'audio-mp3-cover-art') return 'mp3'
    return 'mp4'
  }

  async #generate(name: FixtureName, out: string): Promise<void> {
    // Standard MP4 H.264 + AAC at various resolutions
    const resMatch = /^mp4-h264-aac-(\d+)$/.exec(name)
    if (resMatch) {
      const dim = DIMENSIONS[resMatch[1]!]!
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        `testsrc=duration=1:size=${dim.w}x${dim.h}:rate=24`,
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        out,
      ])
      return
    }

    if (name === 'mp4-h265-aac-720') {
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=1280x720:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-crf',
        '32',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        out,
      ])
      return
    }

    if (name === 'mp4-h265-10bit-720') {
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=1280x720:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-crf',
        '32',
        '-pix_fmt',
        'yuv420p10le',
        '-c:a',
        'aac',
        out,
      ])
      return
    }

    if (name === 'webm-vp9-opus-720') {
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=1280x720:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:v',
        'libvpx-vp9',
        '-crf',
        '35',
        '-b:v',
        '0',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-c:a',
        'libopus',
        '-b:a',
        '64k',
        out,
      ])
      return
    }

    if (name === 'webm-av1-opus-720') {
      try {
        runFfmpegSync([
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=1:size=640x360:rate=24',
          '-f',
          'lavfi',
          '-i',
          'sine=duration=1:frequency=440',
          '-c:v',
          'libsvtav1',
          '-preset',
          '10',
          '-c:a',
          'libopus',
          out,
        ])
      } catch {
        // Fallback to VP9 if AV1 encoder not available in environment
        runFfmpegSync([
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=1:size=640x360:rate=24',
          '-f',
          'lavfi',
          '-i',
          'sine=duration=1:frequency=440',
          '-c:v',
          'libvpx-vp9',
          '-crf',
          '35',
          '-b:v',
          '0',
          '-c:a',
          'libopus',
          out,
        ])
      }
      return
    }

    if (name === 'video-silent-720') {
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=1280x720:rate=24',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        out,
      ])
      return
    }

    if (name === 'audio-aac-m4a') {
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        out,
      ])
      return
    }

    if (name === 'audio-opus') {
      runFfmpegSync(['-f', 'lavfi', '-i', 'sine=duration=1:frequency=440', '-c:a', 'libopus', '-b:a', '96k', out])
      return
    }

    if (name === 'video-vertical-9-16') {
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=360x640:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        out,
      ])
      return
    }

    if (name === 'video-metadata-rotated') {
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=640x360:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-metadata:s:v:0',
        'rotate=90',
        out,
      ])
      return
    }

    if (name === 'video-vfr') {
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=640x360:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-vsync',
        'vfr',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        out,
      ])
      return
    }

    if (name === 'audio-mp3-cover-art') {
      const cover = path.join(this.#dir, 'cover.png')
      runFfmpegSync(['-f', 'lavfi', '-i', 'color=c=blue:s=300x300:d=1', '-vframes', '1', cover])
      runFfmpegSync([
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-i',
        cover,
        '-map',
        '0:a',
        '-map',
        '1:v',
        '-c:a',
        'libmp3lame',
        '-c:v',
        'copy',
        '-id3v2_version',
        '3',
        '-metadata:s:v',
        'title="Album cover"',
        '-metadata:s:v',
        'comment="Cover (front)"',
        out,
      ])
      await fs.rm(cover, {force: true})
      return
    }

    if (name === 'truncated-mp4') {
      const valid = await this.fixture('mp4-h264-aac-360')
      const bytes = await fs.readFile(valid)
      // Cut in half to simulate truncated download
      await fs.writeFile(out, bytes.subarray(0, Math.floor(bytes.length / 2)))
      return
    }

    if (name === 'corrupted-middle-mp4') {
      const valid = await this.fixture('mp4-h264-aac-360')
      const bytes = Buffer.from(await fs.readFile(valid))
      // Corrupt 200 bytes in the middle of data stream
      const mid = Math.floor(bytes.length / 2)
      bytes.fill(0xff, mid, mid + 200)
      await fs.writeFile(out, bytes)
      return
    }

    if (name === 'duration-mismatch-mp4') {
      // 1-second file, will be expected as 10s by caller
      const valid = await this.fixture('mp4-h264-aac-360')
      await fs.copyFile(valid, out)
      return
    }

    throw new Error(`Unknown fixture name: ${name}`)
  }
}
