// The same hard scenarios on every site the engine reads, each against its
// local fake: a whole list with one download cancelled mid-way, the checks put
// off until after the batch, refusals from the site, and the event loop kept
// responsive throughout. A site that passes here does not stall, does not
// stop a batch for one cancel, and does not keep the UI waiting.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import {after, before, describe, it} from 'node:test'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {PlayerPageSource} from '../src/sources/player-page/source.js'
import type {BatchStatus, DownloaderOptions} from '../src/types.js'
import {startFakeFacebook} from './helpers/fake-facebook.js'
import {SESSION_COOKIE, startFakeInstagram} from './helpers/fake-instagram.js'
import {startFakePlayerSite} from './helpers/fake-player-site.js'
import {startFakeTikTok} from './helpers/fake-tiktok.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

let root = ''
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-scenarios-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 60}
const mp4 = {kind: 'video', container: 'mp4'} as const

/** A site under test: the engine options that point at its fake, a list on it, and how many items it holds. */
type Site = {
  readonly options: Partial<DownloaderOptions>
  readonly listUrl: string
  readonly items: number
  close(): Promise<void>
}

/** Every site, each with a list of 6 and the site refusing its first answers. */
const SITES: ReadonlyArray<readonly [string, () => Promise<Site>]> = [
  [
    'YouTube and other yt-dlp sites',
    async () => ({
      options: {tiktok: false, instagram: false, facebook: false},
      listUrl: 'https://fake.test/list?n=6&p=slow-',
      items: 6,
      close: async () => {},
    }),
  ],
  [
    'TikTok',
    async () => {
      const site = await startFakeTikTok({posts: 6, refusals: 2})
      return {
        options: {tiktok: {origin: site.origin, pacing: fast}, instagram: false, facebook: false},
        listUrl: `${site.origin}/@${site.user}`,
        items: 6,
        close: () => site.close(),
      }
    },
  ],
  [
    'Instagram',
    async () => {
      const site = await startFakeInstagram({posts: 6, refusals: 2})
      const [name, value] = SESSION_COOKIE.split('=') as [string, string]
      const host = new URL(site.origin).hostname
      return {
        options: {
          tiktok: false,
          facebook: false,
          instagram: {origin: site.origin, pacing: fast, cookies: async () => [{name, value, domain: host}]},
        },
        listUrl: `${site.origin}/${site.user}/`,
        items: 6,
        close: () => site.close(),
      }
    },
  ],
  [
    'Facebook',
    async () => {
      const site = await startFakeFacebook({videos: 6})
      return {
        options: {tiktok: false, instagram: false, facebook: {origin: site.origin, pacing: fast}},
        listUrl: `${site.origin}/${site.page}/videos/`,
        items: 6,
        close: () => site.close(),
      }
    },
  ],
  [
    'player-page sites',
    async () => {
      const site = await startFakePlayerSite({results: 6, perPage: 6, mediaBytes: 256 * 1024})
      const source = new PlayerPageSource({
        site: {name: 'Local Site', hosts: [site.host]},
        pacing: {concurrency: 4, ...fast},
        resolveMedia: site.resolve,
      })
      return {
        options: {tiktok: false, instagram: false, facebook: false, sources: [source]},
        listUrl: site.searchUrl('x'),
        items: 6,
        close: () => site.close(),
      }
    },
  ],
]

async function harness(name: string, site: Site, extra: Partial<DownloaderOptions> = {}) {
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    maxRetries: 2,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    concurrency: 3,
    ...site.options,
    ...extra,
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  const statuses: BatchStatus[] = []
  scheduler.on('batch', batch => {
    if (statuses.at(-1) !== batch.status) statuses.push(batch.status)
  })
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {engine, scheduler, statuses, out: path.join(root, name, 'out')}
}

/** Resolves with the batch's last snapshot, or fails after `ms`: a stall is a failure, not a hung test. */
async function settled(scheduler: BatchScheduler, ms = 60_000) {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      scheduler.whenIdle(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the batch did not settle within ${ms / 1000} s`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const [label, start] of SITES) {
  const slug = label.replace(/\W+/g, '-').toLowerCase()
  describe(`scenarios · ${label}`, () => {
    it('a whole list with one download cancelled mid-way: the rest go on and the batch completes', async () => {
      const site = await start()
      const {engine, scheduler, statuses, out} = await harness(`${slug}-cancel`, site)
      const lag = monitorEventLoopDelay({resolution: 10})
      lag.enable()
      let cancelled: string | undefined
      engine.on('job', job => {
        if (cancelled || job.status !== 'downloading') return
        cancelled = job.id
        engine.cancel(job.id)
      })
      const batch = scheduler.schedule({url: site.listUrl, profile: mp4, outDir: out})
      await settled(scheduler)
      lag.disable()
      const done = scheduler.batch(batch.id)!
      assert.ok(cancelled, 'one download was cancelled')
      assert.equal(done.status, 'completed', `ended ${done.status}: ${JSON.stringify(done.problems)}`)
      assert.equal(done.jobs.cancelled, 1)
      assert.equal(done.jobs.succeeded, site.items - 1)
      assert.equal(done.jobs.failed, 0)
      assert.deepEqual(statuses, ['scheduled', 'checking', 'running', 'completed'])
      // the engine never blocks the event loop the UI shares: no single stall near a second, even
      // with the whole suite running beside it (a blocking bug stalls for far longer)
      assert.ok(lag.max / 1e6 < 1000, `event loop blocked ${Math.round(lag.max / 1e6)} ms`)
    })

    it('checks put off until after the batch: downloads first, then one check of every file', async () => {
      const site = await start()
      const {engine, scheduler, statuses, out} = await harness(`${slug}-later`, site, {
        validation: 'quick',
        validationTiming: 'after-batch',
      })
      // when the check begins, every download has ended (none still running)
      let atCheck: string[] | undefined
      scheduler.on('batch', snapshot => {
        if (snapshot.status === 'validating' && !atCheck) atCheck = engine.jobs().map(job => job.status)
      })
      const batch = scheduler.schedule({url: site.listUrl, profile: mp4, outDir: out})
      await settled(scheduler)
      const done = scheduler.batch(batch.id)!
      assert.ok(statuses.includes('validating'), `statuses: ${statuses.join(' → ')}`)
      assert.deepEqual(atCheck, Array(site.items).fill('completed'), 'every download finished before the check began')
      assert.equal(done.jobs.succeeded + done.jobs.failed, site.items)
      assert.ok(
        engine.jobs().every(job => !job.validationPending),
        'nothing left waiting for its check',
      )
      // whatever a file's verdict, the history agrees with the jobs
      const history = await engine.archive.list({batchId: batch.id})
      assert.equal(history.total, done.jobs.succeeded + (done.problems?.failed?.['damaged-source'] ?? 0))
    })
  })
}
