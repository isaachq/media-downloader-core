import type {JobId, JobSnapshot, LogEntry} from '../types.js'
import {finishedLine, jobLine, logLine} from './render.js'
import {cursor, type Output, type Style} from './term.js'

const FRAME_MS = 100
const MAX_ROWS = 12

/**
 * Live view of the running jobs.
 *
 * TTY: a region at the bottom repainted at most every 100 ms (one write per
 * frame; memory is one snapshot per running job). Finished jobs and log
 * lines are printed above it permanently, like a scrolling console.
 * Non-TTY (pipes, CI): no repainting — status changes and results only.
 */
export class Dashboard {
  readonly #active = new Map<JobId, JobSnapshot>()
  #queued = 0
  #drawn = 0
  #tick = 0
  #timer: NodeJS.Timeout | undefined
  #dirty = false
  readonly #lastStatus = new Map<JobId, string>()

  constructor(
    private readonly out: Output,
    private readonly style: Style,
    private readonly showDebug = false,
  ) {
    if (out.isTTY) {
      out.write(cursor.hide)
      this.#timer = setInterval(() => this.#frame(), FRAME_MS)
      this.#timer.unref()
    }
  }

  job(snapshot: JobSnapshot): void {
    if (snapshot.outcome !== 'in-progress') {
      this.#active.delete(snapshot.id)
      this.#lastStatus.delete(snapshot.id)
      this.#print(finishedLine(snapshot, this.style, this.out.columns))
      return
    }
    if (snapshot.status === 'queued' && snapshot.attempt === 0) {
      this.#active.delete(snapshot.id)
    } else {
      this.#active.set(snapshot.id, snapshot)
    }
    const fresh = snapshot.status === 'queued' && snapshot.attempt === 0 // just added: the "queued" log says it
    if (!this.out.isTTY && !fresh && this.#lastStatus.get(snapshot.id) !== snapshot.status) {
      this.#lastStatus.set(snapshot.id, snapshot.status)
      this.out.write(`${jobLine(snapshot, this.style, this.out.columns)}\n`)
    }
    this.#dirty = true
  }

  setQueued(count: number): void {
    if (count !== this.#queued) this.#dirty = true
    this.#queued = count
  }

  log(entry: LogEntry): void {
    if (entry.level === 'debug' && !this.showDebug) return
    this.#print(logLine(entry, this.style))
  }

  /** Print a permanent line above the live region. */
  #print(line: string): void {
    if (!this.out.isTTY) {
      this.out.write(`${line}\n`)
      return
    }
    this.out.write(`${this.#erase()}${line}\n`)
    this.#drawn = 0
    this.#dirty = true
  }

  #erase(): string {
    return this.#drawn > 0
      ? `${cursor.up(this.#drawn)}${cursor.column0}${cursor.clearDown}`
      : `${cursor.column0}${cursor.clearDown}`
  }

  #frame(): void {
    this.#tick++
    const animating = [...this.#active.values()].some(job => job.progress.fraction === undefined)
    if (!this.#dirty && !animating) return
    this.#dirty = false
    const rows = [...this.#active.values()]
      .slice(0, MAX_ROWS)
      .map(job => jobLine(job, this.style, this.out.columns, this.#tick))
    const hidden = this.#active.size - rows.length
    if (hidden > 0) rows.push(this.style.dim(`  … ${hidden} more running`))
    if (this.#queued > 0) rows.push(this.style.dark(`  ${this.#queued} queued`))
    this.out.write(`${this.#erase()}${rows.map(row => `${row}\n`).join('')}`)
    this.#drawn = rows.length
  }

  /** Remove the live region and restore the cursor. */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    if (this.out.isTTY) {
      this.out.write(`${this.#erase()}${cursor.show}`)
      this.#drawn = 0
    }
  }
}
