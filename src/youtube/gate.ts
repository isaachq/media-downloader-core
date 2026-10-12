import {Pacer} from '../sources/pacer.js'
import {untilAborted} from '../util/abort.js'

/**
 * How YouTube is reached right now — the ladder climbed only when YouTube
 * refuses ("Sign in to confirm you're not a bot"), one rung at a time:
 *
 *  - `open`: plain requests, a second apart. Nothing else.
 *  - `attested`: YouTube refused once: requests carry PO tokens (when the host
 *    can mint them), retried after short waits (15 s, 1.5 min, 5 min).
 *  - `held`: still refused after those retries: YouTube requests stop and wait
 *    for the user — sign in (`enterAccount`), or wait it out (`waitItOut`). Only
 *    when the host can ask the user; otherwise the pauses just grow (5 → 60 min).
 *  - `account`: a signed-in session (the user agreed to it).
 *
 * The level stays for the session: once YouTube has refused this connection,
 * tokens stay on. Every operation is O(1).
 */
export type YouTubeLevel = 'open' | 'attested' | 'held' | 'account'

export type YouTubeAccess = {
  readonly level: YouTubeLevel
  /** YouTube requests wait until then (ms since epoch); undefined when not paused. */
  readonly pausedUntil: number | undefined
  /** Refusals in a row at this level. */
  readonly refusals: number
  /** Requests carry PO tokens. */
  readonly tokens: boolean
}

export type GateOptions = {
  readonly pacing?:
    | {
        readonly spacingMs?: number | undefined
        readonly jitterMs?: number | undefined
        readonly backoffMs?: number | undefined
        readonly maxBackoffMs?: number | undefined
      }
    | undefined
  /** PO tokens can be minted (the host supplied attestation strategies). */
  readonly attestation: boolean
  /** The host can ask the user (sign in, or wait): hold instead of pausing on and on. */
  readonly canHold: boolean
  /** Start with tokens on (a health check, or a connection YouTube is known to refuse). */
  readonly startAttested?: boolean | undefined
  /** Waits before the retries with tokens; their count is the retries. Default 15 s, 90 s, 5 min. */
  readonly attestedDelaysMs?: readonly number[] | undefined
  /** The pause when the user chooses to wait instead of signing in. Default 30 min. */
  readonly waitItOutMs?: number | undefined
  readonly now?: (() => number) | undefined
  readonly onChange?: ((access: YouTubeAccess) => void) | undefined
}

/** What a refusal means for the request that got it. */
export type Refusal = {
  /** How long until YouTube requests start again; undefined while held for the user. */
  readonly waitMs: number | undefined
  /** The ladder is still climbing: this attempt doesn't count against the job's retries. */
  readonly free: boolean
}

export class YouTubeGate {
  readonly #pacer: Pacer
  readonly #attestation: boolean
  readonly #canHold: boolean
  readonly #delays: readonly number[]
  readonly #waitItOutMs: number
  readonly #now: () => number
  readonly #onChange: ((access: YouTubeAccess) => void) | undefined
  #level: YouTubeLevel = 'open'
  #refusals = 0
  /** Resolved when a hold ends. */
  #release: {promise: Promise<void>; resolve: () => void} | undefined

  constructor(options: GateOptions) {
    this.#now = options.now ?? Date.now
    this.#pacer = new Pacer({
      concurrency: Number.MAX_SAFE_INTEGER, // a gate for when requests start, not a limit on how many run
      spacingMs: 1000,
      jitterMs: 500,
      backoffMs: 5 * 60_000,
      maxBackoffMs: 60 * 60_000,
      ...options.pacing,
      now: this.#now,
    })
    this.#attestation = options.attestation
    this.#canHold = options.canHold
    this.#delays = options.attestedDelaysMs?.length ? options.attestedDelaysMs : [15_000, 90_000, 5 * 60_000]
    this.#waitItOutMs = Math.max(0, options.waitItOutMs ?? 30 * 60_000)
    this.#onChange = options.onChange
    if (options.startAttested && this.#attestation) this.#level = 'attested'
  }

  get access(): YouTubeAccess {
    const wait = this.#pacer.coolingDownMs
    return {
      level: this.#level,
      pausedUntil: wait > 0 ? this.#now() + wait : undefined,
      refusals: this.#refusals,
      tokens: this.#attestation && this.#level !== 'open',
    }
  }

  /** Requests would wait now (paused or held): a check can say so at once instead of waiting. */
  get blocked(): boolean {
    return this.#level === 'held' || this.#pacer.coolingDownMs > 0
  }

  /** Wait for this request's turn: through a hold, a pause, and the normal spacing. */
  async turn(signal?: AbortSignal): Promise<void> {
    while (this.#release) await untilAborted(this.#release.promise, signal)
    await this.#pacer.run(async () => {}, signal)
  }

  /** YouTube refused a request: climb a rung, or join the pause already running. */
  refused(): Refusal {
    if (this.#level === 'held') return {waitMs: undefined, free: true}
    const running = this.#pacer.coolingDownMs
    // other requests refused by the same block: one pause for all, not one rung each
    if (running > 0) return {waitMs: running, free: this.#escalating()}
    if (this.#level === 'open' && this.#attestation) {
      this.#level = 'attested'
      this.#refusals = 0
      return this.#pause(this.#delays[0]!, true)
    }
    this.#refusals++
    if (this.#level === 'attested' && this.#attestation) {
      if (this.#refusals < this.#delays.length) return this.#pause(this.#delays[this.#refusals]!, true)
      if (this.#canHold) {
        this.#hold()
        return {waitMs: undefined, free: true}
      }
    }
    // no rung left (or none to climb): pauses that double, 5 → 60 min
    const wait = this.#pacer.refused()
    this.#changed()
    return {waitMs: wait, free: false}
  }

  succeeded(): void {
    this.#pacer.succeeded()
    if (this.#refusals === 0) return
    this.#refusals = 0
    this.#changed()
  }

  /** The user signed in: YouTube requests go on now, as that account. */
  enterAccount(): void {
    this.#level = 'account'
    this.#refusals = 0
    this.#pacer.resume()
    this.#unhold()
    this.#changed()
  }

  /** The user signed out: back to tokens (YouTube has refused this connection before) or plain. */
  leaveAccount(): void {
    if (this.#level !== 'account') return
    this.#level = this.#attestation ? 'attested' : 'open'
    this.#refusals = 0
    this.#changed()
  }

  /** The user chose to wait instead of signing in: try again (with tokens) after a long pause. */
  waitItOut(): void {
    if (this.#level !== 'held') return
    this.#level = 'attested'
    this.#refusals = 0
    this.#pacer.pause(this.#waitItOutMs)
    this.#unhold()
    this.#changed()
  }

  /** The reason to wait is gone (e.g. the user picked a browser's signed-in session): go on now. */
  resume(): void {
    this.#refusals = 0
    this.#pacer.resume()
    this.#unhold()
    if (this.#level === 'held') this.#level = 'attested'
    this.#changed()
  }

  #escalating(): boolean {
    return (
      this.#level === 'held' ||
      (this.#level === 'attested' && this.#attestation && this.#refusals < this.#delays.length)
    )
  }

  #pause(ms: number, free: boolean): Refusal {
    this.#pacer.pause(ms)
    this.#changed()
    return {waitMs: ms, free}
  }

  #hold(): void {
    this.#level = 'held'
    let resolve = () => {}
    const promise = new Promise<void>(done => {
      resolve = done
    })
    this.#release = {promise, resolve}
    this.#changed()
  }

  #unhold(): void {
    const release = this.#release
    this.#release = undefined
    release?.resolve()
  }

  #changed(): void {
    this.#onChange?.(this.access)
  }
}
