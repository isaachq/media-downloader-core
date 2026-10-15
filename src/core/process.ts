import {type ChildProcess, spawn, spawnSync} from 'node:child_process'
import {deferred} from './deferred.js'

const IS_WINDOWS = process.platform === 'win32'
const KILL_GRACE_MS = 1000
/** After the child exited: how long its pipes may stay silent before the result is settled without 'close'. */
const EXIT_DRAIN_MS = 2000

/**
 * Environment for yt-dlp (a Python program): force UTF-8 so paths with
 * accents / CJK / emoji survive the pipe on Windows, whose console code page
 * would otherwise mangle them.
 */
export function utf8Env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...extra}
}

/**
 * Splits a byte stream into lines without re-scanning or re-allocating the
 * whole buffer on every chunk: only the trailing partial line is carried over.
 */
export class LineSplitter {
  #rest = ''

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    let start = 0
    let data = chunk
    if (this.#rest) {
      data = this.#rest + chunk
      this.#rest = ''
    }
    for (let nl = data.indexOf('\n'); nl !== -1; nl = data.indexOf('\n', start)) {
      const end = nl > start && data.charCodeAt(nl - 1) === 13 ? nl - 1 : nl // strip \r of \r\n
      if (end > start) this.onLine(data.slice(start, end))
      start = nl + 1
    }
    if (start < data.length) this.#rest = data.slice(start)
  }

  flush(): void {
    if (this.#rest) this.onLine(this.#rest)
    this.#rest = ''
  }
}

/** Keeps only the last `limit` characters of a stream, with amortized O(1) appends. */
export class TailBuffer {
  #chunks: string[] = []
  #length = 0

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.#chunks.push(chunk)
    this.#length += chunk.length
    // compact only when twice over the limit, so trimming cost is amortized
    if (this.#length > this.limit * 2) {
      const joined = this.#chunks.join('').slice(-this.limit)
      this.#chunks = [joined]
      this.#length = joined.length
    }
  }

  toString(): string {
    const joined = this.#chunks.join('')
    return joined.length > this.limit ? joined.slice(-this.limit) : joined
  }
}

export type RunOptions = {
  readonly signal?: AbortSignal | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly cwd?: string | undefined
  /** Called for every complete stdout line. */
  readonly onStdoutLine?: ((line: string) => void) | undefined
  /** Collect stdout into the result. Disable for line-driven processes. Default true. */
  readonly collectStdout?: boolean | undefined
  /** Fail (as `outputLimitExceeded`) if collected stdout grows beyond this. Default 256 MiB. */
  readonly maxStdoutBytes?: number | undefined
  /** Characters of stderr kept for error reporting. Default 64 KiB. */
  readonly stderrTail?: number | undefined
  /** Kill the process after this long. */
  readonly timeoutMs?: number | undefined
}

export type RunResult = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly aborted: boolean
  readonly timedOut: boolean
  readonly outputLimitExceeded: boolean
}

/** Every child we started and haven't seen exit — killed if the host process exits. */
const live = new Set<ChildProcess>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true

  const killAllSync = () => {
    for (const child of live) {
      const pid = child.pid
      if (pid === undefined || child.exitCode !== null || child.signalCode !== null) continue
      try {
        child.stdin?.destroy()
      } catch {}
      if (IS_WINDOWS) {
        try {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'})
        } catch {}
        try {
          child.kill('SIGKILL')
        } catch {}
      } else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {}
        }
      }
    }
  }

  // 'exit' only: signals belong to the host (the CLI disposes the engine on
  // Ctrl+C and exits itself; Electron has its own quit sequence). A library
  // handler calling process.exit() would cut those short.
  process.once('exit', killAllSync)
}

/**
 * Spawn a binary and wait for it.
 * Time complexity: O(M) where M is stdout/stderr data bytes.
 * Space complexity: O(min(M, maxStdoutBytes) + stderrTail).
 */
export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  if (opts.signal?.aborted) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: '',
      aborted: true,
      timedOut: false,
      outputLimitExceeded: false,
    })
  }
  installExitHook()

  const {promise, resolve, reject} = deferred<RunResult>()
  let child: ChildProcess
  try {
    child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      windowsHide: true,
      // own process group on POSIX, so a cancel reaches the ffmpeg that yt-dlp spawned
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    reject(error)
    return promise
  }
  live.add(child)

  const collect = opts.collectStdout !== false
  const maxStdout = opts.maxStdoutBytes ?? 256 * 1024 * 1024
  const stdoutChunks: string[] = []
  let stdoutLength = 0
  let aborted = false
  let timedOut = false
  let outputLimitExceeded = false
  const stderr = new TailBuffer(opts.stderrTail ?? 64 * 1024)
  const lines = opts.onStdoutLine ? new LineSplitter(opts.onStdoutLine) : undefined

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    lines?.push(chunk)
    if (!collect) return
    stdoutLength += chunk.length
    if (stdoutLength > maxStdout) {
      outputLimitExceeded = true
      killTree(child)
      return
    }
    stdoutChunks.push(chunk)
  })
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk))

  const onAbort = () => {
    aborted = true
    killTree(child)
  }
  opts.signal?.addEventListener('abort', onAbort, {once: true})
  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          killTree(child)
        }, opts.timeoutMs)

  let exitWatchdog: NodeJS.Timeout | undefined
  const cleanup = () => {
    live.delete(child)
    opts.signal?.removeEventListener('abort', onAbort)
    if (timer) clearTimeout(timer)
    if (exitWatchdog) clearTimeout(exitWatchdog)
    if (child.stdout) {
      child.stdout.removeAllListeners()
      child.stdout.destroy()
    }
    if (child.stderr) {
      child.stderr.removeAllListeners()
      child.stderr.destroy()
    }
    if (child.stdin) {
      child.stdin.removeAllListeners()
      child.stdin.destroy()
    }
    child.removeAllListeners()
  }

  let settled = false
  const finish = (code: number | null) => {
    if (settled) return
    settled = true
    cleanup()
    lines?.flush()
    resolve({
      code,
      stdout: collect ? stdoutChunks.join('') : '',
      stderr: stderr.toString(),
      aborted,
      timedOut,
      outputLimitExceeded,
    })
  }

  child.once('error', error => {
    if (settled) return
    settled = true
    cleanup()
    reject(error)
  })

  // Once the child exited, 'close' follows when its pipes are drained. A
  // grandchild that inherited them (ffmpeg under yt-dlp) can hold them open
  // after that, so a watchdog settles with what was read — but only once the
  // pipes went quiet: every chunk that still arrives re-arms it, so a large
  // stdout (a playlist's JSON) read slowly under load is never cut short.
  child.once('exit', code => {
    exitWatchdog = setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.stdin?.destroy()
      finish(code)
    }, EXIT_DRAIN_MS)
    exitWatchdog.unref()
    const rearm = () => exitWatchdog?.refresh()
    child.stdout?.on('data', rearm)
    child.stderr?.on('data', rearm)
  })

  child.once('close', code => {
    finish(code)
  })
  return promise
}

/**
 * Kill a process and all of its descendants in O(1) time. A plain `child.kill()`
 * leaves the ffmpeg that yt-dlp spawned running — on Windows always, on POSIX
 * unless the whole process group is signalled.
 *
 * Time Complexity: O(1) signal dispatch.
 * Space Complexity: O(1) auxiliary space.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return

  try {
    // Close stdin to signal EOF, but preserve stdout/stderr to capture final error diagnostics
    child.stdin?.destroy()
  } catch {
    // Ignore stream destruction errors
  }

  if (IS_WINDOWS) {
    // taskkill /T walks the tree from this pid: the parent must still be alive
    // when it looks, or its children are orphaned (and keep writing their
    // files). So the direct kill is the fallback, once taskkill is done or
    // could not run — never first.
    const direct = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'})
      killer.once('error', direct)
      killer.once('exit', direct)
      killer.unref()
    } catch {
      direct()
    }
    return
  }

  try {
    process.kill(-pid, signal)
  } catch {
    child.kill(signal)
  }
  if (signal === 'SIGKILL') return
  // escalate if it ignores SIGTERM (ffmpeg flushing a write, Python cleanup…)
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS).unref()
}

/** Last `count` non-empty lines — for error details shown in a UI. */
export function lastLines(text: string, count = 8): string {
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
    const line = lines[i]!.trim()
    if (line) out.push(line)
  }
  return out.reverse().join('\n')
}

/** Reads `key=value` lines of `ffmpeg -progress pipe:1` and reports seconds processed. */
export function ffmpegProgressReader(onSeconds: (seconds: number) => void): (line: string) => void {
  return line => {
    if (!line.startsWith('out_time_us=')) return
    const micros = Number(line.slice('out_time_us='.length))
    if (Number.isFinite(micros) && micros >= 0) onSeconds(micros / 1_000_000)
  }
}
