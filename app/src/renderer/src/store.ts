import type {BatchId, BatchSnapshot, JobId, JobSnapshot, LogEntry, PreflightItem} from 'media-downloader-core'
import {createContext, useContext, useSyncExternalStore} from 'react'
import type {EventBundle} from '../../shared/contract'

const MAX_JOBS = 1500
const MAX_LOGS = 500
const TERMINAL = new Set(['completed', 'skipped', 'failed', 'cancelled'])
export const BATCH_FINISHED: ReadonlySet<string> = new Set([
  'completed',
  'completed-with-errors',
  'failed',
  'cancelled',
])

type ItemListener = (item: PreflightItem) => void

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
  // stable React keys for log lines (entries carry no id of their own): O(1), no copies
  readonly #logKeys = new WeakMap<LogEntry, number>()
  #nextLogKey = 0
  #version = 0
  readonly #listeners = new Set<() => void>()
  readonly #itemListeners = new Map<BatchId, Set<ItemListener>>()

  get version(): number {
    return this.#version
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getVersion = (): number => this.#version

  load(state: {readonly batches: readonly BatchSnapshot[]; readonly jobs: readonly JobSnapshot[]}): void {
    for (const batch of state.batches) this.batches.set(batch.id, batch)
    for (const job of state.jobs) this.jobs.set(job.id, job)
    this.#trimJobs()
    this.#notify()
  }

  apply(bundle: EventBundle): void {
    for (const batch of bundle.batches) this.batches.set(batch.id, batch)
    for (const job of bundle.jobs) {
      // Map keeps insertion order: re-inserting keeps a job in its original row
      this.jobs.set(job.id, job)
    }
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
    for (const [id, job] of this.jobs) if (job.outcome !== 'in-progress') this.jobs.delete(id)
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

  /** Drop the oldest finished jobs beyond the cap (running ones are never dropped). */
  #trimJobs(): void {
    if (this.jobs.size <= MAX_JOBS) return
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break
      if (TERMINAL.has(job.status)) this.jobs.delete(id)
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
