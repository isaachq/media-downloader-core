import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {writeAtomic} from '../core/files.js'

export type ManagedTool = 'yt-dlp' | 'ffmpeg'

/** current.json: the active version and its executables, relative to the version folder. */
type Pointer = {
  readonly version: string
  readonly executables: Readonly<Record<string, string>>
}

/** Validate a parsed current.json; also accepts the 1.0 format `{version, executable}` (yt-dlp only). */
function readPointer(raw: unknown, tool: ManagedTool): Pointer | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const {version, executables, executable} = raw as Record<string, unknown>
  if (typeof version !== 'string' || !/^[\w.-]+$/.test(version)) return undefined
  if (typeof executables === 'object' && executables !== null) {
    const entries = Object.entries(executables)
    if (entries.every(([, file]) => typeof file === 'string' && !file.includes('..'))) {
      return {version, executables: Object.fromEntries(entries) as Record<string, string>}
    }
    return undefined
  }
  if (tool === 'yt-dlp' && typeof executable === 'string' && !executable.includes('..')) {
    return {version, executables: {'yt-dlp': executable}}
  }
  return undefined
}

export type ManagedInstall = {
  readonly version: string
  /** Absolute path of each executable, by name ("yt-dlp", "ffmpeg", "ffprobe"). */
  readonly executables: Readonly<Record<string, string>>
}

/**
 * Versioned installs of one tool under `<root>/<version>/`, with
 * `current.json` naming the active one. Switching versions is one atomic
 * pointer write, so an update never touches files a running process uses
 * (Windows locks executables in use).
 */
export class ManagedStore {
  readonly root: string

  constructor(
    binRoot: string,
    readonly tool: ManagedTool,
  ) {
    this.root = path.join(binRoot, tool)
  }

  get #pointerFile(): string {
    return path.join(this.root, 'current.json')
  }

  async current(): Promise<ManagedInstall | undefined> {
    let raw: unknown
    try {
      raw = JSON.parse(await fs.readFile(this.#pointerFile, 'utf8'))
    } catch {
      return undefined
    }
    const pointer = readPointer(raw, this.tool)
    if (!pointer) return undefined // unreadable pointer: behave as "not installed", setup rewrites it
    const base = path.join(this.root, pointer.version)
    const executables = Object.fromEntries(
      Object.entries(pointer.executables).map(([name, relative]) => [name, path.join(base, relative)]),
    )
    return {version: pointer.version, executables}
  }

  /** A fresh staging folder inside the store (same volume, so the final move is a rename). */
  async staging(version: string): Promise<string> {
    const dir = path.join(this.root, `.staging-${version}-${process.pid}-${Date.now()}`)
    await fs.mkdir(dir, {recursive: true})
    return dir
  }

  /**
   * Promote a verified staging folder to `<root>/<version>/` and point
   * `current.json` at it. `executables` are paths relative to the folder.
   */
  async commit(
    version: string,
    stagingDir: string,
    executables: Readonly<Record<string, string>>,
  ): Promise<ManagedInstall> {
    const finalDir = path.join(this.root, version)
    await fs.rm(finalDir, {recursive: true, force: true})
    await fs.rename(stagingDir, finalDir)
    await writeAtomic(this.#pointerFile, JSON.stringify({version, executables} satisfies Pointer))
    void this.prune(version)
    const absolute = Object.fromEntries(
      Object.entries(executables).map(([name, relative]) => [name, path.join(finalDir, relative)]),
    )
    return {version, executables: absolute}
  }

  /** Remove other versions and abandoned staging folders. Best effort: in-use files stay until next time. */
  async prune(keep: string): Promise<void> {
    const entries = await fs.readdir(this.root, {withFileTypes: true}).catch(() => [])
    await Promise.all(
      entries
        .filter(entry => entry.isDirectory() && entry.name !== keep)
        .map(entry => fs.rm(path.join(this.root, entry.name), {recursive: true, force: true}).catch(() => {})),
    )
  }
}
