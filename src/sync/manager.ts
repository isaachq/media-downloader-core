import {EventEmitter} from 'node:events'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {MAX_REQUESTED_ITEMS} from '../core/analyze.js'
import {DownloadError} from '../core/errors.js'
import {profileProblem} from '../core/formats.js'
import {newId} from '../core/ids.js'
import type {MediaDownloader} from '../downloader.js'
import type {BatchScheduler} from '../scheduler.js'
import {parseTikTokLink, profileUrl} from '../sources/tiktok/links.js'
import {slideshowOptions} from '../sources/tiktok/slideshow.js'
import type {BatchSnapshot, FormatProfile, PlaylistEntry, SlideshowOptions} from '../types.js'
import {folderFormat, scanFolder, scanFormat, syncProfile} from './folder.js'
import {
  isDue,
  MAX_RUNS,
  nextRunAt,
  type Subscription,
  SubscriptionStore,
  type SyncRun,
  type SyncSchedule,
  type SyncTrigger,
  syncSchedule,
} from './subscriptions.js'

/** What a subscription is doing right now. */
export type SyncState = 'idle' | 'scanning' | 'listing' | 'downloading'

/** A subscription as a UI shows it: the saved one, plus what it is doing and when it runs next. */
export type SubscriptionView = Subscription & {
  readonly state: SyncState
  /** While listing: posts read so far, of how many. */
  readonly progress?: {readonly listed: number; readonly expected?: number | undefined} | undefined
  readonly nextRunAt?: number | undefined
}

/** What a sync would do, without doing it. */
export type SyncPlan = {
  readonly listed: number
  readonly total?: number | undefined
  readonly inFolder: number
  /** Posts to download, newest first. */
  readonly entries: readonly PlaylistEntry[]
  /** Full checks: files whose post TikTok no longer lists. */
  readonly gone: readonly string[]
  /** The listing stopped where the folder's posts start (incremental). */
  readonly caughtUp: boolean
}

export type NewSubscription = {
  readonly url: string
  readonly folder: string
  readonly profile?: FormatProfile | undefined
  readonly slideshow?: SlideshowOptions | undefined
  readonly schedule?: SyncSchedule | undefined
}

/** A run left this long without finishing (a crash) is not a lock any more. */
const STALE_LOCK_MS = 12 * 3_600_000
const DEFAULT_PROFILE: FormatProfile = {kind: 'video', container: 'mp4'}

type SyncEvents = {subscription: [view: SubscriptionView]; removed: [id: string]}

/**
 * TikTok accounts kept in step with folders. A sync scans the folder for the
 * posts it holds (ids in file names, the archive, file tags), lists the
 * account — incrementally, from the newest post until the folder's posts
 * start, or fully for a deep check — and downloads what's missing as one
 * batch (flat, into the folder), so it shows in Batches / Downloads /
 * Finished like any other. Runs are recorded per subscription.
 *
 * The same store is used by the app (its own schedule) and the CLI
 * (`mdc sync run --due`, for cron / launchd / Task Scheduler): a lock file
 * keeps two processes from syncing at once.
 */
export class SyncManager extends EventEmitter<SyncEvents> {
  readonly #engine: MediaDownloader
  readonly #scheduler: BatchScheduler
  readonly #store: SubscriptionStore
  readonly #lockDir: string
  readonly #state = new Map<string, {state: SyncState; progress?: SubscriptionView['progress']}>()
  /** Batch → the subscription and run it is downloading for, and the lock it holds until it ends. */
  readonly #batches = new Map<string, {subscriptionId: string; runId: string; release: () => Promise<void>}>()
  #timer: NodeJS.Timeout | undefined
  readonly #onBatch = (batch: BatchSnapshot) => void this.#batchChanged(batch)

  constructor(engine: MediaDownloader, scheduler: BatchScheduler, opts: {readonly file?: string | undefined} = {}) {
    super()
    this.#engine = engine
    this.#scheduler = scheduler
    this.#store = new SubscriptionStore(opts.file ?? path.join(engine.dataDir, 'subscriptions.json'))
    this.#lockDir = path.dirname(this.#store.file)
    scheduler.on('batch', this.#onBatch)
  }

  // ─── subscriptions ─────────────────────────────────────────────────────────

  async list(): Promise<SubscriptionView[]> {
    this.#store.reload()
    for (const item of await this.#store.list()) await this.#reconcile(item)
    return (await this.#store.list()).map(item => this.#view(item))
  }

  async get(id: string): Promise<SubscriptionView | undefined> {
    const item = await this.#store.get(id)
    return item && this.#view(item)
  }

  /** Follow a TikTok account into a folder. The folder may already hold its posts: they count as had. */
  async add(input: NewSubscription): Promise<SubscriptionView> {
    const link = parseTikTokLink(typeof input.url === 'string' ? input.url.trim() : '')
    if (link?.kind !== 'profile') {
      throw new DownloadError('invalid-request', 'A sync follows a TikTok profile: https://www.tiktok.com/@name')
    }
    const folder = this.#folder(input.folder)
    if (input.profile) {
      const problem = profileProblem(input.profile)
      if (problem) throw new DownloadError('invalid-request', problem)
    }
    // a folder holds one format: one that has files decides it
    const chosen = syncProfile(await folderFormat(folder), input.profile, DEFAULT_PROFILE)
    if ('problem' in chosen) throw new DownloadError('invalid-request', chosen.problem)
    const {profile} = chosen
    const user = link.user
    const existing = (await this.#store.list()).find(
      item => item.user.toLowerCase() === user.toLowerCase() && path.resolve(item.folder) === folder,
    )
    if (existing) throw new DownloadError('invalid-request', `@${user} is already synced into ${folder}.`)
    const subscription: Subscription = {
      id: newId(),
      site: 'tiktok',
      user,
      url: profileUrl('https://www.tiktok.com', user),
      folder,
      profile,
      ...slideshowFor(profile, input.slideshow),
      schedule: input.schedule === undefined ? {every: 'manual'} : this.#schedule(input.schedule),
      createdAt: Date.now(),
      runs: [],
    }
    await fs.mkdir(folder, {recursive: true})
    await this.#store.put(subscription)
    this.#emitView(subscription)
    return this.#view(subscription)
  }

  /**
   * Change when it syncs, how slideshows are made, or move it to another
   * folder (one in the same format). The format itself never changes: it is
   * the format of the files already in the folder.
   */
  async update(
    id: string,
    patch: {
      readonly folder?: string
      readonly slideshow?: SlideshowOptions
      readonly schedule?: SyncSchedule
    },
  ): Promise<SubscriptionView> {
    const current = await this.#require(id)
    const folder = patch.folder === undefined ? undefined : this.#folder(patch.folder)
    if (folder !== undefined) {
      const chosen = syncProfile(await folderFormat(folder), current.profile, current.profile)
      if ('problem' in chosen) throw new DownloadError('invalid-request', chosen.problem)
    }
    const next: Subscription = {
      ...current,
      ...(folder !== undefined && {folder}),
      ...(patch.slideshow && slideshowFor(current.profile, patch.slideshow)),
      ...(patch.schedule && {schedule: this.#schedule(patch.schedule)}),
    }
    await this.#store.put(next)
    this.#emitView(next)
    return this.#view(next)
  }

  /** Stop following an account. Its folder and files are left as they are. */
  async remove(id: string): Promise<void> {
    await this.#store.remove(id)
    this.#state.delete(id)
    this.emit('removed', id)
  }

  // ─── syncing ───────────────────────────────────────────────────────────────

  /**
   * What a sync would download, without downloading: the folder's posts, the
   * account's listing (incremental unless `deep`), the difference.
   */
  async check(id: string, opts: {readonly deep?: boolean; readonly signal?: AbortSignal} = {}): Promise<SyncPlan> {
    const subscription = await this.#require(id)
    try {
      return await this.#plan(subscription, opts.deep === true || firstSync(subscription), opts.signal)
    } finally {
      this.#setState(subscription, 'idle')
    }
  }

  /**
   * Sync now: check, then download what's new as one batch into the folder.
   * Resolves once the batch is scheduled (or at once when nothing is new);
   * `whenDone` follows it to the end. A subscription syncs once at a time
   * across processes: its lock is held until its downloads end, so a second
   * process never sees a half-filled folder and downloads the same posts.
   */
  async run(
    id: string,
    opts: {readonly deep?: boolean; readonly trigger?: SyncTrigger; readonly signal?: AbortSignal} = {},
  ): Promise<SyncRun> {
    const subscription = await this.#require(id)
    if (this.#busy(subscription.id))
      throw new DownloadError('invalid-request', `@${subscription.user} is already syncing.`)
    const release = await this.#lock(subscription)
    let held = true
    const run: SyncRun = {
      id: newId(),
      trigger: opts.trigger ?? 'manual',
      // the first sync checks the whole profile: the folder may have gaps anywhere, not only at the top
      deep: opts.deep === true || firstSync(subscription),
      status: 'running',
      startedAt: Date.now(),
      listed: 0,
      inFolder: 0,
      new: 0,
      downloaded: 0,
      failed: 0,
    }
    await this.#saveRun(subscription.id, run)
    try {
      const plan = await this.#plan(subscription, run.deep, opts.signal)
      const base = {
        ...run,
        listed: plan.listed,
        total: plan.total,
        inFolder: plan.inFolder,
        new: plan.entries.length,
        ...(run.deep && {gone: plan.gone.length}),
      }
      if (plan.entries.length === 0) {
        const done: SyncRun = {...base, status: 'done', finishedAt: Date.now()}
        held = false
        await release()
        await this.#saveRun(subscription.id, done)
        this.#setState(subscription, 'idle')
        return done
      }
      const latest = (await this.#store.get(subscription.id)) ?? subscription
      const batch = this.#scheduler.schedule({
        url: latest.url,
        profile: latest.profile,
        outDir: latest.folder,
        flat: true,
        ...(latest.slideshow && {slideshow: latest.slideshow}),
        selection: {
          title: `Sync @${latest.user}`,
          entries: plan.entries.map((entry, i) => ({...entry, index: i + 1})),
        },
      })
      // the lock now belongs to the batch: released when its downloads end
      this.#batches.set(batch.id, {subscriptionId: subscription.id, runId: run.id, release})
      const scheduled: SyncRun = {...base, batchId: batch.id}
      await this.#saveRun(subscription.id, scheduled)
      this.#setState(subscription, 'downloading')
      return scheduled
    } catch (error) {
      const failed: SyncRun = {
        ...run,
        status: 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }
      await this.#saveRun(subscription.id, failed)
      this.#setState(subscription, 'idle')
      if (held) await release()
      throw error
    }
  }

  /** Sync every subscription whose time has come, one after the other. */
  async runDue(trigger: SyncTrigger = 'schedule', now = Date.now()): Promise<SyncRun[]> {
    const runs: SyncRun[] = []
    for (const subscription of await this.list()) {
      if (!isDue(subscription, now) || this.#busy(subscription.id)) continue
      try {
        runs.push(await this.run(subscription.id, {trigger}))
      } catch (error) {
        this.#engine.log(
          'warn',
          `sync @${subscription.user}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return runs
  }

  /** Check every minute for subscriptions due (the app, while it runs). */
  startSchedule(intervalMs = 60_000): void {
    this.stopSchedule()
    this.#timer = setInterval(() => void this.runDue('schedule'), intervalMs)
    this.#timer.unref()
    // a sync missed while the app was closed runs now
    void this.runDue('schedule')
  }

  stopSchedule(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** Resolves when the run's downloads have ended (at once when it had none). */
  async whenDone(subscriptionId: string, runId: string): Promise<SyncRun | undefined> {
    for (;;) {
      const run = (await this.#store.get(subscriptionId))?.runs.find(item => item.id === runId)
      if (run?.status !== 'running') return run
      await new Promise<void>(resolve => {
        const check = (view: SubscriptionView) => {
          if (view.id !== subscriptionId) return
          const current = view.runs.find(item => item.id === runId)
          if (current?.status !== 'running') {
            this.off('subscription', check)
            resolve()
          }
        }
        this.on('subscription', check)
      })
    }
  }

  dispose(): void {
    this.stopSchedule()
    this.#scheduler.off('batch', this.#onBatch)
    this.removeAllListeners()
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  async #plan(subscription: Subscription, deep: boolean, signal?: AbortSignal): Promise<SyncPlan> {
    this.#setState(subscription, 'scanning')
    const bins = await this.#engine.resolveBinaries()
    const scan = await scanFolder(subscription.folder, {
      archive: this.#engine.archive,
      extractor: 'TikTok',
      ffprobe: bins.ffprobe.exe,
      signal,
    })
    // a folder holds one format: files in another (added by hand, another tool) stop the sync
    const format = syncProfile(scanFormat(scan), subscription.profile, subscription.profile)
    if ('problem' in format) throw new DownloadError('invalid-request', format.problem)
    this.#setState(subscription, 'listing', {listed: 0})
    // an empty folder has nothing to stop at: the whole profile is listed
    const incremental = !deep && scan.ids.size > 0
    const analysis = await this.#engine.analyze(subscription.url, {
      maxEntries: MAX_REQUESTED_ITEMS,
      // a sync runs on its own: it waits out a site's cool-down instead of failing
      waitForSite: true,
      ...(signal && {signal}),
      ...(incremental && {known: new Set(scan.ids.keys())}),
      onProgress: progress => this.#setState(subscription, 'listing', progress),
    })
    if (analysis.kind !== 'playlist') throw new DownloadError('unavailable', `@${subscription.user} is not a profile.`)
    const entries = analysis.entries.filter(entry => !scan.ids.has(entry.id))
    const listedIds = new Set(analysis.entries.map(entry => entry.id))
    // only a complete listing can tell what TikTok no longer has
    const gone =
      deep && analysis.complete ? [...scan.ids].filter(([id]) => !listedIds.has(id)).map(([, file]) => file) : []
    this.#engine.log(
      'info',
      `sync @${subscription.user}: ${analysis.entries.length} listed${incremental ? ' (incremental)' : ''}, ${scan.ids.size} in the folder, ${entries.length} new${gone.length ? `, ${gone.length} gone from TikTok` : ''}`,
    )
    return {
      listed: analysis.entries.length,
      total: analysis.total,
      inFolder: scan.ids.size,
      entries,
      gone,
      caughtUp: analysis.caughtUp === true,
    }
  }

  async #batchChanged(batch: BatchSnapshot): Promise<void> {
    const link = this.#batches.get(batch.id)
    if (!link || !['completed', 'completed-with-errors', 'failed', 'cancelled'].includes(batch.status)) return
    this.#batches.delete(batch.id)
    await link.release()
    const subscription = await this.#store.get(link.subscriptionId)
    const run = subscription?.runs.find(item => item.id === link.runId)
    if (!subscription || !run) return
    await this.#saveRun(subscription.id, {
      ...run,
      status:
        batch.status === 'cancelled'
          ? 'interrupted'
          : batch.status === 'failed' && !batch.jobs.succeeded
            ? 'failed'
            : 'done',
      finishedAt: Date.now(),
      downloaded: batch.jobs.succeeded,
      failed: batch.jobs.failed + batch.preflight.unavailable,
      ...(batch.error && batch.jobs.succeeded === 0 && {error: batch.error.message}),
    })
    this.#setState(subscription, 'idle')
  }

  /**
   * A run left "running" by a process that is gone (the app closed or
   * crashed mid-sync) is marked interrupted — unless a live process still
   * holds its lock (`mdc sync` running right now).
   */
  async #reconcile(subscription: Subscription): Promise<void> {
    const run = subscription.runs[0]
    if (run?.status !== 'running' || this.#busy(subscription.id)) return
    const held = JSON.parse(
      await fs.readFile(path.join(this.#lockDir, `sync-${subscription.id}.lock`), 'utf8').catch(() => '{}'),
    ) as {pid?: number; at?: number}
    const live = held.pid !== undefined && held.pid !== process.pid && isAlive(held.pid)
    if (live && Date.now() - (held.at ?? 0) < STALE_LOCK_MS) return
    await this.#saveRun(subscription.id, {...run, status: 'interrupted', finishedAt: Date.now()})
  }

  async #saveRun(subscriptionId: string, run: SyncRun): Promise<void> {
    const current = await this.#store.get(subscriptionId)
    if (!current) return
    const runs = [run, ...current.runs.filter(item => item.id !== run.id)].slice(0, MAX_RUNS)
    const next = {...current, runs}
    await this.#store.put(next)
    this.#emitView(next)
  }

  #busy(id: string): boolean {
    return (this.#state.get(id)?.state ?? 'idle') !== 'idle'
  }

  #setState(subscription: Subscription, state: SyncState, progress?: SubscriptionView['progress']): void {
    this.#state.set(subscription.id, {state, ...(progress && {progress})})
    void this.#store.get(subscription.id).then(latest => latest && this.#emitView(latest))
  }

  #view(subscription: Subscription): SubscriptionView {
    const live = this.#state.get(subscription.id)
    return {
      ...subscription,
      state: live?.state ?? 'idle',
      ...(live?.progress && {progress: live.progress}),
      nextRunAt: nextRunAt(subscription),
    }
  }

  #emitView(subscription: Subscription): void {
    this.emit('subscription', this.#view(subscription))
  }

  async #require(id: string): Promise<Subscription> {
    const subscription = await this.#store.get(id)
    if (!subscription) throw new DownloadError('invalid-request', `No sync with id ${id}.`)
    return subscription
  }

  #folder(folder: string): string {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
      throw new DownloadError('invalid-request', 'The folder must be an absolute path.')
    }
    return path.resolve(folder)
  }

  #schedule(raw: unknown): SyncSchedule {
    const schedule = syncSchedule(raw)
    if (!schedule) throw new DownloadError('invalid-request', 'Schedule: manual, daily at HH:MM, or every 1–168 hours.')
    return schedule
  }

  /**
   * A subscription syncs once at a time across processes (the app and
   * `mdc sync`): a lock file per subscription with the owner's pid, taken
   * over when that process is gone or the lock is older than STALE_LOCK_MS.
   */
  async #lock(subscription: Subscription): Promise<() => Promise<void>> {
    const file = path.join(this.#lockDir, `sync-${subscription.id}.lock`)
    const mine = JSON.stringify({pid: process.pid, at: Date.now()})
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(file, mine, {flag: 'wx'})
        return async () => {
          const held = await fs.readFile(file, 'utf8').catch(() => '')
          if (held === mine) await fs.rm(file, {force: true})
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const held = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}')) as {pid?: number; at?: number}
        const owner = held.pid !== undefined && (held.pid === process.pid || isAlive(held.pid))
        if (owner && Date.now() - (held.at ?? 0) < STALE_LOCK_MS) {
          throw new DownloadError(
            'invalid-request',
            held.pid === process.pid
              ? `@${subscription.user} is already syncing.`
              : `@${subscription.user} is syncing in another process (pid ${held.pid}); try again when it ends.`,
          )
        }
        await fs.rm(file, {force: true}) // a crashed owner's lock
      }
    }
    throw new DownloadError('invalid-request', 'Could not take the sync lock.')
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** No sync of it has finished yet: the next one is a full check. */
const firstSync = (subscription: Subscription): boolean => !subscription.runs.some(run => run.status === 'done')

/** Video folders get slideshows as videos (a folder of images is not a file in the folder's format). */
function slideshowFor(profile: FormatProfile, slideshow: SlideshowOptions | undefined): {slideshow?: SlideshowOptions} {
  if (profile.kind !== 'video') return {}
  return {slideshow: {...slideshowOptions(slideshow), mode: 'video'}}
}
