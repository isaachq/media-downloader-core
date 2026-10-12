// Performance harness: runs the benchmarks in fresh processes, keeps the medians and compares them
// against a saved baseline (no network: every scenario uses the fake tools).
//
//   npm run perf                          # full suite, 3 runs each, compared with .perf/baseline.json
//   npm run perf -- --quick               # smaller sizes, for a fast loop while changing code
//   npm run perf -- --runs 5 --only stress,archive
//   npm run perf -- --save-baseline       # run and keep the result as the new baseline
//   npm run perf -- --baseline .perf/results/<file>.json   # compare against any earlier result
//   npm run perf -- --fail-on-regression  # exit 1 when a metric is worse than the threshold (default 10%)
//   npm run perf -- profile stress 1000   # CPU profile of one scenario + the hottest functions in src/
//
// Results land in .perf/results/<date>-<commit>.json; profiles in .perf/profiles/ (open them in
// Chrome DevTools → Performance, or https://www.speedscope.app).
import {execFileSync, spawn} from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PERF_DIR = path.join(ROOT, '.perf')
const BASELINE = path.join(PERF_DIR, 'baseline.json')

/** Which way is better for a metric, and whether it is compared at all. */
type Direction = 'lower' | 'higher'
type Scenario = {
  readonly name: string
  readonly script: string
  readonly size: number
  readonly quickSize: number
  readonly metrics: Readonly<Record<string, Direction>>
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'stress',
    script: 'stress.ts',
    size: 1000,
    quickSize: 300,
    metrics: {jobsPerSec: 'higher', cpuMsPerJob: 'lower', loopP99Ms: 'lower', heapGrowthKiB: 'lower'},
  },
  {
    name: 'batch',
    script: 'batch-bench.ts',
    size: 2000,
    quickSize: 300,
    metrics: {
      preflightSec: 'lower',
      totalSec: 'lower',
      cpuMsPerItem: 'lower',
      loopP99Ms: 'lower',
      heapGrowthMiB: 'lower',
      batchEventKiB: 'lower',
    },
  },
  {
    name: 'archive',
    script: 'archive-bench.ts',
    size: 50_000,
    quickSize: 20_000,
    metrics: {loadMs: 'lower', bytesPerEntry: 'lower'},
  },
]

type Sample = Record<string, unknown>
type Summary = {median: number; min: number; max: number}
type ScenarioResult = {size: number; runs: Sample[]; summary: Record<string, Summary>}
type Result = {env: Record<string, unknown>; scenarios: Record<string, ScenarioResult>}

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function sh(command: string, argv: string[]): string {
  try {
    return execFileSync(command, argv, {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()
  } catch {
    return ''
  }
}

async function readText(file: string): Promise<string> {
  return (await fs.readFile(file, 'utf8').catch(() => '')).trim()
}

async function environment(): Promise<Record<string, unknown>> {
  return {
    date: new Date().toISOString(),
    commit: sh('git', ['rev-parse', '--short', 'HEAD']),
    branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: sh('git', ['status', '--porcelain', '--', 'src']) !== '',
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? '?',
    cpus: os.availableParallelism(),
    memGiB: Math.round(os.totalmem() / 2 ** 30),
    governor: (await readText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor')) || undefined,
    powerProfile: sh('powerprofilesctl', ['get']) || undefined,
    loadAvg: os.loadavg().map(n => Number(n.toFixed(2))),
  }
}

/** One benchmark run in a fresh process; resolves with its --json line. */
function runOnce(scenario: Scenario, size: number, extraNodeArgs: string[] = []): Promise<Sample> {
  const script = path.join(ROOT, 'scripts', scenario.script)
  const argv = [...extraNodeArgs, '--expose-gc', '--import', 'tsx', script, String(size), '--json']
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit']})
    let out = ''
    child.stdout.setEncoding('utf8').on('data', chunk => {
      out += chunk
    })
    child.on('error', reject)
    child.on('close', code => {
      const line = out.trim().split('\n').at(-1) ?? ''
      if (code !== 0) return reject(new Error(`${scenario.name} exited with ${code}:\n${out}`))
      try {
        resolve(JSON.parse(line) as Sample)
      } catch {
        reject(new Error(`${scenario.name} printed no JSON result:\n${out}`))
      }
    })
  })
}

function summarize(runs: Sample[]): Record<string, Summary> {
  const summary: Record<string, Summary> = {}
  for (const key of Object.keys(runs[0] ?? {})) {
    const values = runs.map(r => r[key]).filter((v): v is number => typeof v === 'number')
    if (values.length !== runs.length) continue
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
    summary[key] = {median, min: sorted[0]!, max: sorted.at(-1)!}
  }
  return summary
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2))

/** Prints the table; returns the regressions beyond the threshold. */
function report(current: Result, baseline: Result | undefined, threshold: number): string[] {
  const regressions: string[] = []
  for (const scenario of SCENARIOS) {
    const now = current.scenarios[scenario.name]
    if (!now) continue
    const before = baseline?.scenarios[scenario.name]
    const comparable = before?.size === now.size
    console.log(`\n${scenario.name} (size ${now.size}, ${now.runs.length} runs)`)
    console.log(
      `  ${'metric'.padEnd(16)}${'median'.padStart(10)}${'min..max'.padStart(20)}${comparable ? `${'baseline'.padStart(11)}${'Δ'.padStart(9)}` : ''}`,
    )
    for (const [metric, direction] of Object.entries(scenario.metrics)) {
      const s = now.summary[metric]
      if (!s) continue
      let line = `  ${metric.padEnd(16)}${fmt(s.median).padStart(10)}${`${fmt(s.min)}..${fmt(s.max)}`.padStart(20)}`
      const b = comparable ? before.summary[metric] : undefined
      if (b && b.median !== 0) {
        const delta = (s.median - b.median) / Math.abs(b.median)
        const worse = direction === 'lower' ? delta > threshold : delta < -threshold
        const better = direction === 'lower' ? delta < -threshold : delta > threshold
        const mark = worse ? '  ▲ worse' : better ? '  ▼ better' : ''
        line += `${fmt(b.median).padStart(11)}${`${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`.padStart(9)}${mark}`
        if (worse) regressions.push(`${scenario.name}.${metric} ${(delta * 100).toFixed(1)}%`)
      }
      console.log(line)
    }
    if (before && !comparable) console.log(`  (baseline ran size ${before.size}: not compared)`)
  }
  return regressions
}

async function runSuite(): Promise<void> {
  const runs = Number(option('--runs') ?? 3)
  const quick = flag('--quick')
  const only = option('--only')?.split(',')
  const threshold = Number(option('--threshold') ?? 10) / 100
  const baselineFile = option('--baseline') ?? BASELINE
  const env = await environment()

  if (env['governor'] && env['governor'] !== 'performance') {
    console.log(`note: CPU governor is "${env['governor']}" — numbers vary more than with "performance"`)
  }
  const result: Result = {env, scenarios: {}}
  for (const scenario of SCENARIOS) {
    if (only && !only.includes(scenario.name)) continue
    const size = Number(option(`--${scenario.name}-size`) ?? (quick ? scenario.quickSize : scenario.size))
    const samples: Sample[] = []
    for (let i = 1; i <= runs; i++) {
      if (process.stdout.isTTY) process.stdout.write(`\r${scenario.name}: run ${i}/${runs} (size ${size})…   `)
      samples.push(await runOnce(scenario, size))
    }
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K')
    result.scenarios[scenario.name] = {size, runs: samples, summary: summarize(samples)}
  }

  const baseline = await fs
    .readFile(baselineFile, 'utf8')
    .then(text => JSON.parse(text) as Result)
    .catch(() => undefined)
  console.log(
    `${env['cpu']} · ${env['cpus']} CPUs · node ${env['node']} · ${env['commit']}${env['dirty'] ? ' (src modified)' : ''}`,
  )
  if (baseline) {
    const b = baseline.env
    console.log(`baseline: ${path.relative(ROOT, baselineFile)} · ${b['commit']}${b['dirty'] ? ' (src modified)' : ''} · ${b['date']}`)
  } else {
    console.log('no baseline yet: run with --save-baseline to keep this result as one')
  }
  const regressions = report(result, baseline, threshold)

  const resultsDir = path.join(PERF_DIR, 'results')
  await fs.mkdir(resultsDir, {recursive: true})
  const stamp = String(env['date']).replace(/[:.]/g, '-')
  const file = path.join(resultsDir, `${stamp}-${env['commit'] || 'nogit'}${env['dirty'] ? '-dirty' : ''}.json`)
  await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`\nsaved ${path.relative(ROOT, file)}`)
  if (flag('--save-baseline')) {
    await fs.copyFile(file, BASELINE)
    console.log(`baseline → ${path.relative(ROOT, BASELINE)}`)
  }
  if (regressions.length) {
    console.log(`\n${regressions.length} metric(s) worse than ${threshold * 100}%: ${regressions.join(', ')}`)
    if (flag('--fail-on-regression')) process.exitCode = 1
  }
}

type ProfileNode = {id: number; callFrame: {functionName: string; url: string; lineNumber: number}; children?: number[]}
type CpuProfile = {nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]}

/** Self time per function from a .cpuprofile, the project's own code listed apart from the rest. */
function hottest(profile: CpuProfile, top: number): void {
  const byId = new Map(profile.nodes.map(n => [n.id, n]))
  const self = new Map<string, number>()
  let total = 0
  profile.samples.forEach((id, i) => {
    const node = byId.get(id)
    const dt = profile.timeDeltas[i] ?? 0
    total += dt
    if (!node) return
    const {functionName, url, lineNumber} = node.callFrame
    const where = url ? `${url.replace(/^file:\/\//, '').replace(`${ROOT}/`, '')}:${lineNumber + 1}` : ''
    const key = `${functionName || '(anonymous)'}${where ? `  ${where}` : ''}`
    self.set(key, (self.get(key) ?? 0) + dt)
  })
  const rows = [...self].sort((a, b) => b[1] - a[1])
  const print = (title: string, list: [string, number][]) => {
    console.log(`\n${title}`)
    for (const [name, us] of list.slice(0, top)) {
      console.log(`  ${(us / 1000).toFixed(1).padStart(9)} ms ${((us / total) * 100).toFixed(1).padStart(5)}%  ${name}`)
    }
  }
  console.log(`\nsampled ${(total / 1000).toFixed(0)} ms on the main thread`)
  print('hottest overall (self time)', rows)
  print('hottest in src/ (self time)', rows.filter(([name]) => name.includes(' src/')))
}

async function runProfile(): Promise<void> {
  const [, name = 'stress', sizeArg] = args.filter(a => !a.startsWith('--'))
  const scenario = SCENARIOS.find(s => s.name === name)
  if (!scenario) throw new Error(`unknown scenario "${name}" (${SCENARIOS.map(s => s.name).join(', ')})`)
  const size = Number(sizeArg ?? scenario.quickSize)
  const dir = path.join(PERF_DIR, 'profiles', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await fs.mkdir(dir, {recursive: true})
  console.log(`profiling ${name} (size ${size})…`)
  const sample = await runOnce(scenario, size, ['--cpu-prof', '--cpu-prof-dir', dir, '--cpu-prof-interval', '200'])
  console.log(JSON.stringify(sample))
  // one profile per thread; the main thread's is the largest
  const files = await Promise.all(
    (await fs.readdir(dir)).map(async f => ({f, size: (await fs.stat(path.join(dir, f))).size})),
  )
  const main = files.sort((a, b) => b.size - a.size)[0]
  if (!main) throw new Error('no profile written')
  const file = path.join(dir, main.f)
  hottest(JSON.parse(await fs.readFile(file, 'utf8')) as CpuProfile, Number(option('--top') ?? 20))
  console.log(`\nprofile: ${path.relative(ROOT, file)}`)
}

await (args[0] === 'profile' ? runProfile() : runSuite())
