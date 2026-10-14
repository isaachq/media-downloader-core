import type {
  AttemptRecord,
  AttemptStrategy,
  JobError,
  JobId,
  JobOutcome,
  JobProgress,
  JobRequest,
  JobSnapshot,
  JobStatus,
  JobStep,
  JobTier,
  StepName,
  StepState,
  TerminalStatus,
  TraceId,
  ValidationReport,
} from '../types.js'
import {newId} from './ids.js'

const TERMINAL: ReadonlySet<JobStatus> = new Set<TerminalStatus>(['completed', 'skipped', 'failed', 'cancelled'])
export const STEP_ORDER: readonly StepName[] = ['download', 'convert', 'validate', 'finalize']

export const isTerminal = (status: JobStatus): status is TerminalStatus => TERMINAL.has(status)

const EMPTY_PROGRESS: JobProgress = Object.freeze({})

const freshSteps = (): JobStep[] => STEP_ORDER.map(name => ({id: newId(), name, state: 'pending'}))

function outcomeOf(status: JobStatus): JobOutcome {
  if (status === 'completed' || status === 'skipped') return 'success'
  return status === 'failed' || status === 'cancelled' ? 'failed' : 'in-progress'
}

export type JobPatch = {
  status?: JobStatus
  progress?: JobProgress
  title?: string | undefined
  mediaId?: string | undefined
}

/**
 * Mutable state of one job, owned by the downloader. The outside world only
 * sees frozen `JobSnapshot`s, built lazily and cached until the next change,
 * so reading a job between changes allocates nothing.
 */
export class Job {
  status: JobStatus = 'queued'
  progress: JobProgress = EMPTY_PROGRESS
  title: string | undefined
  mediaId: string | undefined
  filepath: string | undefined
  validation: ValidationReport | undefined
  /** Finished with its check put off until its batch has downloaded everything. */
  validationPending = false
  error: JobError | undefined
  readonly createdAt = Date.now()
  startedAt: number | undefined
  finishedAt: number | undefined

  /** Fixed-size (4) array indexed like STEP_ORDER: updates are O(1). */
  #steps: JobStep[] = freshSteps()
  #attempts: AttemptRecord[] = []
  #currentStep: StepName | undefined

  controller: AbortController | undefined
  /** When the last event went out, for throttling. */
  lastEmit = 0
  emitTimer: NodeJS.Timeout | undefined
  #snapshot: JobSnapshot | undefined

  constructor(
    readonly id: JobId,
    readonly request: JobRequest,
    readonly maxAttempts: number,
    readonly tier: JobTier,
    readonly weight: number,
  ) {
    this.title = request.title
    this.mediaId = request.mediaId
  }

  get terminal(): boolean {
    return isTerminal(this.status)
  }

  get attempt(): number {
    return this.#attempts.length
  }

  get currentStep(): StepName | undefined {
    return this.#currentStep
  }

  /** Apply a change. Returns whether the status changed (status changes are never throttled). */
  patch(patch: JobPatch): boolean {
    const statusChanged = patch.status !== undefined && patch.status !== this.status
    if (patch.status !== undefined) this.status = patch.status
    if (patch.progress !== undefined) this.progress = patch.progress
    if (patch.title !== undefined) this.title = patch.title
    if (patch.mediaId !== undefined) this.mediaId = patch.mediaId
    this.#snapshot = undefined
    return statusChanged
  }

  get attemptId(): TraceId | undefined {
    return this.#attempts.at(-1)?.id
  }

  /** Id of the step in progress (or last started) in the current attempt. */
  get stepId(): TraceId | undefined {
    const name = this.#currentStep
    return name === undefined ? undefined : this.#steps[STEP_ORDER.indexOf(name)]?.id
  }

  /** Start a new attempt: every step goes back to pending, with fresh ids. */
  beginAttempt(strategy: AttemptStrategy): number {
    this.#attempts.push({id: newId(), strategy, attempt: this.#attempts.length + 1, startedAt: Date.now()})
    this.#steps = freshSteps()
    this.#currentStep = undefined
    this.#snapshot = undefined
    return this.#attempts.length
  }

  /** Close the current attempt with its error and, if another follows, the wait before it. */
  endAttempt(error: JobError | undefined, retryInMs?: number): void {
    const last = this.#attempts.at(-1)
    if (!last) return
    this.#attempts[this.#attempts.length - 1] = {
      ...last,
      finishedAt: Date.now(),
      failedStep: error ? this.#currentStep : undefined,
      lastStatus: error ? this.status : undefined,
      lastProgress: error ? this.progress : undefined,
      error,
      retryInMs,
    }
    this.#snapshot = undefined
  }

  startStep(name: StepName): void {
    this.#setStep(name, 'in-progress')
    this.#currentStep = name
  }

  endStep(name: StepName, state: Exclude<StepState, 'pending' | 'in-progress'>, error?: JobError): void {
    this.#setStep(name, state, error)
  }

  /** Put a started step back to pending: it runs later (a check after the batch). */
  putOff(name: StepName): void {
    this.#setStep(name, 'pending')
  }

  /** Mark the step in progress as failed (no-op when none is). */
  failCurrentStep(error: JobError): void {
    const name = this.#currentStep
    const index = name === undefined ? -1 : STEP_ORDER.indexOf(name)
    if (name && this.#steps[index]?.state === 'in-progress') this.#setStep(name, 'failed', error)
  }

  #setStep(name: StepName, state: StepState, error?: JobError): void {
    const index = STEP_ORDER.indexOf(name)
    const previous = this.#steps[index]!
    const now = Date.now()
    this.#steps[index] = {
      id: previous.id,
      name,
      state,
      startedAt: state === 'in-progress' ? now : previous.startedAt,
      finishedAt: state === 'in-progress' ? undefined : now,
      error,
    }
    this.#snapshot = undefined
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

  /**
   * The check put off until after the batch: its verdict. A file that failed
   * turns a completed job into a failed one (outcome success → failed).
   */
  checkedLater(report: ValidationReport, error?: JobError): void {
    this.validationPending = false
    this.validation = report
    this.#setStep('validate', error ? 'failed' : 'success', error)
    if (error) {
      this.status = 'failed'
      this.error = error
    }
    this.#snapshot = undefined
  }

  snapshot(): JobSnapshot {
    this.#snapshot ??= Object.freeze({
      id: this.id,
      batchId: this.request.batchId,
      url: this.request.url,
      profile: this.request.profile,
      status: this.status,
      outcome: outcomeOf(this.status),
      tier: this.tier,
      weight: this.weight,
      estimatedBytes: this.request.estimatedBytes,
      title: this.title,
      mediaId: this.mediaId,
      playlist: this.request.playlist,
      progress: this.progress,
      steps: Object.freeze([...this.#steps]),
      attempts: Object.freeze([...this.#attempts]),
      attempt: this.attempt,
      maxAttempts: this.maxAttempts,
      filepath: this.filepath,
      validation: this.validation,
      ...(this.validationPending && {validationPending: true}),
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    })
    return this.#snapshot
  }

  /**
   * Drop everything that holds resources: pending timers, snapshot references, and the abort controller.
   *
   * Time Complexity: O(1).
   * Space Complexity: O(1).
   */
  release(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = undefined
    this.controller = undefined
    this.#snapshot = undefined
  }
}
