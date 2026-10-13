// A host without yt-dlp (`ytDlp: 'optional'`, the Android app): the built-in extractors read
// every link they handle; where one would hand a link to yt-dlp, its own reason comes back to come
// back to later; anything else that needs yt-dlp says it is missing — never a failed spawn.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import type {DownloadError} from '../src/core/errors.js'
import {MediaDownloader} from '../src/downloader.js'
import {startFakeInstagram} from './helpers/fake-instagram.js'
import {startFakeTikTok} from './helpers/fake-tiktok.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const pacing = {spacingMs: 0, jitterMs: 0, backoffMs: 30, maxBackoffMs: 100}

let root: string
let bins: FakeBinaries
let savedPath: string | undefined
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-no-ytdlp-'))
  bins = await writeFakes(path.join(root, 'bin'))
  // no yt-dlp anywhere: not configured, and none on PATH either
  savedPath = process.env['PATH']
  process.env['PATH'] = path.join(root, 'empty')
})
after(async () => {
  process.env['PATH'] = savedPath
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

function engineFor(name: string, sites: {readonly tiktok?: string; readonly instagram?: string}) {
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: {ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe},
    ytDlp: 'optional',
    validation: 'none',
    maxRetries: 2,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: sites.tiktok ? {origin: sites.tiktok, pacing} : false,
    instagram: sites.instagram ? {origin: sites.instagram, pacing} : false,
    facebook: false,
  })
  cleanups.push(() => engine.dispose())
  return engine
}

describe('a host without yt-dlp', () => {
  it('downloads natively, and resolveBinaries still says yt-dlp is missing', async () => {
    const site = await startFakeTikTok({posts: 1})
    cleanups.push(() => site.close())
    const engine = engineFor('native', {tiktok: site.origin})
    const url = `${site.origin}/@${site.user}/video/${site.ids[0]}`
    assert.equal((await engine.analyze(url)).kind, 'video')
    const job = engine.add({url, profile: mp4, outDir: path.join(root, 'native', 'out')})
    await engine.whenIdle()
    assert.equal(engine.job(job.id)?.status, 'completed', JSON.stringify(engine.job(job.id)?.error))
    await assert.rejects(engine.resolveBinaries(), /yt-dlp/)
  })

  it('a page the source no longer reads: its own reason, to try later — not a hand-off to nobody', async () => {
    // the page of the only post has no data script any more (layout changed)
    const site = await startFakeTikTok({posts: 1, brokenPost: '7400000000000000001'})
    cleanups.push(() => site.close())
    assert.equal(site.ids[0], '7400000000000000001')
    const engine = engineFor('changed', {tiktok: site.origin})
    const url = `${site.origin}/@${site.user}/video/${site.ids[0]}`
    await assert.rejects(engine.analyze(url), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.equal(e.hint, 'retry-later')
      return true
    })
    const checks = await engine.preflight([{url}])
    const check = checks.get(url)
    assert.equal(check?.ok === false && check.error.hint, 'retry-later')
    const job = engine.add({url, profile: mp4, outDir: path.join(root, 'changed', 'out')})
    await engine.whenIdle()
    const failed = engine.job(job.id)!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error?.hint, 'retry-later')
    assert.deepEqual(
      failed.attempts.map(a => a.strategy),
      ['primary'],
      'no extractor-fallback attempt',
    )
  })

  it('Instagram walled from every route: "this network", and its links stay native (nobody to step aside for)', async () => {
    const site = await startFakeInstagram({loginWall: true, posts: 2})
    cleanups.push(() => site.close())
    const engine = engineFor('walled', {instagram: site.origin})
    for (const code of site.codes) {
      await assert.rejects(engine.analyze(`${site.origin}/p/${code}/`), (e: DownloadError) => {
        assert.equal(e.hint, 'retry-later')
        assert.match(e.message, /limiting this network/)
        return true
      })
    }
    assert.equal(site.hits.login, 4, 'the second post was read natively too (embed + page each)')
  })

  it('a link only yt-dlp reads says yt-dlp is missing', async () => {
    const engine = engineFor('generic', {})
    await assert.rejects(engine.analyze('https://fake.test/watch/single'), (e: DownloadError) => {
      assert.equal(e.code, 'binary-missing')
      return true
    })
    const check = (await engine.preflight([{url: 'https://fake.test/watch/single'}])).get(
      'https://fake.test/watch/single',
    )
    assert.equal(check?.ok === false && check.error.code, 'binary-missing')
  })
})
