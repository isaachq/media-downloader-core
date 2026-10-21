// A host without yt-dlp (`ytDlp: 'optional'`, the Android app): the built-in extractors read
// every link they handle; where one would hand a link to yt-dlp, its own reason comes back to come
// back to later; anything else that needs yt-dlp says it is missing — never a failed spawn.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import type {DownloadError} from '../src/core/errors.js'
import {MediaDownloader} from '../src/downloader.js'
import {startFakeInstagram} from './helpers/fake-instagram.js'
import {startFakeTikTok} from './helpers/fake-tiktok.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'
import {listenLocal} from './helpers/listen.js'

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
      await assert.rejects(engine.analyze(`${site.origin}/p/${code}/`, {attempts: 1}), (e: DownloadError) => {
        assert.equal(e.hint, 'retry-later')
        assert.match(e.message, /limiting this network/)
        return true
      })
    }
    assert.equal(
      site.hits.login,
      4,
      'the second post was read natively too: the routes that refused rest, the signed page is asked (3 + 1)',
    )
  })

  it('an analysis that fails in a way that may pass is tried again, another way; a final answer is not', async () => {
    const site = await startFakeInstagram({posts: 2, refusals: 14, noAppApi: true})
    cleanups.push(() => site.close())
    const engine = engineFor('retried', {instagram: site.origin})
    const retries: number[] = []
    const result = await engine.analyze(`${site.origin}/p/${site.codes[0]}/`, {
      retryWaitMs: () => 5,
      onRetry: attempt => retries.push(attempt),
    })
    assert.equal(result.kind, 'video')
    assert.ok(retries.length >= 1 && retries.length <= 2, `retried ${retries.length} time(s)`)
    // gone: answered at once, never retried
    const gone: number[] = []
    await assert.rejects(
      engine.analyze(`${site.origin}/p/C0DE999999/`, {retryWaitMs: () => 5, onRetry: attempt => gone.push(attempt)}),
      (e: DownloadError) => e.hint === 'removed',
    )
    assert.deepEqual(gone, [])
  })

  it('a thorough batch check reads again what failed in a way that may pass; a fast one answers at once', async () => {
    const fastSite = await startFakeInstagram({posts: 1, forbiddenFirst: 6})
    cleanups.push(() => fastSite.close())
    const fast = {site: fastSite, engine: engineFor('preflight-fast', {instagram: fastSite.origin})}
    const once = await fast.engine.preflight([{url: `${fast.site.origin}/p/${fast.site.codes[0]}/`}])
    assert.equal(once.get(`${fast.site.origin}/p/${fast.site.codes[0]}/`)?.ok, false, 'fast: one check, its answer')
    const thoroughSite = await startFakeInstagram({posts: 1, forbiddenFirst: 6})
    cleanups.push(() => thoroughSite.close())
    const thorough = {site: thoroughSite, engine: engineFor('preflight-thorough', {instagram: thoroughSite.origin})}
    const answers: boolean[] = []
    const checked = await thorough.engine.preflight([{url: `${thorough.site.origin}/p/${thorough.site.codes[0]}/`}], {
      attempts: 3,
      retryWaitMs: () => 5,
      onResult: (_, result) => answers.push(result.ok),
    })
    assert.equal(
      checked.get(`${thorough.site.origin}/p/${thorough.site.codes[0]}/`)?.ok,
      true,
      'thorough: checked again, read',
    )
    assert.deepEqual(answers, [true], 'only the last answer is reported')
  })

  it('a link straight to a media file downloads natively as "Web"; a page or a gone file says so', async () => {
    const body = Buffer.alloc(64 * 1024, 'h')
    const server = http.createServer((req, res) => {
      const where = new URL(req.url ?? '/', 'http://local').pathname
      if (where === '/files/My%20clip.mp4') {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
        if (range) {
          const start = Number(range[1])
          const end = range[2] ? Number(range[2]) : body.length - 1
          res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(end - start + 1),
          })
          res.end(body.subarray(start, end + 1))
          return
        }
        res.writeHead(200, {'Content-Type': 'video/mp4', 'Content-Length': String(body.length)})
        res.end(body)
        return
      }
      if (where === '/watch/page.mp4') {
        res.writeHead(200, {'Content-Type': 'text/html'})
        res.end('<html>a page</html>')
        return
      }
      res.writeHead(404)
      res.end()
    })
    const origin = `http://127.0.0.1:${await listenLocal(server)}`
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const engine = engineFor('direct', {})
    const url = `${origin}/files/My%20clip.mp4?token=1`
    const analysis = await engine.analyze(url)
    assert.equal(analysis.kind, 'video')
    if (analysis.kind !== 'video') return
    assert.equal(analysis.media.extractor, 'Web')
    assert.equal(analysis.media.title, 'My clip')
    assert.equal(analysis.choices[0]?.estimatedBytes, body.length)
    const job = engine.add({url, profile: mp4, outDir: path.join(root, 'direct', 'out')})
    await engine.whenIdle()
    const done = engine.job(job.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal((await fs.stat(done.filepath!)).size, body.length)
    await assert.rejects(
      engine.analyze(`${origin}/watch/page.mp4`, {attempts: 1}),
      (e: DownloadError) => e.hint === 'unsupported-url',
    )
    await assert.rejects(engine.analyze(`${origin}/gone.mp4`), (e: DownloadError) => e.hint === 'removed')
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
