// recordHls against the fake live origin (test/helpers/fake-hls.ts, startFakeLive): a sliding window that
// advances on a simulated clock (the recorder's sleep moves it; nothing waits in real time), with a
// stand-in ffmpeg that joins its inputs byte for byte, so every recording is compared with the bytes the
// fake says it must hold. The real ffmpeg finalizing a recording is in hls-real.test.ts (heavy).
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {setImmediate as tick} from 'node:timers/promises'
import type {Executable} from '../src/binaries/executable.js'
import type {DownloadError} from '../src/core/errors.js'
import {type HlsRecordEvent, type HlsRecordOptions, recordHls} from '../src/core/hls/index.js'
import {HttpSession} from '../src/sources/http.js'
import type {JobProgress} from '../src/types.js'
import {type FakeLive, type FakeLiveTrack, LIVE_T0, startFakeLive, writeCopyFfmpeg} from './helpers/fake-hls.js'

const T = {timeout: 5_000}
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-hls-rec-'))
let ffmpeg: Executable
let jobs = 0
const workDir = () => path.join(tmp, `job-${++jobs}`)

const TRACKS: Record<string, FakeLiveTrack> = {
  ends: {made: 6, endAfter: 12},
  ends2: {made: 6, endAfter: 12},
  endsLater: {made: 6, endAfter: 9},
  open: {made: 6},
  open2: {made: 6},
  open3: {made: 6},
  capped: {made: 6},
  gap: {made: 6, endAfter: 30},
  stops: {made: 6, stopAfter: 9},
  gone404: {made: 6, stopAfter: 8, offline404: true},
  never: {made: 6, stopAfter: 6, offline404: true},
  signed: {made: 6, endAfter: 20, signed: {validFor: 7}},
  renumbered: {made: 6, endAfter: 20, signed: {validFor: 7}, renumberOnSign: 5000},
  aes: {made: 6, endAfter: 14, aes: {rotateEvery: 3}},
  ads: {made: 6, endAfter: 16, ads: [{from: 8, to: 11}]},
  missing: {made: 6, endAfter: 10, missing: [7]},
  fmp4: {made: 6, endAfter: 12, format: 'fmp4', discontinuities: [9]},
  stall: {made: 6, endAfter: 10, stallOnce: [7]},
  slow: {made: 4, window: 4, duration: 6, endAfter: 7},
}

let fake: FakeLive
before(async () => {
  ffmpeg = await writeCopyFfmpeg(path.join(tmp, 'bin'))
  fake = await startFakeLive({tracks: TRACKS})
})
after(async () => {
  await fake.close()
  await fs.rm(tmp, {recursive: true, force: true})
})

type Run = {
  readonly events: HlsRecordEvent[]
  readonly progress: JobProgress[]
  readonly sleeps: number[]
}

/** A recording on the fake's clock: each sleep moves the clock by what was asked (+ `extra(n)` on the n-th). */
function recording(name: string, overrides: Partial<HlsRecordOptions> = {}, extra: (n: number) => number = () => 0) {
  const run: Run = {events: [], progress: [], sleeps: []}
  fake.clock.reset()
  const options: HlsRecordOptions = {
    session: new HttpSession(),
    site: 'Fake',
    playlist: fake.playlistUrl(name),
    kind: 'video',
    workDir: workDir(),
    ffmpeg,
    signal: AbortSignal.timeout(4_000),
    onProgress: p => run.progress.push(p),
    onEvent: e => run.events.push(e),
    now: () => LIVE_T0 + fake.clock.now(),
    sleep: async (ms, signal) => {
      if (signal.aborted) return
      run.sleeps.push(ms)
      fake.clock.advance(ms + extra(run.sleeps.length))
      await tick()
    },
    ...overrides,
  }
  return {run, options, result: () => recordHls(options)}
}

const read = (file: string) => fs.readFile(file)

describe('recordHls (fake live origin, simulated clock)', () => {
  it('from the window: every segment the window holds, then each new one once, until ENDLIST', T, async () => {
    const {run, result} = recording('ends')
    const r = await result()
    assert.equal(r.ended, 'endlist')
    assert.equal(r.segments, 12)
    assert.equal(r.duration, 24)
    assert.deepEqual(await read(r.filepath), fake.expected('ends', 0, 12), 'segments 0…11, in order, byte for byte')
    assert.equal(fake.segmentRequests('ends'), 12, 'one request per segment: none asked twice')
    assert.deepEqual([r.gaps, r.lostSegments, r.skippedSegments, r.refreshes], [0, 0, 0, 0])
    assert.ok(
      run.sleeps.every(ms => ms === 2000),
      `a reload every target duration when each brings something: ${run.sleeps}`,
    )
    const last = run.progress.at(-1)
    assert.equal(last?.live, true)
    assert.equal(last?.bytes, r.bytes)
    assert.equal(last?.downloadedBytes, r.bytes)
    assert.equal(last?.fragmentIndex, 12)
    assert.ok((last?.elapsedSec ?? 0) >= 12, 'elapsed seconds on the clock')
    assert.ok(
      run.progress.every(p => p.fraction === undefined && p.eta === undefined && p.totalBytes === undefined),
      'a live job has no fraction, no total, no ETA',
    )
    assert.deepEqual(
      run.events.filter(e => e.type === 'ended'),
      [{type: 'ended', reason: 'endlist'}],
    )
  })

  it('from now: the newest segment of the first read, then what comes after', T, async () => {
    const {result} = recording('ends2', {from: 'now'})
    const r = await result()
    assert.equal(r.ended, 'endlist')
    assert.deepEqual(await read(r.filepath), fake.expected('ends2', 5, 12))
    assert.equal(fake.segmentRequests('ends2'), 7, 'what was before the live edge is never asked')
  })

  it('a reload that brings nothing waits half the target duration (6 s segments)', T, async () => {
    const {run, result} = recording('slow', {}, n => (n === 1 ? -3000 : 0))
    const r = await result()
    assert.equal(r.ended, 'endlist')
    assert.deepEqual(await read(r.filepath), fake.expected('slow', 0, 7))
    // the first wait is cut short by the test (the clock moves 3 s): that reload is empty, the next waits 3 s
    assert.deepEqual(run.sleeps.slice(0, 2), [6000, 3000])
  })

  it('stop: no new segment, what was recorded is finalized and kept', T, async () => {
    const stop = new AbortController()
    const {run, result} = recording('open', {
      stop: stop.signal,
      onProgress: p => {
        run.progress.push(p)
        if ((p.fragmentIndex ?? 0) >= 8) stop.abort()
      },
    })
    const r = await result()
    assert.equal(r.ended, 'stopped')
    assert.equal(r.segments, 8)
    assert.deepEqual(await read(r.filepath), fake.expected('open', 0, 8))
    assert.equal(fake.segmentRequests('open'), 8, 'nothing asked after the stop')
  })

  it('stop while waiting for the next reload wakes the wait and finalizes', T, async () => {
    const stop = new AbortController()
    const {result} = recording('open2', {
      stop: stop.signal,
      sleep: async (_ms, signal) => {
        // the wait never ends on its own: only the stop can wake it
        stop.abort()
        if (signal.aborted) return
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}))
      },
    })
    const r = await result()
    assert.equal(r.ended, 'stopped')
    assert.deepEqual(await read(r.filepath), fake.expected('open2', 0, 6), 'the first window, kept')
  })

  it('a stop before anything was recorded keeps nothing: cancelled', T, async () => {
    const stop = new AbortController()
    stop.abort()
    const {result} = recording('open3', {stop: stop.signal})
    await assert.rejects(result(), (e: DownloadError) => e.code === 'cancelled')
  })

  it('cancel: the recording throws cancelled at once, nothing finalized', T, async () => {
    const cancel = new AbortController()
    const {run, options, result} = recording('open3', {
      signal: cancel.signal,
      onProgress: p => {
        run.progress.push(p)
        if ((p.fragmentIndex ?? 0) >= 3) cancel.abort()
      },
    })
    await assert.rejects(result(), (e: DownloadError) => e.code === 'cancelled')
    const left = await fs.readdir(path.join(options.workDir, 'hls')).catch(() => [])
    assert.ok(!left.some(name => name.startsWith('out.')), `no finished file: ${left}`)
  })

  it('maxDuration: recorded seconds reach the cap and the recording ends there, finalized', T, async () => {
    const {result} = recording('capped', {maxDuration: 10})
    const r = await result()
    assert.equal(r.ended, 'max-duration')
    assert.equal(r.duration, 10)
    assert.deepEqual(await read(r.filepath), fake.expected('capped', 0, 5))
  })

  it('maxDuration also bounds the wall clock: a stream that only brings skipped segments ends', T, async () => {
    const {result} = recording('open3', {maxDuration: 30, skip: segment => segment.sequence >= 106})
    const r = await result()
    assert.equal(r.ended, 'max-duration')
    assert.equal(r.segments, 6, 'the first window')
    assert.ok(r.elapsed >= 30)
  })

  it(
    'a gap: the window moved past segments never seen; counted, dated, a new period, the recording goes on',
    T,
    async () => {
      // the process "freezes" 20 s after its first wait: 10 more segments are made, the window holds 6
      const {run, result} = recording('gap', {}, n => (n === 1 ? 20_000 : 0))
      const r = await result()
      assert.equal(r.ended, 'endlist')
      assert.equal(r.gaps, 1)
      assert.equal(r.lostSegments, 5, 'segments 6…10 left the window unseen')
      const gap = run.events.find(e => e.type === 'gap')
      assert.deepEqual(gap, {type: 'gap', segments: 5, after: 105, at: LIVE_T0 + 11 * 2000})
      const lost = new Set([6, 7, 8, 9, 10])
      assert.deepEqual(
        await read(r.filepath),
        fake.expected('gap', 0, 30, lost),
        'both sides of the gap, nothing twice',
      )
      const args = JSON.parse(await fs.readFile(`${r.filepath}.args.json`, 'utf8')) as string[]
      assert.ok(args.includes('concat'), 'two periods joined by the concat demuxer (contiguous timestamps)')
    },
  )

  it('going offline: the window stops growing; after N empty reloads the recording ends, finalized', T, async () => {
    const {run, result} = recording('stops', {emptyReloads: 4})
    const r = await result()
    assert.equal(r.ended, 'offline')
    assert.deepEqual(await read(r.filepath), fake.expected('stops', 0, 9))
    assert.deepEqual(run.sleeps.slice(-3), [1000, 1000, 1000], 'empty reloads come at half the target duration')
  })

  it('going offline: a playlist that answers 404 ends it the same way', T, async () => {
    const {result} = recording('gone404', {emptyReloads: 3})
    const r = await result()
    assert.equal(r.ended, 'offline')
    assert.deepEqual(await read(r.filepath), fake.expected('gone404', 0, 7))
  })

  it('offline before anything was recorded: unavailable', T, async () => {
    const {result} = recording('never', {emptyReloads: 2})
    await assert.rejects(result(), (e: DownloadError) => {
      assert.equal(e.code, 'unavailable')
      assert.match(e.message, /offline before anything was recorded/)
      return true
    })
  })

  it('a 403: refreshUrl re-signs the playlist and the recording goes on without a gap', T, async () => {
    const asked: number[] = []
    const {run, result} = recording('signed', {
      refreshUrl: async why => {
        asked.push(why.status)
        return fake.signedUrl('signed')
      },
    })
    const r = await result()
    assert.equal(r.ended, 'endlist')
    assert.ok(r.refreshes >= 2, `refreshed ${r.refreshes} times`)
    assert.ok(asked.every(status => status === 403))
    assert.equal(r.gaps, 0)
    assert.deepEqual(await read(r.filepath), fake.expected('signed', 0, 20))
    assert.ok(run.events.some(e => e.type === 'refreshed'))
  })

  it(
    'a refresh that starts a new session (numbering elsewhere): re-anchored by date, no gap, nothing twice',
    T,
    async () => {
      const {run, result} = recording('renumbered', {refreshUrl: async () => fake.signedUrl('renumbered')})
      const r = await result()
      assert.equal(r.gaps, 0)
      assert.ok(run.events.some(e => e.type === 'rebased'))
      assert.deepEqual(await read(r.filepath), fake.expected('renumbered', 0, 20))
    },
  )

  it('a 403 with no way to re-sign ends the recording as refused, finalized', T, async () => {
    const {result} = recording('signed')
    const r = await result()
    assert.equal(r.ended, 'refused')
    assert.ok(r.segments > 0)
  })

  it('a refresh that says the stream is over ends it as offline', T, async () => {
    const {result} = recording('signed', {refreshUrl: async () => undefined})
    const r = await result()
    assert.equal(r.ended, 'offline')
  })

  it('AES-128 with key rotation: each key fetched once, every segment decrypted with its sequence IV', T, async () => {
    const {result} = recording('aes')
    const r = await result()
    assert.deepEqual(await read(r.filepath), fake.expected('aes', 0, 14))
    for (const k of [0, 1, 2, 3, 4]) assert.equal(fake.count(`/l/aes/key${k}.bin`), 1, `key ${k} once`)
  })

  it(
    'skip: segments the caller refuses are left out, their seconds counted, a new period where they were',
    T,
    async () => {
      const {run, result} = recording('ads', {skip: segment => segment.title !== 'live'})
      const r = await result()
      assert.equal(r.skippedSegments, 3)
      assert.equal(r.skippedSeconds, 6)
      assert.equal(r.gaps, 0)
      assert.deepEqual(await read(r.filepath), fake.expected('ads', 0, 16, new Set([8, 9, 10])))
      assert.equal(fake.count('/l/ads/s9.ts'), 0, 'a skipped segment is never asked')
      assert.equal(run.events.filter(e => e.type === 'segment-skipped').length, 3)
    },
  )

  it('a segment that keeps answering 404 is lost (a gap), never fails the recording', T, async () => {
    const {run, result} = recording('missing')
    const r = await result()
    assert.equal(r.ended, 'endlist')
    assert.equal(r.gaps, 1)
    assert.deepEqual(await read(r.filepath), fake.expected('missing', 0, 10, new Set([7])))
    assert.ok(run.events.some(e => e.type === 'segment-lost' && e.sequence === 107))
    assert.equal(fake.count('/l/missing/s7.ts'), 3, 'asked, then retried twice')
  })

  it(
    'a segment that stalls is dropped after stallMs and asked again: no gap (the window would not wait a minute)',
    T,
    async () => {
      const {run, result} = recording('stall', {stallMs: 200})
      const r = await result()
      assert.equal(r.gaps, 0)
      assert.deepEqual(await read(r.filepath), fake.expected('stall', 0, 10))
      assert.equal(fake.count('/l/stall/s7.ts'), 2, 'the stalled request, then the one that came whole')
      assert.ok(!run.events.some(e => e.type === 'segment-lost'))
    },
  )

  it('fMP4 with a discontinuity: each period starts with its own init segment', T, async () => {
    const {result} = recording('fmp4')
    const r = await result()
    assert.deepEqual(await read(r.filepath), fake.expected('fmp4', 0, 12))
    assert.equal(fake.count('/l/fmp4/init0.mp4'), 1)
    assert.equal(fake.count('/l/fmp4/init1.mp4'), 1)
  })
})
