// HLS downloader at VOD scale on the fake origin (design §10):
//
//   node --expose-gc --import tsx scripts/hls-bench.ts [--segments 18000] [--bytes 16384] [--k 3,6] [--quick] [--json]
//
// The fake origin runs in its own process, so heap and event-loop numbers are the downloader's alone.
// Per k: heap growth beyond the parsed list (live: the highest heapUsed after a full GC every 500 ms;
// raw: the highest heapUsed sampled every 50 ms, uncollected garbage included),
// event-loop delay p99 during the download, segment requests per segment, wall time. Then a kill: a
// child process downloads with k = 3 and is killed (no flush, a hard TerminateProcess / SIGKILL) at
// half the segments; this process resumes the same folder and counts the segments requested twice,
// against the bound W + 1 s of segments (W = 2k: the reorder window; 1 s: the state write interval).
// ffmpeg is a stand-in that writes an empty output: the bench measures the download, not the copy.
import {type ChildProcess, spawn} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import * as readline from 'node:readline'
import {fileURLToPath} from 'node:url'
import {asMedia, downloadHls, fetchPlaylist} from '../src/core/hls/index.js'
import {HttpSession} from '../src/sources/http.js'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const QUICK = args.includes('--quick')
const SEGMENTS = Number(flag('segments', QUICK ? '3000' : '18000'))
const BYTES = Number(flag('bytes', '16384'))
const KS = flag('k', '3,6').split(',').map(Number)
const JSON_OUT = args.includes('--json')
const SELF = fileURLToPath(import.meta.url)
const NOOP_FFMPEG = {
  command: process.execPath,
  args: ['-e', "require('fs').writeFileSync(process.argv[process.argv.length - 1], '')", '--'],
}

// ── the bench ────────────────────────────────────────────────────────────────────────────────
type Server = {url: string; count: () => Promise<number>; quit: () => void}

function lines(child: ChildProcess, onLine: (line: string) => void): void {
  if (!child.stdout) throw new Error('no stdout')
  readline.createInterface({input: child.stdout}).on('line', onLine)
}

async function serve(): Promise<Server> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', SELF, '--serve', '--segments', String(SEGMENTS), '--bytes', String(BYTES)],
    {stdio: ['pipe', 'pipe', 'inherit']},
  )
  const waiting: Array<(n: number) => void> = []
  const url = await new Promise<string>((resolve, reject) => {
    child.once('exit', code => reject(new Error(`fake origin exited ${code}`)))
    lines(child, line => {
      if (line.startsWith('URL ')) resolve(line.slice(4))
      if (line.startsWith('COUNT ')) waiting.shift()?.(Number(line.slice(6)))
    })
  })
  return {
    url,
    count: () =>
      new Promise<number>(resolve => {
        waiting.push(resolve)
        child.stdin?.write('count\n')
      }),
    quit: () => child.stdin?.write('quit\n'),
  }
}

const gc = (globalThis as {gc?: () => void}).gc ?? (() => {})
const mib = (b: number) => b / 1024 / 1024

/** One download. With `liveHeap` a full GC runs every 500 ms (which would distort the loop delay). */
async function measure(server: Server, k: number, root: string, liveHeap: boolean) {
  const before = await server.count()
  gc()
  const playlist = asMedia(
    await fetchPlaylist(new HttpSession(), server.url, {site: 'Bench', signal: AbortSignal.timeout(60_000)}),
  )
  gc()
  const heapParsed = process.memoryUsage().heapUsed
  let peak = heapParsed
  let live = heapParsed
  let ticks = 0
  const sampler = setInterval(() => {
    // every 50 ms the raw heap (garbage included); every 500 ms the live heap after a full GC
    if (liveHeap && ++ticks % 10 === 0) {
      gc()
      live = Math.max(live, process.memoryUsage().heapUsed)
    } else peak = Math.max(peak, process.memoryUsage().heapUsed)
  }, 50)
  const loop = monitorEventLoopDelay({resolution: 1})
  loop.enable()
  const started = performance.now()
  const result = await downloadHls({
    session: new HttpSession(),
    site: 'Bench',
    main: {playlist},
    kind: 'video',
    workDir: path.join(root, `k${k}`),
    ffmpeg: NOOP_FFMPEG,
    concurrency: k,
    signal: AbortSignal.timeout(30 * 60_000),
    onProgress: () => {},
  })
  const seconds = (performance.now() - started) / 1000
  loop.disable()
  clearInterval(sampler)
  const requests = (await server.count()) - before
  await fs.rm(path.join(root, `k${k}`), {recursive: true, force: true})
  return {
    k,
    segments: result.segments,
    heapGrowthMiB: mib(live - heapParsed),
    rawPeakGrowthMiB: mib(peak - heapParsed),
    loopP99Ms: loop.percentile(99) / 1e6,
    loopMaxMs: loop.max / 1e6,
    requestsPerSegment: requests / SEGMENTS,
    seconds,
    segmentsPerSecond: SEGMENTS / seconds,
    mibPerSecond: mib(result.bytes) / seconds,
  }
}

async function killAndResume(server: Server, root: string) {
  const k = 3
  const workDir = path.join(root, 'kill')
  const before = await server.count()
  const child = spawn(process.execPath, ['--import', 'tsx', SELF, '--download', server.url, workDir, String(k)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const started = performance.now()
  let appendedAtKill = 0
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve())
    child.once('error', reject)
    lines(child, line => {
      if (!line.startsWith('P ')) return
      const n = Number(line.slice(2))
      if (n >= SEGMENTS / 2 && appendedAtKill === 0) {
        appendedAtKill = n
        child.kill('SIGKILL')
      }
    })
  })
  const firstSeconds = (performance.now() - started) / 1000
  const firstRequests = (await server.count()) - before
  const resumed = await downloadHls({
    session: new HttpSession(),
    site: 'Bench',
    main: {playlist: server.url},
    kind: 'video',
    workDir,
    ffmpeg: NOOP_FFMPEG,
    concurrency: k,
    signal: AbortSignal.timeout(30 * 60_000),
    onProgress: () => {},
  })
  const total = (await server.count()) - before
  await fs.rm(workDir, {recursive: true, force: true})
  const rate = appendedAtKill / firstSeconds
  return {
    k,
    appendedAtKill,
    requestedBeforeKill: firstRequests,
    requestedAgain: total - SEGMENTS,
    bound: Math.ceil(2 * k + rate),
    segmentsPerSecond: rate,
    segments: resumed.segments,
  }
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-hls-bench-'))
  const server = await serve()
  try {
    // the parsed list alone, measured first (a clean heap): what "beyond the parsed list" leaves out
    gc()
    const h0 = process.memoryUsage().heapUsed
    const list = asMedia(
      await fetchPlaylist(new HttpSession(), server.url, {site: 'Bench', signal: AbortSignal.timeout(60_000)}),
    )
    gc()
    const parsedListMiB = mib(process.memoryUsage().heapUsed - h0)
    const listed = list.segments.length
    const runs = []
    for (const k of KS) {
      const loop = await measure(server, k, root, false)
      const heap = await measure(server, k, root, true)
      runs.push({...loop, heapGrowthMiB: heap.heapGrowthMiB})
    }
    const kill = await killAndResume(server, root)
    if (JSON_OUT) {
      console.log(
        JSON.stringify({segments: SEGMENTS, bytes: BYTES, cpus: os.availableParallelism(), parsedListMiB, runs, kill}),
      )
      return
    }
    console.log(
      `HLS bench: ${SEGMENTS} segments × ${BYTES} B (${mib(SEGMENTS * BYTES).toFixed(0)} MiB), ${os.availableParallelism()} CPUs; ` +
        `parsed list of ${listed} segments: ${parsedListMiB.toFixed(1)} MiB`,
    )
    for (const r of runs) {
      console.log(
        `  k=${r.k}: live heap growth ${r.heapGrowthMiB.toFixed(1)} MiB (raw peak ${r.rawPeakGrowthMiB.toFixed(1)}) · ` +
          `loop p99 ${r.loopP99Ms.toFixed(1)} ms (max ${r.loopMaxMs.toFixed(0)}) · ${r.requestsPerSegment.toFixed(3)} requests/segment · ` +
          `${r.seconds.toFixed(1)} s (${r.segmentsPerSecond.toFixed(0)} seg/s, ${r.mibPerSecond.toFixed(1)} MiB/s)`,
      )
    }
    console.log(
      `  kill at ${kill.appendedAtKill}/${SEGMENTS} (k=${kill.k}), resumed: ${kill.requestedAgain} segments requested twice ` +
        `(bound W + 1 s = ${kill.bound}); ${kill.segments} segments in the file`,
    )
  } finally {
    server.quit()
    await fs.rm(root, {recursive: true, force: true})
  }
}

// ── child roles ──────────────────────────────────────────────────────────────────────────────
if (args[0] === '--serve') {
  const {startFakeHls} = await import('../test/helpers/fake-hls.js')
  const bytes = Math.floor(BYTES / 188) * 188
  const fake = await startFakeHls({tracks: {vod: {segments: SEGMENTS, bytes, duration: 2}}})
  console.log(`URL ${fake.playlistUrl('vod')}`)
  readline.createInterface({input: process.stdin}).on('line', line => {
    if (line === 'count') console.log(`COUNT ${fake.segmentRequests('vod')}`)
    if (line === 'quit') void fake.close().then(() => process.exit(0))
  })
} else if (args[0] === '--download') {
  const [, url = '', workDir = '', k = '3'] = args
  let last = 0
  await downloadHls({
    session: new HttpSession(),
    site: 'Bench',
    main: {playlist: url},
    kind: 'video',
    workDir,
    ffmpeg: NOOP_FFMPEG,
    concurrency: Number(k),
    signal: new AbortController().signal,
    onProgress: p => {
      if ((p.fragmentIndex ?? 0) !== last) {
        last = p.fragmentIndex ?? 0
        console.log(`P ${last}`)
      }
    },
  })
  console.log('DONE')
} else {
  await main()
}
