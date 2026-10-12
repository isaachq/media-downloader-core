import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {UpdateState} from '../../shared/contract'
import {downloadUpdate, UpdateError} from './download'
import {type InstallKind, pickUpdate, RELEASES_API, RELEASES_PAGE, type UpdateOffer} from './feed'
import {INSTALL_LOG, type InstallContext, installUpdate, NOT_INSTALLED} from './install'

export type UpdaterOptions = {
  readonly current: string
  readonly kind: InstallKind | undefined
  readonly arch: string
  /** Where verified downloads and helper scripts go. */
  readonly dir: string
  readonly bundleId: string
  readonly execPath: string
  readonly env: NodeJS.ProcessEnv
  /** Tests: a local feed and download host instead of GitHub. */
  readonly feedUrl?: string | undefined
  readonly trustedPrefix?: string | undefined
  /** Tests: stop once the update is downloaded and verified. */
  readonly dryRun?: boolean | undefined
  readonly fetch?: typeof fetch | undefined
  /** Leaves the app after a successful install ('quit' or 'relaunch'). */
  readonly exit: (how: 'quit' | 'relaunch') => void
}

/**
 * Checks this project's releases, and on request downloads the update,
 * verifies it (size + GitHub's SHA-256), installs it and restarts the app.
 * One state at a time, pushed to the UI on every change.
 */
export class Updater {
  readonly #opts: UpdaterOptions
  readonly #listeners = new Set<(state: UpdateState) => void>()
  #state: UpdateState = {status: 'idle'}
  #offer: UpdateOffer | undefined
  #busy: Promise<void> | undefined

  constructor(opts: UpdaterOptions) {
    this.#opts = opts
    if (!opts.kind) this.#state = {status: 'unsupported', page: RELEASES_PAGE}
  }

  /**
   * Remove what earlier updates left (installers, staged bundles, scripts —
   * ~130 MB each): at start-up all of it is either installed or stale.
   */
  /**
   * Remove what earlier updates left behind. The Windows helper's log is read
   * first: an update that did not go in says why (state 'error') instead of
   * vanishing. Returns that log, for the trace.
   */
  async cleanUp(): Promise<string | undefined> {
    const log = await fs.readFile(path.join(this.#opts.dir, INSTALL_LOG), 'utf8').catch(() => undefined)
    await fs.rm(this.#opts.dir, {recursive: true, force: true}).catch(() => {})
    const failed = log?.split(/\r?\n/).find(line => line.includes(NOT_INSTALLED))
    if (failed) {
      const why = failed.slice(failed.indexOf(NOT_INSTALLED) + NOT_INSTALLED.length).trim()
      this.#set({status: 'error', message: `The last update was not installed: ${why}.`, page: RELEASES_PAGE})
    }
    return log
  }

  get state(): UpdateState {
    return this.#state
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Ask GitHub for a newer version. Quiet errors leave the state as it was (background checks). */
  async check(opts: {quiet?: boolean} = {}): Promise<UpdateState> {
    if (!this.#opts.kind || this.#busy) return this.#state
    if (!opts.quiet) this.#set({status: 'checking'})
    try {
      const response = await (this.#opts.fetch ?? fetch)(this.#opts.feedUrl ?? `${RELEASES_API}?per_page=20`, {
        headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'media-download-core-updater'},
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new UpdateError(`GitHub answered HTTP ${response.status}.`)
      const offer = pickUpdate(
        await response.json(),
        this.#opts.current,
        this.#opts.kind,
        this.#opts.arch,
        this.#opts.trustedPrefix,
      )
      this.#offer = offer
      this.#set(
        offer
          ? {status: 'available', version: offer.version, notes: offer.notes, page: offer.page, size: offer.asset.size}
          : {status: 'up-to-date', checkedAt: Date.now()},
      )
    } catch (error) {
      if (!opts.quiet) this.#set({status: 'error', message: messageOf(error), page: RELEASES_PAGE})
    }
    return this.#state
  }

  /** Download, verify, install, restart. Safe to call twice: the second call joins the first. */
  update(): Promise<void> {
    this.#busy ??= this.#update().finally(() => {
      this.#busy = undefined
    })
    return this.#busy
  }

  async #update(): Promise<void> {
    const offer = this.#offer
    const kind = this.#opts.kind
    if (!offer || !kind) return
    const base = {version: offer.version, page: offer.page}
    try {
      this.#set({status: 'downloading', ...base, received: 0, total: offer.asset.size})
      let last = 0
      const file = await downloadUpdate({
        asset: offer.asset,
        dir: this.#opts.dir,
        fetch: this.#opts.fetch,
        onProgress: (received, total) => {
          // at most ~100 UI updates per download
          if (received - last < total / 100 && received < total) return
          last = received
          this.#set({status: 'downloading', ...base, received, total})
        },
      })
      if (this.#opts.dryRun) {
        this.#set({status: 'ready', ...base, file})
        return
      }
      this.#set({status: 'installing', ...base})
      const ctx: InstallContext = {
        kind,
        file,
        version: offer.version,
        bundleId: this.#opts.bundleId,
        execPath: this.#opts.execPath,
        pid: process.pid,
        env: this.#opts.env,
        workDir: this.#opts.dir,
      }
      this.#opts.exit(await installUpdate(ctx))
    } catch (error) {
      this.#set({status: 'error', message: messageOf(error), ...base})
    }
  }

  #set(state: UpdateState): void {
    this.#state = state
    for (const listener of this.#listeners) listener(state)
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
