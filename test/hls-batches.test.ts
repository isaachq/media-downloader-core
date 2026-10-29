import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {clampConcurrency} from '../src/core/pool.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {HYDRATION_ID, startFakeSoundcloud, trackUrl} from './helpers/fake-soundcloud.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

// Scenario gate row: a slow HLS batch does not hold a quick one scheduled after it.
// Library 1.23.0 ran one batch at a time on a downstream integration: a song on a
// slow CDN kept every link added after it waiting.

const m4a = {kind: 'audio', container: 'm4a'} as const
const fast = {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 50} as const
// the pool is capped at ⌊CPUs/2⌋ (1 on a 3-core CI runner): with one slot the slow song holds it, as it should
const oneSlot = clampConcurrency(2) < 2 && 'one job slot on this machine: nothing can finish first'

let root: string
let bins: FakeBinaries

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-hls-batches-'))
  bins = await writeFakes(path.join(root, 'bin'))
})

after(async () => {
  await fs.rm(root, {recursive: true, force: true})
})

function soundcloudEngine(site: Awaited<ReturnType<typeof startFakeSoundcloud>>, name: string): MediaDownloader {
  return new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    concurrency: 2,
    maxRetries: 1,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: false,
    instagram: false,
    facebook: false,
    x: false,
    vk: false,
    snapchat: false,
    threads: false,
    bluesky: false,
    twitch: false,
    soundcloud: {
      endpoints: {api: site.api, web: site.origin, short: `${site.origin}/short`, assetHost: `${site.origin}/assets`},
      pacing: fast,
    },
  })
}

describe('HLS batches share the pool', () => {
  it('a slow HLS batch does not hold a quick one scheduled after it', {timeout: 5_000, skip: oneSlot}, async () => {
    // every segment of the slow song answers 250 ms late (a slow CDN)
    const site = await startFakeSoundcloud({hydrationId: HYDRATION_ID, segmentDelayMs: {'low-only': 250}})
    const engine = soundcloudEngine(site, 'slow-and-quick')
    const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
    try {
      const out = path.join(root, 'slow-and-quick-out')
      const slow = scheduler.schedule({url: trackUrl('low-only'), profile: m4a, outDir: out})
      const quick = scheduler.schedule({url: trackUrl('clear-track'), profile: m4a, outDir: out})
      await scheduler.whenIdle()
      const slowDone = scheduler.batch(slow.id)!
      const quickDone = scheduler.batch(quick.id)!
      assert.equal(slowDone.status, 'completed', JSON.stringify(slowDone.error))
      assert.equal(quickDone.status, 'completed', JSON.stringify(quickDone.error))
      assert.ok(
        quickDone.finishedAt! < slowDone.finishedAt!,
        `the quick batch ended ${quickDone.finishedAt! - slowDone.finishedAt!} ms after the slow one`,
      )
    } finally {
      await scheduler.dispose()
      await engine.dispose()
      await site.close()
    }
  })
})
