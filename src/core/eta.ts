/**
 * Progress and time left of a batch, measured rather than guessed.
 *
 * Every job weighs its estimated size. Work done = finished jobs + the
 * downloaded fraction of running ones, kept as running sums. Throughput is the
 * work done over the last 30 s (since the start while younger), so it includes
 * everything this machine does in parallel — downloads, conversions, integrity
 * checks on the ⌊CPUs/2⌋ pool — without the slow start-up seconds weighing on
 * the whole batch. Time left = remaining work ÷ throughput. O(1) amortized.
 */
export type WorkEstimate = {
  /** 0–1, weighted by size. */
  readonly fraction: number
  /** Undefined until enough has been measured. */
  readonly etaSeconds?: number | undefined
}

/** Too early to measure: the first seconds are mostly process start-up. */
const WARM_UP_MS = 3000
/** Throughput is measured over this recent window… */
const WINDOW_MS = 30_000
/** …once it spans at least this long. */
const MIN_WINDOW_MS = 10_000
/** One sample per second at most: the window holds ≤ 31. */
const SAMPLE_EVERY_MS = 1000
/** Weight of a job whose size is unknown, until known sizes give an average. */
const DEFAULT_WEIGHT = 50e6

export class WorkMeter {
  readonly #now: () => number
  /** Weight of every job still in flight. */
  readonly #weights = new Map<string, number>()
  /** weight × downloaded fraction of the running ones. */
  readonly #partial = new Map<string, number>()
  #total = 0
  #done = 0
  #partialSum = 0
  #knownSum = 0
  #knownCount = 0
  #startedAt: number | undefined
  /** (time, work done) samples of the last WINDOW_MS, oldest first. */
  readonly #samples: Array<{readonly at: number; readonly work: number}> = []

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  add(id: string, estimatedBytes: number | undefined): void {
    if (this.#weights.has(id)) return
    let weight = estimatedBytes && estimatedBytes > 0 ? estimatedBytes : undefined
    if (weight) {
      this.#knownSum += weight
      this.#knownCount++
    } else {
      weight = this.#knownCount ? this.#knownSum / this.#knownCount : DEFAULT_WEIGHT
    }
    this.#weights.set(id, weight)
    this.#total += weight
    this.#startedAt ??= this.#now()
  }

  progress(id: string, fraction: number): void {
    const weight = this.#weights.get(id)
    if (weight === undefined || !Number.isFinite(fraction)) return
    const next = weight * Math.min(Math.max(fraction, 0), 1)
    this.#partialSum += next - (this.#partial.get(id) ?? 0)
    this.#partial.set(id, next)
  }

  /**
   * A job left the batch. `worked`: it took real time (succeeded or failed);
   * false for skipped / cancelled jobs, whose weight leaves the total so they
   * don't make the batch look faster than it is.
   */
  finish(id: string, worked: boolean): void {
    const weight = this.#weights.get(id)
    if (weight === undefined) return
    this.#weights.delete(id)
    this.#partialSum -= this.#partial.get(id) ?? 0
    this.#partial.delete(id)
    if (worked) this.#done += weight
    else this.#total -= weight
  }

  estimate(): WorkEstimate {
    if (this.#total <= 0) return {fraction: this.#startedAt === undefined ? 0 : 1}
    const work = Math.min(this.#done + Math.max(this.#partialSum, 0), this.#total)
    const fraction = work / this.#total
    const now = this.#now()
    this.#sample(now, work)
    const elapsed = this.#startedAt === undefined ? 0 : now - this.#startedAt
    if (elapsed < WARM_UP_MS || work <= 0) return {fraction}
    // recent throughput when the window is wide enough and work moved in it; else since the start
    const oldest = this.#samples[0]!
    const span = now - oldest.at
    const recent = span >= MIN_WINDOW_MS ? (work - oldest.work) / span : 0
    const perMs = recent > 0 ? recent : work / elapsed
    return {fraction, etaSeconds: Math.ceil((this.#total - work) / perMs / 1000)}
  }

  #sample(now: number, work: number): void {
    const last = this.#samples.at(-1)
    if (!last || now - last.at >= SAMPLE_EVERY_MS) this.#samples.push({at: now, work})
    // keep one sample at or beyond the window edge so the span can reach WINDOW_MS
    while (this.#samples.length > 2 && now - this.#samples[1]!.at >= WINDOW_MS) this.#samples.shift()
  }
}
