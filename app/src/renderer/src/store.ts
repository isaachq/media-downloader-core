import type {
  BatchId,
  BatchSnapshot,
  JobId,
  JobSnapshot,
  JobStatus,
  LogEntry,
  PreflightItem,
} from 'media-downloader-core'
import {createContext, useContext, useSyncExternalStore} from 'react'
import type {EventBundle, YouTubeState} from '../../shared/contract'

const MAX_JOBS = 1500
/** Failed jobs are kept past MAX_JOBS (the Failed list retries them) up to this many. */
const MAX_FAILED = 5000
const MAX_LOGS = 500
const TERMINAL = new Set(['completed', 'skipped', 'failed', 'cancelled'])
/** Failed jobs the Failed list offers: this session's, not yet sent to a new batch. O(jobs). */
export function failedJobs(store: AppStore): JobSnapshot[] {
  const failed: JobSnapshot[] = []
  for (const job of store.jobs.values()) if (job.status === 'failed' && !store.retried.has(job.id)) failed.push(job)
  return failed
}

export const BATCH_FINISHED: ReadonlySet<string> = new Set([
  'completed',
  'completed-with-errors',
  'failed',
  'cancelled',
])

type ItemListener = (item: PreflightItem) => void

const STATUSES: readonly JobStatus[] = [
  'queued',
  'downloading',
  'processing',
  'converting',
  'validating',
  'finalizing',
  'completed',
  'skipped',
  'failed',
  'cancelled',
]
/** Statuses of a job doing work (holding capacity). */
export const WORKING: ReadonlySet<JobStatus> = new Set([
  'downloading',
  'processing',
  'converting',
  'validating',
  'finalizing',
])

/**
 * Jobs of this session by status, plus the capacity in use and the bytes of
 * the files finished. Kept up to date per change (O(1) each), so the stats
 * and the report never scan the jobs — and finished jobs the store drops to
 * bound its memory still count until "clear finished".
 */
export type JobCounts = Readonly<Record<JobStatus, number>> & {
  /** Capacity units held by working jobs. */
  readonly used: number
  /** Bytes of the files completed this session. */
  readonly finishedBytes: number
}

const zero = (): Record<JobStatus, number> =>
  Object.fromEntries(STATUSES.map(status => [status, 0])) as Record<JobStatus, number>

/**
 * Renderer state. Event bundles arrive at most every 100 ms and are applied
 * in O(changes); React is told once per bundle (one version bump), so a
 * 5,000-job batch costs ≤ 10 renders per second. Memory is bounded: finished
 * jobs beyond MAX_JOBS and logs beyond MAX_LOGS are dropped oldest first.
 */
export class AppStore {
  readonly jobs = new Map<JobId, JobSnapshot>()
  readonly batches = new Map<BatchId, BatchSnapshot>()
  logs: LogEntry[] = []
  /** YouTube requests paused by a bot check until then (ms), as the engine last said. */
  youtubePausedUntil: number | undefined
  /** How YouTube is reached (tokens after a bot check, a hold for the user, an account), as the app last said. */
  youtube: YouTubeState | undefined
  /** Failed jobs already sent to a new batch from the Failed list: no longer offered there. */
  readonly retried = new Set<JobId>()
  // stable React keys for log lines (entries carry no id of their own): O(1), no copies
  readonly #logKeys = new WeakMap<LogEntry, number>()
  #nextLogKey = 0
  #version = 0
  readonly #listeners = new Set<() => void>()
  readonly #itemListeners = new Map<BatchId, Set<ItemListener>>()
  /** Jobs in the map by status, and terminal ones trimmed from it (still counted). */
  readonly #live = zero()
  readonly #retired = zero()
  #used = 0
  #finishedBytes = 0
  #counts: JobCounts | undefined
  /** Bytes per second of every working job, summed as each job reports — O(1) per change. */
  #speed = 0
  /** Live recordings not over yet, by id: started here, or a standalone job reporting live progress. */
  readonly #recordingIds = new Set<JobId>()
  #recordings: readonly JobSnapshot[] = []
  /** Recordings that ended since the app last asked (a notice says how each one ended). */
  #ended: JobSnapshot[] = []

  get version(): number {
    return this.#version
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getVersion = (): number => this.#version

  /**
   * Jobs by status, capacity in use, bytes finished — O(1). The same object
   * until a job changes status: progress events alone leave it untouched, so
   * whatever shows only counts doesn't re-render 10×/s.
   */
  /** The downloads' combined speed (B/s): a sum kept per change, never a scan of the jobs. */
  get speed(): number {
    return this.#speed
  }

  /** The live recordings running (or saving): a new array only when one of them changes. O(1) to read. */
  get recordings(): readonly JobSnapshot[] {
    return this.#recordings
  }

  /** A recording this window started (it may report live progress only once it runs). */
  addRecording(job: JobSnapshot): void {
    this.#recordingIds.add(job.id)
    this.#setJob(job)
    this.#notify()
  }

  /** Recordings that ended since the last call, oldest first; the list empties. */
  takeEndedRecordings(): JobSnapshot[] {
    const ended = this.#ended
    this.#ended = []
    return ended
  }

  get counts(): JobCounts {
    if (!this.#counts) {
      const total = zero()
      for (const status of STATUSES) total[status] = this.#live[status] + this.#retired[status]
      this.#counts = {...total, used: this.#used, finishedBytes: this.#finishedBytes}
    }
    return this.#counts
  }

  load(state: {
    readonly batches: readonly BatchSnapshot[]
    readonly jobs: readonly JobSnapshot[]
    readonly youtubePausedUntil?: number | null | undefined
    readonly youtube?: YouTubeState | undefined
  }): void {
    this.youtubePausedUntil = state.youtubePausedUntil ?? undefined
    this.youtube = state.youtube
    for (const batch of state.batches) this.batches.set(batch.id, batch)
    for (const job of state.jobs) this.#setJob(job)
    this.#trimJobs()
    this.#notify()
  }

  setYouTube(state: YouTubeState): void {
    this.youtube = state
    this.youtubePausedUntil = state.pausedUntil ?? undefined
    this.#notify()
  }

  /** Opens kept for batches still running ("show in folder" waits for the batch): one per batch, the last tap wins. */
  readonly #revealLater = new Map<BatchId, () => void>()

  /**
   * Keep `open` until the batch ends, when it runs once: true. False when the batch is over,
   * or none this session knows: nothing kept, open now. Lives here, not in a component, so
   * a tab that unmounts (Finished, Downloads) keeps its tap. O(1).
   */
  revealWhenDone(batchId: string | undefined, open: () => void): boolean {
    const batch = batchId ? this.batches.get(batchId as BatchId) : undefined
    if (!batch || BATCH_FINISHED.has(batch.status)) return false
    this.#revealLater.set(batch.id, open)
    return true
  }

  apply(bundle: EventBundle): void {
    if (bundle.youtubePausedUntil !== undefined) this.youtubePausedUntil = bundle.youtubePausedUntil ?? undefined
    for (const batch of bundle.batches) {
      this.batches.set(batch.id, batch)
      // a batch that just ended: what waited for it opens, once
      const open = this.#revealLater.get(batch.id)
      if (open && BATCH_FINISHED.has(batch.status)) {
        this.#revealLater.delete(batch.id)
        open()
      }
    }
    for (const job of bundle.jobs) this.#setJob(job)
    for (const {batchId, item} of bundle.items) {
      for (const listener of this.#itemListeners.get(batchId) ?? []) listener(item)
    }
    if (bundle.logs.length) {
      for (const entry of bundle.logs) this.#logKeys.set(entry, this.#nextLogKey++)
      this.logs = [...this.logs, ...bundle.logs].slice(-MAX_LOGS)
    }
    this.#trimJobs()
    this.#notify()
  }

  /** A key that stays the same for a log entry as newer lines arrive. */
  logKey(entry: LogEntry): number {
    let key = this.#logKeys.get(entry)
    if (key === undefined) {
      key = this.#nextLogKey++
      this.#logKeys.set(entry, key)
    }
    return key
  }

  /** Forget finished batches and jobs (files on disk are untouched). O(batches + jobs). */
  clearFinished(): void {
    for (const [id, batch] of this.batches) if (BATCH_FINISHED.has(batch.status)) this.batches.delete(id)
    for (const [id, job] of this.jobs) {
      if (job.outcome === 'in-progress') continue
      this.jobs.delete(id)
      this.#live[job.status]--
    }
    for (const status of TERMINAL) this.#retired[status as JobStatus] = 0
    this.#counts = undefined
    this.#notify()
  }

  /** These failed jobs went into a new batch: the Failed list stops offering them. */
  markRetried(ids: Iterable<JobId>): void {
    for (const id of ids) this.retried.add(id)
    this.#notify()
  }

  /** Follow item changes of one batch (an expanded batch table). */
  onItem(batchId: BatchId, listener: ItemListener): () => void {
    let set = this.#itemListeners.get(batchId)
    if (!set) {
      set = new Set()
      this.#itemListeners.set(batchId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.#itemListeners.delete(batchId)
    }
  }

  /** Store a job snapshot and move the counts from its previous status to the new one. */
  #setJob(job: JobSnapshot): void {
    const before = this.jobs.get(job.id)
    if (before?.status !== job.status) this.#counts = undefined
    if (before) {
      this.#live[before.status]--
      if (WORKING.has(before.status)) {
        this.#used -= before.weight
        this.#speed -= before.progress.speed ?? 0
      }
    }
    this.#live[job.status]++
    if (WORKING.has(job.status)) {
      this.#used += job.weight
      this.#speed += job.progress.speed ?? 0
    }
    // a sum of floats drifts; once nothing works it is exactly nothing
    if (this.#used === 0) this.#speed = 0
    if (job.status === 'completed' && before?.status !== 'completed') {
      this.#finishedBytes += job.validation?.sizeBytes ?? job.progress.totalBytes ?? 0
    }
    // Map keeps insertion order: re-inserting keeps a job in its original row
    this.jobs.set(job.id, job)
    this.#followRecording(job, before)
  }

  /** O(1) for any other job; O(r) to rebuild the list when a recording changes (r: single digits). */
  #followRecording(job: JobSnapshot, before: JobSnapshot | undefined): void {
    const recording = this.#recordingIds.has(job.id) || (job.progress.live === true && !job.batchId)
    if (!recording) return
    if (TERMINAL.has(job.status)) {
      if (!this.#recordingIds.delete(job.id)) return
      if (before && !TERMINAL.has(before.status)) this.#ended.push(job)
    } else this.#recordingIds.add(job.id)
    this.#recordings = [...this.#recordingIds].flatMap(id => this.jobs.get(id) ?? [])
  }

  /** Drop the oldest finished jobs beyond the cap (running ones are never dropped); they stay counted. */
  #trimJobs(): void {
    if (this.jobs.size <= MAX_JOBS) return
    // failed ones stay for the Failed list, unless there are very many of them
    const keepFailed = this.#live.failed <= MAX_FAILED
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break
      if (!TERMINAL.has(job.status) || (keepFailed && job.status === 'failed')) continue
      this.jobs.delete(id)
      this.#live[job.status]--
      this.#retired[job.status]++
    }
  }

  #notify(): void {
    this.#version++
    for (const listener of this.#listeners) listener()
  }
}

/** The store of this app tree — injected, so every window (and every test) has its own. */
export const StoreContext = createContext<AppStore | undefined>(undefined)

export function useAppStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useAppStore() outside <StoreContext.Provider>')
  return store
}

/** The store, re-rendering the caller whenever it changes (≤ 10×/s). */
export function useStore(): AppStore {
  const store = useAppStore()
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store
}

/**
 * One value read from the store, re-rendering the caller only when that value
 * changes (compared with Object.is): a number, a string, or an object the
 * store keeps stable (`counts`) — not 10×/s.
 */
export function useStoreValue<T>(select: (store: AppStore) => T): T {
  const store = useAppStore()
  return useSyncExternalStore(store.subscribe, () => select(store))
}
