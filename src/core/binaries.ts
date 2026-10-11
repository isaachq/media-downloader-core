import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {BinaryPaths, JsRuntime} from '../types.js'
import {sha256Stream} from './files.js'
import {run} from './process.js'

const IS_WINDOWS = process.platform === 'win32'
const EXE = IS_WINDOWS ? '.exe' : ''
const GITHUB_API_LATEST = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const GITHUB_DOWNLOAD = 'https://github.com/yt-dlp/yt-dlp/releases/download'

/**
 * Apps launched from Finder / the Start menu don't inherit the shell PATH,
 * so a Homebrew install is invisible to Electron unless we look explicitly.
 */
const SEARCH_DIRS: Partial<Readonly<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'],
  linux: ['/usr/local/bin', '/usr/bin', '/snap/bin'],
}
const EXTRA_SEARCH_DIRS: readonly string[] = SEARCH_DIRS[process.platform] ?? []

/**
 * The first launch of a freshly downloaded binary on macOS waits for the
 * XProtect scan (~25 s measured), so version probes need a generous timeout.
 */
const PROBE_TIMEOUT_MS = 120_000

export type ResolvedBinaries = {
  readonly ytDlp: string
  readonly ytDlpVersion: string
  readonly ffmpeg: string
  readonly ffprobe: string
}

export class BinaryError extends Error {
  override readonly name = 'BinaryError'
}

/**
 * yt-dlp release asset per platform-arch. Always the "onedir" zip builds:
 * the single-file builds are PyInstaller archives that unpack themselves on
 * *every* launch — measured 25 s per call on macOS vs 0.7 s for onedir. With
 * one yt-dlp process per playlist item, that is the whole performance budget.
 */
const YT_DLP_BUILDS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'yt-dlp_macos.zip', // universal binary
  'darwin-x64': 'yt-dlp_macos.zip',
  'win32-x64': 'yt-dlp_win.zip',
  'win32-arm64': 'yt-dlp_win_arm64.zip',
  'win32-ia32': 'yt-dlp_win_x86.zip',
  'linux-x64': 'yt-dlp_linux.zip',
  'linux-arm64': 'yt-dlp_linux_aarch64.zip',
  'linux-arm': 'yt-dlp_linux_armv7l.zip',
}

/** Release asset for a platform, or a BinaryError when yt-dlp ships no build for it. */
export function ytDlpBuildFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const asset = YT_DLP_BUILDS[`${platform}-${arch}`]
  if (!asset) throw new BinaryError(`yt-dlp publishes no build for ${platform}-${arch}; install it manually.`)
  return asset
}

/**
 * The JavaScript runtime yt-dlp needs for YouTube's player challenges. Reuse
 * the Node.js that runs this library; inside Electron that is the app binary
 * itself, which behaves as plain Node with ELECTRON_RUN_AS_NODE=1 (set in
 * the yt-dlp environment, which its children inherit).
 */
export function defaultJsRuntime(): {runtime: JsRuntime; env: NodeJS.ProcessEnv} {
  const env: NodeJS.ProcessEnv = process.versions['electron'] ? {ELECTRON_RUN_AS_NODE: '1'} : {}
  return {runtime: {name: 'node', path: process.execPath}, env}
}

async function probeVersion(bin: string, versionFlag: string): Promise<string | undefined> {
  try {
    const result = await run(bin, [versionFlag], {timeoutMs: PROBE_TIMEOUT_MS})
    if (result.code !== 0) return undefined
    return result.stdout.split('\n', 1)[0]?.trim() || 'unknown'
  } catch {
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

type Located = {readonly path: string; readonly version: string}

/** First working candidate: explicit paths → PATH → well-known install dirs. */
async function locate(name: string, versionFlag: string, explicit: ReadonlyArray<string | undefined>) {
  const candidates = [
    ...explicit.filter((p): p is string => Boolean(p)),
    name + EXE, // resolved through PATH by spawn
    ...EXTRA_SEARCH_DIRS.map(dir => path.join(dir, name + EXE)),
  ]
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !(await exists(candidate))) continue
    const version = await probeVersion(candidate, versionFlag)
    if (version) return {path: candidate, version} satisfies Located
  }
  return undefined
}

type ManagedPointer = {readonly version: string; readonly executable: string}

export type UpdateResult = {readonly updated: boolean; readonly version: string}

/**
 * Finds yt-dlp / ffmpeg / ffprobe and keeps yt-dlp current.
 *
 * Auto-updated yt-dlp versions live in `<dataDir>/bin/yt-dlp/<version>/`
 * and `current.json` points at the active one, so an update never touches
 * an executable that a running download is using (Windows locks those).
 */
export class BinaryManager {
  readonly managedDir: string
  #resolved: Promise<ResolvedBinaries> | undefined
  #updating: Promise<UpdateResult> | undefined

  constructor(
    dataDir: string,
    private readonly explicit: BinaryPaths = {},
  ) {
    this.managedDir = path.join(dataDir, 'bin', 'yt-dlp')
  }

  get #pointerFile(): string {
    return path.join(this.managedDir, 'current.json')
  }

  /** Executable of the auto-updated yt-dlp, if one is installed. */
  async managedYtDlp(): Promise<string | undefined> {
    try {
      const pointer = JSON.parse(await fs.readFile(this.#pointerFile, 'utf8')) as ManagedPointer
      return path.join(this.managedDir, pointer.version, pointer.executable)
    } catch {
      return undefined
    }
  }

  /** Resolve once and cache. A failure is not cached, so the next call retries. */
  resolve(): Promise<ResolvedBinaries> {
    this.#resolved ??= this.#resolve().catch((error: unknown) => {
      this.#resolved = undefined
      throw error
    })
    return this.#resolved
  }

  invalidate(): void {
    this.#resolved = undefined
  }

  async #locateYtDlp(): Promise<Located | undefined> {
    // the managed copy only exists if an update wrote it, so it is the newest
    // one we know of — prefer it over the copy bundled with the app
    return locate('yt-dlp', '--version', [await this.managedYtDlp(), this.explicit.ytDlp])
  }

  async #resolve(): Promise<ResolvedBinaries> {
    const [ytDlp, ffmpeg, ffprobe] = await Promise.all([
      this.#locateYtDlp(),
      locate('ffmpeg', '-version', [this.explicit.ffmpeg]),
      locate('ffprobe', '-version', [this.explicit.ffprobe]),
    ])
    if (!ffmpeg || !ffprobe) {
      const missing = [!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(', ')
      throw new BinaryError(
        `Missing required tools: ${missing}. Bundle them with the app or install them ` +
          '(macOS: "brew install ffmpeg"; Windows: "winget install Gyan.FFmpeg").',
      )
    }

    let yt = ytDlp
    if (!yt) {
      // yt-dlp is the one tool we can fetch safely ourselves (published checksums)
      const {version} = await this.#install()
      const managed = await this.managedYtDlp()
      if (!managed) throw new BinaryError('yt-dlp could not be installed.')
      yt = {path: managed, version}
    }
    return {ytDlp: yt.path, ytDlpVersion: yt.version, ffmpeg: ffmpeg.path, ffprobe: ffprobe.path}
  }

  /** Latest yt-dlp release tag on GitHub, e.g. "2026.08.19". */
  async latestYtDlpVersion(signal?: AbortSignal): Promise<string> {
    const response = await fetch(GITHUB_API_LATEST, {
      ...(signal && {signal}),
      headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'media-downloader-core'},
    })
    if (!response.ok) throw new BinaryError(`Could not check for yt-dlp updates (HTTP ${response.status}).`)
    const body = (await response.json()) as {tag_name?: unknown}
    if (typeof body.tag_name !== 'string') throw new BinaryError('Unexpected response from the GitHub releases API.')
    return body.tag_name
  }

  /**
   * Install the latest yt-dlp if it is newer than the one in use. The archive
   * is verified against the release's SHA2-256SUMS before anything is
   * extracted. YouTube changes break old versions often, so call this on
   * startup. Concurrent calls share one update.
   */
  updateYtDlp(signal?: AbortSignal): Promise<UpdateResult> {
    this.#updating ??= (async (): Promise<UpdateResult> => {
      const latest = await this.latestYtDlpVersion(signal)
      // only yt-dlp matters here — a missing ffmpeg must not force a reinstall
      const current = (await this.#locateYtDlp())?.version
      if (current && compareVersions(current, latest) >= 0) return {updated: false, version: current}
      return this.#install(latest, signal)
    })().finally(() => {
      this.#updating = undefined
    })
    return this.#updating
  }

  async #install(tag?: string, signal?: AbortSignal): Promise<UpdateResult> {
    const version = tag ?? (await this.latestYtDlpVersion(signal))
    const asset = ytDlpBuildFor()
    const init = signal ? {signal} : {}
    const [archive, sums] = await Promise.all([
      fetch(`${GITHUB_DOWNLOAD}/${version}/${asset}`, init),
      fetch(`${GITHUB_DOWNLOAD}/${version}/SHA2-256SUMS`, init),
    ])
    if (!archive.ok || !archive.body || !sums.ok) {
      throw new BinaryError(`Could not download yt-dlp ${version} (HTTP ${archive.status}/${sums.status}).`)
    }
    const expected = parseChecksums(await sums.text()).get(asset)
    if (!expected) throw new BinaryError(`yt-dlp ${version} publishes no checksum for ${asset}.`)

    await fs.mkdir(this.managedDir, {recursive: true})
    const zip = path.join(this.managedDir, `${version}.${process.pid}.zip`)
    const staging = path.join(this.managedDir, `${version}.${process.pid}.staging`)
    const finalDir = path.join(this.managedDir, version)
    try {
      // stream to disk while hashing — the archive is never held in memory
      const actual = await sha256Stream(archive.body, zip, signal)
      if (actual !== expected) {
        throw new BinaryError(`yt-dlp checksum mismatch (expected ${expected}, got ${actual}). Not installed.`)
      }

      await fs.rm(staging, {recursive: true, force: true})
      await fs.mkdir(staging, {recursive: true})
      await extractZip(zip, staging)

      const executable = (await fs.readdir(staging)).find(name => /^yt-dlp[\w-]*(\.exe)?$/i.test(name))
      if (!executable) throw new BinaryError('The yt-dlp package contains no executable.')
      if (!IS_WINDOWS) await fs.chmod(path.join(staging, executable), 0o755)
      const ran = await probeVersion(path.join(staging, executable), '--version')
      if (!ran) throw new BinaryError('The downloaded yt-dlp does not run on this system.')

      await fs.rm(finalDir, {recursive: true, force: true})
      await fs.rename(staging, finalDir)
      const pointer: ManagedPointer = {version, executable}
      const tmpPointer = `${this.#pointerFile}.${process.pid}.tmp`
      await fs.writeFile(tmpPointer, JSON.stringify(pointer))
      await fs.rename(tmpPointer, this.#pointerFile)
      this.invalidate()
      void this.#pruneOldVersions(version)
      return {updated: true, version: ran}
    } finally {
      await Promise.all([fs.rm(zip, {force: true}), fs.rm(staging, {recursive: true, force: true})])
    }
  }

  /** Best effort: a version still in use on Windows is left for next time. */
  async #pruneOldVersions(keep: string): Promise<void> {
    const entries = await fs.readdir(this.managedDir, {withFileTypes: true}).catch(() => [])
    await Promise.all(
      entries
        .filter(entry => entry.isDirectory() && entry.name !== keep && /^\d{4}\.\d{2}\.\d{2}/.test(entry.name))
        .map(entry => fs.rm(path.join(this.managedDir, entry.name), {recursive: true, force: true}).catch(() => {})),
    )
  }
}

/**
 * bsdtar reads zip on macOS and Windows 10+ (shipped as tar.exe). GNU tar on
 * Linux doesn't — use unzip there.
 */
async function extractZip(zip: string, dest: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'linux' ? ['unzip', ['-q', '-o', zip, '-d', dest]] : ['tar', ['-xf', zip, '-C', dest]]
  const result = await run(cmd, args, {timeoutMs: 120_000})
  if (result.code !== 0) throw new BinaryError(`Could not extract yt-dlp: ${result.stderr.trim()}`)
}

export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match?.[1] && match[2]) map.set(match[2].trim(), match[1].toLowerCase())
  }
  return map
}

/** Compares yt-dlp style versions: "2025.10.22" < "2025.10.22.1". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
