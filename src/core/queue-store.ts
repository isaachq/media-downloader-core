import * as fs from 'node:fs/promises'
import type {JobRequest} from '../types.js'
import {writeAtomic} from './files.js'

const NO_REQUESTS: readonly JobRequest[] = Object.freeze([])

type QueueFile = {readonly version: 1; readonly requests: readonly JobRequest[]}

/**
 * Persists the pending queue so it survives a restart or a crash.
 *
 * Saves are debounced: a playlist of 500 items queued at once produces one
 * write, not 500. `freeze()` stops all further writes — used on shutdown so
 * jobs cancelled *because* the app is quitting are not dropped from the file.
 */
export class QueueStore {
  #timer: NodeJS.Timeout | undefined
  #frozen = false
  #writing: Promise<void> = Promise.resolve()

  constructor(
    readonly file: string,
    private readonly snapshot: () => readonly JobRequest[],
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
    const body: QueueFile = {version: 1, requests: this.snapshot()}
    const data = JSON.stringify(body)
    this.#writing = this.#writing.then(() => writeAtomic(this.file, data)).catch(() => {})
    return this.#writing
  }

  /** Final save, then ignore every later change. */
  async freeze(): Promise<void> {
    await this.flush()
    this.#frozen = true
  }

  async load(): Promise<readonly JobRequest[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<QueueFile>
      return Array.isArray(parsed.requests) ? parsed.requests : []
    } catch {
      return NO_REQUESTS // first launch, or an unreadable file
    }
  }
}
