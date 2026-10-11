import {createReadStream, createWriteStream} from 'node:fs'
import type {FileHandle} from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createInterface} from 'node:readline'
import {writeAtomic} from './files.js'

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
  #writes: Promise<void> = Promise.resolve()
  #lines = 0
  #frozen = false
  #compactScheduled = false
  /** Ids put and not deleted — an O(1) live count for the compaction threshold. */
  readonly #liveIds = new Set<string>()

  constructor(
    readonly file: string,
    /** Current live entries, used to compact. */
    private readonly live: () => ReadonlyArray<readonly [id: string, value: T]>,
  ) {}

  put(id: string, value: T): void {
    this.#liveIds.add(id)
    this.#append({op: 'put', id, value})
  }

  delete(id: string): void {
    if (!this.#liveIds.delete(id)) return
    this.#append({op: 'del', id})
  }

  /** Replay the journal: the entries that were pending, in insertion order. */
  async load(): Promise<T[]> {
    const live = new Map<string, T>()
    let lines: AsyncIterable<string>
    try {
      await fs.access(this.file)
      lines = createInterface({
        input: createReadStream(this.file, {encoding: 'utf8'}),
        crlfDelay: Number.POSITIVE_INFINITY,
      })
    } catch {
      return []
    }
    for await (const line of lines) {
      if (!line) continue
      try {
        const record = JSON.parse(line) as JournalRecord<T>
        if (record.op === 'put') live.set(record.id, record.value)
        else live.delete(record.id)
      } catch {
        // torn last line from a crash
      }
    }
    return [...live.values()]
  }

  /**
   * Rewrite the file with only the live entries: streamed to a temp file in
   * slices with event-loop yields (no multi-MB string, no long block), then
   * renamed over the journal atomically.
   */
  compact(): Promise<void> {
    const write = this.#writes.then(async () => {
      if (this.#frozen) return
      await this.#handle?.close()
      this.#handle = undefined
      this.#opening = undefined
      const entries = this.live()
      await fs.mkdir(path.dirname(this.file), {recursive: true})
      const tmp = `${this.file}.${process.pid}.compact`
      const out = createWriteStream(tmp)
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
      await fs.rename(tmp, this.file)
      this.#lines = entries.length
    })
    this.#writes = write.catch(() => {})
    return write
  }

  /**
   * Final flush (and compaction if the journal is over the slack, so every
   * session ends with a minimal file), then ignore every later change: a
   * shutdown keeps the pending set as it was.
   */
  async freeze(): Promise<void> {
    await this.#writes
    if (!this.#frozen && this.#lines > this.#liveIds.size * 2 + 1000) await this.compact()
    this.#frozen = true
    await this.#handle?.close()
    this.#handle = undefined
  }

  #append(record: JournalRecord<T>): void {
    if (this.#frozen) return
    const line = `${JSON.stringify(record)}\n`
    this.#writes = this.#writes
      .then(async () => {
        if (this.#frozen) return
        this.#opening ??= fs.mkdir(path.dirname(this.file), {recursive: true}).then(async () => {
          this.#handle = await fs.open(this.file, 'a')
        })
        await this.#opening
        await this.#handle?.write(line)
        this.#lines++
      })
      .catch(() => {})
      .then(() => {
        // amortized O(1): compact once superseded lines dominate. Scheduled as a
        // LATER link of the chain and not awaited here — awaiting it from inside
        // the chain would deadlock (it queues behind this very link).
        if (this.#frozen || this.#compactScheduled || this.#lines <= this.#liveIds.size * 2 + 1000) return
        this.#compactScheduled = true
        void this.compact().finally(() => {
          this.#compactScheduled = false
        })
      })
  }
}
