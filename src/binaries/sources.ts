import type {ManagedTool} from './managed.js'

export class BinaryError extends Error {
  override readonly name = 'BinaryError'
}

export type ArchiveFormat = 'zip' | 'tar.xz'

export type Asset = {
  readonly url: string
  readonly name: string
  readonly sha256: string
  readonly format: ArchiveFormat
}

/** A downloadable release: its archives and the executable names to look for once extracted. */
export type Release = {
  readonly tool: ManagedTool
  readonly version: string
  readonly assets: readonly Asset[]
  /** name → matcher for the executable's file name. */
  readonly executables: Readonly<Record<string, RegExp>>
}

export type Fetcher = typeof fetch

type Target = {readonly platform: NodeJS.Platform; readonly arch: string}

const here: Target = {platform: process.platform, arch: process.arch}
const exe = (name: string) => new RegExp(`^${name}(\\.exe)?$`, 'i')

// ─── yt-dlp: official GitHub releases ──────────────────────────────────────

/** A yt-dlp release tag, e.g. "2026.08.19". */
export type YtDlpVersion = string

const YT_DLP_REPO = 'https://github.com/yt-dlp/yt-dlp/releases'
const YT_DLP_API_LATEST = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'

/**
 * Always the "onedir" zip builds: the single-file builds are PyInstaller
 * archives that unpack themselves on *every* launch — measured 25 s per call
 * on macOS vs 0.7 s for onedir, with one yt-dlp process per playlist item.
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

export function ytDlpBuildFor(platform: NodeJS.Platform = here.platform, arch: string = here.arch): string {
  const asset = YT_DLP_BUILDS[`${platform}-${arch}`]
  if (!asset) throw new BinaryError(`yt-dlp publishes no build for ${platform}-${arch}; install it manually.`)
  return asset
}

/** "<sha256>  <file name>" lines → name → digest. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match?.[1] && match[2]) map.set(match[2].trim(), match[1].toLowerCase())
  }
  return map
}

async function text(fetcher: Fetcher, url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetcher(url, {
    headers: {'User-Agent': 'media-download-core'},
    ...(signal && {signal}),
  })
  if (!response.ok) throw new BinaryError(`GET ${url} failed (HTTP ${response.status}).`)
  return response.text()
}

/**
 * Latest yt-dlp tag. Primary: the web redirect /releases/latest →
 * /releases/tag/<version>, which has no API rate limit (the REST API allows
 * 60 calls/hour per IP — easily exhausted behind shared IPs or on CI).
 * Fallback: the REST API, authenticated when GITHUB_TOKEN is set.
 */
export async function latestYtDlpVersion(
  fetcher: Fetcher = fetch,
  abort?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<YtDlpVersion> {
  try {
    const location = await resolveRedirect(fetcher, `${YT_DLP_REPO}/latest`, abort)
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1]
    if (tag) return decodeURIComponent(tag)
  } catch (error) {
    if (abort?.aborted) throw error
  }
  const token = env['GITHUB_TOKEN']
  const response = await fetcher(YT_DLP_API_LATEST, {
    headers: {'User-Agent': 'media-download-core', ...(token && {Authorization: `Bearer ${token}`})},
    ...(abort && {signal: abort}),
  })
  if (!response.ok) throw new BinaryError(`Could not find the latest yt-dlp release (HTTP ${response.status}).`)
  const body = (await response.json()) as {tag_name?: unknown}
  if (typeof body.tag_name !== 'string') throw new BinaryError('Unexpected response from the GitHub releases API.')
  return body.tag_name
}

export async function ytDlpRelease(
  opts: {version?: string; target?: Target; fetcher?: Fetcher; signal?: AbortSignal} = {},
): Promise<Release> {
  const fetcher = opts.fetcher ?? fetch
  const target = opts.target ?? here
  const name = ytDlpBuildFor(target.platform, target.arch)
  const version = opts.version ?? (await latestYtDlpVersion(fetcher, opts.signal))
  const sums = parseChecksums(await text(fetcher, `${YT_DLP_REPO}/download/${version}/SHA2-256SUMS`, opts.signal))
  const sha256 = sums.get(name)
  if (!sha256) throw new BinaryError(`yt-dlp ${version} publishes no checksum for ${name}.`)
  return {
    tool: 'yt-dlp',
    version,
    assets: [{url: `${YT_DLP_REPO}/download/${version}/${name}`, name, sha256, format: 'zip'}],
    // onedir zips hold "yt-dlp_macos" / "yt-dlp.exe" / "yt-dlp_linux" next to _internal/
    executables: {'yt-dlp': /^yt-dlp[\w-]*(\.exe)?$/i},
  }
}

// ─── ffmpeg: builds linked from ffmpeg.org ─────────────────────────────────
// macOS: Martin Riedl (static, arm64 + amd64, per-file .sha256)
// Windows / Linux: BtbN (static GPL builds — libx264, libvpx, libopus, lame)

const RIEDL = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos'
const RIEDL_ARCH: Readonly<Record<string, string>> = {arm64: 'arm64', x64: 'amd64'}

const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
const BTBN_TARGET: Readonly<Record<string, string>> = {
  'win32-x64': 'win64',
  'win32-arm64': 'winarm64',
  'linux-x64': 'linux64',
  'linux-arm64': 'linuxarm64',
}

/** Follow the "latest" redirect once to learn the versioned url, e.g. …/1789931006_9.0.2/ffmpeg.zip. */
async function resolveRedirect(fetcher: Fetcher, url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetcher(url, {redirect: 'manual', ...(signal && {signal})})
  const location = response.headers.get('location')
  await response.body?.cancel() // the body of a redirect is irrelevant; free the socket
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new BinaryError(`Expected a redirect from ${url} (HTTP ${response.status}).`)
  }
  return new URL(location, url).href
}

async function riedlAsset(fetcher: Fetcher, arch: string, file: string, signal?: AbortSignal) {
  const url = await resolveRedirect(fetcher, `${RIEDL}/${arch}/release/${file}`, signal)
  const sha256 = (await text(fetcher, `${url}.sha256`, signal)).trim().split(/\s+/, 1)[0]?.toLowerCase()
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new BinaryError(`No valid checksum published for ${url}.`)
  const version = /_(\d+(?:\.\d+)+)\//.exec(url)?.[1]
  return {asset: {url, name: file, sha256, format: 'zip'} satisfies Asset, version}
}

/** Highest stable "ffmpeg-nX.Y-latest-<target>-gpl-X.Y.<ext>" listed in BtbN's checksums. */
export function pickBtbnBuild(checksums: string, target: string): {name: string; version: string} | undefined {
  const pattern = new RegExp(`^ffmpeg-n(\\d+(?:\\.\\d+)*)-latest-${target}-gpl-[\\d.]+\\.(?:zip|tar\\.xz)$`)
  let best: {name: string; version: string; parts: number[]} | undefined
  for (const name of parseChecksums(checksums).keys()) {
    const version = pattern.exec(name)?.[1]
    if (!version) continue
    const parts = version.split('.').map(Number)
    if (!best || compareParts(parts, best.parts) > 0) best = {name, version, parts}
  }
  return best && {name: best.name, version: best.version}
}

function compareParts(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export async function ffmpegRelease(
  opts: {target?: Target; fetcher?: Fetcher; signal?: AbortSignal} = {},
): Promise<Release> {
  const fetcher = opts.fetcher ?? fetch
  const {platform, arch} = opts.target ?? here
  const executables = {ffmpeg: exe('ffmpeg'), ffprobe: exe('ffprobe')}

  if (platform === 'darwin') {
    const riedlArch = RIEDL_ARCH[arch]
    if (!riedlArch) throw new BinaryError(`No ffmpeg build for macOS ${arch}.`)
    const [ffmpeg, ffprobe] = await Promise.all([
      riedlAsset(fetcher, riedlArch, 'ffmpeg.zip', opts.signal),
      riedlAsset(fetcher, riedlArch, 'ffprobe.zip', opts.signal),
    ])
    return {tool: 'ffmpeg', version: ffmpeg.version ?? 'latest', assets: [ffmpeg.asset, ffprobe.asset], executables}
  }

  const btbnTarget = BTBN_TARGET[`${platform}-${arch}`]
  if (!btbnTarget) throw new BinaryError(`No ffmpeg build for ${platform}-${arch}; install ffmpeg manually.`)
  const checksums = await text(fetcher, `${BTBN}/checksums.sha256`, opts.signal)
  const build = pickBtbnBuild(checksums, btbnTarget)
  if (!build) throw new BinaryError(`No stable ffmpeg build listed for ${btbnTarget}.`)
  const sha256 = parseChecksums(checksums).get(build.name)!
  const format: ArchiveFormat = build.name.endsWith('.zip') ? 'zip' : 'tar.xz'
  return {
    tool: 'ffmpeg',
    version: build.version,
    assets: [{url: `${BTBN}/${build.name}`, name: build.name, sha256, format}],
    executables,
  }
}
