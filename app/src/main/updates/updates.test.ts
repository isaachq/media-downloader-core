// @vitest-environment node
import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import type {AddressInfo} from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {downloadUpdate, UpdateError} from './download'
import {pickUpdate, RELEASES_PAGE} from './feed'
import {bundleOf} from './install'
import {Updater} from './updater'
import {compareVersions, parseVersion} from './version'

const v = (text: string) => parseVersion(text)!
const sorted = (list: string[]) => [...list].sort((a, b) => compareVersions(v(a), v(b)))

describe('versions', () => {
  it('orders releases and pre-releases the semver way', () => {
    expect(
      sorted(['0.2.0', '0.2.0-beta.10', '0.10.0', '0.2.0-beta.2', '0.2.0-alpha.1', '0.2.1', 'v0.2.0-beta.3']),
    ).toEqual(['0.2.0-alpha.1', '0.2.0-beta.2', 'v0.2.0-beta.3', '0.2.0-beta.10', '0.2.0', '0.2.1', '0.10.0'])
    expect(parseVersion('not a version')).toBeUndefined()
  })
})

const asset = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  size: 100,
  digest: `sha256:${'a'.repeat(64)}`,
  browser_download_url: `${RELEASES_PAGE}/download/x/${name}`,
  ...extra,
})
const release = (tag: string, names: string[], extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  body: `notes ${tag}`,
  html_url: `${RELEASES_PAGE}/tag/${tag}`,
  assets: names.map(name => asset(name)),
  ...extra,
})
const files = (version: string) =>
  [
    'mac-arm64.zip',
    'mac-x64.zip',
    'win-x64.exe',
    'win-arm64.exe',
    'linux-amd64.deb',
    'linux-x86_64.rpm',
    'linux-x86_64.AppImage',
    'linux-arm64.deb',
    'linux-aarch64.rpm',
    'linux-arm64.AppImage',
  ].map(suffix => `Media-Download-Core-${version}-${suffix}`)

describe('release feed', () => {
  const feed = [
    release('app-v0.2.0-beta.2', files('0.2.0-beta.2')),
    release('app-v0.3.0-beta.1', files('0.3.0-beta.1')),
    release('app-v0.4.0-beta.1', files('0.4.0-beta.1'), {draft: true}),
    release('v9.9.9', files('9.9.9')), // not an app tag
  ]

  it('offers the newest published app release, with the file for this install', () => {
    const offer = pickUpdate(feed, '0.2.0-beta.3', 'mac-app', 'arm64')
    expect(offer?.version).toBe('0.3.0-beta.1')
    expect(offer?.asset.name).toBe('Media-Download-Core-0.3.0-beta.1-mac-arm64.zip')
    expect(offer?.notes).toBe('notes app-v0.3.0-beta.1')
    expect(pickUpdate(feed, '0.2.0-beta.3', 'windows-nsis', 'x64')?.asset.name).toMatch(/win-x64\.exe$/)
    expect(pickUpdate(feed, '0.2.0-beta.3', 'linux-rpm', 'arm64')?.asset.name).toMatch(/linux-aarch64\.rpm$/)
    expect(pickUpdate(feed, '0.2.0-beta.3', 'linux-deb', 'x64')?.asset.name).toMatch(/linux-amd64\.deb$/)
    expect(pickUpdate(feed, '0.2.0-beta.3', 'linux-appimage', 'x64')?.asset.name).toMatch(/x86_64\.AppImage$/)
  })

  it('offers nothing when up to date, and never a file it cannot verify or that comes from elsewhere', () => {
    expect(pickUpdate(feed, '0.3.0-beta.1', 'mac-app', 'arm64')).toBeUndefined()
    const unverifiable = [release('app-v1.0.0', [])]
    unverifiable[0]!.assets = [asset('Media-Download-Core-1.0.0-mac-arm64.zip', {digest: undefined})]
    expect(pickUpdate(unverifiable, '0.2.0', 'mac-app', 'arm64')).toBeUndefined()
    const elsewhere = [release('app-v1.0.0', [])]
    elsewhere[0]!.assets = [
      asset('Media-Download-Core-1.0.0-mac-arm64.zip', {browser_download_url: 'https://evil.example/x.zip'}),
    ]
    expect(pickUpdate(elsewhere, '0.2.0', 'mac-app', 'arm64')).toBeUndefined()
    expect(pickUpdate('garbage', '0.2.0', 'mac-app', 'arm64')).toBeUndefined()
  })
})

describe('install helpers', () => {
  it('finds the app bundle of the running executable', () => {
    expect(bundleOf('/Applications/Media Download Core.app/Contents/MacOS/Media Download Core')).toBe(
      '/Applications/Media Download Core.app',
    )
    expect(bundleOf('/usr/local/bin/electron')).toBeUndefined()
  })
})

// ─── download + updater against a local server ──────────────────────────────

const payload = Buffer.from('new version '.repeat(5000))
const sha256 = createHash('sha256').update(payload).digest('hex')
let server: http.Server
let origin = ''
let downloads = 0
let dir = ''

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-update-'))
  server = http.createServer((req, res) => {
    if (req.url === '/releases') {
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(
        JSON.stringify([
          {
            tag_name: 'app-v9.0.0',
            draft: false,
            body: 'Big update',
            html_url: `${origin}/page`,
            assets: [
              {
                name: 'Media-Download-Core-9.0.0-mac-x64.zip',
                size: payload.length,
                digest: `sha256:${sha256}`,
                browser_download_url: `${origin}/download/ok.zip`,
              },
            ],
          },
        ]),
      )
      return
    }
    downloads++
    const body = req.url === '/download/tampered.zip' ? Buffer.from(payload).fill(65, 0, 10) : payload
    res.writeHead(200, {'Content-Length': String(body.length)})
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
  await fs.rm(dir, {recursive: true, force: true})
})

describe('verified download', () => {
  const ok = () => ({name: 'ok.zip', url: `${origin}/download/ok.zip`, size: payload.length, sha256})

  it('keeps the file only when size and SHA-256 match, and reuses a verified one', async () => {
    const before = downloads
    const progress: number[] = []
    const file = await downloadUpdate({asset: ok(), dir, onProgress: received => progress.push(received)})
    expect((await fs.readFile(file)).equals(payload)).toBe(true)
    expect(progress.at(-1)).toBe(payload.length)
    await downloadUpdate({asset: ok(), dir})
    expect(downloads - before).toBe(1) // already verified: not downloaded again
  })

  it('rejects a file that does not match the published checksum, leaving nothing behind', async () => {
    const tampered = {name: 'tampered.zip', url: `${origin}/download/tampered.zip`, size: payload.length, sha256}
    await expect(downloadUpdate({asset: tampered, dir})).rejects.toBeInstanceOf(UpdateError)
    const left = await fs.readdir(dir)
    expect(left.some(name => name.startsWith('tampered'))).toBe(false)
  })
})

describe('Updater', () => {
  it('checks, then downloads and verifies the update (dry run stops before installing)', async () => {
    const states: string[] = []
    const updater = new Updater({
      current: '0.2.0-beta.3',
      kind: 'mac-app',
      arch: 'x64',
      dir: path.join(dir, 'updater'),
      bundleId: 'x',
      execPath: '/x',
      env: {},
      feedUrl: `${origin}/releases`,
      trustedPrefix: `${origin}/download/`,
      dryRun: true,
      exit: () => {
        throw new Error('must not exit in a dry run')
      },
    })
    updater.onChange(state => states.push(state.status))
    const checked = await updater.check()
    expect(checked).toMatchObject({status: 'available', version: '9.0.0', notes: 'Big update'})
    await updater.update()
    expect(updater.state).toMatchObject({status: 'ready', version: '9.0.0'})
    expect(states[0]).toBe('checking')
    expect(states).toContain('downloading')
    expect(states.at(-1)).toBe('ready')
  })

  it('cleans up what earlier updates left behind', async () => {
    const leftovers = path.join(dir, 'leftovers')
    await fs.mkdir(path.join(leftovers, 'staging-1.0.0'), {recursive: true})
    await fs.writeFile(path.join(leftovers, 'old-installer.zip'), 'x')
    const updater = new Updater({
      current: '1.0.0',
      kind: 'mac-app',
      arch: 'x64',
      dir: leftovers,
      bundleId: 'x',
      execPath: '/x',
      env: {},
      exit: () => {},
    })
    await updater.cleanUp()
    await expect(fs.access(leftovers)).rejects.toThrow()
  })

  it('a copy that cannot update itself says so instead of checking', async () => {
    const updater = new Updater({
      current: '0.2.0',
      kind: undefined,
      arch: 'x64',
      dir,
      bundleId: 'x',
      execPath: '/x',
      env: {},
      exit: () => {},
    })
    expect((await updater.check()).status).toBe('unsupported')
  })

  it('reports a failing check, or keeps quiet about it in the background', async () => {
    const make = () =>
      new Updater({
        current: '0.2.0',
        kind: 'mac-app',
        arch: 'x64',
        dir,
        bundleId: 'x',
        execPath: '/x',
        env: {},
        feedUrl: `${origin}/nope-not-json`,
        exit: () => {},
      })
    expect((await make().check()).status).toBe('error')
    expect((await make().check({quiet: true})).status).toBe('idle')
  })
})
