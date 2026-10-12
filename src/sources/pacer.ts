import {setTimeout as sleep} from 'node:timers/promises'

/**
 * Polite request scheduling for one site: at most `concurrency` requests in
 * flight, starts at least `spacingMs` apart (± jitter), and a shared cool-down
 * when the site pushes back — every caller waits it out, not just the one
 * that was refused. All bookkeeping is O(1) per request.
 */
export type PacerOptions = {
  /** Requests in flight at once. Default 2. */
  readonly concurrency?: number | undefined
  /** Minimum gap between two request starts. Default 1500 ms. */
  readonly spacingMs?: number | undefined
  /** Random extra gap, 0…jitterMs. Default 1000 ms. */
  readonly jitterMs?: number | undefined
  /** First cool-down after a refusal; doubles on each refusal in a row. Default 30 s. */
  readonly backoffMs?: number | undefined
  /** Cool-down ceiling. Default 10 min. */
  readonly maxBackoffMs?: number | undefined
  /** Injected for tests. */
  readonly now?: (() => number) | undefined
  readonly random?: (() => number) | undefined
}

type Waiter = {resolve: () => void; next: Waiter | undefined}

export class Pacer {
  readonly #concurrency: number
  readonly #spacingMs: number
  readonly #jitterMs: number
  readonly #backoffMs: number
  readonly #maxBackoffMs: number
  readonly #now: () => number
  readonly #random: () => number
  #inFlight = 0
  // FIFO of callers waiting for a slot (singly linked: O(1) push and shift)
  #head: Waiter | undefined
  #tail: Waiter | undefined
  /** Earliest time the next request may start. */
  #nextStart = 0
  #refusals = 0
  /** Aborted by resume(): wakes the callers sleeping through a cool-down. */
  #wake = new AbortController()

  constructor(options: PacerOptions = {}) {
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? 2))
    this.#spacingMs = Math.max(0, options.spacingMs ?? 1500)
    this.#jitterMs = Math.max(0, options.jitterMs ?? 1000)
    this.#backoffMs = Math.max(0, options.backoffMs ?? 30_000)
    this.#maxBackoffMs = Math.max(this.#backoffMs, options.maxBackoffMs ?? 600_000)
    this.#now = options.now ?? Date.now
    this.#random = options.random ?? Math.random
  }

  /** Milliseconds until requests may resume (0 when not cooling down). */
  get coolingDownMs(): number {
    return Math.max(0, this.#nextStart - this.#now())
  }

  /** Run `task` when a slot is free and its turn has come. */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal)
    try {
      await this.#waitTurn(signal)
      return await task()
    } finally {
      this.#release()
    }
  }

  /** The site refused (403 / 429 / challenge / empty page): everybody backs off, doubling each time. */
  refused(): number {
    const wait = Math.min(this.#maxBackoffMs, this.#backoffMs * 2 ** this.#refusals)
    this.#refusals++
    this.#nextStart = Math.max(this.#nextStart, this.#now() + wait)
    return wait
  }

  /** A request went through: the next refusal starts the back-off from the bottom again. */
  succeeded(): void {
    this.#refusals = 0
  }

  /**
   * The reason to back off is gone (e.g. a browser passed the check the
   * refusal came from): drop the cool-down, keep the normal spacing.
   */
  resume(): void {
    this.#refusals = 0
    this.#nextStart = Math.min(this.#nextStart, this.#now())
    // callers already sleeping through the cool-down take their turns now, spaced as usual
    this.#wake.abort()
    this.#wake = new AbortController()
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.#inFlight < this.#concurrency) {
      this.#inFlight++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        next: undefined,
      }
      // an aborted waiter stays in the list but hands its slot straight on
      const onAbort = () => {
        waiter.resolve = () => this.#release()
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, {once: true})
      if (this.#tail) this.#tail.next = waiter
      else this.#head = waiter
      this.#tail = waiter
    })
  }

  #release(): void {
    const next = this.#head
    if (next) {
      this.#head = next.next
      if (!this.#head) this.#tail = undefined
      next.resolve() // the slot passes to the next caller: #inFlight is unchanged
    } else {
      this.#inFlight--
    }
  }

  async #waitTurn(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.#now()
      const start = Math.max(now, this.#nextStart)
      // reserve this start before awaiting, so concurrent callers queue up behind it
      this.#nextStart = start + this.#spacingMs + this.#random() * this.#jitterMs
      const wait = start - now
      if (wait <= 0) return
      const wake = this.#wake.signal
      try {
        await sleep(wait, undefined, {signal: signal ? AbortSignal.any([signal, wake]) : wake})
        return
      } catch (error) {
        if (signal?.aborted || !wake.aborted) throw error
        // resume(): the cool-down is over — take a turn again
      }
    }
  }
}
