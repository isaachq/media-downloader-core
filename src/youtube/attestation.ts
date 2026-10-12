/**
 * YouTube PO (Proof of Origin) tokens, for learning how a site attests the
 * client that streams from it (see the README, "YouTube: attestation").
 *
 * A token is minted for a *content binding* (the session's visitor data, or a
 * video id) by a session that passed YouTube's attestation (BotGuard). Opening
 * a session is the expensive part — the attestation itself, about a second and
 * 2–3 round trips — and it stays valid for hours; each mint after that costs a
 * few milliseconds. The host supplies the ways to open one (`strategies`: the
 * desktop app runs them in its own hidden Chromium); this service decides which
 * to use, keeps one session open, rotates it, and remembers what each way did,
 * so when YouTube changes one the next is tried and the status says which broke.
 *
 * Costs, per token: O(1) — a cache hit (hash map, LRU-bounded), a join on a
 * mint already running for the same binding, or one mint. One session opening
 * at a time whatever the number of callers (single flight); choosing a
 * strategy is O(k) over the k strategies (two in the app).
 */

import {untilAborted} from '../util/abort.js'

export type PoTokenContext = 'gvs' | 'player' | 'subs'

/** A session that passed attestation: mints tokens until it expires. */
export type MintSession = {
  /** When the attestation runs out (ms since epoch). */
  readonly expiresAt: number
  /** Mints before a fresh session, when the site says (YouTube answers 100). */
  readonly maxMints?: number | undefined
  /** A token for this content binding (visitor data, data sync id or video id), websafe base64. */
  mint(contentBinding: string, signal: AbortSignal): Promise<string>
  close(): void
}

/** One way to pass attestation. Opening throws when it can't (the site changed, no network…). */
export type AttestationStrategy = {
  readonly name: string
  open(signal: AbortSignal): Promise<MintSession>
}

export type StrategyStatus = {
  readonly name: string
  /** Not cooling down after failures. */
  readonly healthy: boolean
  readonly opened: number
  /** Failures in a row (opening, minting, or tokens YouTube refused). */
  readonly failures: number
  readonly lastError?: string | undefined
  /** While cooling down: when it may be tried again. */
  readonly retryAt?: number | undefined
}

export type AttestationStatus = {
  /** The strategy of the open session, if one is open. */
  readonly active: string | undefined
  readonly sessionExpiresAt: number | undefined
  readonly minted: number
  readonly cached: number
  readonly strategies: readonly StrategyStatus[]
}

export type MintedToken = {readonly token: string; readonly expiresAt: number}

export type AttestationOptions = {
  /** Mints per session before a fresh one (YouTube was seen refusing after 100). Default 90. */
  readonly maxMintsPerSession?: number | undefined
  /** Open the next session this long before the current one expires. Default 10 min. */
  readonly refreshBeforeMs?: number | undefined
  /** Tokens remembered (LRU). Default 512. */
  readonly cacheSize?: number | undefined
  /** A token is reused at most this long. Default 6 h (what yt-dlp assumes). */
  readonly tokenTtlMs?: number | undefined
  /** Opening a session gives up after this long. Default 45 s. */
  readonly openTimeoutMs?: number | undefined
  /** First cool-down of a failing strategy, doubling per failure in a row. Default 1 min. */
  readonly cooldownMs?: number | undefined
  /** Cool-down ceiling. Default 30 min. */
  readonly maxCooldownMs?: number | undefined
  /** Injected for tests. */
  readonly now?: (() => number) | undefined
}

/** No strategy could open a session: each one's reason. */
export class AttestationError extends Error {
  constructor(
    message: string,
    readonly attempts: ReadonlyArray<{readonly strategy: string; readonly error: string}>,
  ) {
    super(message)
    this.name = 'AttestationError'
  }
}

type Health = {
  readonly strategy: AttestationStrategy
  opened: number
  failures: number
  lastError: string | undefined
  retryAt: number
}

type Active = {readonly session: MintSession; readonly health: Health; mints: number}

const MAX_BINDING_LENGTH = 512

export class PoTokenService {
  readonly #health: Health[]
  readonly #maxMints: number
  readonly #refreshBeforeMs: number
  readonly #cacheSize: number
  readonly #tokenTtlMs: number
  readonly #openTimeoutMs: number
  readonly #cooldownMs: number
  readonly #maxCooldownMs: number
  readonly #now: () => number
  /** binding → token, oldest first (Map order: O(1) LRU). */
  readonly #cache = new Map<string, MintedToken>()
  /** binding → the mint already running for it. */
  readonly #inflight = new Map<string, Promise<MintedToken>>()
  /** Aborted by close(): ends every shared operation. */
  readonly #life = new AbortController()
  #active: Active | undefined
  #opening: Promise<Active> | undefined
  /** Mints run one after another on a session (its page is single-threaded anyway). */
  #queue: Promise<unknown> = Promise.resolve()
  #minted = 0
  /** Bumped by reset(): a session opened for an earlier identity is not kept. */
  #generation = 0
  /** Index in #health of the strategy that last opened a session: tried first. */
  #preferred = 0

  constructor(strategies: readonly AttestationStrategy[], options: AttestationOptions = {}) {
    if (strategies.length === 0) throw new TypeError('PoTokenService needs at least one strategy.')
    this.#health = strategies.map(strategy => ({strategy, opened: 0, failures: 0, lastError: undefined, retryAt: 0}))
    this.#maxMints = Math.max(1, Math.floor(options.maxMintsPerSession ?? 90))
    this.#refreshBeforeMs = Math.max(0, options.refreshBeforeMs ?? 10 * 60_000)
    this.#cacheSize = Math.max(1, Math.floor(options.cacheSize ?? 512))
    this.#tokenTtlMs = Math.max(1000, options.tokenTtlMs ?? 6 * 60 * 60_000)
    this.#openTimeoutMs = Math.max(1000, options.openTimeoutMs ?? 45_000)
    this.#cooldownMs = Math.max(0, options.cooldownMs ?? 60_000)
    this.#maxCooldownMs = Math.max(this.#cooldownMs, options.maxCooldownMs ?? 30 * 60_000)
    this.#now = options.now ?? Date.now
  }

  /** A token for `binding`: from the cache, joined to a mint in flight, or minted. */
  token(binding: string, signal?: AbortSignal): Promise<MintedToken> {
    if (this.#life.signal.aborted) return Promise.reject(new Error('The PO token service is closed.'))
    if (!binding || binding.length > MAX_BINDING_LENGTH) return Promise.reject(new TypeError('Not a content binding.'))
    const cached = this.#cache.get(binding)
    if (cached && cached.expiresAt > this.#now()) {
      this.#cache.delete(binding) // most recently used goes last
      this.#cache.set(binding, cached)
      return Promise.resolve(cached)
    }
    if (cached) this.#cache.delete(binding)
    let shared = this.#inflight.get(binding)
    if (!shared) {
      shared = this.#mint(binding).finally(() => this.#inflight.delete(binding))
      this.#inflight.set(binding, shared)
    }
    return untilAborted(shared, signal)
  }

  /**
   * YouTube refused a token (a 403 on the stream after it): forget it, retire
   * the session that made it and count it against that session's strategy.
   */
  reject(binding?: string): void {
    if (binding) this.#cache.delete(binding)
    const active = this.#active
    if (!active) return
    this.#failed(active.health, 'a token was refused by YouTube')
    this.#retire(active)
  }

  status(): AttestationStatus {
    const now = this.#now()
    return {
      active: this.#active?.health.strategy.name,
      sessionExpiresAt: this.#active?.session.expiresAt,
      minted: this.#minted,
      cached: this.#cache.size,
      strategies: this.#health.map(h => ({
        name: h.strategy.name,
        healthy: h.retryAt <= now,
        opened: h.opened,
        failures: h.failures,
        ...(h.lastError !== undefined && {lastError: h.lastError}),
        ...(h.retryAt > now && {retryAt: h.retryAt}),
      })),
    }
  }

  /**
   * Start over with a fresh session and no tokens (the identity changed: a
   * guest's tokens on a signed-in session look like what they are). Strategy
   * health is kept.
   */
  reset(): void {
    this.#generation++
    if (this.#active) this.#retire(this.#active)
    this.#cache.clear()
  }

  close(): void {
    if (this.#life.signal.aborted) return
    this.#life.abort(new Error('The PO token service is closed.'))
    if (this.#active) this.#retire(this.#active)
    this.#cache.clear()
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** Mint on the current session; a session that fails to mint is retired and a fresh one tried once. */
  async #mint(binding: string): Promise<MintedToken> {
    for (let round = 1; ; round++) {
      const active = await this.#session()
      try {
        const token = await this.#serial(() => active.session.mint(binding, this.#life.signal))
        if (!token) throw new Error('the session minted an empty token')
        active.mints++
        this.#minted++
        active.health.failures = 0
        const minted = {token, expiresAt: Math.min(active.session.expiresAt, this.#now() + this.#tokenTtlMs)}
        this.#cache.set(binding, minted)
        if (this.#cache.size > this.#cacheSize) this.#cache.delete(this.#cache.keys().next().value!)
        return minted
      } catch (error) {
        if (this.#life.signal.aborted) throw error
        this.#failed(active.health, `minting failed: ${messageOf(error)}`)
        this.#retire(active)
        if (round >= 2) throw error
      }
    }
  }

  /** The open session if it is still good; otherwise one fresh session, shared by every caller. */
  #session(): Promise<Active> {
    const active = this.#active
    if (active) {
      // the site's own limit, a little short of it (a refusal at exactly the limit was seen), or ours
      const limit = Math.min(this.#maxMints, Math.max(1, Math.floor((active.session.maxMints ?? Infinity) * 0.9)))
      const fresh = this.#now() < active.session.expiresAt - this.#refreshBeforeMs && active.mints < limit
      if (fresh) return Promise.resolve(active)
      this.#retire(active)
    }
    this.#opening ??= this.#open().finally(() => {
      this.#opening = undefined
    })
    return this.#opening
  }

  /** Strategies in order — the last one that worked first, then the rest — skipping those cooling down. */
  async #open(): Promise<Active> {
    const generation = this.#generation
    const now = this.#now()
    const order = [this.#preferred, ...this.#health.keys()].filter((i, at, all) => all.indexOf(i) === at)
    let ready = order.filter(i => this.#health[i]!.retryAt <= now)
    // every strategy is cooling down: try the one that may go soonest rather than none
    if (ready.length === 0)
      ready = [order.reduce((a, b) => (this.#health[b]!.retryAt < this.#health[a]!.retryAt ? b : a))]
    const attempts: Array<{strategy: string; error: string}> = []
    for (const index of ready) {
      const health = this.#health[index]!
      const timeout = AbortSignal.timeout(this.#openTimeoutMs)
      try {
        const session = await health.strategy.open(AbortSignal.any([this.#life.signal, timeout]))
        if (this.#life.signal.aborted) {
          session.close()
          throw this.#life.signal.reason
        }
        // reset() while it opened: that session belongs to the identity before
        if (generation !== this.#generation) {
          session.close()
          return this.#open()
        }
        health.opened++
        health.retryAt = 0
        health.lastError = undefined
        this.#preferred = index
        this.#active = {session, health, mints: 0}
        return this.#active
      } catch (error) {
        if (this.#life.signal.aborted) throw error
        const reason = timeout.aborted ? `no session within ${this.#openTimeoutMs / 1000} s` : messageOf(error)
        this.#failed(health, reason)
        attempts.push({strategy: health.strategy.name, error: reason})
      }
    }
    throw new AttestationError(
      `YouTube attestation failed: ${attempts.map(a => `${a.strategy}: ${a.error}`).join('; ')}`,
      attempts,
    )
  }

  #failed(health: Health, reason: string): void {
    health.failures++
    health.lastError = reason
    health.retryAt = this.#now() + Math.min(this.#maxCooldownMs, this.#cooldownMs * 2 ** (health.failures - 1))
  }

  /** Stop using a session; it closes once the mints already queued on it are done. */
  #retire(active: Active): void {
    if (this.#active === active) this.#active = undefined
    this.#queue = this.#queue.then(() => active.session.close())
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task)
    this.#queue = run.catch(() => {})
    return run
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
