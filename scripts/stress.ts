// Stress test of the orchestrator with fake binaries (no network):
//   node --expose-gc --import tsx scripts/stress.ts [jobs] [--json]
// Reports event-loop latency, heap growth, main-thread CPU and peak parallelism.
// --json prints one machine-readable line instead (used by scripts/perf.ts).
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import {MediaDownloader} from '../src/downloader.js'
import type {JobStatus} from '../src/types.js'
import {writeFakes} from '../test/helpers/fakes.js'

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const JSON_OUT = process.argv.includes('--json')
const JOBS = Number(positional[0] ?? 300)
const gc = (globalThis as {gc?: () => void}).gc
if (!gc) throw new Error('run with --expose-gc')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-stress-'))
// the tests' fakes: Node scripts run as `node <script>`, so the stress runs on every OS
const binaries = await writeFakes(path.join(root, 'fakes'))

const dl = new MediaDownloader({
  dataDir: path.join(root, 'data'),
  binaries,
  validation: 'none',
  checksums: true,
  progressIntervalMs: 100,
  retainFinishedJobs: 50,
  minFreeSpaceBytes: 0,
})
await dl.resolveBinaries()

gc()
const heapBefore = process.memoryUsage().heapUsed
const loop = monitorEventLoopDelay({resolution: 1})
loop.enable()

const busy: ReadonlySet<JobStatus> = new Set(['downloading', 'processing', 'converting', 'validating', 'finalizing'])
const active = new Set<string>()
let peak = 0
let events = 0
dl.on('job', s => {
  events++
  if (busy.has(s.status)) active.add(s.id)
  else active.delete(s.id)
  peak = Math.max(peak, active.size)
})

const cpuBefore = process.cpuUsage()
const started = performance.now()
const outDir = path.join(root, 'out')
for (let i = 0; i < JOBS; i++) {
  dl.add({url: `https://fake.test/v${i}`, profile: {kind: 'audio', container: 'm4a'}, outDir, mediaId: `v${i}`, extractor: 'Fake'})
}
await dl.whenIdle()
const seconds = (performance.now() - started) / 1000
const cpu = process.cpuUsage(cpuBefore)
loop.disable()

const completed = dl.jobs().filter(j => j.status === 'completed').length
const files = (await fs.readdir(outDir)).length
gc()
const heapAfter = process.memoryUsage().heapUsed
const ms = (ns: number) => (ns / 1e6).toFixed(1)
const cpuMsPerJob = (cpu.user + cpu.system) / 1000 / JOBS

if (JSON_OUT) {
  console.log(
    JSON.stringify({
      jobs: JOBS,
      files,
      seconds,
      jobsPerSec: JOBS / seconds,
      peak,
      events,
      cpuMsPerJob,
      loopP50Ms: loop.percentile(50) / 1e6,
      loopP99Ms: loop.percentile(99) / 1e6,
      loopMaxMs: loop.max / 1e6,
      heapGrowthKiB: (heapAfter - heapBefore) / 1024,
    }),
  )
} else {
  console.log(`jobs                 ${JOBS} (${files} files written, ${(JOBS / seconds).toFixed(1)} jobs/s)`)
  console.log(`cpus / concurrency   ${MediaDownloader.cpuCount()} / ${dl.concurrency}, peak parallel ${peak}`)
  console.log(`events emitted       ${events}`)
  console.log(`jobs kept in memory  ${dl.stats.total} (retainFinishedJobs = 50; last ${completed} visible)`)
  console.log(`event loop delay     p50 ${ms(loop.percentile(50))} ms · p99 ${ms(loop.percentile(99))} ms · max ${ms(loop.max)} ms`)
  console.log(`heap after GC        ${((heapAfter - heapBefore) / 1024).toFixed(0)} KiB growth for ${JOBS} jobs`)
  console.log(`main-thread CPU      ${cpuMsPerJob.toFixed(2)} ms per job`)
}

await dl.dispose()
await fs.rm(root, {recursive: true, force: true})
