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

// ─── a cancel while waiting out a cool-down ──────────────────────────────────
// Found late by a downstream integration (core 1.23.1): a cancel during a site's
// cool-down left the window in place, so the next link said "rate limited"
// although nothing was refused. The sites whose fakes can refuse an answer run
// it; YouTube (yt-dlp) and player-page sites have no cool-down of their own and
// are skipped by name.

/** A cool-down window long enough to cancel inside, short enough for the test. */
const WINDOW_MS = 1500
const coolingPacing = {spacingMs: 0, jitterMs: 0, backoffMs: WINDOW_MS, maxBackoffMs: WINDOW_MS}

/** A refusing site: the engine options, the link whose first read is refused, and a count of refusals so far. */
type CoolingSite = {
  readonly options: Partial<DownloaderOptions>
  readonly url: string
  refused(): number
  close(): Promise<void>
}

const COOLING_SITES: ReadonlyArray<readonly [string, () => Promise<CoolingSite>]> = [
  [
    'TikTok',
    async () => {
      // the fake refuses video pages, not the profile listing: a single post is the link
      const site = await startFakeTikTok({posts: 2, refusals: 1})
      return {
        options: {tiktok: {origin: site.origin, pacing: coolingPacing}, instagram: false, facebook: false},
        url: `${site.origin}/@${site.user}/video/${site.ids[0]}`,
        refused: () => site.hits.page,
        close: () => site.close(),
      }
    },
  ],
  [
    'Instagram',
    async () => {
      const site = await startFakeInstagram({posts: 2, refusals: 1})
      const [name, value] = SESSION_COOKIE.split('=') as [string, string]
      const host = new URL(site.origin).hostname
      return {
        options: {
          tiktok: false,
          facebook: false,
          instagram: {origin: site.origin, pacing: coolingPacing, cookies: async () => [{name, value, domain: host}]},
        },
        url: `${site.origin}/${site.user}/`,
        refused: () => site.hits.refused,
        close: () => site.close(),
      }
    },
  ],
  [
    'Facebook',
    async () => {
      const site = await startFakeFacebook({videos: 2, refusals: 1})
      return {
        options: {tiktok: false, instagram: false, facebook: {origin: site.origin, pacing: coolingPacing}},
        url: `${site.origin}/${site.page}/videos/`,
        refused: () => site.hits.refused,
        close: () => site.close(),
      }
    },
  ],
]

/** Resolves once `count()` is at least `n`, or fails after `ms`: polled every 20 ms, never open-ended. */
async function reached(count: () => number, n: number, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (count() < n) {
    if (Date.now() > until) throw new Error(`waited ${ms} ms for ${n} hit(s): ${count()}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

for (const [label, start] of COOLING_SITES) {
  const slug = label.replace(/\W+/g, '-').toLowerCase()
  describe(`scenarios · ${label}`, () => {
    it('cancel while waiting out a cool-down: rejects at once, the window is not extended', async () => {
      const site = await start()
      const {engine} = await harness(`${slug}-cooldown-cancel`, {
        options: site.options,
        listUrl: site.url,
        items: 2,
        close: () => site.close(),
      })
      const control = new AbortController()
      const first = engine.analyze(site.url, {signal: control.signal})
      // the site refused once: the source is now sleeping through the cool-down
      await reached(site.refused, 1)
      const refusedAt = Date.now()
      control.abort()
      await assert.rejects(
        first,
        (e: {code?: string; message: string}) => e.code === 'cancelled' || /abort/i.test(e.message),
      )
      const rejectedIn = Date.now() - refusedAt
      assert.ok(rejectedIn < 300, `the cancelled analysis took ${rejectedIn} ms to reject`)
      // the next read of the same link waits out the one window that was running, not a second one
      const startedAt = Date.now()
      const second = await engine.analyze(site.url)
      const took = Date.now() - startedAt
      assert.ok(second.kind === 'video' || second.kind === 'playlist', `the second analysis answered ${second.kind}`)
      assert.ok(took < 2 * WINDOW_MS, `the second analysis took ${took} ms: more than one ${WINDOW_MS} ms window`)
      assert.ok(Date.now() - refusedAt < 2 * WINDOW_MS, 'one window since the refusal, not two')
    })
  })
}

// ─── a restart in the middle of a batch ──────────────────────────────────────
// Found late by a downstream integration: a reopened batch of ~840 items read
// every item over the network again (28 minutes) instead of only the unfinished
// ones. The fake yt-dlp site is enough: the scheduler's restore is shared by every site.

/** Counts the items the engine checks over the network from now on. */
function countPreflight(engine: MediaDownloader): () => number {
  let items = 0
  const original = engine.preflight.bind(engine)
  engine.preflight = (list, opts) => {
    items += list.length
    return original(list, opts)
  }
  return () => items
}

/** An engine on `dataDir` with the restart test's settings: the same before and after the crash. */
function restartEngine(dataDir: string): MediaDownloader {
  return new MediaDownloader({
    dataDir,
    binaries: bins,
    validation: 'none',
    maxRetries: 2,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    concurrency: 4,
    tiktok: false,
    instagram: false,
    facebook: false,
  })
}

describe('scenarios · restart', () => {
  it('a crash mid-batch: the restored batch finishes, done items are not downloaded again, checks are bounded by the unfinished ones', async () => {
    // 24 items of ~400 ms at concurrency 4 (6 rounds); the crash comes after 8 completions (2 rounds)
    const total = 24
    const doneBefore = 8
    const listUrl = `https://fake.test/list?n=${total}&p=slow-`
    const dataDir = path.join(root, 'restart')
    const out = path.join(dataDir, 'out')
    const first = restartEngine(dataDir)
    const firstScheduler = new BatchScheduler(first, {progressIntervalMs: 0})
    const crashed = new Promise<void>(resolve => {
      let completed = 0
      first.on('job', job => {
        if (job.status === 'completed' && ++completed === doneBefore) resolve()
      })
    })
    const batch = firstScheduler.schedule({url: listUrl, profile: mp4, outDir: out})
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        crashed,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${doneBefore} downloads did not complete within 20 s`)), 20_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    // the crash: scheduler and engine go away with downloads in flight
    await firstScheduler.dispose()
    await first.dispose()

    const engine = restartEngine(dataDir)
    const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
    cleanups.push(async () => {
      await scheduler.dispose()
      await engine.dispose()
    })
    const checked = countPreflight(engine)
    let downloadedAfter = 0
    engine.on('job', job => {
      if (job.status === 'completed') downloadedAfter++
    })
    const restored = await scheduler.restore()
    assert.equal(restored.length, 1)
    // a restored batch is a new one on the saved request: it is followed by its own id
    assert.equal(restored[0]?.url, batch.url)
    const id = restored[0]!.id
    await settled(scheduler, 20_000)
    const done = scheduler.batch(id)!
    assert.equal(done.status, 'completed', `ended ${done.status}: ${JSON.stringify(done.problems)}`)
    assert.equal(done.jobs.failed, 0)
    assert.equal(done.jobs.succeeded, total, 'every item ended well (downloaded now, or skipped as already done)')
    // the items done before the crash are in the archive: skipped, not downloaded again
    const skipped = engine.jobs().filter(job => job.status === 'skipped').length
    assert.ok(
      skipped >= doneBefore,
      `${skipped} skipped: the ${doneBefore} done before the crash are not downloaded again`,
    )
    assert.ok(
      downloadedAfter <= total - doneBefore,
      `${downloadedAfter} downloads after the restart for ${total - doneBefore} unfinished items`,
    )
    const files = (await fs.readdir(out, {recursive: true, withFileTypes: true})).filter(entry => entry.isFile())
    assert.equal(files.length, total, "one file per item (in the list's folder), none twice")
    // the batch was checked before the crash: the restore checks at most the unfinished items (ideally none)
    assert.ok(
      checked() <= total - doneBefore,
      `$checked()items checked over the network on restore for ${total - doneBefore} unfinished`,
    )
    assert.equal(checked(), 0, 'a batch checked before the crash is not checked again on restore')
  })
})
