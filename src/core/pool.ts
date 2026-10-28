import * as os from 'node:os'

/** Logical processors visible to this process (respects cgroup / affinity limits). */
export function cpuCount(): number {
  return os.availableParallelism()
}

/** Share of the logical processors jobs may use: half by default, at most 60% (the rest stays free for the user). */
export const DEFAULT_CPU_SHARE = 0.5
export const MAX_CPU_SHARE = 0.6

/** A share within 50–60% (anything else falls back to the nearest bound, invalid input to 50%). */
export function cpuShare(share: number | undefined): number {
  if (share === undefined || !Number.isFinite(share)) return DEFAULT_CPU_SHARE
  return Math.min(MAX_CPU_SHARE, Math.max(DEFAULT_CPU_SHARE, share))
}

/**
 * Ceiling for simultaneous jobs: half the logical processors (or up to 60%
 * with a larger `share`), at least one. Each job drives its own yt-dlp /
 * ffmpeg processes, so this keeps the system responsive while downloading.
 */
export function maxConcurrency(cpus: number = cpuCount(), share: number = DEFAULT_CPU_SHARE): number {
  // the epsilon keeps 10 × 0.6 at 6, not 5.999…
  return Math.max(1, Math.floor(cpus * cpuShare(share) + 1e-9))
}

export function clampConcurrency(
  requested: number | undefined,
  cpus: number = cpuCount(),
  share: number = DEFAULT_CPU_SHARE,
): number {
  const max = maxConcurrency(cpus, share)
  if (requested === undefined || !Number.isFinite(requested)) return max
  return Math.min(max, Math.max(1, Math.floor(requested)))
}

type Node<K> = {
  readonly key: K
  run?: (() => Promise<void>) | undefined
  /** Capacity units this task occupies while running (1 = one normal job). */
  readonly weight: number
  /** The lane this task waits in (a batch's). */
  lane: Lane<K>
  prev: Node<K> | undefined
  next: Node<K> | undefined
}

/**
 * One FIFO of tasks that belong together (a batch's jobs). Lanes with a task
 * waiting form a ring, served one task at a time in turn, so a batch added
 * later never waits for every job of the batches before it.
 */
type Lane<K> = {
  readonly id: unknown
  head: Node<K> | undefined
  tail: Node<K> | undefined
  size: number
  /** Ring links; undefined while the lane has nothing waiting. */
  prevLane: Lane<K> | undefined
  nextLane: Lane<K> | undefined
}

/** Tasks added without a lane share this one. */
const NO_LANE = Symbol('no lane')

/**
 * Task pool with a live-adjustable limit and fair lanes.
 *
 * Every task waits in a lane (its batch's; tasks without one share a lane).
 * Lanes with something waiting form a ring and are served in turn, one task
 * each, FIFO inside the lane: a single video added behind a 500-post backup
 * starts after the backup's current job, not after its 499 others. Enqueue,
 * dequeue, cancel and prioritize are O(1) — doubly linked lists indexed by
 * key — so a 5,000-item playlist costs the same per operation as a single
 * video. Memory: one node per waiting task and one lane per batch with a
 * task waiting (lanes are dropped as they empty). Tasks own their error
 * handling; the pool only decides *when* each one starts.
 */
export class TaskPool<K = string> {
  #limit: number
  #queued = new Map<K, Node<K>>()
  /** Lanes with at least one task waiting, by their id. */
  #lanes = new Map<unknown, Lane<K>>()
  /** The lane whose turn is next; undefined when nothing waits. */
  #turn: Lane<K> | undefined
  /** Running tasks and the weight each one holds. */
  #running = new Map<K, number>()
  /** Sum of the weights running now — O(1) admission checks. */
  #used = 0
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

  /** Capacity units in use by running tasks. */
  get used(): number {
    return this.#used
  }

  /**
   * Queue a task. `weight` is how much of the capacity it occupies: a pool of
   * limit 6 runs six weight-1 tasks, four weight-1.5 tasks, or a mix. `lane`
   * groups tasks that wait together (a batch id); lanes take turns.
   *
   * Time Complexity: O(1).
   */
  add(key: K, run: () => Promise<void>, weight = 1, lane: unknown = NO_LANE): void {
    if (this.#queued.has(key) || this.#running.has(key)) throw new Error(`Task ${String(key)} already exists.`)
    const where = this.#lane(lane)
    const node: Node<K> = {key, run, weight: Math.max(0.01, weight), lane: where, prev: where.tail, next: undefined}
    if (where.tail) where.tail.next = node
    else where.head = node
    where.tail = node
    where.size++
    this.#queued.set(key, node)
    this.#drain()
  }

  /**
   * Drop a task that hasn't started. False if it is running or unknown.
   *
   * Time Complexity: O(1).
   * Space Complexity: O(1).
   */
  remove(key: K): boolean {
    const node = this.#queued.get(key)
    if (!node) return false
    node.run = undefined
    this.#unlink(node)
    this.#checkIdle()
    return true
  }

  /**
   * Move a queued task to the front: first of its lane, and its lane next in turn.
   *
   * Time Complexity: O(1).
   * Space Complexity: O(1).
   */
  prioritize(key: K): boolean {
    const node = this.#queued.get(key)
    if (!node) return false
    const lane = node.lane
    if (node !== lane.head) {
      // out of its place in the lane, back in at the head
      if (node.prev) node.prev.next = node.next
      if (node.next) node.next.prev = node.prev
      else lane.tail = node.prev
      node.prev = undefined
      node.next = lane.head
      if (lane.head) lane.head.prev = node
      lane.head = node
    }
    this.#turn = lane
    this.#drain()
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

  /**
   * Drop every queued task and immediately release task closures; returns their keys.
   *
   * Time Complexity: O(Q) where Q is the number of queued tasks.
   * Space Complexity: O(Q) for the returned array of keys.
   */
  clear(): K[] {
    const keys = [...this.#queued.keys()]
    for (const node of this.#queued.values()) {
      node.run = undefined
      node.prev = undefined
      node.next = undefined
    }
    this.#queued.clear()
    for (const lane of this.#lanes.values()) {
      lane.head = undefined
      lane.tail = undefined
      lane.size = 0
      lane.prevLane = undefined
      lane.nextLane = undefined
    }
    this.#lanes.clear()
    this.#turn = undefined
    this.#checkIdle()
    return keys
  }

  /** Resolves once nothing is running and nothing can start (empty or paused queue). */
  whenIdle(): Promise<void> {
    if (this.#isIdle()) return Promise.resolve()
    return new Promise(resolve => this.#idleWaiters.push(resolve))
  }

  /** The lane for `id`, made and put at the end of the ring (after every lane waiting) when new. O(1). */
  #lane(id: unknown): Lane<K> {
    let lane = this.#lanes.get(id)
    if (lane) return lane
    lane = {id, head: undefined, tail: undefined, size: 0, prevLane: undefined, nextLane: undefined}
    this.#lanes.set(id, lane)
    const turn = this.#turn
    if (!turn) {
      lane.nextLane = lane
      lane.prevLane = lane
      this.#turn = lane
    } else {
      // last in the cycle: right before the lane whose turn is next
      const last = turn.prevLane as Lane<K>
      last.nextLane = lane
      lane.prevLane = last
      lane.nextLane = turn
      turn.prevLane = lane
    }
    return lane
  }

  /** Take a task out of its lane; an emptied lane leaves the ring and the map. O(1). */
  #unlink(node: Node<K>): void {
    const lane = node.lane
    if (node.prev) node.prev.next = node.next
    else lane.head = node.next
    if (node.next) node.next.prev = node.prev
    else lane.tail = node.prev
    node.prev = undefined
    node.next = undefined
    lane.size--
    this.#queued.delete(node.key)
    if (lane.size === 0) this.#dropLane(lane)
  }

  #dropLane(lane: Lane<K>): void {
    const next = lane.nextLane as Lane<K>
    if (next === lane) this.#turn = undefined
    else {
      const prev = lane.prevLane as Lane<K>
      prev.nextLane = next
      next.prevLane = prev
      if (this.#turn === lane) this.#turn = next
    }
    lane.prevLane = undefined
    lane.nextLane = undefined
    this.#lanes.delete(lane.id)
  }

  #isIdle(): boolean {
    return this.#running.size === 0 && (this.#queued.size === 0 || this.#paused)
  }

  /**
   * Start queued tasks while the next one fits in the remaining capacity:
   * the head of the lane whose turn it is, then the next lane's. Strict
   * order (no small task overtakes a waiting big one) keeps heavy tasks
   * from starving; an empty pool always admits the next task, so a task
   * heavier than the whole capacity still runs (alone).
   */
  #drain(): void {
    while (!this.#paused && this.#turn) {
      const lane = this.#turn
      const node = lane.head as Node<K>
      if (this.#running.size > 0 && this.#used + node.weight > this.#limit + 1e-9) break
      const taskRun = node.run
      node.run = undefined // Immediately release task function reference to free memory
      // the lane's turn passes to the next one; an emptied lane leaves the ring
      this.#turn = lane.nextLane
      this.#unlink(node)
      if (!taskRun) continue
      this.#running.set(node.key, node.weight)
      this.#used += node.weight
      // tasks handle their own errors; the catch only protects the pool
      Promise.resolve()
        .then(() => taskRun())
        .catch(() => {})
        .finally(() => {
          this.#running.delete(node.key)
          this.#used -= node.weight
          if (this.#running.size === 0) this.#used = 0 // drop float drift
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
