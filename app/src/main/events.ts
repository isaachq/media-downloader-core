import type {BatchId, BatchSnapshot, JobId, JobSnapshot, LogEntry, PreflightItem} from 'media-downloader-core'
import type {EventBundle} from '../shared/contract'

const FLUSH_MS = 100
/** Log lines per flush; a burst beyond this is summarized by the newest ones. */
const MAX_LOGS = 200
/** Item updates per flush (a 5,000-item preflight streams them over several flushes). */
const MAX_ITEMS = 500

/**
 * Coalesces engine events into one IPC message per 100 ms. Only the latest
 * snapshot of each job and batch is kept (a job emitting 10 progress
 * updates in a window sends one), so the renderer's work is bounded by what
 * changed, never by how often it changed.
 */
export class EventCoalescer {
  #jobs = new Map<JobId, JobSnapshot>()
  #batches = new Map<BatchId, BatchSnapshot>()
  #items: Array<{batchId: BatchId; item: PreflightItem}> = []
  #logs: LogEntry[] = []
  #timer: NodeJS.Timeout | undefined

  constructor(
    private readonly send: (bundle: EventBundle) => void,
    /** Engine state every bundle carries (cheap to read): when YouTube requests resume after a bot check. */
    private readonly youtubePausedUntil: () => number | undefined = () => undefined,
  ) {}

  job(snapshot: JobSnapshot): void {
    this.#jobs.set(snapshot.id, snapshot)
    this.#schedule()
  }

  batch(snapshot: BatchSnapshot): void {
    this.#batches.set(snapshot.id, snapshot)
    this.#schedule()
  }

  item(batchId: BatchId, item: PreflightItem): void {
    this.#items.push({batchId, item})
    this.#schedule()
  }

  log(entry: LogEntry): void {
    if (entry.level === 'debug') return // the trace file has them; the UI shows what matters
    this.#logs.push(entry)
    if (this.#logs.length > MAX_LOGS) this.#logs.splice(0, this.#logs.length - MAX_LOGS)
    this.#schedule()
  }

  #schedule(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (!this.#jobs.size && !this.#batches.size && !this.#items.length && !this.#logs.length) return
    const items = this.#items.splice(0, MAX_ITEMS)
    this.send({
      jobs: [...this.#jobs.values()],
      batches: [...this.#batches.values()],
      items,
      logs: this.#logs,
      youtubePausedUntil: this.youtubePausedUntil() ?? null,
    })
    this.#jobs.clear()
    this.#batches.clear()
    this.#logs = []
    if (this.#items.length) this.#schedule() // the rest of a big item burst goes in the next flush
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }
}
