import {createReadStream, createWriteStream} from 'node:fs'
import type {FileHandle} from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createInterface} from 'node:readline'
import {endsMidLine, quarantine, removeLeftovers, renameRetrying, syncFile, writeAtomic} from './files.js'

type StoreFile<T> = {readonly version: 1; readonly requests: readonly T[]}

/**
 * Persists a list of pending requests (jobs, batches) so it survives a
 * restart or a crash.
 *
 * Saves are debounced: a playlist of 500 items queued at once produces one
 * write, not 500. `freeze()` stops all further writes — used on shutdown so
 * jobs cancelled *because* the app is quitting are not dropped from the file.
 */
export class QueueStore<T> {
  #timer: NodeJS.Timeout | undefined
  #frozen = false
  #writing: Promise<void> = Promise.resolve()

  constructor(
    readonly file: string,
    private readonly snapshot: () => readonly T[],
    private readonly debounceMs = 1000,
  ) {}

  /** Schedule a save of the current pending requests. */
  touch(): void {
    if (this.#frozen || this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.flush()
    }, this.debounceMs)
    this.#timer.unref()
  }

  /** Write now (and wait for any write in flight). */
  flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#frozen) return this.#writing
    const body: StoreFile<T> = {version: 1, requests: this.snapshot()}
    const data = JSON.stringify(body)
    this.#writing = this.#writing.then(() => writeAtomic(this.file, data)).catch(() => {})
    return this.#writing
  }

  /** Final save, then ignore every later change. */
  async freeze(): Promise<void> {
    await this.flush()
    this.#frozen = true
  }

  /**
   * The saved requests. A file that can't be read back (cut short, of
   * another shape) is moved aside (`<file>.corrupt-<time>`), not overwritten
   * by the next save: nothing pending is restored from it, and it is kept.
   */
  async load(): Promise<readonly T[]> {
    await this.#writing
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch {
      return [] // first launch
    }
    try {
      const parsed = JSON.parse(text) as Partial<StoreFile<T>> | null
      if (parsed && Array.isArray(parsed.requests)) return parsed.requests
    } catch {
      // unreadable: kept aside below
    }
    await quarantine(this.file)
    return []
  }
}

/** Entries serialized per event-loop turn while compacting. */
const COMPACT_SLICE = 500

type JournalRecord<T> =
  | {readonly op: 'put'; readonly id: string; readonly value: T}
  | {readonly op: 'del'; readonly id: string}

/** A journal line read back as a record; undefined for a torn write or a line of another shape. */
export function parseJournalLine<T>(raw: string): JournalRecord<T> | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as {op?: unknown; id?: unknown; value?: unknown}
  if (typeof record.id !== 'string') return undefined
  if (record.op === 'del') return {op: 'del', id: record.id}
  if (record.op === 'put' && record.value !== undefined && record.value !== null) {
    return {op: 'put', id: record.id, value: record.value as T}
  }
  return undefined
}

/**
 * Pending-work journal for large queues: adding or finishing an item appends
 * one short line (O(1)), instead of rewriting the whole pending list on
 * every change (O(n) — gigabytes of writes over a long 5,000-item batch).
 * Replaying the log yields the live set; it is compacted on restore and
 * whenever superseded lines outnumber live ones.
 */
export class PendingJournal<T> {
  #handle: FileHandle | undefined
  #opening: Promise<void> | undefined
  #buffer: string[] = []
  #writing = false
  #writePromise: Promise<void> = Promise.resolve()
  #lines = 0
  #frozen = false
  /** The file ends mid-line (a write cut short): the next chunk starts a new line first. */
  #torn = false
  #compactScheduled = false
  #compactPromise: Promise<void> | undefined
  #compactSeq = 0
  /**
   * One holder of the file at a time: an append (a flushed chunk) or a
   * compaction. Without it a chunk flushed while compacting reopens the old
   * file, and the rename of the compacted one over it drops those lines.
   */
  #lock: Promise<void> = Promise.resolve()
  /** Ids put and not deleted — an O(1) live count for the compaction threshold. */
  readonly #liveIds = new Set<string>()

  constructor(
    readonly file: string,
    /** Current live entries, used to compact. */
    private readonly live: () => ReadonlyArray<readonly [id: string, value: T]>,
  ) {}

  /**
   * Appends an entry in O(1) amortized time by batching into an in-memory buffer.
   */
  put(id: string, value: T): void {
    this.#liveIds.add(id)
    this.#append({op: 'put', id, value})
  }

  /**
   * Removes an entry in O(1) amortized time.
   */
  delete(id: string): void {
    if (!this.#liveIds.delete(id)) return
    this.#append({op: 'del', id})
  }

  /**
   * Replay the journal: the entries that were pending, in insertion order.
   *
   * Time Complexity: O(L) where L is the total journal line count.
   * Space Complexity: O(E) where E is the unique live entries map.
   */
  async load(): Promise<T[]> {
    const live = new Map<string, T>()
    let stream: ReturnType<typeof createReadStream> | undefined
    let rl: ReturnType<typeof createInterface> | undefined
    // a compaction a crash cut short: the journal itself was never replaced
    await removeLeftovers(this.file, '.compact')
    try {
      await fs.access(this.file)
      stream = createReadStream(this.file, {encoding: 'utf8'})
      rl = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
      })
      for await (const line of rl) {
        if (!line.trim()) continue
        const record = parseJournalLine<T>(line)
        if (record?.op === 'put') live.set(record.id, record.value)
        else if (record?.op === 'del') live.delete(record.id)
      }
    } catch {
      return []
    } finally {
      rl?.close()
      stream?.destroy()
    }
    return [...live.values()]
  }

  /**
   * Rewrite the file with only the live entries: streamed to a temp file in
   * slices with event-loop yields (no multi-MB string, no long block), then
   * renamed over the journal atomically.
   *
   * Time Complexity: O(N) where N is number of live entries.
   * Space Complexity: O(COMPACT_SLICE) buffered string chunk in memory.
   */
  compact(): Promise<void> {
    if (this.#compactPromise) return this.#compactPromise
    this.#compactPromise = this.#doCompact().finally(() => {
      this.#compactPromise = undefined
    })
    return this.#compactPromise
  }

  /** Run `fn` once every earlier holder is done; the lock is never left held by a failure. */
  #withLock<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.#lock.then(fn)
    this.#lock = run.then(
      () => {},
      () => {},
    )
    return run
  }

  #doCompact(): Promise<void> {
    return this.#withLock(() => this.#compactLocked())
  }

  async #compactLocked(): Promise<void> {
    if (this.#frozen) return
    await this.#handle?.close()
    this.#handle = undefined
    this.#opening = undefined
    const entries = this.live()
    await fs.mkdir(path.dirname(this.file), {recursive: true})
    const tmp = `${this.file}.${process.pid}.${++this.#compactSeq}.compact`
    const out = createWriteStream(tmp)
    try {
      for (let i = 0; i < entries.length; i += COMPACT_SLICE) {
        let chunk = ''
        for (const [id, value] of entries.slice(i, i + COMPACT_SLICE)) {
          chunk += `${JSON.stringify({op: 'put', id, value} satisfies JournalRecord<T>)}\n`
        }
        if (!out.write(chunk)) await new Promise<void>(resolve => out.once('drain', () => resolve()))
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      )
      // on the disk before it replaces the journal: a power cut leaves one or the other, whole
      await syncFile(tmp)
      await renameRetrying(tmp, this.file)
      this.#lines = entries.length
    } catch (error) {
      out.destroy()
      await fs.rm(tmp, {force: true}).catch(() => {})
      throw error
    }
  }

  /**
   * Final flush (and compaction if the journal is over the slack, so every
   * session ends with a minimal file), then ignore every later change: a
   * shutdown keeps the pending set as it was.
   */
  async freeze(): Promise<void> {
    while (this.#writing || this.#buffer.length > 0) {
      await this.#writePromise
    }
    if (this.#compactPromise) await this.#compactPromise
    if (!this.#frozen && this.#lines > this.#liveIds.size * 2 + 1000) await this.compact()
    this.#frozen = true
    await this.#withLock(async () => {
      await this.#handle?.close()
      this.#handle = undefined
    })
  }

  #append(record: JournalRecord<T>): void {
    if (this.#frozen) return
    this.#buffer.push(`${JSON.stringify(record)}\n`)
    this.#scheduleFlush()
  }

  #scheduleFlush(): void {
    if (this.#writing || this.#buffer.length === 0) return
    this.#writing = true
    this.#writePromise = this.#flushLoop().finally(() => {
      this.#writing = false
      if (this.#buffer.length > 0 && !this.#frozen) {
        this.#scheduleFlush()
      }
    })
  }

  async #flushLoop(): Promise<void> {
    while (this.#buffer.length > 0 && !this.#frozen) {
      const chunk = this.#buffer.join('')
      const count = this.#buffer.length
      this.#buffer = []
      try {
        await this.#withLock(async () => {
          if (this.#frozen) return
          this.#opening ??= fs.mkdir(path.dirname(this.file), {recursive: true}).then(async () => {
            this.#torn = await endsMidLine(this.file)
            this.#handle = await fs.open(this.file, 'a')
          })
          await this.#opening
          try {
            await this.#handle?.write(this.#torn ? `\n${chunk}` : chunk)
          } catch (error) {
            this.#torn = true // part of a line may be on disk
            throw error
          }
          this.#torn = false
          this.#lines += count
        })
      } catch {
        // a disk error loses this chunk, never the engine: the next restore replays what was written
      }
    }

    if (!this.#frozen && !this.#compactScheduled && this.#lines > this.#liveIds.size * 2 + 1000) {
      this.#compactScheduled = true
      void this.compact().finally(() => {
        this.#compactScheduled = false
      })
    }
  }
}
