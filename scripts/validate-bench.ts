// Integrity validation on a real file (needs ffmpeg/ffprobe on PATH):
//   node --import tsx scripts/validate-bench.ts [seconds] [--json]
// Makes a 1080p30 H.264 + AAC clip of that length, then validates it 'full'
// and 'quick' on one decoder thread — what each job gets when the pool is full.
// --json prints one machine-readable line instead (used by scripts/perf.ts).
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {rulesFor} from '../src/core/formats.js'
import {validateFile} from '../src/core/validate.js'

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const JSON_OUT = process.argv.includes('--json')
const SECONDS = Number(positional[0] ?? 60)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-validate-bench-'))
const file = path.join(root, 'clip.mp4')
// testsrc2 moves and has fine detail: the decoder works as on real footage
execFileSync('ffmpeg', [
  ...['-hide_banner', '-v', 'error', '-y'],
  ...['-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${SECONDS}`],
  ...['-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`],
  ...['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '4M', '-g', '60', '-c:a', 'aac', '-b:a', '128k', file],
])

const profile = {kind: 'video', container: 'mp4'} as const
const tool = (command: string) => ({command, args: []})
async function timed(level: 'full' | 'quick'): Promise<number> {
  const started = performance.now()
  const report = await validateFile({
    ffmpeg: tool('ffmpeg'),
    ffprobe: tool('ffprobe'),
    file,
    rules: rulesFor(profile),
    level,
    expectedDuration: SECONDS,
    expectAudio: true,
    threads: 1,
  })
  if (!report.ok) throw new Error(`${level} validation failed: ${JSON.stringify(report.issues)}`)
  return (performance.now() - started) / 1000
}

const fullSec = await timed('full')
const quickSec = await timed('quick')
await fs.rm(root, {recursive: true, force: true})

if (JSON_OUT) {
  console.log(JSON.stringify({seconds: SECONDS, fullSec, fullSpeed: SECONDS / fullSec, quickSec}))
} else {
  console.log(`clip                 ${SECONDS} s of 1080p30 H.264 + AAC`)
  console.log(`full (1 thread)      ${fullSec.toFixed(2)} s · ${(SECONDS / fullSec).toFixed(1)}× real time`)
  console.log(`quick                ${quickSec.toFixed(2)} s`)
}
