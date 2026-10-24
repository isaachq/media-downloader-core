/**
 * Reads of the same thing at the same time, made once. A post with k videos
 * checked in parallel, or an analysis, its preflight and its download landing
 * together, ask for one item k times: k requests to the site where one does
 * (and k steps closer to its rate limit). With this they share one: O(1)
 * requests per item while it is being read, O(1) work per call.
 *
 * Each caller waits with its own signal: one that gives up leaves (its own
 * AbortError) without failing the others. The shared request has its own
 * controller and is aborted only when every caller has left.
 */
export class Coalescer<K, V> {
  readonly #reads = new Map<K, {readonly promise: Promise<V>; readonly controller: AbortController; waiting: number}>()

  /** Reads in flight now (for tests). */
  get size(): number {
    return this.#reads.size
  }

  /** `read(signal)` once for `key` while it runs; every caller gets its result. */
  run(key: K, signal: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<V>): Promise<V> {
    signal?.throwIfAborted()
    let shared = this.#reads.get(key)
    if (!shared) {
      const controller = new AbortController()
      const promise = read(controller.signal).finally(() => {
        if (this.#reads.get(key)?.promise === promise) this.#reads.delete(key)
      })
      // no caller left to see it: not an unhandled rejection
      promise.catch(() => {})
      shared = {promise, controller, waiting: 0}
      this.#reads.set(key, shared)
    }
    const entry = shared
    entry.waiting++
    if (!signal) return entry.promise.finally(() => entry.waiting--)
    return new Promise<V>((resolve, reject) => {
      let done = false
      const leave = () => {
        if (done) return
        done = true
        signal.removeEventListener('abort', onAbort)
        entry.waiting--
      }
      const onAbort = () => {
        leave()
        if (entry.waiting === 0) {
          entry.controller.abort(signal.reason)
          if (this.#reads.get(key) === entry) this.#reads.delete(key)
        }
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, {once: true})
      entry.promise.then(
        value => {
          leave()
          resolve(value)
        },
        error => {
          leave()
          reject(error)
        },
      )
    })
  }
}
