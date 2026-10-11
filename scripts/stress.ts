// Stress test of the orchestrator with fake binaries (no network):
//   node --expose-gc --import tsx scripts/stress.ts [jobs]
// Reports event-loop latency, heap growth and peak parallelism.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {monitorEventLoopDelay} from 'node:perf_hooks'
import {MediaDownloader} from '../src/downloader.js'
import type {JobStatus} from '../src/types.js'

const JOBS = Number(process.argv[2] ?? 300)
const gc = (globalThis as {gc?: () => void}).gc
if (!gc) throw new Error('run with --expose-gc')

const FAKE_YTDLP = `#!/bin/sh
for last; do :; done
id=$(basename "$last")
home=""
prev=""
for a in "$@"; do
  case "$prev" in --paths) case "$a" in home:*) home="\${a#home:}";; esac;; esac
  prev="$a"
done
[ "$1" = "--version" ] && { echo 2099.01.01; exit 0; }
echo "__MDC_INFO__{\\"id\\":\\"$id\\",\\"title\\":\\"T $id\\",\\"duration\\":10,\\"extractor\\":\\"Fake\\",\\"formatId\\":\\"140\\",\\"acodec\\":\\"mp4a\\",\\"filesize\\":1000}"
for n in 250 500 750; do echo "__MDC_PROGRESS__{\\"status\\":\\"downloading\\",\\"downloaded\\":$n,\\"total\\":1000,\\"file\\":\\"x\\"}"; done
printf 'fake %s' "$id" > "$home/T $id [$id].m4a"
echo "__MDC_DONE__{\\"filepath\\":\\"$home/T $id [$id].m4a\\"}"
`
const FAKE_FF = '#!/bin/sh\n[ "$1" = "-version" ] && exit 0\nexit 1\n'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-stress-'))
const bin = async (name: string, body: string) => {
  const file = path.join(root, name)
  await fs.writeFile(file, body, {mode: 0o755})
  return file
}
const binaries = {ytDlp: await bin('yt-dlp', FAKE_YTDLP), ffmpeg: await bin('ffmpeg', FAKE_FF), ffprobe: await bin('ffprobe', FAKE_FF)}

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

const started = performance.now()
const outDir = path.join(root, 'out')
for (let i = 0; i < JOBS; i++) {
  dl.add({url: `https://fake.test/v${i}`, profile: {kind: 'audio', container: 'm4a'}, outDir, mediaId: `v${i}`, extractor: 'Fake'})
}
await dl.whenIdle()
const seconds = (performance.now() - started) / 1000
loop.disable()

const completed = dl.jobs().filter(j => j.status === 'completed').length
const files = (await fs.readdir(outDir)).length
gc()
const heapAfter = process.memoryUsage().heapUsed
const ms = (ns: number) => (ns / 1e6).toFixed(1)

console.log(`jobs                 ${JOBS} (${files} files written, ${(JOBS / seconds).toFixed(1)} jobs/s)`)
console.log(`cpus / concurrency   ${MediaDownloader.cpuCount()} / ${dl.concurrency}, peak parallel ${peak}`)
console.log(`events emitted       ${events}`)
console.log(`jobs kept in memory  ${dl.stats.total} (retainFinishedJobs = 50; last ${completed} visible)`)
console.log(`event loop delay     p50 ${ms(loop.percentile(50))} ms · p99 ${ms(loop.percentile(99))} ms · max ${ms(loop.max)} ms`)
console.log(`heap after GC        ${((heapAfter - heapBefore) / 1024).toFixed(0)} KiB growth for ${JOBS} jobs`)

await dl.dispose()
await fs.rm(root, {recursive: true, force: true})
