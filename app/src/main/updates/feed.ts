import {compareVersions, parseVersion, type Version} from './version'

/**
 * Where updates come from: this project's GitHub releases tagged `app-v…`.
 * Pre-releases count (the app is in beta); drafts never do. Every file must
 * carry GitHub's SHA-256 digest — without it the update is not offered.
 */
export const RELEASES_API = 'https://api.github.com/repos/isaachq/media-downloader-core/releases'
export const RELEASES_PAGE = 'https://github.com/isaachq/media-downloader-core/releases'
const TAG_PREFIX = 'app-v'

/** How this copy of the app was installed: decides which file updates it. */
export type InstallKind = 'mac-app' | 'windows-nsis' | 'linux-appimage' | 'linux-deb' | 'linux-rpm'

export type UpdateAsset = {
  readonly name: string
  readonly url: string
  readonly size: number
  /** Hex SHA-256 from GitHub. */
  readonly sha256: string
}

export type UpdateOffer = {
  readonly version: string
  readonly tag: string
  readonly notes: string
  readonly publishedAt?: string | undefined
  readonly page: string
  readonly asset: UpdateAsset
}

type RawAsset = {
  readonly name?: unknown
  readonly browser_download_url?: unknown
  readonly size?: unknown
  readonly digest?: unknown
}
type RawRelease = {
  readonly tag_name?: unknown
  readonly draft?: unknown
  readonly body?: unknown
  readonly html_url?: unknown
  readonly published_at?: unknown
  readonly assets?: unknown
}

/** File name endings per install kind and architecture (as electron-builder names them). */
function assetSuffix(kind: InstallKind, arch: string): string {
  const linux = (deb: string, rpm: string, appImage: string) =>
    kind === 'linux-deb' ? deb : kind === 'linux-rpm' ? rpm : appImage
  switch (kind) {
    case 'mac-app':
      return `-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`
    case 'windows-nsis':
      return `-win-${arch === 'arm64' ? 'arm64' : 'x64'}.exe`
    default:
      return arch === 'arm64'
        ? linux('-linux-arm64.deb', '-linux-aarch64.rpm', '-linux-arm64.AppImage')
        : linux('-linux-amd64.deb', '-linux-x86_64.rpm', '-linux-x86_64.AppImage')
  }
}

/**
 * The newest release above `current` that has a verifiable file for this
 * install, or undefined. O(releases × assets).
 */
export function pickUpdate(
  releases: unknown,
  current: string,
  kind: InstallKind,
  arch: string,
  /** Downloads must come from here (this project's releases); tests point it at a local server. */
  trustedPrefix = `${RELEASES_PAGE}/download/`,
): UpdateOffer | undefined {
  const running = parseVersion(current)
  if (!running || !Array.isArray(releases)) return undefined
  let best: {version: Version; release: RawRelease; asset: UpdateAsset} | undefined
  for (const release of releases as RawRelease[]) {
    if (release.draft === true || typeof release.tag_name !== 'string' || !release.tag_name.startsWith(TAG_PREFIX))
      continue
    const version = parseVersion(release.tag_name.slice(TAG_PREFIX.length))
    if (!version || compareVersions(version, running) <= 0) continue
    if (best && compareVersions(version, best.version) <= 0) continue
    const asset = matchingAsset(release.assets, kind, arch, trustedPrefix)
    if (asset) best = {version, release, asset}
  }
  if (!best) return undefined
  return {
    version: best.version.text,
    tag: String(best.release.tag_name),
    notes: typeof best.release.body === 'string' ? best.release.body : '',
    publishedAt: typeof best.release.published_at === 'string' ? best.release.published_at : undefined,
    page: typeof best.release.html_url === 'string' ? best.release.html_url : RELEASES_PAGE,
    asset: best.asset,
  }
}

function matchingAsset(
  assets: unknown,
  kind: InstallKind,
  arch: string,
  trustedPrefix: string,
): UpdateAsset | undefined {
  if (!Array.isArray(assets)) return undefined
  const suffix = assetSuffix(kind, arch)
  for (const raw of assets as RawAsset[]) {
    if (typeof raw.name !== 'string' || !raw.name.endsWith(suffix)) continue
    const digest = typeof raw.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(raw.digest)?.[1] : undefined
    const url = typeof raw.browser_download_url === 'string' ? raw.browser_download_url : undefined
    // only files GitHub can vouch for, from this project's releases, over https
    if (!digest || !url?.startsWith(trustedPrefix)) continue
    return {name: raw.name, url, size: typeof raw.size === 'number' ? raw.size : 0, sha256: digest.toLowerCase()}
  }
  return undefined
}
