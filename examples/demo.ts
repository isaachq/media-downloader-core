// Manual end-to-end check from the terminal (the real product is the Electron UI).
//
//   npm run demo -- <url>                 list the format choices
//   npm run demo -- <url> <choice #>      download with that choice
//   npm run demo -- <url> <choice #> 1-5  playlist: only entries 1 to 5
//
// Files go to ./.tmp/out, app data to ./.tmp/data.
import * as path from 'node:path'
import {formatBytes, formatRate, type JobSnapshot, MediaDownloader} from '../src/index.js'

const [url, choiceArg, rangeArg] = process.argv.slice(2)
if (!url) throw new Error('usage: npm run demo -- <url> [choice #] [playlist range like 1-5]')

const root = path.resolve('.tmp')
const dl = new MediaDownloader({dataDir: path.join(root, 'data')})
console.log(
  `CPUs: ${MediaDownloader.cpuCount()} → concurrency ${dl.concurrency} (max ${MediaDownloader.maxConcurrency()})`,
)

const bins = await dl.resolveBinaries()
console.log(`yt-dlp ${bins.ytDlpVersion} · ${bins.ytDlp}\nffmpeg ${bins.ffmpeg} · ffprobe ${bins.ffprobe}\n`)

let t = Date.now()
const analysis = await dl.analyze(url)
console.log(`analyzed in ${Date.now() - t} ms`)

if (analysis.kind === 'playlist') {
  console.log(`▤ Playlist "${analysis.title}" — ${analysis.entries.length} entries`)
  for (const e of analysis.entries.slice(0, 10)) console.log(`   ${e.index}. ${e.title}`)
  if (analysis.entries.length > 10) console.log('   …')
} else {
  console.log(`▶ ${analysis.media.title} (${analysis.media.duration ?? '?'} s) — ${analysis.media.extractor}`)
}
for (const [i, c] of analysis.choices.entries()) console.log(`  [${i}] ${c.label}`)
if (choiceArg === undefined) process.exit(0)

const choice = analysis.choices[Number(choiceArg)]
if (!choice) throw new Error(`no choice #${choiceArg}`)
const outDir = path.join(root, 'out')

let indexes: number[] | undefined
if (rangeArg) {
  const [a, b] = rangeArg.split('-').map(Number)
  indexes = Array.from({length: (b ?? a!) - a! + 1}, (_, i) => a! + i)
}

const line = (s: JobSnapshot) => {
  const p = s.progress
  const pct = p.fraction !== undefined ? `${(p.fraction * 100).toFixed(0).padStart(3)}%` : '  … '
  const extra = s.status === 'downloading' && p.speed ? ` ${formatRate(p.speed)}` : ''
  const part = p.totalParts && p.totalParts > 1 ? ` part ${p.part}/${p.totalParts}` : ''
  return `${s.status.padEnd(11)} ${pct}${part}${extra}  ${(s.title ?? s.url).slice(0, 50)}`
}

dl.on('job', s => {
  if (['completed', 'failed', 'skipped', 'cancelled'].includes(s.status)) return
  process.stdout.write(`\r\x1b[K${line(s)}`)
})
dl.on('completed', s => {
  const v = s.validation
  console.log(`\r\x1b[K✓ ${s.status} ${s.filepath}`)
  if (v) {
    console.log(
      `   ${v.container} · ${v.video ? `${v.video.codec} ${v.video.width}x${v.video.height} · ` : ''}` +
        `${v.audio?.codec ?? 'no audio'} · ${v.duration?.toFixed(1)}s (decoded ${v.decodedDuration?.toFixed(1)}s, ` +
        `expected ${v.expectedDuration ?? '?'}) · ${formatBytes(v.sizeBytes)} · validation ${v.level}`,
    )
    if (v.sha256) console.log(`   sha256 ${v.sha256}`)
  }
})
dl.on('failed', s => console.log(`\r\x1b[K✗ ${s.title ?? s.url}: [${s.error?.code}] ${s.error?.message}`))
dl.on('log', (level, message) => console.log(`\r\x1b[K[${level}] ${message}`))

t = Date.now()
if (analysis.kind === 'playlist') dl.addPlaylist(analysis, choice.profile, outDir, indexes ? {indexes} : {})
else dl.addVideo(analysis, choice.profile, outDir)

await dl.whenIdle()
const jobs = dl.jobs()
const count = (status: string) => jobs.filter(j => j.status === status).length
console.log(
  `\ndone in ${((Date.now() - t) / 1000).toFixed(1)} s — ${count('completed')} completed, ` +
    `${count('skipped')} skipped, ${count('failed')} failed`,
)
await dl.dispose()
