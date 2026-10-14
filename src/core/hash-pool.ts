import {Worker} from 'node:worker_threads'
import {deferred} from './deferred.js'
import {cancelledError} from './errors.js'
import type {Sha256Hex} from './files.js'

// CommonJS source evaluated inside the worker: no extra file to ship or to
// unpack from an Electron asar archive.
const WORKER_SOURCE = `
const {parentPort} = require('node:worker_threads')
const {createHash} = require('node:crypto')
const {createReadStream} = require('node:fs')
parentPort.on('message', ({id, file}) => {
  const hash = createHash('sha256')
  const stream = createReadStream(file, {highWaterMark: 1 << 20})
  stream.on('data', chunk => hash.update(chunk))
  stream.on('error', error => {
    stream.destroy()
    parentPort.postMessage({id, error: error.message})
  })
  stream.on('end', () => {
    stream.destroy()
    parentPort.postMessage({id, digest: hash.digest('hex')})
  })
})
`

type Reply = {id: number; digest?: string; error?: string}

type Task = {
  readonly id: number
  readonly file: string
  readonly resolve: (digest: string) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal | undefined
}

type Slot = {
  readonly worker: Worker
  task?: Task | undefined
  onAbort?: (() => void) | undefined
  idleTimer?: NodeJS.Timeout | undefined
}

/**
 * SHA-256 of large files on worker threads, so hashing a 4 GB video never
 * competes with the event loop that serves the UI.
 *
 * Workers start on demand and exit after `idleMs` without work, so the pool
 * holds no memory while nothing is being hashed. Hashing is I/O-bound, so a
 * small pool (default 2) saturates the disk.
 */
export class HashPool {
  #slots = new Set<Slot>()
  #queue: Task[] = []
  #headIndex = 0
  #nextId = 1
  #closed = false

  constructor(
    private readonly size = 2,
    private readonly idleMs = 30_000,
  ) {}

  /**
   * Dispatches or queues a SHA-256 computation on a worker thread.
   *
   * Time Complexity: O(1) amortized enqueue.
   * Space Complexity: O(1) task structure allocation.
   */
  sha256(file: string, signal?: AbortSignal): Promise<Sha256Hex> {
    if (this.#closed) return Promise.reject(new Error('HashPool is closed.'))
    if (signal?.aborted) return Promise.reject(cancelledError())
    const {promise, resolve, reject} = deferred<Sha256Hex>()
    this.#queue.push({id: this.#nextId++, file, resolve, reject, signal})
    this.#dispatch()
    return promise
  }

  /**
   * Terminate all workers; pending tasks are rejected.
   *
   * Time Complexity: O(T + W) where T is pending tasks and W is active workers.
   * Space Complexity: O(1) auxiliary space.
   */
  async close(): Promise<void> {
    this.#closed = true
    const pending = this.#queue.slice(this.#headIndex)
    this.#queue = []
    this.#headIndex = 0
    for (const task of pending) task.reject(new Error('HashPool closed.'))
    await Promise.all([...this.#slots].map(slot => this.#retire(slot, new Error('HashPool closed.'))))
  }

  get workerCount(): number {
    return this.#slots.size
  }

  /**
   * Dispatches queued tasks to idle or freshly spawned worker slots.
   *
   * Time Complexity: O(1) amortized per task dispatch (avoids O(N) array shifts).
   * Space Complexity: O(1) auxiliary space.
   */
  #dispatch(): void {
    while (this.#headIndex < this.#queue.length) {
      const task = this.#queue[this.#headIndex]!
      if (task.signal?.aborted) {
        this.#headIndex++
        this.#compactQueueIfNeeded()
        task.reject(cancelledError())
        continue
      }
      const slot = this.#idleSlot() ?? (this.#slots.size < this.size ? this.#spawn() : undefined)
      if (!slot) return
      this.#headIndex++
      this.#compactQueueIfNeeded()
      this.#start(slot, task)
    }
  }

  #compactQueueIfNeeded(): void {
    if (this.#headIndex > 64 && this.#headIndex * 2 >= this.#queue.length) {
      this.#queue = this.#queue.slice(this.#headIndex)
      this.#headIndex = 0
    }
  }

  #idleSlot(): Slot | undefined {
    for (const slot of this.#slots) if (!slot.task) return slot
    return undefined
  }

  #spawn(): Slot {
    const worker = new Worker(WORKER_SOURCE, {eval: true})
    const slot: Slot = {worker}
    worker.on('message', (reply: Reply) => this.#settle(slot, reply))
    worker.on('error', error => void this.#retire(slot, error))
    worker.on('exit', () => {
      if (this.#slots.delete(slot)) {
        if (slot.idleTimer) clearTimeout(slot.idleTimer)
        slot.idleTimer = undefined
        const task = slot.task
        this.#release(slot)
        if (task) task.reject(new Error('Hash worker exited unexpectedly.'))
        if (!this.#closed) this.#dispatch()
      }
    })
    // idle workers never keep the host alive (set after the listeners, which re-ref the channel)
    worker.unref()
    this.#slots.add(slot)
    return slot
  }

  #start(slot: Slot, task: Task): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    slot.idleTimer = undefined
    slot.task = task
    slot.worker.ref() // busy: the process must wait for this result
    if (task.signal) {
      // a running hash can't be interrupted from outside, so abort = discard the worker
      slot.onAbort = () => void this.#retire(slot, cancelledError())
      task.signal.addEventListener('abort', slot.onAbort, {once: true})
    }
    slot.worker.postMessage({id: task.id, file: task.file})
  }

  #settle(slot: Slot, reply: Reply): void {
    const task = slot.task
    if (!task || task.id !== reply.id) return
    this.#release(slot)
    if (reply.digest) task.resolve(reply.digest)
    else task.reject(new Error(reply.error ?? 'Hashing failed.'))
    slot.idleTimer = setTimeout(() => void this.#retire(slot), this.idleMs)
    slot.idleTimer.unref()
    this.#dispatch()
  }

  /** Detach the slot's current task and its abort listener. */
  #release(slot: Slot): void {
    if (slot.task?.signal && slot.onAbort) slot.task.signal.removeEventListener('abort', slot.onAbort)
    slot.worker.unref() // idle again
    slot.task = undefined
    slot.onAbort = undefined
  }

  async #retire(slot: Slot, error?: Error): Promise<void> {
    if (!this.#slots.delete(slot)) return
    if (slot.idleTimer) clearTimeout(slot.idleTimer)
    const task = slot.task
    this.#release(slot)
    if (task) task.reject(error ?? new Error('Hash worker retired.'))
    slot.worker.removeAllListeners()
    await slot.worker.terminate()
    if (!this.#closed) this.#dispatch()
  }
}
