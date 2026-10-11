import type {
  JobError,
  JobId,
  JobProgress,
  JobRequest,
  JobSnapshot,
  JobStatus,
  TerminalStatus,
  ValidationReport,
} from '../types.js'

const TERMINAL: ReadonlySet<JobStatus> = new Set<TerminalStatus>(['completed', 'skipped', 'failed', 'cancelled'])

export const isTerminal = (status: JobStatus): status is TerminalStatus => TERMINAL.has(status)

const EMPTY_PROGRESS: JobProgress = Object.freeze({})

export type JobPatch = {
  status?: JobStatus
  progress?: JobProgress
  title?: string | undefined
  mediaId?: string | undefined
}

/**
 * Mutable state of one job, owned by the downloader. The outside world only
 * ever sees frozen `JobSnapshot`s, built lazily and cached until the next
 * change — reading a job many times between changes allocates nothing.
 */
export class Job {
  status: JobStatus = 'queued'
  progress: JobProgress = EMPTY_PROGRESS
  attempt = 0
  title: string | undefined
  mediaId: string | undefined
  filepath: string | undefined
  validation: ValidationReport | undefined
  error: JobError | undefined
  readonly createdAt = Date.now()
  startedAt: number | undefined
  finishedAt: number | undefined

  controller: AbortController | undefined
  /** When the last event went out, for throttling. */
  lastEmit = 0
  emitTimer: NodeJS.Timeout | undefined
  #snapshot: JobSnapshot | undefined

  constructor(
    readonly id: JobId,
    readonly request: JobRequest,
  ) {
    this.title = request.title
    this.mediaId = request.mediaId
  }

  get terminal(): boolean {
    return isTerminal(this.status)
  }

  /** Apply a change. Returns whether the status changed (status changes are never throttled). */
  patch(patch: JobPatch): boolean {
    const statusChanged = patch.status !== undefined && patch.status !== this.status
    if (patch.status !== undefined) this.status = patch.status
    if (patch.progress !== undefined) this.progress = patch.progress
    if ('title' in patch && patch.title !== undefined) this.title = patch.title
    if ('mediaId' in patch && patch.mediaId !== undefined) this.mediaId = patch.mediaId
    this.#snapshot = undefined
    return statusChanged
  }

  finish(
    status: TerminalStatus,
    result: {filepath?: string | undefined; validation?: ValidationReport | undefined; error?: JobError | undefined},
  ): void {
    this.status = status
    this.finishedAt = Date.now()
    this.progress = status === 'completed' ? {fraction: 1} : EMPTY_PROGRESS
    this.filepath = result.filepath ?? this.filepath
    this.validation = result.validation ?? this.validation
    this.error = result.error
    this.#snapshot = undefined
    this.release()
  }

  snapshot(): JobSnapshot {
    this.#snapshot ??= Object.freeze({
      id: this.id,
      url: this.request.url,
      profile: this.request.profile,
      status: this.status,
      title: this.title,
      mediaId: this.mediaId,
      playlist: this.request.playlist,
      progress: this.progress,
      attempt: this.attempt,
      filepath: this.filepath,
      validation: this.validation,
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    })
    return this.#snapshot
  }

  /** Drop everything that holds resources: pending timers and the abort controller. */
  release(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = undefined
    this.controller = undefined
  }
}
