import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {run} from '../core/process.js'
import {type ArchiveFormat, BinaryError} from './sources.js'

/**
 * Extract with the system's archivers — no unzip code to ship or trust:
 * bsdtar reads zip and tar.xz on macOS and Windows 10+ (tar.exe); GNU tar on
 * Linux handles tar.xz, and unzip handles zip.
 */
export async function extractArchive(archive: string, format: ArchiveFormat, dest: string): Promise<void> {
  const linuxZip = format === 'zip' && process.platform === 'linux'
  const [cmd, args] = linuxZip
    ? ['unzip', ['-q', '-o', archive, '-d', dest]]
    : [tarCommand(), ['-xf', archive, '-C', dest]]
  const result = await run(cmd, args, {timeoutMs: 300_000})
  if (result.code !== 0) throw new BinaryError(`Could not extract ${path.basename(archive)}: ${result.stderr.trim()}`)
}

/**
 * Windows' own bsdtar, by its full path: a GNU tar earlier on the PATH (Git for
 * Windows', MSYS2's) reads "C:\…" as a remote host and fails to extract.
 */
export function tarCommand(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return 'tar'
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir']
  return root ? path.win32.join(root, 'System32', 'tar.exe') : 'tar'
}

/**
 * Breadth-first search for a file whose name matches, at most `maxDepth`
 * folders deep. Archives nest binaries differently (`bin/ffmpeg.exe`,
 * `ffmpeg`, `yt-dlp_macos`); BFS finds the shallowest match first.
 */
export async function findFile(root: string, pattern: RegExp, maxDepth = 3): Promise<string | undefined> {
  let level = [root]
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = []
    for (const dir of level) {
      const entries = await fs.readdir(dir, {withFileTypes: true}).catch(() => [])
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isFile() && pattern.test(entry.name)) return full
        // skip the bundled Python runtime of yt-dlp: thousands of files, never the executable
        if (entry.isDirectory() && entry.name !== '_internal') next.push(full)
      }
    }
    level = next
  }
  return undefined
}
