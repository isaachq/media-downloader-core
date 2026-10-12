#!/usr/bin/env node
// Writes the winget manifests (version, installer, en-US locale) of a GitHub
// release of the app into packaging/winget/<version>/, ready for a pull
// request to microsoft/winget-pkgs. Installer urls and SHA-256 come from the
// release itself (GitHub's asset digests): nothing is typed by hand.
//
//   node scripts/winget-manifests.mjs app-v0.2.0-beta.7
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const REPO = 'isaachq/media-downloader-core'
const ID = 'isaachq.MediaDownloadCore'
const SCHEMA = '1.6.0'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tag = process.argv[2]
if (!tag?.startsWith('app-v')) {
  console.error('usage: node scripts/winget-manifests.mjs app-v<version>')
  process.exit(2)
}
const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
  headers: {Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN && {Authorization: `Bearer ${process.env.GITHUB_TOKEN}`})},
})
if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${tag}`)
const release = await response.json()
const version = tag.slice('app-v'.length)

const installers = [
  ['x64', `-win-x64.exe`],
  ['arm64', `-win-arm64.exe`],
].map(([arch, suffix]) => {
  const asset = release.assets.find(item => item.name.endsWith(suffix))
  if (!asset) throw new Error(`${tag} has no ${suffix} installer`)
  if (!asset.digest?.startsWith('sha256:')) throw new Error(`${asset.name} has no SHA-256 digest on GitHub`)
  return {arch, url: asset.browser_download_url, sha256: asset.digest.slice('sha256:'.length).toUpperCase()}
})

const header = kind =>
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${SCHEMA}.schema.json\n`
const common = `PackageIdentifier: ${ID}\nPackageVersion: ${version}\n`
const files = {
  [`${ID}.yaml`]: `${header('version')}\n${common}DefaultLocale: en-US\nManifestType: version\nManifestVersion: ${SCHEMA}\n`,
  [`${ID}.installer.yaml`]: `${header('installer')}
${common}InstallerType: nullsoft
Scope: user
InstallModes:
- interactive
- silent
InstallerSwitches:
  Custom: /currentuser
UpgradeBehavior: install
ReleaseDate: ${release.published_at.slice(0, 10)}
Installers:
${installers
  .map(
    item => `- Architecture: ${item.arch}
  InstallerUrl: ${item.url}
  InstallerSha256: ${item.sha256}`,
  )
  .join('\n')}
ManifestType: installer
ManifestVersion: ${SCHEMA}
`,
  [`${ID}.locale.en-US.yaml`]: `${header('defaultLocale')}
${common}PackageLocale: en-US
Publisher: isaachq
PublisherUrl: https://github.com/isaachq
PublisherSupportUrl: https://github.com/${REPO}/issues
Author: isaachq
PackageName: Media Download Core
PackageUrl: https://isaachq.github.io/media-downloader-core/
License: PolyForm Noncommercial 1.0.0
LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE
ShortDescription: Back up whole playlists and profiles, every file verified.
Description: |-
  A desktop app for heavy batch downloads: paste a video, a playlist, a channel or a TikTok profile, pick what you want, and it downloads on a pool sized to your computer while it checks every file (codecs, duration, every frame, SHA-256). Finished files of every session in one place, a live report of the run, file names cars and TVs read, English and Spanish.
Moniker: media-download-core
Tags:
- downloader
- backup
- playlist
- tiktok
- youtube
- mp3
- mp4
ReleaseNotesUrl: ${release.html_url}
ManifestType: defaultLocale
ManifestVersion: ${SCHEMA}
`,
}
const dir = path.join(ROOT, 'packaging', 'winget', version)
await mkdir(dir, {recursive: true})
for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
console.log(`${path.relative(ROOT, dir)}: ${Object.keys(files).join(', ')}`)
