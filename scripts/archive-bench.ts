// Memory of the download archive index:  node --expose-gc --import tsx scripts/archive-bench.ts [entries]
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {DownloadArchive} from '../src/core/archive.js'

const N = Number(process.argv[2] ?? 50_000)
const gc = (globalThis as {gc?: () => void}).gc!
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-archive-bench-'))
const file = path.join(dir, 'archive.jsonl')
const batch: string[] = []
for (let i = 0; i < N; i++) {
  const entry = {
    key: `youtube:vid${String(i).padStart(8, '0')}:audio:m4a:0`,
    extractor: 'Youtube',
    mediaId: `vid${String(i).padStart(8, '0')}`,
    profile: 'audio:m4a:0',
    url: `https://www.youtube.com/watch?v=vid${String(i).padStart(8, '0')}`,
    filepath: `/Users/someone/Music/My Backups/Some Long Playlist Name/${String(i).padStart(3, '0')} - A typical song title (Official Video) [vid${i}].m4a`,
    sizeBytes: 4_000_000 + i,
    title: `A typical song title number ${i} (Official Video)`,
    sha256: 'a'.repeat(64),
    duration: 215,
    completedAt: Date.now(),
  }
  batch.push(JSON.stringify({op: 'put', entry}))
}
await fs.writeFile(file, `${batch.join('\n')}\n`)
batch.length = 0
gc()
const before = process.memoryUsage().heapUsed
const t = performance.now()
const archive = new DownloadArchive(file)
await archive.open()
const loadMs = performance.now() - t
gc()
const after = process.memoryUsage().heapUsed
console.log(`entries ${N}: load ${loadMs.toFixed(0)} ms · heap ${((after - before) / 1024 / 1024).toFixed(1)} MiB (${((after - before) / N).toFixed(0)} B/entry)`)
await archive.close()
await fs.rm(dir, {recursive: true, force: true})
