// The live recorder at scale on the fake live origin (recorder.md §3: memory flat over the recording):
//
//   node --expose-gc --import tsx scripts/hls-record-bench.ts [--segments 10000] [--bytes 1504] [--quick] [--json]
//
// The fake live origin (test/helpers/fake-hls.ts, startFakeLive) runs in its own process, so heap and
// event-loop numbers are the recorder's alone. Its sliding window (6 segments of 2 s) advances on a
// simulated clock that the recorder's sleep moves (one line over a pipe per wait): 10,000 segments are
// 5.5 hours of stream recorded in seconds. Measured: the live heap after a full GC every 1,000 segments
// (growth from the first sample to the last, and the largest step), event-loop delay p99, requests per
// segment (playlist reloads and segments), wall time. ffmpeg is a stand-in that writes an empty output:
// the bench measures the recording, not the copy.
import {type ChildProcess, spawn} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import * as readline from 'node:readline'
import {fileURLToPath} from 'node:url'
import {recordHls} from '../src/core/hls/index.js'
import {HttpSession} from '../src/sources/http.js'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const QUICK = args.includes('--quick')
const SEGMENTS = Number(flag('segments', QUICK ? '2000' : '10000'))
const BYTES = Math.floor(Number(flag('bytes', '1504')) / 188) * 188
const JSON_OUT = args.includes('--json')
const SELF = fileURLToPath(import.meta.url)
const NOOP_FFMPEG = {
  command: process.execPath,
  args: ['-e', "require('fs').writeFileSync(process.argv[process.argv.length - 1], '')", '--'],
}
const SAMPLE_EVERY = Math.max(100, Math.floor(SEGMENTS / 10))

type Origin = {
  url: string
  advance: (ms: number) => Promise<void>
  counts: () => Promise<{segments: number; playlists: number}>
  quit: () => void
}

function lines(child: ChildProcess, onLine: (line: string) => void): void {
  if (!child.stdout) throw new Error('no stdout')
  readline.createInterface({input: child.stdout}).on('line', onLine)
}

async function serve(): Promise<Origin> {
  const child = spawn(process.execPath, ['--import', 'tsx', SELF, '--serve', '--segments', String(SEGMENTS)], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting: Array<(line: string) => void> = []
  const url = await new Promise<string>((resolve, reject) => {
    child.once('exit', code => reject(new Error(`fake origin exited ${code}`)))
    lines(child, line => {
      if (line.startsWith('URL ')) resolve(line.slice(4))
      else waiting.shift()?.(line)
    })
  })
  const ask = (command: string) =>
    new Promise<string>(resolve => {
      waiting.push(resolve)
      child.stdin?.write(`${command}\n`)
    })
  return {
    url,
    advance: async ms => {
      await ask(`advance ${ms}`)
    },
    counts: async () => {
      const [segments = 0, playlists = 0] = (await ask('count')).split(' ').slice(1).map(Number)
      return {segments, playlists}
    },
    quit: () => child.stdin?.write('quit\n'),
  }
}

const gc = (globalThis as {gc?: () => void}).gc ?? (() => {})
const mib = (b: number) => b / 1024 / 1024

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-hls-record-bench-'))
  const origin = await serve()
  try {
    const samples: Array<{segments: number; heapMiB: number}> = []
    let next = SAMPLE_EVERY
    const loop = monitorEventLoopDelay({resolution: 1})
    loop.enable()
    const started = performance.now()
    let simulated = 0
    const result = await recordHls({
      session: new HttpSession(),
      site: 'Bench',
      playlist: origin.url,
      kind: 'video',
      workDir: path.join(root, 'rec'),
      ffmpeg: NOOP_FFMPEG,
      signal: AbortSignal.timeout(30 * 60_000),
      maxDuration: 24 * 3600,
      now: () => simulated,
      sleep: async ms => {
        simulated += ms
        await origin.advance(ms)
      },
      onProgress: p => {
        const n = p.fragmentIndex ?? 0
        if (n >= next) {
          next += SAMPLE_EVERY
          gc()
          samples.push({segments: n, heapMiB: mib(process.memoryUsage().heapUsed)})
        }
      },
    })
    const seconds = (performance.now() - started) / 1000
    loop.disable()
    const {segments: segmentRequests, playlists} = await origin.counts()
    const first = samples[0]
    const last = samples[samples.length - 1]
    let maxStep = 0
    for (let i = 1; i < samples.length; i++) {
      maxStep = Math.max(maxStep, (samples[i]?.heapMiB ?? 0) - (samples[i - 1]?.heapMiB ?? 0))
    }
    const out = {
      segments: result.segments,
      ended: result.ended,
      recordedHours: result.duration / 3600,
      gaps: result.gaps,
      heapFirstMiB: first?.heapMiB ?? 0,
      heapLastMiB: last?.heapMiB ?? 0,
      heapGrowthMiB: (last?.heapMiB ?? 0) - (first?.heapMiB ?? 0),
      heapMaxStepMiB: maxStep,
      loopP99Ms: loop.percentile(99) / 1e6,
      loopMaxMs: loop.max / 1e6,
      segmentRequestsPerSegment: segmentRequests / result.segments,
      reloadsPerSegment: playlists / result.segments,
      seconds,
      segmentsPerSecond: result.segments / seconds,
      samples,
    }
    if (JSON_OUT) {
      console.log(JSON.stringify(out))
      return
    }
    console.log(
      `HLS record bench: ${out.segments} segments × ${BYTES} B (${out.recordedHours.toFixed(1)} h of stream, ended ${out.ended}, ${out.gaps} gaps)`,
    )
    console.log(
      `  live heap: ${out.heapFirstMiB.toFixed(2)} MiB at ${first?.segments} segments → ${out.heapLastMiB.toFixed(2)} MiB at ${last?.segments}` +
        ` (growth ${out.heapGrowthMiB.toFixed(2)} MiB, largest step ${out.heapMaxStepMiB.toFixed(2)} MiB)`,
    )
    console.log(`  heap samples (MiB): ${samples.map(s => s.heapMiB.toFixed(2)).join(' ')}`)
    console.log(
      `  loop p99 ${out.loopP99Ms.toFixed(1)} ms (max ${out.loopMaxMs.toFixed(0)}) · ${out.segmentRequestsPerSegment.toFixed(3)} segment requests/segment · ` +
        `${out.reloadsPerSegment.toFixed(3)} reloads/segment · ${seconds.toFixed(1)} s (${out.segmentsPerSecond.toFixed(0)} seg/s)`,
    )
  } finally {
    origin.quit()
    await fs.rm(root, {recursive: true, force: true})
  }
}

// ── child role: the fake live origin ─────────────────────────────────────────────────────────────
if (args[0] === '--serve') {
  const {startFakeLive} = await import('../test/helpers/fake-hls.js')
  const fake = await startFakeLive({tracks: {live: {made: 6, window: 6, bytes: BYTES, endAfter: SEGMENTS}}})
  console.log(`URL ${fake.playlistUrl('live')}`)
  readline.createInterface({input: process.stdin}).on('line', line => {
    if (line.startsWith('advance ')) {
      fake.clock.advance(Number(line.slice(8)))
      console.log('OK')
    }
    if (line === 'count') console.log(`COUNT ${fake.segmentRequests('live')} ${fake.count('/l/live/index.m3u8')}`)
    if (line === 'quit') void fake.close().then(() => process.exit(0))
  })
} else {
  await main()
}
