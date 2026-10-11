import {createReadStream, createWriteStream, mkdirSync, type WriteStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createInterface} from 'node:readline'
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
    this.#stream = undefined
    this.#day = day
    try {
      // synchronous on purpose, but only once per day (µs): write() stays a plain ordered append
      mkdirSync(this.dir, {recursive: true})
    } catch {
      this.#closed = true // unusable folder: tracing turns itself off, the engine carries on
      return
    }
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

/**
 * Every trace entry where a session / batch / job / attempt / step id starts
 * with `id` (a prefix of 6+ chars works), oldest first. Files are streamed
 * line by line with a cheap substring pre-filter before JSON.parse, and
 * `limit` keeps only the last n in a bounded buffer: constant memory for
 * any amount of logs.
 */
export async function searchTrace(
  dir: string,
  id: string,
  opts: {readonly limit?: number | undefined} = {},
): Promise<{readonly entries: LogEntry[]; readonly total: number}> {
  const files = (await fs.readdir(dir).catch(() => [])).filter(file => FILE_PATTERN.test(file)).sort()
  const kept: LogEntry[] = []
  let total = 0
  for (const file of files) {
    const lines = createInterface({
      input: createReadStream(path.join(dir, file), {encoding: 'utf8'}),
      crlfDelay: Number.POSITIVE_INFINITY,
    })
    for await (const raw of lines) {
      if (!raw.includes(id)) continue
      let entry: LogEntry
      try {
        entry = JSON.parse(raw) as LogEntry
      } catch {
        continue
      }
      const ids = [entry.sessionId, entry.batchId, entry.jobId, entry.attemptId, entry.stepId]
      if (!ids.some(value => value?.startsWith(id))) continue
      total++
      kept.push(entry)
      if (opts.limit && kept.length > opts.limit) kept.shift()
    }
  }
  return {entries: kept, total}
}
