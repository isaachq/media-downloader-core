import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {cancelledError} from '../core/errors.js'
import type {BinaryPaths, JsRuntime} from '../types.js'
import {inspectFfmpeg, isFullyCapable, parseFfmpegVersion} from './capabilities.js'
import {type Executable, invoke, toExecutable} from './executable.js'
import {extractArchive, findFile} from './extract.js'
import {downloadVerified, type TransferProgress} from './fetch.js'
import {type ManagedInstall, ManagedStore, type ManagedTool} from './managed.js'
import {BinaryError, type Fetcher, ffmpegRelease, latestYtDlpVersion, type Release, ytDlpRelease} from './sources.js'

const IS_WINDOWS = process.platform === 'win32'
const EXE = IS_WINDOWS ? '.exe' : ''

/**
 * Apps launched from Finder / the Start menu don't inherit the shell PATH,
 * so a Homebrew install is invisible to Electron unless we look explicitly.
 */
const SEARCH_DIRS: Partial<Readonly<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'],
  linux: ['/usr/local/bin', '/usr/bin', '/snap/bin'],
}
const EXTRA_SEARCH_DIRS: readonly string[] = SEARCH_DIRS[process.platform] ?? []

/** First launch of a fresh binary on macOS waits for the XProtect scan (~25 s measured). */
const PROBE_TIMEOUT_MS = 120_000

export type ToolName = 'yt-dlp' | 'ffmpeg' | 'ffprobe'
/** managed = installed by this library · configured = passed in options · system = PATH / well-known dirs. */
export type ToolSource = 'managed' | 'configured' | 'system'

export type ResolvedTool = {
  readonly exe: Executable
  readonly version: string
  readonly source: ToolSource
}

export type ResolvedBinaries = {
  readonly ytDlp: ResolvedTool
  readonly ffmpeg: ResolvedTool
  readonly ffprobe: ResolvedTool
}

export type InstallStage = 'resolving' | 'downloading' | 'extracting' | 'testing' | 'done'

export type InstallProgress = {
  readonly tool: ManagedTool
  readonly stage: InstallStage
  readonly version?: string | undefined
  readonly asset?: string | undefined
  readonly transfer?: TransferProgress | undefined
}

export type InstallOptions = {
  readonly signal?: AbortSignal | undefined
  readonly onProgress?: ((progress: InstallProgress) => void) | undefined
}

export type UpdateResult = {readonly updated: boolean; readonly version: string}

const VERSION_FLAG: Readonly<Record<ToolName, string>> = {
  'yt-dlp': '--version',
  ffmpeg: '-version',
  ffprobe: '-version',
}
const CONFIG_KEY: Readonly<Record<ToolName, keyof BinaryPaths>> = {
  'yt-dlp': 'ytDlp',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
}

/** Version reported by a tool, or undefined if it doesn't run. */
export async function probeVersion(tool: ToolName, exe: Executable): Promise<string | undefined> {
  try {
    const result = await invoke(exe, [VERSION_FLAG[tool]], {timeoutMs: PROBE_TIMEOUT_MS})
    if (result.code !== 0) return undefined
    const firstLine = result.stdout.split('\n', 1)[0]?.trim() ?? ''
    return (tool === 'yt-dlp' ? firstLine : parseFfmpegVersion(firstLine)) || 'unknown'
  } catch {
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

/**
 * Finds, installs and updates the external tools.
 *
 * Resolution order per tool: managed install (written by `install()`, so the
 * newest one we know) → configured path (e.g. bundled with the app) → PATH →
 * well-known install folders. Installs are versioned and switched atomically
 * (see ManagedStore), and verified against published SHA-256 sums.
 */
export class BinaryManager {
  readonly #stores: Readonly<Record<ManagedTool, ManagedStore>>
  readonly #configured: BinaryPaths
  readonly #fetcher: Fetcher
  #resolved: Promise<ResolvedBinaries> | undefined
  readonly #installing = new Map<ManagedTool, Promise<ManagedInstall>>()

  constructor(dataDir: string, configured: BinaryPaths = {}, fetcher: Fetcher = fetch) {
    const binRoot = path.join(dataDir, 'bin')
    this.#stores = {'yt-dlp': new ManagedStore(binRoot, 'yt-dlp'), ffmpeg: new ManagedStore(binRoot, 'ffmpeg')}
    this.#configured = configured
    this.#fetcher = fetcher
  }

  /** Find one tool without failing. */
  async locate(tool: ToolName): Promise<ResolvedTool | undefined> {
    const store = this.#stores[tool === 'yt-dlp' ? 'yt-dlp' : 'ffmpeg']
    const managed = (await store.current())?.executables[tool]
    const configured = this.#configured[CONFIG_KEY[tool]]

    const candidates: Array<{exe: Executable; source: ToolSource}> = []
    if (managed) candidates.push({exe: toExecutable(managed), source: 'managed'})
    if (configured) candidates.push({exe: toExecutable(configured), source: 'configured'})
    candidates.push({exe: toExecutable(tool + EXE), source: 'system'}) // PATH lookup by spawn
    for (const dir of EXTRA_SEARCH_DIRS)
      candidates.push({exe: toExecutable(path.join(dir, tool + EXE)), source: 'system'})

    for (const {exe, source} of candidates) {
      if (exe.args.length === 0 && path.isAbsolute(exe.command) && !(await exists(exe.command))) continue
      const version = await probeVersion(tool, exe)
      if (version) return {exe, version, source}
    }
    return undefined
  }

  /** Resolve all three tools once and cache. A failure isn't cached, so the next call retries. */
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

  async #resolve(): Promise<ResolvedBinaries> {
    const [ytDlp, ffmpeg, ffprobe] = await Promise.all([
      this.locate('yt-dlp'),
      this.locate('ffmpeg'),
      this.locate('ffprobe'),
    ])
    if (!ytDlp || !ffmpeg || !ffprobe) {
      const missing = [!ytDlp && 'yt-dlp', !ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(', ')
      throw new BinaryError(`Missing required tools: ${missing}. Run the setup (\`mdc setup\`) to install them.`)
    }
    return {ytDlp, ffmpeg, ffprobe}
  }

  /** Path of the managed install of a tool, if any. */
  managed(tool: ManagedTool): Promise<ManagedInstall | undefined> {
    return this.#stores[tool].current()
  }

  /**
   * Download, verify (SHA-256), extract, test and activate the latest release
   * of a tool. Concurrent calls for the same tool share one install.
   */
  install(tool: ManagedTool, opts: InstallOptions = {}): Promise<ManagedInstall> {
    let pending = this.#installing.get(tool)
    if (!pending) {
      pending = this.#install(tool, opts).finally(() => this.#installing.delete(tool))
      this.#installing.set(tool, pending)
    }
    return pending
  }

  async #install(tool: ManagedTool, opts: InstallOptions): Promise<ManagedInstall> {
    const report = (progress: Omit<InstallProgress, 'tool'>) => opts.onProgress?.({tool, ...progress})
    report({stage: 'resolving'})
    const fetcher = this.#fetcher
    const release: Release =
      tool === 'yt-dlp'
        ? await ytDlpRelease({fetcher, ...(opts.signal && {signal: opts.signal})})
        : await ffmpegRelease({fetcher, ...(opts.signal && {signal: opts.signal})})

    const store = this.#stores[tool]
    const staging = await store.staging(release.version)
    try {
      for (const asset of release.assets) {
        const archive = path.join(staging, asset.name)
        report({stage: 'downloading', version: release.version, asset: asset.name})
        await downloadVerified(asset, archive, {
          fetcher,
          signal: opts.signal,
          onProgress: transfer => report({stage: 'downloading', version: release.version, asset: asset.name, transfer}),
        })
        report({stage: 'extracting', version: release.version, asset: asset.name})
        await extractArchive(archive, asset.format, staging)
        await fs.rm(archive, {force: true})
        if (opts.signal?.aborted) throw cancelledError()
      }

      report({stage: 'testing', version: release.version})
      const executables: Record<string, string> = {}
      for (const [name, pattern] of Object.entries(release.executables)) {
        const file = await findFile(staging, pattern)
        if (!file) throw new BinaryError(`${name} not found in the ${tool} ${release.version} package.`)
        if (!IS_WINDOWS) await fs.chmod(file, 0o755)
        if (!(await probeVersion(name as ToolName, toExecutable(file)))) {
          throw new BinaryError(`The downloaded ${name} does not run on this system.`)
        }
        executables[name] = path.relative(staging, file)
      }
      if (tool === 'ffmpeg') await this.#assertCapable(path.join(staging, executables['ffmpeg']!))

      const installed = await store.commit(release.version, staging, executables)
      this.invalidate()
      report({stage: 'done', version: release.version})
      return installed
    } catch (error) {
      await fs.rm(staging, {recursive: true, force: true})
      throw error
    }
  }

  async #assertCapable(ffmpeg: string): Promise<void> {
    const caps = await inspectFfmpeg(toExecutable(ffmpeg))
    if (!caps) throw new BinaryError('The downloaded ffmpeg could not be inspected.')
    if (!isFullyCapable(caps)) {
      const missing = Object.values(caps.missing).flat().join(', ')
      throw new BinaryError(`The downloaded ffmpeg lacks required codecs/formats: ${missing}.`)
    }
  }

  /** Install a newer yt-dlp if one exists. YouTube breaks old versions often: call this on startup. */
  async updateYtDlp(opts: InstallOptions = {}): Promise<UpdateResult> {
    const latest = await latestYtDlpVersion(this.#fetcher, opts.signal)
    const current = (await this.locate('yt-dlp'))?.version
    if (current && compareVersions(current, latest) >= 0) return {updated: false, version: current}
    const installed = await this.install('yt-dlp', opts)
    return {updated: true, version: installed.version}
  }
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

/**
 * The JavaScript runtime yt-dlp needs for YouTube's player challenges: the
 * Node.js running this library. Inside Electron that is the app binary,
 * which behaves as plain Node with ELECTRON_RUN_AS_NODE=1 (set in yt-dlp's
 * environment; its children inherit it).
 */
export function defaultJsRuntime(): {runtime: JsRuntime; env: NodeJS.ProcessEnv} {
  const env: NodeJS.ProcessEnv = process.versions['electron'] ? {ELECTRON_RUN_AS_NODE: '1'} : {}
  return {runtime: {name: 'node', path: process.execPath}, env}
}
