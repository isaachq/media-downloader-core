// Large-batch benchmark of the scheduler with fake tools (no network):
//   node --expose-gc --import tsx scripts/batch-bench.ts [items]
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {writeFakes} from '../test/helpers/fakes.js'

const ITEMS = Number(process.argv[2] ?? 500)
const gc = (globalThis as {gc?: () => void}).gc
if (!gc) throw new Error('run with --expose-gc')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-batch-bench-'))
const fakes = await writeFakes(path.join(root, 'fakes'))
const dataDir = path.join(root, 'data')
const engine = new MediaDownloader({dataDir, binaries: fakes, validation: 'none', checksums: true, progressIntervalMs: 250})
const scheduler = new BatchScheduler(engine)
await engine.resolveBinaries()

let batchEvents = 0
let batchEventBytes = 0
let jobEvents = 0
scheduler.on('batch', batch => {
  batchEvents++
  batchEventBytes += JSON.stringify(batch).length
})
engine.on('job', () => jobEvents++)

gc()
const heapBefore = process.memoryUsage().heapUsed
const loop = monitorEventLoopDelay({resolution: 1})
loop.enable()
const started = performance.now()
let checkedAt = 0
scheduler.on('batch', batch => {
  if (!checkedAt && batch.status === 'running') checkedAt = performance.now()
})

const batch = scheduler.schedule({url: `https://fake.test/list?n=${ITEMS}`, profile: {kind: 'audio', container: 'm4a'}, outDir: path.join(root, 'out')})
await scheduler.whenIdle()
const total = (performance.now() - started) / 1000
loop.disable()
gc()
const heapAfter = process.memoryUsage().heapUsed
await new Promise(resolve => setTimeout(resolve, 1500)) // let debounced writes land
const files = ['archive.jsonl', 'pending.jsonl', 'schedule.json']
const sizes = await Promise.all(files.map(async f => [f, (await fs.stat(path.join(dataDir, f)).catch(() => ({size: 0}))).size] as const))
const cacheDir = path.join(dataDir, 'cache')
const ms = (ns: number) => (ns / 1e6).toFixed(1)

const done = scheduler.batch(batch.id)!
console.log(`items                ${ITEMS} → ${done.status} (${done.jobs.succeeded} ok)${done.error ? ` [${done.error.code}] ${done.error.message}` : ''}`)
console.log(`time                 preflight ${((checkedAt - started) / 1000).toFixed(1)}s · total ${total.toFixed(1)}s`)
console.log(`batch events         ${batchEvents} (${(batchEventBytes / 1024 / 1024).toFixed(1)} MiB serialized)`)
console.log(`job events           ${jobEvents}`)
console.log(`event loop delay     p50 ${ms(loop.percentile(50))} ms · p99 ${ms(loop.percentile(99))} ms · max ${ms(loop.max)} ms`)
console.log(`heap after GC        ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)} MiB growth`)
console.log(`state files          ${sizes.map(([f, s]) => `${f}=${(s / 1024).toFixed(0)}KiB`).join(' ')}`)
console.log(`cache left           ${(await fs.readdir(cacheDir).catch(() => [])).length} files`)
await scheduler.dispose()
await engine.dispose()
await fs.rm(root, {recursive: true, force: true})
