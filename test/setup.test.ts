import {strict as assert} from 'node:assert'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {crc32} from 'node:zlib'
import {FFMPEG_REQUIREMENTS, parseCodecList, parseFfmpegVersion} from '../src/binaries/capabilities.js'
import {ytDlpAgeDays} from '../src/binaries/doctor.js'
import {BinaryManager} from '../src/binaries/manager.js'
import {type Fetcher, ffmpegRelease, latestYtDlpVersion, pickBtbnBuild, ytDlpRelease} from '../src/binaries/sources.js'
import {run} from '../src/core/process.js'

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** Minimal "stored" (uncompressed) zip writer — enough to serve test archives. */
function makeZip(files: ReadonlyArray<{name: string; data: Buffer}>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const {name, data} of files) {
    const nameBytes = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4) // made by unix, so the mode below is honored
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** fetch() stand-in serving a fixed url → response table. */
function fakeFetch(routes: Record<string, () => Response>): Fetcher & {calls: string[]} {
  const calls: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    const route = routes[url]
    return route ? route() : new Response('not found', {status: 404})
  }) as Fetcher & {calls: string[]}
  fetcher.calls = calls
  return fetcher
}

const ok = (body: string | Buffer) => () => new Response(new Uint8Array(Buffer.from(body)), {status: 200})

describe('release sources', () => {
  it('picks the newest stable GPL BtbN build and ignores master / lgpl / shared', () => {
    const listing = [
      `${'a'.repeat(64)}  ffmpeg-master-latest-win64-gpl.zip`,
      `${'b'.repeat(64)}  ffmpeg-n8.1-latest-win64-gpl-8.1.zip`,
      `${'c'.repeat(64)}  ffmpeg-n9.0-latest-win64-gpl-9.0.zip`,
      `${'d'.repeat(64)}  ffmpeg-n9.0-latest-win64-lgpl-9.0.zip`,
      `${'e'.repeat(64)}  ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip`,
      `${'f'.repeat(64)}  ffmpeg-n10.0-latest-linux64-gpl-10.0.tar.xz`,
    ].join('\n')
    assert.deepEqual(pickBtbnBuild(listing, 'win64'), {name: 'ffmpeg-n9.0-latest-win64-gpl-9.0.zip', version: '9.0'})
    assert.equal(pickBtbnBuild(listing, 'linuxarm64'), undefined)
  })

  it('resolves macOS ffmpeg through the versioned redirect and its .sha256', async () => {
    const base = 'https://ffmpeg.martin-riedl.de'
    const versioned = (file: string) => `${base}/download/macos/arm64/1789931890_9.0.2/${file}`
    const fetcher = fakeFetch({
      [`${base}/redirect/latest/macos/arm64/release/ffmpeg.zip`]: () =>
        new Response(null, {status: 307, headers: {location: versioned('ffmpeg.zip')}}),
      [`${base}/redirect/latest/macos/arm64/release/ffprobe.zip`]: () =>
        new Response(null, {status: 307, headers: {location: versioned('ffprobe.zip')}}),
      [`${versioned('ffmpeg.zip')}.sha256`]: ok(`${'1'.repeat(64)}  ffmpeg.zip\n`),
      [`${versioned('ffprobe.zip')}.sha256`]: ok(`${'2'.repeat(64)}  ffprobe.zip\n`),
    })
    const release = await ffmpegRelease({target: {platform: 'darwin', arch: 'arm64'}, fetcher})
    assert.equal(release.version, '9.0.2')
    assert.deepEqual(
      release.assets.map(a => [a.name, a.sha256]),
      [
        ['ffmpeg.zip', '1'.repeat(64)],
        ['ffprobe.zip', '2'.repeat(64)],
      ],
    )
  })

  it('finds the latest yt-dlp through the web redirect, without the rate-limited API', async () => {
    const fetcher = fakeFetch({
      'https://github.com/yt-dlp/yt-dlp/releases/latest': () =>
        new Response(null, {
          status: 302,
          headers: {location: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2099.02.02'},
        }),
      'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest': () => new Response('rate limited', {status: 403}),
    })
    assert.equal(await latestYtDlpVersion(fetcher), '2099.02.02')
    assert.ok(!fetcher.calls.some(url => url.includes('api.github.com')))
  })

  it('falls back to the API (with GITHUB_TOKEN) when the redirect is unavailable', async () => {
    let auth: string | null = null
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('api.github.com')) {
        auth = new Headers(init?.headers).get('authorization')
        return new Response(JSON.stringify({tag_name: '2099.03.03'}), {status: 200})
      }
      return new Response('nope', {status: 500})
    }) as Fetcher
    assert.equal(await latestYtDlpVersion(fetcher, undefined, {GITHUB_TOKEN: 't0k3n'}), '2099.03.03')
    assert.equal(auth, 'Bearer t0k3n')
  })

  it('resolves yt-dlp from the latest tag and SHA2-256SUMS', async () => {
    const fetcher = fakeFetch({
      'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest': ok(JSON.stringify({tag_name: '2099.01.01'})),
      'https://github.com/yt-dlp/yt-dlp/releases/download/2099.01.01/SHA2-256SUMS': ok(
        `${'9'.repeat(64)}  yt-dlp_win.zip\n${'8'.repeat(64)}  yt-dlp_macos.zip\n`,
      ),
    })
    const release = await ytDlpRelease({target: {platform: 'win32', arch: 'x64'}, fetcher})
    assert.equal(release.version, '2099.01.01')
    assert.equal(release.assets[0]?.sha256, '9'.repeat(64))
  })
})

describe('ffmpeg capability parsing', () => {
  it('reads codec tables and versions', () => {
    const table = ' Encoders:\n V..... = Video\n ------\n V....D libx264   H.264\n A....D aac       AAC\n'
    assert.deepEqual([...parseCodecList(table)], ['libx264', 'aac'])
    assert.equal(parseFfmpegVersion('ffmpeg version 9.0.2 Copyright (c) 2000-2026'), '9.0.2')
    assert.equal(parseFfmpegVersion('ffprobe version N-121234-gabc Copyright'), 'N-121234-gabc')
  })

  it('computes yt-dlp age from its date version', () => {
    assert.equal(ytDlpAgeDays('2026.08.19', Date.UTC(2026, 9, 11)), 53)
    assert.equal(ytDlpAgeDays('2026.08.19.1', Date.UTC(2026, 7, 19)), 0)
    assert.equal(ytDlpAgeDays('git-abc'), undefined)
  })
})

// End-to-end install from an in-memory "internet". The fake binaries are
// shell scripts, so this suite runs on macOS and Linux.
describe('BinaryManager.install', {skip: process.platform === 'win32' && 'fake binaries are shell scripts'}, () => {
  let root = ''
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-setup-'))
  })
  after(async () => {
    await fs.rm(root, {recursive: true, force: true})
  })

  const ytDlpScript = Buffer.from('#!/bin/sh\necho 2099.01.01\n')
  const ytDlpRoutes = (zip: Buffer, digest: string) => ({
    'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest': ok(JSON.stringify({tag_name: '2099.01.01'})),
    'https://github.com/yt-dlp/yt-dlp/releases/download/2099.01.01/SHA2-256SUMS': ok(
      ['yt-dlp_macos.zip', 'yt-dlp_linux.zip', 'yt-dlp_linux_aarch64.zip'].map(n => `${digest}  ${n}`).join('\n'),
    ),
    [`https://github.com/yt-dlp/yt-dlp/releases/download/2099.01.01/yt-dlp_${process.platform === 'darwin' ? 'macos' : process.arch === 'arm64' ? 'linux_aarch64' : 'linux'}.zip`]:
      () => new Response(new Uint8Array(zip), {status: 200, headers: {'content-length': String(zip.length)}}),
  })

  it('downloads, verifies, extracts, tests and activates yt-dlp', async () => {
    const zip = makeZip([
      {name: 'yt-dlp_bin', data: ytDlpScript},
      {name: '_internal/python.so', data: Buffer.from('x')},
    ])
    const manager = new BinaryManager(path.join(root, 'ok'), {}, fakeFetch(ytDlpRoutes(zip, sha(zip))))
    const stages: string[] = []
    const installed = await manager.install('yt-dlp', {onProgress: p => stages.push(p.stage)})
    assert.equal(installed.version, '2099.01.01')
    assert.deepEqual([...new Set(stages)], ['resolving', 'downloading', 'extracting', 'testing', 'done'])
    const located = await manager.locate('yt-dlp')
    assert.equal(located?.source, 'managed')
    assert.equal(located?.version, '2099.01.01')
  })

  it('refuses an archive whose SHA-256 does not match, leaving nothing behind', async () => {
    const zip = makeZip([{name: 'yt-dlp_bin', data: ytDlpScript}])
    const dataDir = path.join(root, 'tampered')
    const manager = new BinaryManager(dataDir, {}, fakeFetch(ytDlpRoutes(zip, '0'.repeat(64))))
    await assert.rejects(manager.install('yt-dlp'), /Checksum mismatch/)
    assert.equal(await manager.managed('yt-dlp'), undefined)
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'bin', 'yt-dlp')), [], 'staging must be cleaned up')
  })

  it('installs a capable ffmpeg and rejects an incapable one', async () => {
    const listing = (names: readonly string[]) => [' ------', ...names.map(n => ` V..... ${n}  x`)].join('\\n')
    const all = (kind: keyof typeof FFMPEG_REQUIREMENTS) => FFMPEG_REQUIREMENTS[kind].map(anyOf => anyOf[0]!)
    const script = (encoders: readonly string[]) =>
      Buffer.from(
        [
          '#!/bin/sh',
          'case "$1$2" in',
          '  -version) echo "ffmpeg version 9.0.2 test";;',
          `  -hide_banner-version) echo "ffmpeg version 9.0.2 test";;`,
          `  -hide_banner-encoders) printf '${listing(encoders)}\\n';;`,
          `  -hide_banner-decoders) printf '${listing(all('decoders'))}\\n';;`,
          `  -hide_banner-muxers) printf '${listing(all('muxers'))}\\n';;`,
          'esac',
        ].join('\n'),
      )

    const routesFor = async (encoders: readonly string[]): Promise<Record<string, () => Response>> => {
      const ffmpeg = script(encoders)
      if (process.platform === 'darwin') {
        const base = 'https://ffmpeg.martin-riedl.de'
        const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
        const routes: Record<string, () => Response> = {}
        for (const tool of ['ffmpeg', 'ffprobe']) {
          const zip = makeZip([{name: tool, data: ffmpeg}])
          const url = `${base}/download/macos/${arch}/1_9.0.2/${tool}.zip`
          routes[`${base}/redirect/latest/macos/${arch}/release/${tool}.zip`] = () =>
            new Response(null, {status: 307, headers: {location: url}})
          routes[`${url}.sha256`] = ok(`${sha(zip)}  ${tool}.zip`)
          routes[url] = () => new Response(new Uint8Array(zip), {status: 200})
        }
        return routes
      }
      // Linux: BtbN tar.xz with bin/ffmpeg and bin/ffprobe
      const target = process.arch === 'arm64' ? 'linuxarm64' : 'linux64'
      const name = `ffmpeg-n9.0-latest-${target}-gpl-9.0.tar.xz`
      const src = await fs.mkdtemp(path.join(root, 'tar-'))
      await fs.mkdir(path.join(src, 'pkg', 'bin'), {recursive: true})
      for (const tool of ['ffmpeg', 'ffprobe']) {
        await fs.writeFile(path.join(src, 'pkg', 'bin', tool), ffmpeg, {mode: 0o755})
      }
      const archive = path.join(src, name)
      assert.equal((await run('tar', ['-cJf', archive, '-C', src, 'pkg'])).code, 0)
      const data = await fs.readFile(archive)
      const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
      return {
        [`${base}/checksums.sha256`]: ok(`${sha(data)}  ${name}\n`),
        [`${base}/${name}`]: () => new Response(new Uint8Array(data), {status: 200}),
      }
    }

    const capable = new BinaryManager(path.join(root, 'ff-ok'), {}, fakeFetch(await routesFor(all('encoders'))))
    const installed = await capable.install('ffmpeg')
    // macOS builds are versioned 9.0.2, BtbN stable builds 9.0
    assert.ok(['9.0.2', '9.0'].includes(installed.version), installed.version)
    assert.ok(installed.executables['ffmpeg'] && installed.executables['ffprobe'])
    assert.equal((await capable.locate('ffprobe'))?.source, 'managed')

    const weak = new BinaryManager(path.join(root, 'ff-weak'), {}, fakeFetch(await routesFor(['aac'])))
    await assert.rejects(weak.install('ffmpeg'), /lacks required codecs.*libx264/)
    assert.equal(await weak.managed('ffmpeg'), undefined)
  })
})
