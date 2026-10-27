// downloadHls against the fake origin (test/helpers/fake-hls.ts) with a stand-in ffmpeg that joins its
// inputs byte for byte: every assembled file is compared with the bytes the fake says it must hold.
// No network, no real ffmpeg (the real -c copy is in hls-real.test.ts, a heavy suite).
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import type {Executable} from '../src/binaries/executable.js'
import type {DownloadError} from '../src/core/errors.js'
import {
  asMedia,
  downloadHls,
  fetchPlaylist,
  type HlsDownloadOptions,
  HlsError,
  type HlsEvent,
} from '../src/core/hls/index.js'
import {HttpSession} from '../src/sources/http.js'
import type {JobProgress} from '../src/types.js'
import {type FakeHls, type FakeTrack, startFakeHls, writeCopyFfmpeg} from './helpers/fake-hls.js'

const T = {timeout: 5_000}
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-hls-dl-'))
let ffmpeg: Executable
let jobs = 0
const workDir = () => path.join(tmp, `job-${++jobs}`)

const TRACKS: Record<string, FakeTrack> = {
  vod: {segments: 30},
  big: {segments: 150, bytes: 188 * 4},
  fmp4: {segments: 6, format: 'fmp4'},
  periods: {segments: 9, format: 'fmp4', discontinuities: [3, 6]},
  sameinit: {segments: 6, format: 'fmp4', discontinuities: [3], sameInit: true},
  tsperiods: {segments: 6, discontinuities: [2]},
  aes: {segments: 9, aes: {rotateEvery: 4}},
  aestag: {segments: 5, aes: {ivInTag: true}, mediaSequence: 77},
  ranges: {segments: 8, byteRange: true},
  muted: {segments: 6, muted: [2, 3]},
  signed: {segments: 20, signed: {validFor: 6}},
  flaky: {segments: 6, faults: {1: 'flaky', 2: 'missing-once', 3: 'html-once', 4: 'short-once'}},
  stall: {segments: 4, faults: {2: 'stall-once'}},
  missing: {segments: 5, faults: {3: 'missing'}},
  html: {segments: 4, faults: {1: 'html'}},
  gaps: {segments: 6, gaps: [2, 4]},
  live: {segments: 5, ended: false},
  event: {segments: 5, ended: false, playlistType: 'EVENT'},
  eventEnded: {segments: 5, playlistType: 'EVENT'},
  drm: {segments: 3, drm: true},
  wrongType: {segments: 3, contentType: 'text/plain'},
  mp3: {segments: 5, format: 'mp3', bytes: 600},
  video: {segments: 5},
  audio: {segments: 5, bytes: 188 * 2},
  resume: {segments: 40, bytes: 188 * 32},
}

let fake: FakeHls
before(async () => {
  ffmpeg = await writeCopyFfmpeg(path.join(tmp, 'bin'))
  fake = await startFakeHls({tracks: TRACKS})
})
after(async () => {
  await fake.close()
  await fs.rm(tmp, {recursive: true, force: true})
})

type Run = {
  readonly progress: JobProgress[]
  readonly events: HlsEvent[]
  readonly dir: string
}

const options = (
  name: string,
  over: Partial<HlsDownloadOptions> = {},
  run: Run = {progress: [], events: [], dir: workDir()},
): HlsDownloadOptions => ({
  session: new HttpSession(),
  site: 'Test',
  main: {playlist: fake.playlistUrl(name)},
  kind: 'video',
  workDir: run.dir,
  ffmpeg,
  signal: AbortSignal.timeout(4_000),
  sleep: async () => {},
  onProgress: p => run.progress.push(p),
  onEvent: e => run.events.push(e),
  ...over,
})

const fresh = (): Run => ({progress: [], events: [], dir: workDir()})
const argsOf = async (file: string): Promise<string[] | undefined> =>
  JSON.parse(await fs.readFile(`${file}.args.json`, 'utf8').catch(() => 'null')) ?? undefined
/** Byte equality without assert's diff (a diff of two large buffers takes minutes). */
async function sameBytes(file: string, expected: Buffer, label = path.basename(file)): Promise<void> {
  const actual = await fs.readFile(file)
  if (actual.equals(expected)) return
  let at = 0
  while (at < actual.length && actual[at] === expected[at]) at++
  assert.fail(`${label}: ${actual.length} bytes, expected ${expected.length}; first difference at byte ${at}`)
}
const reasonOf = (e: unknown) => (e instanceof HlsError ? e.reason : (e as DownloadError).code)

describe('downloadHls', () => {
  it('downloads a TS VOD in order, each segment once, with progress to the end', T, async () => {
    const run = fresh()
    const result = await downloadHls(options('vod', {concurrency: 3}, run))
    assert.equal(result.container, 'mp4')
    await sameBytes(result.filepath, fake.expected('vod'))
    assert.equal(fake.segmentRequests('vod'), 30, 'each segment requested once')
    assert.equal(result.segments, 30)
    assert.equal(result.duration, 60)
    assert.equal(result.skipped, 0)
    assert.equal(result.bytes, fake.expected('vod').length)
    const last = run.progress.at(-1)
    assert.equal(last?.fragmentIndex, 30)
    assert.equal(last?.fragmentCount, 30)
    assert.equal(last?.fraction, 1)
    assert.equal(last?.part, 1)
    assert.equal(last?.totalParts, 1)
    const fractions = run.progress.map(p => p.fraction ?? 0)
    assert.ok(
      fractions.every((f, i) => i === 0 || f >= (fractions[i - 1] ?? 0)),
      'the fraction never moves backwards',
    )
    const args = (await argsOf(result.filepath)) ?? []
    assert.ok(args.includes('-c') && args.includes('copy'), 'a stream copy')
    assert.ok(args.includes('+faststart'))
    const left = await fs.readdir(path.dirname(result.filepath))
    assert.deepEqual(
      left.filter(f => !f.startsWith('out.')),
      [],
      'period files and state removed',
    )
  })

  it('keeps at most k segments in flight and W on disk', T, async () => {
    const before = fake.maxInFlight()
    const result = await downloadHls(options('big', {concurrency: 2}))
    await sameBytes(result.filepath, fake.expected('big'))
    assert.ok(fake.maxInFlight() <= Math.max(before, 3), `in flight: ${fake.maxInFlight()}`)
    assert.equal(fake.segmentRequests('big'), 150)
  })

  it('hands a single fMP4 period over as it is, without ffmpeg', T, async () => {
    const result = await downloadHls(options('fmp4'))
    assert.equal(result.container, 'mp4')
    await sameBytes(result.filepath, fake.expected('fmp4'))
    assert.equal(await argsOf(result.filepath), undefined, 'no ffmpeg run')
    assert.equal(fake.count('/t/fmp4/init0.mp4'), 1)
  })

  it('writes one file per period, each with its init, and joins them with the concat demuxer', T, async () => {
    for (const name of ['periods', 'sameinit', 'tsperiods']) {
      const run = fresh()
      const result = await downloadHls(options(name, {}, run))
      await sameBytes(result.filepath, fake.expected(name), name)
      const args = (await argsOf(result.filepath)) ?? []
      assert.ok(args.includes('concat'), `${name}: concat demuxer`)
      const assembling = run.events.find(e => e.type === 'assembling')
      assert.equal(assembling?.type === 'assembling' && assembling.periods, name === 'periods' ? 3 : 2)
    }
    assert.equal(fake.count('/t/sameinit/init0.mp4'), 2, 'the repeated map is written into both periods')
  })

  it('decrypts AES-128 with key rotation, IVs from the tag or the sequence, one request per key', T, async () => {
    for (const name of ['aes', 'aestag']) {
      const result = await downloadHls(options(name))
      await sameBytes(result.filepath, fake.expected(name), name)
    }
    assert.equal(fake.count('/t/aes/key0.bin'), 1)
    assert.equal(fake.count('/t/aes/key1.bin'), 1)
    assert.equal(fake.count('/t/aes/key2.bin'), 1)
    assert.equal(fake.count('/t/aestag/key0.bin'), 1)
  })

  it('reads a single-file BYTERANGE playlist with exact progress totals', T, async () => {
    const run = fresh()
    const result = await downloadHls(options('ranges', {}, run))
    await sameBytes(result.filepath, fake.expected('ranges'))
    assert.equal(fake.count('/t/ranges/all.ts'), 8, 'one range request per segment')
    assert.equal(run.progress[0]?.totalBytes, fake.expected('ranges').length, 'Σ BYTERANGE from the start')
  })

  it("follows Twitch's muted parts through mapSegmentUri; without it the 403 fails as expired", T, async () => {
    const result = await downloadHls(
      options('muted', {parse: {mapSegmentUri: u => u.replace(/-unmuted\.ts/, '-muted.ts')}}),
    )
    await sameBytes(result.filepath, fake.expected('muted'))
    assert.equal(fake.count('/t/muted/s2-unmuted.ts'), 0)
    await assert.rejects(downloadHls(options('muted')), (e: unknown) => {
      assert.equal(reasonOf(e), 'refused')
      assert.equal((e as DownloadError).code, 'expired')
      return true
    })
  })

  it('re-signs an expired playlist once per refusal wave, within the budget', T, async () => {
    const run = fresh()
    const sign = async () => {
      const r = await fetch(`${fake.origin}/t/signed/sign`)
      return ((await r.json()) as {url: string}).url
    }
    const result = await downloadHls(
      options('signed', {concurrency: 2, main: {playlist: fake.playlistUrl('signed'), refresh: sign}}, run),
    )
    await sameBytes(result.filepath, fake.expected('signed'))
    assert.ok(result.refreshes >= 3 && result.refreshes <= 5, `refreshes: ${result.refreshes}`)
    assert.equal(run.events.filter(e => e.type === 'refreshed').length, result.refreshes)
    // the budget ends it as expired
    await assert.rejects(
      downloadHls(options('signed', {maxRefreshes: 1, main: {playlist: fake.playlistUrl('signed'), refresh: sign}})),
      (e: unknown) => reasonOf(e) === 'refused',
    )
    // a refresh that answers another playlist
    await assert.rejects(
      downloadHls(
        options('signed', {main: {playlist: fake.playlistUrl('signed'), refresh: async () => fake.playlistUrl('vod')}}),
      ),
      (e: unknown) => reasonOf(e) === 'changed' && (e as DownloadError).code === 'expired',
    )
  })

  it('retries a 500, a 404, an HTML page and a short body, resuming the part with Range', T, async () => {
    const run = fresh()
    const result = await downloadHls(options('flaky', {}, run))
    await sameBytes(result.filepath, fake.expected('flaky'))
    const retried = run.events
      .filter(e => e.type === 'segment-retry')
      .map(e => (e.type === 'segment-retry' ? e.index : -1))
    assert.deepEqual([...retried].sort(), [1, 2, 3, 4])
  })

  it('gives up on a stalled segment after stallMs and fetches it again', T, async () => {
    const result = await downloadHls(options('stall', {stallMs: 150}))
    await sameBytes(result.filepath, fake.expected('stall'))
  })

  it('fails a segment that stays missing as a resumable network error, or skips it when asked', T, async () => {
    const run = fresh()
    await assert.rejects(downloadHls(options('missing', {segmentRetries: 2, concurrency: 1}, run)), (e: unknown) => {
      assert.equal(reasonOf(e), 'missing')
      assert.equal((e as DownloadError).code, 'network', 'network: the engine keeps the folder')
      return true
    })
    const state = await fs.readFile(path.join(run.dir, 'hls', 'state.json'), 'utf8')
    assert.ok(JSON.parse(state).tracks.main.next >= 3, 'the cursor was saved for the next attempt')
    const skipped = await downloadHls(options('missing', {segmentRetries: 1, missingSegments: 'skip'}))
    assert.equal(skipped.skipped, 1)
    await assert.rejects(downloadHls(options('html', {segmentRetries: 1})), (e: unknown) => reasonOf(e) === 'corrupt')
  })

  it('skips EXT-X-GAP segments without requesting them', T, async () => {
    const run = fresh()
    const result = await downloadHls(options('gaps', {}, run))
    await sameBytes(result.filepath, fake.expected('gaps'))
    assert.equal(fake.count('/t/gaps/s2.ts'), 0)
    assert.equal(result.skipped, 2)
    assert.equal(result.duration, 8)
  })

  it('refuses live playlists as live-now before any segment; an EVENT that ended downloads', T, async () => {
    for (const name of ['live', 'event']) {
      await assert.rejects(downloadHls(options(name)), (e: unknown) => {
        assert.equal((e as DownloadError).code, 'unavailable')
        assert.equal((e as DownloadError).hint, 'live-now')
        return true
      })
      assert.equal(fake.segmentRequests(name), 0, `${name}: nothing requested`)
    }
    const result = await downloadHls(options('eventEnded'))
    await sameBytes(result.filepath, fake.expected('eventEnded'))
  })

  it('refuses DRM; accepts a wrong Content-Type and a redirect before the playlist', T, async () => {
    await assert.rejects(downloadHls(options('drm')), (e: unknown) => reasonOf(e) === 'drm')
    const typed = await downloadHls(options('wrongType'))
    await sameBytes(typed.filepath, fake.expected('wrongType'))
    const before = fake.count('/t/vod/s0.ts')
    const redirected = await downloadHls(options('vod', {main: {playlist: fake.redirectUrl('vod')}}))
    await sameBytes(redirected.filepath, fake.expected('vod'))
    assert.equal(fake.count('/t/vod/s0.ts'), before + 1, 'segments resolved against the final url (/deep/…)')
  })

  it('muxes a demuxed audio track as a second input; an audio-only download keeps packed MP3', T, async () => {
    const run = fresh()
    const result = await downloadHls(
      options(
        'video',
        {
          main: {playlist: fake.playlistUrl('video')},
          audio: {playlist: fake.playlistUrl('audio')},
          codecs: ['avc1.64001f', 'mp4a.40.2'],
        },
        run,
      ),
    )
    await sameBytes(result.filepath, Buffer.concat([fake.expected('video'), fake.expected('audio')]))
    const args = (await argsOf(result.filepath)) ?? []
    assert.ok(args.join(' ').includes('-map 0:v:0 -map 1:a:0'))
    assert.ok(args.includes('aac_adtstoasc'), 'ADTS → mp4 when CODECS says mp4a')
    assert.deepEqual([...new Set(run.progress.map(p => p.part))], [1, 2])
    const mp3 = await downloadHls(options('mp3', {kind: 'audio'}))
    assert.equal(mp3.container, 'mp3')
    await sameBytes(mp3.filepath, fake.expected('mp3'))
  })

  it('takes a playlist the Source already parsed without asking for it again', T, async () => {
    const parsed = asMedia(
      await fetchPlaylist(new HttpSession(), fake.playlistUrl('vod'), {
        site: 'Test',
        signal: AbortSignal.timeout(2_000),
      }),
    )
    const before = fake.count('/t/vod/index.m3u8')
    const result = await downloadHls(options('vod', {main: {playlist: parsed}}))
    await sameBytes(result.filepath, fake.expected('vod'))
    assert.equal(fake.count('/t/vod/index.m3u8'), before)
  })

  it('resumes after a cancel at half: the cursor, the waiting segments and the part files are reused', T, async () => {
    const run = fresh()
    const controller = new AbortController()
    await assert.rejects(
      downloadHls(
        options(
          'resume',
          {
            concurrency: 3,
            signal: controller.signal,
            onProgress: p => {
              if ((p.fragmentIndex ?? 0) >= 20) controller.abort()
            },
          },
          run,
        ),
      ),
      (e: unknown) => (e as DownloadError).code === 'cancelled',
    )
    const first = fake.segmentRequests('resume')
    assert.ok(first < 40, `stopped early: ${first}`)
    const again: Run = {progress: [], events: [], dir: run.dir}
    const result = await downloadHls(options('resume', {concurrency: 3}, again))
    await sameBytes(result.filepath, fake.expected('resume'))
    const resumed = again.events.find(e => e.type === 'resumed')
    assert.ok(resumed?.type === 'resumed' && resumed.next >= 20, 'resumed from the cursor')
    const total = fake.segmentRequests('resume')
    assert.ok(total <= 40 + 6, `re-requested ${total - 40} segments (≤ W = 6)`)
  })

  it('truncates a period file that grew past the saved cursor (a crash between writes)', T, async () => {
    const run = fresh()
    const controller = new AbortController()
    await assert.rejects(
      downloadHls(
        options(
          'vod',
          {
            concurrency: 1,
            signal: controller.signal,
            onProgress: p => {
              if ((p.fragmentIndex ?? 0) >= 10) controller.abort()
            },
          },
          run,
        ),
      ),
    )
    await fs.appendFile(path.join(run.dir, 'hls', 'main.p0.ts'), Buffer.alloc(1000, 0xee))
    const result = await downloadHls(options('vod', {}, {progress: [], events: [], dir: run.dir}))
    await sameBytes(result.filepath, fake.expected('vod'))
  })

  it('starts over when the files no longer match the state, or when asked to', T, async () => {
    const run = fresh()
    const controller = new AbortController()
    await assert.rejects(
      downloadHls(
        options(
          'periods',
          {
            concurrency: 1,
            signal: controller.signal,
            onProgress: p => {
              if ((p.fragmentIndex ?? 0) >= 5) controller.abort()
            },
          },
          run,
        ),
      ),
    )
    await fs.rm(path.join(run.dir, 'hls', 'main.p0.mp4'))
    const result = await downloadHls(options('periods', {}, {progress: [], events: [], dir: run.dir}))
    await sameBytes(result.filepath, fake.expected('periods'))
    const again = fresh()
    await fs.mkdir(path.join(again.dir, 'hls'), {recursive: true})
    await fs.writeFile(path.join(again.dir, 'hls', 'main.s0.done'), 'stale')
    const clean = await downloadHls(options('fmp4', {fresh: true}, again))
    await sameBytes(clean.filepath, fake.expected('fmp4'))
  })

  it('reports a failed ffmpeg as a conversion error and a cancel before the start as cancelled', T, async () => {
    const failing: Executable = {
      command: process.execPath,
      args: ['-e', 'process.stderr.write("Invalid data"); process.exit(1)', '--'],
    }
    await assert.rejects(downloadHls(options('tsperiods', {ffmpeg: failing})), (e: unknown) => {
      assert.equal(reasonOf(e), 'assemble')
      assert.equal((e as DownloadError).code, 'conversion')
      return true
    })
    await assert.rejects(
      downloadHls(options('vod', {signal: AbortSignal.abort()})),
      (e: unknown) => (e as DownloadError).code === 'cancelled',
    )
  })
})
