import * as os from 'node:os'

/** Logical processors visible to this process (respects cgroup / affinity limits). */
export function cpuCount(): number {
  return os.availableParallelism()
}

/**
 * Ceiling for simultaneous jobs: half the logical processors, at least one.
 * Each job drives its own yt-dlp / ffmpeg processes, so this keeps the
 * system responsive while downloading.
 */
export function maxConcurrency(cpus: number = cpuCount()): number {
  return Math.max(1, Math.floor(cpus / 2))
}

export function clampConcurrency(requested: number | undefined, cpus: number = cpuCount()): number {
  const max = maxConcurrency(cpus)
  if (requested === undefined || !Number.isFinite(requested)) return max
  return Math.min(max, Math.max(1, Math.floor(requested)))
}

type Node<K> = {
  readonly key: K
  readonly run: () => Promise<void>
  prev: Node<K> | undefined
  next: Node<K> | undefined
}

/**
 * FIFO task pool with a live-adjustable limit.
 *
 * The queue is a doubly linked list indexed by key, so enqueue, dequeue,
 * cancel and prioritize are all O(1) — a 5,000-item playlist costs the same
 * per operation as a single video. Tasks own their error handling; the pool
 * only decides *when* each one starts.
 */
export class TaskPool<K = string> {
  #limit: number
  #head: Node<K> | undefined
  #tail: Node<K> | undefined
  #queued = new Map<K, Node<K>>()
  #running = new Set<K>()
  #paused = false
  #idleWaiters: Array<() => void> = []

  constructor(
    limit: number,
    private readonly onIdle?: () => void,
  ) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  get limit(): number {
    return this.#limit
  }

  get active(): number {
    return this.#running.size
  }

  get pending(): number {
    return this.#queued.size
  }

  get paused(): boolean {
    return this.#paused
  }

  setLimit(limit: number): void {
    this.#limit = Math.max(1, Math.floor(limit))
    this.#drain()
  }

  add(key: K, run: () => Promise<void>): void {
    if (this.#queued.has(key) || this.#running.has(key)) throw new Error(`Task ${String(key)} already exists.`)
    const node: Node<K> = {key, run, prev: this.#tail, next: undefined}
    if (this.#tail) this.#tail.next = node
    else this.#head = node
    this.#tail = node
    this.#queued.set(key, node)
    this.#drain()
  }

  /** Drop a task that hasn't started. False if it is running or unknown. */
  remove(key: K): boolean {
    const node = this.#queued.get(key)
    if (!node) return false
    this.#unlink(node)
    this.#checkIdle()
    return true
  }

  /** Move a queued task to the front. */
  prioritize(key: K): boolean {
    const node = this.#queued.get(key)
    if (!node) return false
    if (node === this.#head) return true
    this.#unlink(node)
    node.prev = undefined
    node.next = this.#head
    if (this.#head) this.#head.prev = node
    this.#head = node
    this.#tail ??= node
    this.#queued.set(key, node)
    return true
  }

  isQueued(key: K): boolean {
    return this.#queued.has(key)
  }

  isRunning(key: K): boolean {
    return this.#running.has(key)
  }

  /** Stop starting tasks; running ones finish normally. */
  pause(): void {
    this.#paused = true
    this.#checkIdle()
  }

  resume(): void {
    this.#paused = false
    this.#drain()
  }

  /** Drop every queued task; returns their keys. */
  clear(): K[] {
    const keys = [...this.#queued.keys()]
    this.#queued.clear()
    this.#head = undefined
    this.#tail = undefined
    this.#checkIdle()
    return keys
  }

  /** Resolves once nothing is running and nothing can start (empty or paused queue). */
  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve()
    return new Promise(resolve => this.#idleWaiters.push(resolve))
  }

  #unlink(node: Node<K>): void {
    if (node.prev) node.prev.next = node.next
    else this.#head = node.next
    if (node.next) node.next.prev = node.prev
    else this.#tail = node.prev
    node.prev = undefined
    node.next = undefined
    this.#queued.delete(node.key)
  }

  #isIdle(): boolean {
    return this.#running.size === 0 && (this.#queued.size === 0 || this.#paused)
  }

  #drain(): void {
    while (!this.#paused && this.#running.size < this.#limit && this.#head) {
      const node = this.#head
      this.#unlink(node)
      this.#running.add(node.key)
      // tasks handle their own errors; the catch only protects the pool
      node
        .run()
        .catch(() => {})
        .finally(() => {
          this.#running.delete(node.key)
          this.#drain()
          this.#checkIdle()
        })
    }
  }

  #checkIdle(): void {
    if (!this.#isIdle()) return
    const waiters = this.#idleWaiters
    this.#idleWaiters = []
    for (const resolve of waiters) resolve()
    this.onIdle?.()
  }
}
