#!/usr/bin/env node
// The library's test lists, named here rather than behind env vars nobody remembers.
//
//   node scripts/run-tests.mjs fast    every suite but the heavy ones: no ffmpeg needed,
//                                      no network; what CI runs on every OS
//   node scripts/run-tests.mjs heavy   the suites that encode real media with ffmpeg
//                                      (and the 26-profile matrix when MDC_MATRIX=1)
//   node scripts/run-tests.mjs list <fast|heavy>   print the files, one per line
//
// Extra arguments go to `tsx --test` as they are (`--test-name-pattern …`, a reporter).
// It launches tsx itself because Windows shells have no `$(…)`.
//
// A new suite lands in `fast` unless it is named below. It belongs here, in HEAVY, when it
// needs ffmpeg for real work or a single test of it takes more than 2 s (see CONTRIBUTING.md).
import {spawn} from 'node:child_process'
import {readdirSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const HEAVY = new Set([
  'characterization.test.ts',
  'conformance-26.test.ts',
  'hls-real.test.ts',
  'integrity.test.ts',
  'matrix.test.ts',
  'resilience.test.ts',
])

const CONCURRENCY = {fast: 4, heavy: 2}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const all = readdirSync(join(root, 'test'))
  .filter(name => name.endsWith('.test.ts'))
  .sort()

function files(mode) {
  if (mode === 'fast') return all.filter(name => !HEAVY.has(name))
  if (mode === 'heavy') return all.filter(name => HEAVY.has(name))
  throw new Error(`unknown test list "${mode}": fast or heavy`)
}

const [mode, ...rest] = process.argv.slice(2)

if (mode === 'list') {
  for (const name of files(rest[0] ?? 'fast')) console.log(`test/${name}`)
} else {
  const list = files(mode ?? 'fast').map(name => `test/${name}`)
  // tsx's own CLI under this Node: no shell, so a pattern with spaces stays one argument
  const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const args = [tsx, '--test', `--test-concurrency=${CONCURRENCY[mode ?? 'fast']}`, ...rest, ...list]
  const child = spawn(process.execPath, args, {cwd: root, stdio: 'inherit'})
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
}
