import {createWriteStream, mkdirSync, type WriteStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {LogEntry} from '../types.js'

const FILE_PATTERN = /^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAY_MS = 86_400_000

const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10)

/**
 * Append-only JSON-lines trace of everything the engine does, one file per
 * UTC day (`trace-2026-10-11.jsonl`), pruned after `retentionDays`.
 *
 * All writers share a single append stream, and each entry is one `write()`
 * of one complete line, so lines from many parallel jobs never interleave.
 * The stream buffers in memory and flushes asynchronously: logging never
 * blocks the event loop. `grep <id>` on these files replays a job, an
 * attempt or a step from start to end.
 */
export class TraceLog {
  #stream: WriteStream | undefined
  #day = ''
  #closed = false

  constructor(
    readonly dir: string,
    private readonly retentionDays = 14,
  ) {}

  write(entry: LogEntry): void {
    if (this.#closed) return
    const day = dayOf(entry.time)
    if (day !== this.#day) this.#rotate(day)
    this.#stream?.write(`${JSON.stringify(entry)}\n`)
  }

  #rotate(day: string): void {
    this.#stream?.end()
    this.#day = day
    // synchronous on purpose, but only once per day (µs): write() stays a plain ordered append
    mkdirSync(this.dir, {recursive: true})
    this.#stream = createWriteStream(path.join(this.dir, `trace-${day}.jsonl`), {flags: 'a'})
    this.#stream.on('error', () => {}) // a full disk must never crash the host; entries are dropped
    void this.#prune()
  }

  async #prune(): Promise<void> {
    const cutoff = Date.now() - this.retentionDays * DAY_MS
    const files = await fs.readdir(this.dir).catch(() => [])
    await Promise.all(
      files.map(file => {
        const day = FILE_PATTERN.exec(file)?.[1]
        return day && Date.parse(day) < cutoff ? fs.rm(path.join(this.dir, file), {force: true}) : undefined
      }),
    )
  }

  /** Flush buffered lines and release the file. */
  async close(): Promise<void> {
    this.#closed = true
    const stream = this.#stream
    this.#stream = undefined
    if (stream) await new Promise<void>(resolve => stream.end(resolve))
  }

  /** Trace files, oldest first. */
  async files(): Promise<string[]> {
    const files = await fs.readdir(this.dir).catch(() => [])
    return files
      .filter(file => FILE_PATTERN.test(file))
      .sort()
      .map(file => path.join(this.dir, file))
  }
}
