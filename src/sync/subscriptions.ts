import * as fs from 'node:fs/promises'
import {writeAtomic} from '../core/files.js'
import type {FormatProfile, SlideshowOptions} from '../types.js'

/** When a subscription syncs by itself: never (on demand), daily at a local time, or every few hours. */
export type SyncSchedule =
  | {readonly every: 'manual'}
  | {readonly every: 'day' /** "HH:MM", local time. */; readonly at: string}
  | {readonly every: 'hours' /** 1–168. */; readonly hours: number}

export type SyncTrigger = 'manual' | 'schedule' | 'cli'

/** One sync: what TikTok listed, what the folder had, what was new and what came of it. */
export type SyncRun = {
  readonly id: string
  readonly trigger: SyncTrigger
  /** A full check (the whole profile) rather than an incremental one (only what is newer). */
  readonly deep: boolean
  readonly status: 'running' | 'done' | 'failed' | 'interrupted'
  readonly startedAt: number
  readonly finishedAt?: number | undefined
  /** Posts read from TikTok this time. */
  readonly listed: number
  /** Posts the account says it has. */
  readonly total?: number | undefined
  /** Posts the folder already had. */
  readonly inFolder: number
  /** Posts TikTok listed that the folder didn't have. */
  readonly new: number
  readonly downloaded: number
  readonly failed: number
  /** Full checks: files in the folder whose post TikTok no longer lists (deleted, made private). */
  readonly gone?: number | undefined
  /** The batch that downloaded the new posts. */
  readonly batchId?: string | undefined
  readonly error?: string | undefined
}

/** A TikTok account kept in step with a folder. */
export type Subscription = {
  readonly id: string
  readonly site: 'tiktok'
  /** Account name, without "@". */
  readonly user: string
  /** Its profile url. */
  readonly url: string
  /** Where its posts are (and new ones go). */
  readonly folder: string
  readonly profile: FormatProfile
  readonly slideshow?: SlideshowOptions | undefined
  readonly schedule: SyncSchedule
  readonly createdAt: number
  /** Newest first, at most MAX_RUNS. */
  readonly runs: readonly SyncRun[]
}

export const MAX_RUNS = 30

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** A schedule from a caller (IPC, CLI flags, a saved file), made valid; undefined when it isn't one. */
export function syncSchedule(raw: unknown): SyncSchedule | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as {every?: unknown; at?: unknown; hours?: unknown}
  if (value.every === 'manual') return {every: 'manual'}
  if (value.every === 'day' && typeof value.at === 'string' && HHMM.test(value.at)) return {every: 'day', at: value.at}
  if (
    value.every === 'hours' &&
    Number.isInteger(value.hours) &&
    (value.hours as number) >= 1 &&
    (value.hours as number) <= 168
  ) {
    return {every: 'hours', hours: value.hours as number}
  }
  return undefined
}

/**
 * When a subscription next syncs by itself (ms), or undefined for on-demand
 * ones. Daily: the next HH:MM (local) after its last scheduled-or-not start —
 * a sync done by hand at 9:00 doesn't make the 8:00 one of the same day run
 * again. Every N hours: N hours after the last start (at once if never run).
 */
export function nextRunAt(subscription: Subscription, now = Date.now()): number | undefined {
  const {schedule} = subscription
  const last = subscription.runs[0]?.startedAt
  if (schedule.every === 'manual') return undefined
  if (schedule.every === 'hours') return last === undefined ? now : last + schedule.hours * 3_600_000
  const [hours, minutes] = schedule.at.split(':').map(Number) as [number, number]
  const from = new Date(last ?? subscription.createdAt)
  const next = new Date(from)
  next.setHours(hours, minutes, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime()
}

export const isDue = (subscription: Subscription, now = Date.now()): boolean => {
  const next = nextRunAt(subscription, now)
  return next !== undefined && next <= now
}

/**
 * subscriptions.json in the data folder — shared by the app and the CLI
 * (`mdc sync`), written atomically. A missing or broken file is an empty list.
 */
export class SubscriptionStore {
  #items: Subscription[] | undefined
  #writes: Promise<void> = Promise.resolve()

  constructor(readonly file: string) {}

  async list(): Promise<readonly Subscription[]> {
    if (!this.#items) {
      try {
        const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as {subscriptions?: unknown}
        this.#items = Array.isArray(data.subscriptions) ? (data.subscriptions as Subscription[]) : []
      } catch {
        this.#items = []
      }
    }
    return this.#items
  }

  async get(id: string): Promise<Subscription | undefined> {
    return (await this.list()).find(item => item.id === id)
  }

  /** Read again from disk (another process — the CLI, the app — may have changed it). */
  reload(): void {
    this.#items = undefined
  }

  async put(subscription: Subscription): Promise<void> {
    const items = [...(await this.list())]
    const at = items.findIndex(item => item.id === subscription.id)
    if (at === -1) items.push(subscription)
    else items[at] = subscription
    await this.#save(items)
  }

  async remove(id: string): Promise<void> {
    await this.#save((await this.list()).filter(item => item.id !== id))
  }

  #save(items: Subscription[]): Promise<void> {
    this.#items = items
    const text = `${JSON.stringify({version: 1, subscriptions: items}, null, 2)}\n`
    const write = this.#writes.then(() => writeAtomic(this.file, text))
    this.#writes = write.catch(() => {})
    return write
  }
}
