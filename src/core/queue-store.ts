import {createReadStream, createWriteStream} from 'node:fs'
import type {FileHandle} from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createInterface} from 'node:readline'
import {renameRetrying, writeAtomic} from './files.js'

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

  async load(): Promise<readonly T[]> {
    try {
      await this.#writing
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<StoreFile<T>>
      return Array.isArray(parsed.requests) ? parsed.requests : []
    } catch {
      return [] // first launch, or an unreadable file
    }
  }
}

/** Entries serialized per event-loop turn while compacting. */
const COMPACT_SLICE = 500

type JournalRecord<T> =
  | {readonly op: 'put'; readonly id: string; readonly value: T}
  | {readonly op: 'del'; readonly id: string}

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
  #compactScheduled = false
  #compactPromise: Promise<void> | undefined
  #compactSeq = 0
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
    try {
      await fs.access(this.file)
      stream = createReadStream(this.file, {encoding: 'utf8'})
      rl = createInterface({
        input: stream,
        crlfDelay: Number.POSITIVE_INFINITY,
      })
      for await (const line of rl) {
        if (line.length === 0) continue
        try {
          const record = JSON.parse(line) as JournalRecord<T>
          if (record.op === 'put') live.set(record.id, record.value)
          else live.delete(record.id)
        } catch {
          // torn last line from a crash
        }
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

  async #doCompact(): Promise<void> {
    await this.#writePromise
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
    await this.#handle?.close()
    this.#handle = undefined
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
        this.#opening ??= fs.mkdir(path.dirname(this.file), {recursive: true}).then(async () => {
          this.#handle = await fs.open(this.file, 'a')
        })
        await this.#opening
        await this.#handle?.write(chunk)
        this.#lines += count
      } catch {
        // Disk error: handled gracefully
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
