import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {parseCli, parseItems, parseProfile} from '../src/cli/args.js'
import {banner, blockText, bootSequence} from '../src/cli/banner.js'
import {binariesFromEnv, EXIT} from '../src/cli/main.js'
import {defaultDataDir} from '../src/cli/paths.js'
import {jobLine, logLine, progressBar, stepTrack, summary} from '../src/cli/render.js'
import {createStyle, fit, stripAnsi, visibleLength, wantsColor} from '../src/cli/term.js'
import {run} from '../src/core/process.js'
import type {BatchSnapshot, JobSnapshot, LogEntry, PreflightItem} from '../src/types.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const plain = createStyle(false)
const color = createStyle(true)

describe('argument parsing', () => {
  it('parses a full get command into a typed profile', () => {
    const parsed = parseCli([
      'get',
      'https://x.test/v',
      '-f',
      'webm',
      '-q',
      '1080p',
      '-o',
      '/tmp/o',
      '-i',
      '1-3,7',
      '-t',
      '4',
    ])
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.command, {
      name: 'get',
      url: 'https://x.test/v',
      profile: {kind: 'video', container: 'webm', maxHeight: 1080},
      out: '/tmp/o',
      items: [1, 2, 3, 7],
      threads: 4,
      validation: undefined,
      cookies: undefined,
      check: true,
    })
  })

  it('defaults to help and understands global flags', () => {
    const parsed = parseCli([])
    assert.ok(parsed.ok && parsed.command.name === 'help')
    const flags = parseCli(['doctor', '--json', '--no-color', '--data-dir', '/d', '-Q'])
    assert.ok(flags.ok)
    assert.deepEqual(flags.global, {dataDir: '/d', json: true, color: false, quiet: true, verbose: false})
  })

  it('rejects bad input with a message instead of throwing', () => {
    for (const argv of [
      ['frobnicate'],
      ['get'],
      ['get', 'u', '-f', 'avi'],
      ['get', 'u', '-f', 'mp3', '-q', '720'],
      ['get', 'u', '-q', '99999'],
      ['get', 'u', '-i', '5-2'],
      ['get', 'u', '-t', '0'],
      ['get', 'u', '--validation', 'maybe'],
      ['doctor', 'extra'],
      ['logs', 'short'],
      ['get', 'u', '--bogus'],
    ]) {
      const parsed = parseCli(argv)
      assert.equal(parsed.ok, false, argv.join(' '))
    }
  })

  it('parses item ranges and profiles', () => {
    assert.deepEqual(parseItems('3,1-2,2'), [1, 2, 3])
    assert.equal(typeof parseItems('0-1'), 'string')
    assert.deepEqual(parseProfile('m4a', undefined, '192K'), {kind: 'audio', container: 'm4a', quality: '192K'})
    assert.deepEqual(parseProfile('mkv', 'best'), {kind: 'video', container: 'mkv'})
  })

  it('validates MDC_BINARIES', () => {
    assert.equal(binariesFromEnv({}), undefined)
    assert.deepEqual(binariesFromEnv({MDC_BINARIES: '{"ytDlp":{"command":"python3","args":["-m","yt_dlp"]}}'}), {
      ytDlp: {command: 'python3', args: ['-m', 'yt_dlp']},
    })
    assert.equal(typeof binariesFromEnv({MDC_BINARIES: '{"ytDlp": 5}'}), 'string')
    assert.equal(typeof binariesFromEnv({MDC_BINARIES: 'nope'}), 'string')
  })

  it('shares the Electron userData folder by default', () => {
    assert.equal(
      defaultDataDir({}, 'darwin'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Media Download Core'),
    )
    assert.match(defaultDataDir({APPDATA: 'C:\\Users\\me\\AppData\\Roaming'}, 'win32'), /Media Download Core$/)
    assert.equal(defaultDataDir({MDC_DATA_DIR: '/custom'}, 'linux'), path.resolve('/custom'))
  })
})

describe('terminal rendering', () => {
  it('honors NO_COLOR / FORCE_COLOR / TTY', () => {
    assert.equal(wantsColor(true, {}), true)
    assert.equal(wantsColor(false, {}), false)
    assert.equal(wantsColor(true, {NO_COLOR: '1'}), false)
    assert.equal(wantsColor(false, {FORCE_COLOR: '1'}), true)
    assert.equal(wantsColor(true, {}, false), false)
  })

  it('progress bars have an exact visible width', () => {
    for (const fraction of [undefined, 0, 0.33, 1, 1.7]) {
      for (const tick of [0, 5, 99]) assert.equal(visibleLength(progressBar(fraction, 16, color, tick)), 16)
    }
    assert.equal(stripAnsi(progressBar(0.5, 4, color)), '▰▰▱▱')
  })

  it('fits text with an ellipsis', () => {
    assert.equal(fit('abcdef', 4), 'abc…')
    assert.equal(fit('abc', 4), 'abc')
  })

  it('draws the banner within the terminal width, or falls back to one line', () => {
    const big = stripAnsi(banner(color, 100, '1.0.0')).split('\n')
    assert.ok(big.every(line => [...line].length <= 100))
    assert.ok(big.some(line => line.includes('█')))
    const small = stripAnsi(banner(color, 40, '1.0.0'))
    assert.match(small, /MEDIA DOWNLOAD CORE/)
    assert.ok(!small.includes('█'))
    assert.equal(blockText('MDC').length, 6, '5 rows + shadow row')
  })

  it('aligns the boot sequence', () => {
    const lines = stripAnsi(
      bootSequence(plain, [
        {label: 'a', value: 'x'},
        {label: 'long', value: 'yyyy', state: 'warn'},
      ]),
    ).split('\n')
    assert.equal(lines[0]!.indexOf('['), lines[1]!.indexOf('['))
    assert.equal(lines[0]!.lastIndexOf('['), lines[1]!.lastIndexOf('['))
    assert.match(lines[1]!, /WARN/)
  })

  const job = (patch: Partial<JobSnapshot>): JobSnapshot => ({
    id: 'AbCdEfGh12345678AbCdEfGh12345678' as JobSnapshot['id'],
    url: 'https://x.test/v',
    profile: {kind: 'audio', container: 'm4a'},
    status: 'downloading',
    outcome: 'in-progress',
    progress: {fraction: 0.5, speed: 2_000_000, eta: 12},
    steps: [
      {id: 'a', name: 'download', state: 'in-progress'},
      {id: 'b', name: 'convert', state: 'pending'},
      {id: 'c', name: 'validate', state: 'pending'},
      {id: 'd', name: 'finalize', state: 'pending'},
    ],
    attempts: [],
    attempt: 2,
    maxAttempts: 4,
    title: 'A very long title that will certainly not fit in a narrow terminal window',
    createdAt: 0,
    ...patch,
  })

  it('renders job rows that never exceed the terminal width', () => {
    for (const width of [60, 80, 120, 200]) {
      assert.ok(visibleLength(jobLine(job({}), color, width)) <= width, `width ${width}`)
    }
    const row = stripAnsi(jobLine(job({}), color, 160))
    assert.match(row, /AbCdEfGh/)
    assert.match(row, /50%/)
    assert.match(row, /2 MB\/s/)
    assert.match(row, /↻2\/4/)
    assert.equal(stripAnsi(stepTrack(job({}).steps, color)), 'D▸ C· V· F·')
  })

  it('renders log lines with short ids and the summary with the session id', () => {
    const entry: LogEntry = {
      level: 'warn',
      message: 'retrying in 2.0s',
      time: Date.UTC(2026, 0, 1, 12, 0, 0),
      sessionId: 'S'.repeat(32),
      jobId: 'J'.repeat(32) as LogEntry['jobId'] & string,
      attempt: 1,
      maxAttempts: 4,
      step: 'download',
    } as LogEntry
    assert.equal(stripAnsi(logLine(entry, color)), '12:00:00 WARN JJJJJJJJ #1/4 download  retrying in 2.0s')
    const batch = {
      id: 'B'.repeat(32),
      url: 'https://x.test/l',
      profile: {kind: 'audio', container: 'm4a'},
      outDir: '/o',
      status: 'completed-with-errors',
      preflight: {total: 3, checked: 3, ok: 2, unavailable: 1},
      jobs: {total: 2, queued: 0, running: 0, succeeded: 2, failed: 0},
      createdAt: 0,
    } as unknown as BatchSnapshot
    const text = stripAnsi(summary(batch, 5000, 'S'.repeat(32), color))
    assert.match(text, /2 completed/)
    assert.match(text, /1 unavailable/)
    assert.match(text, /mdc logs BBBBBBBB/)
    assert.match(text, /session S{32}/)
  })
})

// End to end: the real CLI entry point, with fake tools injected via MDC_BINARIES.
describe('mdc end to end', () => {
  let root = ''
  let fakes: FakeBinaries
  const bin = path.resolve('src/cli/bin.ts')

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-cli-'))
    fakes = await writeFakes(path.join(root, 'fakes'))
  })
  after(async () => {
    await fs.rm(root, {recursive: true, force: true})
  })

  const mdc = (args: string[], dataDir = path.join(root, 'data')) =>
    run(process.execPath, ['--import', 'tsx', bin, ...args, '--data-dir', dataDir], {
      env: {...process.env, MDC_BINARIES: JSON.stringify(fakes), NO_COLOR: '1'},
      timeoutMs: 60_000,
    })

  const ndjson = (stdout: string) =>
    stdout
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as {type?: string} & Record<string, unknown>)

  it('--version, --help and usage errors', async () => {
    assert.match((await mdc(['--version'])).stdout.trim(), /^\d+\.\d+\.\d+$/)
    const help = await mdc(['--help', '-Q'])
    assert.equal(help.code, EXIT.ok)
    assert.match(help.stdout, /usage: mdc/)
    const bad = await mdc(['get', 'x', '-f', 'avi'])
    assert.equal(bad.code, EXIT.usage)
    assert.match(bad.stderr, /unknown format/)
  })

  it('doctor reports a ready system as JSON', async () => {
    const result = await mdc(['doctor', '--json'])
    assert.equal(result.code, EXIT.ok, result.stderr)
    const report = JSON.parse(result.stdout) as {
      ready: boolean
      tools: Array<{name: string; state: string; version: string}>
    }
    assert.equal(report.ready, true)
    assert.deepEqual(
      report.tools.map(t => [t.name, t.state]),
      [
        ['yt-dlp', 'ok'],
        ['ffmpeg', 'ok'],
        ['ffprobe', 'ok'],
      ],
    )
  })

  it('doctor exits 3 when the data folder is unusable', async () => {
    const file = path.join(root, 'not-a-folder')
    await fs.writeFile(file, '')
    const result = await mdc(['doctor', '--json'], path.join(file, 'data'))
    assert.equal(result.code, EXIT.notReady)
  })

  it('get downloads a playlist subset, streams NDJSON and exits 0', async () => {
    const out = path.join(root, 'out')
    const result = await mdc([
      'get',
      'https://fake.test/list',
      '-f',
      'm4a',
      '-i',
      '1,3',
      '-o',
      out,
      '--validation',
      'none',
      '--json',
    ])
    assert.equal(result.code, EXIT.ok, result.stderr)
    const events = ndjson(result.stdout)
    const finals = events.filter(e => e.type === 'job' && e['outcome'] === 'success')
    assert.equal(new Set(finals.map(e => e['id'])).size, 2)
    assert.ok(events.some(e => e.type === 'log'))
    assert.equal(events.at(-1)?.type, 'summary')
    const files = await fs.readdir(path.join(out, 'Fake List'))
    assert.deepEqual(files.sort(), ['001 - Title e1 [e1].m4a', '003 - Title e3 [e3].m4a'])
  })

  it('get exits 1 when some items fail, and logs replays the whole batch by its id', async () => {
    const result = await mdc([
      'get',
      'https://fake.test/list-mixed',
      '-f',
      'm4a',
      '-o',
      path.join(root, 'o2'),
      '--validation',
      'none',
      '--json',
    ])
    assert.equal(result.code, EXIT.failures)
    const events = ndjson(result.stdout)
    const summaryEvent = events.at(-1)!
    assert.equal(summaryEvent.type, 'summary')
    assert.equal(summaryEvent['status'], 'completed-with-errors')
    const batchId = String(summaryEvent['batchId'])
    assert.match(batchId, /^[A-Za-z0-9]{32}$/)
    const bad = events.find(e => e.type === 'item' && e['state'] === 'unavailable') as unknown as PreflightItem
    assert.equal(bad?.error?.hint, 'removed')
    assert.ok(
      events.filter(e => e.type === 'batch').every(e => !('items' in e)),
      'batch events stay small',
    )

    const logs = await mdc(['logs', batchId.slice(0, 10)])
    assert.equal(logs.code, EXIT.ok)
    assert.match(logs.stdout, /batch scheduled: https:\/\/fake\.test\/list-mixed/)
    assert.match(logs.stdout, /preflight: 3\/4 downloadable, 1 unavailable/)
    assert.match(logs.stdout, /finished: completed/)
    assert.match(logs.stdout, /batch closed: completed-with-errors — 3\/4 succeeded/)
  })

  it('get on a single unavailable url exits 1 with the reason', async () => {
    const result = await mdc(['get', 'https://fake.test/unavailable9', '-f', 'm4a', '-o', path.join(root, 'o4')])
    assert.equal(result.code, EXIT.failures)
    assert.match(result.stdout, /FAILED/)
    assert.match(result.stdout, /\[unavailable\]/)
  })

  it('renders the human dashboard without a TTY (plain lines)', async () => {
    const result = await mdc([
      'get',
      'https://fake.test/plain1',
      '-f',
      'm4a',
      '-o',
      path.join(root, 'o3'),
      '--validation',
      'none',
    ])
    assert.equal(result.code, EXIT.ok, result.stderr)
    assert.match(result.stdout, /MEDIA DOWNLOAD CORE|█/)
    assert.match(result.stdout, /\[ 0x01 \] session/)
    assert.match(result.stdout, /✓ \S{8} Title plain1/)
    assert.match(result.stdout, /1 completed/)
    assert.ok(!result.stdout.includes('\x1b['), 'no ANSI codes with NO_COLOR')
  })
})
