import type {BatchId, BatchSnapshot, JobId, JobSnapshot, JobStatus} from 'media-downloader-core'
import {BATCH_FINISHED, type JobCounts, WORKING} from './store'

/** Working stages, in pipeline order. */
export const STAGES = ['downloading', 'processing', 'converting', 'validating', 'finalizing'] as const
export type Stage = (typeof STAGES)[number]

/** Jobs listed per stage; the rest are counted ("+N more"). */
const PER_STAGE = 8
/** Finished and failed jobs listed in "recent". */
const RECENT = 5

export type ReportJob = {
  readonly id: JobId
  readonly batchId?: BatchId | undefined
  readonly title: string
  readonly status: JobStatus
  readonly fraction?: number | undefined
  /** Bytes per second while downloading. */
  readonly speed?: number | undefined
  readonly eta?: number | undefined
  readonly at?: number | undefined
  readonly error?: string | undefined
}

export type ReportBatch = {
  readonly id: BatchId
  readonly title: string
  readonly status: BatchSnapshot['status']
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly running: number
  readonly queued: number
  readonly unavailable: number
  readonly fraction: number
  readonly etaSeconds?: number | undefined
}

/** One reading of the whole run: what the three tabs show, summed up. */
export type Report = {
  readonly at: number
  readonly runId: string
  readonly startedAt: number
  readonly pending: number
  readonly inProgress: number
  readonly finished: number
  readonly skipped: number
  readonly failed: number
  readonly cancelled: number
  readonly stages: Readonly<Record<Stage, number>>
  /** Of everything scheduled in this run, weighted by size where batches measure it. 0…1. */
  readonly fraction: number
  /** Download speed of all jobs right now. */
  readonly speed: number
  readonly finishedBytes: number
  /** Until the running batches end (the longest of them). */
  readonly etaSeconds?: number | undefined
  readonly batchesWaiting: number
  readonly batches: readonly ReportBatch[]
  /** Working jobs per stage, at most PER_STAGE each, most advanced first. */
  readonly now: Readonly<Record<Stage, readonly ReportJob[]>>
  readonly recentDone: readonly ReportJob[]
  readonly recentFailed: readonly ReportJob[]
}

const title = (job: JobSnapshot): string => job.title ?? job.url

function toReportJob(job: JobSnapshot): ReportJob {
  return {
    id: job.id,
    batchId: job.batchId,
    title: title(job),
    status: job.status,
    fraction: job.progress.fraction,
    speed: job.status === 'downloading' ? job.progress.speed : undefined,
    eta: job.status === 'downloading' ? job.progress.eta : undefined,
    at: job.finishedAt,
    error: job.error?.message,
  }
}

/** Keep the `n` items with the highest key, O(items × n) with a tiny n — no full sort of thousands of jobs. */
function topBy<T>(items: Iterable<T>, n: number, key: (item: T) => number): T[] {
  const top: T[] = []
  for (const item of items) {
    const k = key(item)
    if (top.length === n && k <= key(top[n - 1]!)) continue
    let at = top.findIndex(other => k > key(other))
    if (at === -1) at = top.length
    top.splice(at, 0, item)
    if (top.length > n) top.pop()
  }
  return top
}

/**
 * Sum up the run. Totals come from the running counts (O(1)) and the batch
 * snapshots (one per batch); only working jobs — bounded by the pool — and
 * the store's retained finished jobs are walked, once.
 */
export function buildReport(input: {
  readonly runId: string
  readonly startedAt: number
  readonly counts: JobCounts
  readonly batches: Iterable<BatchSnapshot>
  readonly jobs: Iterable<JobSnapshot>
  readonly now?: number | undefined
}): Report {
  const {counts} = input
  const stages = Object.fromEntries(STAGES.map(stage => [stage, counts[stage]])) as Record<Stage, number>
  const working: Record<Stage, JobSnapshot[]> = {
    downloading: [],
    processing: [],
    converting: [],
    validating: [],
    finalizing: [],
  }
  const done: JobSnapshot[] = []
  const failed: JobSnapshot[] = []
  let speed = 0
  for (const job of input.jobs) {
    if (WORKING.has(job.status)) {
      working[job.status as Stage].push(job)
      if (job.status === 'downloading') speed += job.progress.speed ?? 0
    } else if (job.status === 'completed') done.push(job)
    else if (job.status === 'failed') failed.push(job)
  }

  // running first, then the line, then finished newest first — as the Batches tab
  const order = (status: BatchSnapshot['status']) =>
    status === 'running' || status === 'checking' ? 0 : status === 'scheduled' ? 1 : 2
  const snapshots = [...input.batches].sort((a, b) => order(a.status) - order(b.status) || b.createdAt - a.createdAt)
  const batches: ReportBatch[] = []
  let weighted = 0
  let items = 0
  let batchesWaiting = 0
  let etaSeconds: number | undefined
  for (const batch of snapshots) {
    if (batch.status === 'scheduled') batchesWaiting++
    const total = batch.jobs.total || batch.preflight.ok
    const settled = batch.jobs.succeeded + batch.jobs.failed
    const finishedBatch = BATCH_FINISHED.has(batch.status)
    const fraction = finishedBatch
      ? 1
      : batch.status === 'checking'
        ? 0
        : (batch.progress?.fraction ?? (total ? settled / total : 0))
    if (batch.status === 'running' && batch.progress?.etaSeconds !== undefined) {
      etaSeconds = Math.max(etaSeconds ?? 0, batch.progress.etaSeconds)
    }
    weighted += fraction * total
    items += total
    batches.push({
      id: batch.id,
      title: batch.title ?? batch.url,
      status: batch.status,
      total,
      succeeded: batch.jobs.succeeded,
      failed: batch.jobs.failed,
      running: batch.jobs.running,
      queued: batch.jobs.queued,
      unavailable: batch.preflight.unavailable,
      fraction,
      etaSeconds: batch.status === 'running' ? batch.progress?.etaSeconds : undefined,
    })
  }
  const now = Object.fromEntries(
    STAGES.map(stage => [stage, topBy(working[stage], PER_STAGE, job => job.progress.fraction ?? 0).map(toReportJob)]),
  ) as Record<Stage, ReportJob[]>

  return {
    at: input.now ?? Date.now(),
    runId: input.runId,
    startedAt: input.startedAt,
    pending: counts.queued,
    inProgress: STAGES.reduce((sum, stage) => sum + counts[stage], 0),
    finished: counts.completed,
    skipped: counts.skipped,
    failed: counts.failed,
    cancelled: counts.cancelled,
    stages,
    fraction: items ? weighted / items : 0,
    speed,
    finishedBytes: counts.finishedBytes,
    etaSeconds,
    batchesWaiting,
    batches,
    now,
    recentDone: topBy(done, RECENT, job => job.finishedAt ?? 0).map(toReportJob),
    recentFailed: topBy(failed, RECENT, job => job.finishedAt ?? 0).map(toReportJob),
  }
}

/** The report as plain text, for pasting into a message or a ticket. */
export function reportText(
  report: Report,
  format: {
    readonly label: (key: string, params?: Readonly<Record<string, string | number>>) => string
    readonly bytes: (value: number) => string
    readonly rate: (value: number) => string
    readonly time: (ms: number) => string
    readonly left: (seconds: number) => string
  },
): string {
  const {label} = format
  const percent = (fraction: number) => `${Math.floor(fraction * 100)}%`
  const lines = [
    `${label('report.title')} — ${format.time(report.at)}`,
    `${label('report.runId')}: ${report.runId}`,
    `${label('report.started')}: ${format.time(report.startedAt)}`,
    '',
    `${label('report.overall')}: ${percent(report.fraction)}${report.etaSeconds !== undefined ? ` · ${label('report.eta')}: ${format.left(report.etaSeconds)}` : ''}`,
    `${label('report.pending')}: ${report.pending} · ${label('report.inProgress')}: ${report.inProgress} · ${label('report.finished')}: ${report.finished} · ${label('report.failed')}: ${report.failed}`,
    `${STAGES.map(stage => `${label(`job.status.${stage}`)}: ${report.stages[stage]}`).join(' · ')}`,
    `${label('report.speed')}: ${format.rate(report.speed)} · ${label('report.downloaded')}: ${format.bytes(report.finishedBytes)}`,
  ]
  if (report.skipped) lines.push(label('report.skipped', {count: report.skipped}))
  if (report.batches.length) {
    lines.push('', `${label('report.batches')}:`)
    for (const batch of report.batches) {
      lines.push(
        `- [${label(`batch.status.${batch.status}`)}] ${batch.title} (${batch.id}) — ${batch.succeeded}/${batch.total} · ${percent(batch.fraction)}${batch.failed ? ` · ${label('report.failed')}: ${batch.failed}` : ''}`,
      )
    }
  }
  const working = STAGES.flatMap(stage => report.now[stage])
  if (working.length) {
    lines.push('', `${label('report.now')}:`)
    for (const job of working) {
      lines.push(
        `- ${label(`job.status.${job.status}`)}: ${job.title}${job.fraction !== undefined ? ` (${percent(job.fraction)})` : ''}`,
      )
    }
  }
  if (report.recentFailed.length) {
    lines.push('', `${label('report.recentFailed')}:`)
    for (const job of report.recentFailed) lines.push(`- ${job.title}: ${job.error ?? ''}`)
  }
  return lines.join('\n')
}
