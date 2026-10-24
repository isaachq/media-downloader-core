// Pure renderers: data in, strings out. No I/O, no clocks — callers pass the
// animation tick and the width, which keeps every screen unit-testable.
import type {Diagnosis} from '../binaries/doctor.js'
import type {
  AnalysisResult,
  BatchSnapshot,
  FailureHint,
  JobSnapshot,
  JobStep,
  LogEntry,
  PreflightItem,
  StepState,
} from '../types.js'
import {formatBytes, formatClock, formatRate} from '../util/units.js'
import {fit, type Style} from './term.js'

export const shortId = (id: string): string => id.slice(0, 8)

/** ▰▰▰▰▱▱▱▱ for known progress; a sweeping block driven by `tick` when indeterminate. */
export function progressBar(fraction: number | undefined, width: number, style: Style, tick = 0): string {
  if (fraction === undefined) {
    const span = Math.max(1, Math.floor(width / 4))
    const start = (tick % (width + span)) - span
    let bar = ''
    for (let i = 0; i < width; i++) bar += i >= start && i < start + span ? '▰' : '▱'
    return style.dim(bar)
  }
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return style.green('▰'.repeat(filled)) + style.dark('▱'.repeat(width - filled))
}

const STEP_LETTER = {download: 'D', convert: 'C', validate: 'V', finalize: 'F'} as const

function stepGlyph(state: StepState, style: Style): string {
  switch (state) {
    case 'success':
      return style.green('✓')
    case 'failed':
      return style.red('✗')
    case 'in-progress':
      return style.lime('▸')
    case 'skipped':
      return style.dark('–')
    case 'pending':
      return style.dark('·')
  }
}

/** "D✓ C– V▸ F·" — the four sub-tasks at a glance. */
export function stepTrack(steps: readonly JobStep[], style: Style): string {
  return steps.map(step => `${style.dim(STEP_LETTER[step.name])}${stepGlyph(step.state, style)}`).join(' ')
}

/**
 * One live row of the dashboard, laid out for the available width: the
 * essentials always show (id, bar, %, status); speed, ETA, the step track
 * and the title join in priority order while they fit.
 */
export function jobLine(job: JobSnapshot, style: Style, width: number, tick = 0): string {
  const p = job.progress
  const downloading = job.status === 'downloading'
  const pct = p.fraction === undefined ? ' ···' : `${Math.round(p.fraction * 100)}%`.padStart(4)
  const barWidth = width >= 90 ? 16 : 10
  const segments: Array<{text: string; size: number}> = [
    {text: style.lime('▸'), size: 1},
    {text: style.dim(shortId(job.id)), size: 8},
    {text: progressBar(p.fraction, barWidth, style, tick), size: barWidth},
    {text: style.green(pct), size: 4},
    {text: style.cyan(job.status.toUpperCase().padEnd(11)), size: 11},
  ]
  const optional: Array<{text: string; size: number}> = [
    {text: stepTrack(job.steps, style), size: 11},
    ...(job.attempt > 1 ? [{text: style.yellow(`↻${job.attempt}/${job.maxAttempts}`), size: 4}] : []),
    {text: style.dim((downloading && p.speed ? formatRate(p.speed) : '').padStart(10)), size: 10},
    {text: style.dim((downloading && p.eta ? `eta ${formatClock(p.eta)}` : '').padEnd(10)), size: 10},
  ]
  let used = segments.reduce((sum, s) => sum + s.size + 1, 0)
  for (const segment of optional) {
    if (used + segment.size + 1 > width) break
    segments.push(segment)
    used += segment.size + 1
  }
  const room = width - used - 1
  if (room >= 8) segments.push({text: style.green(fit(job.title ?? job.url, room)), size: room})
  return segments.map(s => s.text).join(' ')
}

/** Permanent line printed when a job ends. */
export function finishedLine(job: JobSnapshot, style: Style, width: number): string {
  const title = fit(job.title ?? job.url, Math.max(10, width - 40))
  switch (job.status) {
    case 'completed': {
      const v = job.validation
      // "mp4 h264+aac 12 MB", or just "mp3 5 MB" when the container is the codec
      const codecs = [v?.video?.codec, v?.audio?.codec].filter(Boolean).join('+')
      // the file's extension says more than ffprobe's family name ("mov,mp4,m4a…")
      const container = job.filepath ? (job.filepath.split('.').pop() ?? '') : (v?.container.split(',')[0] ?? '')
      const facts = v
        ? [container === codecs ? '' : container, codecs, formatBytes(v.sizeBytes)].filter(Boolean).join(' ')
        : ''
      const retried = job.attempt > 1 ? style.yellow(` (attempt ${job.attempt})`) : ''
      return `${style.lime('✓')} ${style.dim(shortId(job.id))} ${style.green(title)} ${style.dark(facts)}${retried}`
    }
    case 'skipped':
      return `${style.dim('↷')} ${style.dim(shortId(job.id))} ${style.dim(title)} ${style.dark('already archived')}`
    case 'cancelled':
      return `${style.yellow('■')} ${style.dim(shortId(job.id))} ${style.dim(title)} ${style.yellow('cancelled')}`
    default: {
      const failed = job.attempts.at(-1)?.failedStep ?? 'start'
      return `${style.red('✗')} ${style.dim(shortId(job.id))} ${style.green(title)} ${style.red(`[${job.error?.code ?? 'unknown'}]`)} ${style.dim(`at ${failed}, attempt ${job.attempt}/${job.maxAttempts}:`)} ${job.error?.message ?? ''}`
    }
  }
}

const LEVEL_TAG = {debug: 'DBG ', info: 'INFO', warn: 'WARN', error: 'ERR '} as const

export function logLine(entry: LogEntry, style: Style): string {
  const time = new Date(entry.time).toISOString().slice(11, 19)
  const color = entry.level === 'error' ? style.red : entry.level === 'warn' ? style.yellow : style.dim
  const where = entry.jobId
    ? `${shortId(entry.jobId)}${entry.attempt ? ` #${entry.attempt}/${entry.maxAttempts}` : ''}${entry.step ? ` ${entry.step}` : ''}`
    : shortId(entry.batchId ?? entry.sessionId)
  return `${style.dark(time)} ${color(LEVEL_TAG[entry.level])} ${style.dim(where)}  ${color(entry.message)}`
}

/** Full-precision trace line for `mdc logs`: every id spelled out. */
export function traceLine(entry: LogEntry, style: Style): string {
  const ids = [
    `sid=${entry.sessionId}`,
    entry.jobId && `job=${entry.jobId}`,
    entry.attemptId && `att=${entry.attemptId}`,
    entry.stepId && `stp=${entry.stepId}`,
  ].filter(Boolean)
  return `${logLine(entry, style)}\n${style.dark(`         ${ids.join(' ')}`)}`
}

const STATE_TAG = {ok: '  OK  ', warn: ' WARN ', fail: ' FAIL '} as const

export function doctorReport(d: Diagnosis, style: Style): string {
  const tag = (state: keyof typeof STATE_TAG) => {
    const paintTag = state === 'fail' ? style.red : state === 'warn' ? style.yellow : style.green
    return `${style.dark('[')}${paintTag(STATE_TAG[state])}${style.dark(']')}`
  }
  const lines = [
    `${style.dim('platform')}  ${style.green(`${d.platform} · node ${d.node} · ${d.cpus} cpus → ${d.maxConcurrency} threads (N/2)`)}`,
    `${style.dim('data    ')}  ${tag(d.dataDir.state)} ${style.green(d.dataDir.path)}${d.dataDir.freeBytes ? style.dim(`  (${formatBytes(d.dataDir.freeBytes)} free)`) : ''}`,
    '',
  ]
  for (const tool of d.tools) {
    const where = tool.command
      ? `${tool.version} ${style.dark(`${tool.source} · ${tool.command}`)}`
      : style.red('not found')
    lines.push(`${style.dim(tool.name.padEnd(8))}  ${tag(tool.state)} ${style.green(where)}`)
    for (const note of tool.notes) lines.push(`${' '.repeat(19)}${style.yellow('↳')} ${style.dim(note)}`)
    if (tool.missing) {
      for (const [kind, names] of Object.entries(tool.missing)) {
        if (names.length)
          lines.push(`${' '.repeat(19)}${style.red('↳')} ${style.dim(`missing ${kind}: ${names.join(', ')}`)}`)
      }
    }
  }
  lines.push(
    '',
    d.ready
      ? style.lime('  ▓▒░ SYSTEM READY ░▒▓')
      : `${style.red('  ▓▒░ NOT READY ░▒▓')}  ${style.dim('run')} ${style.green('mdc setup')}`,
  )
  return lines.join('\n')
}

export function analysisReport(result: AnalysisResult, style: Style, width: number): string {
  const out: string[] = []
  if (result.kind === 'video') {
    const m = result.media
    out.push(
      `${style.lime('▶')} ${style.bold(style.green(fit(m.title, width - 4)))}`,
      `  ${style.dim([m.extractor, m.uploader, m.duration ? formatClock(m.duration) : undefined].filter(Boolean).join(' · '))}`,
    )
  } else {
    out.push(
      `${style.lime('▤')} ${style.bold(style.green(fit(result.title, width - 4)))}`,
      `  ${style.dim(`${result.extractor} · ${result.entries.length} items`)}`,
    )
    for (const entry of result.entries.slice(0, 15)) {
      const duration = entry.duration ? style.dark(` ${formatClock(entry.duration)}`) : ''
      out.push(
        `  ${style.dark(String(entry.index).padStart(4))} ${style.green(fit(entry.title, width - 16))}${duration}`,
      )
    }
    if (result.entries.length > 15) out.push(style.dark(`       … ${result.entries.length - 15} more`))
  }
  out.push('', style.dim('  formats  (mdc get <url> -f <format> -q <quality>)'))
  for (const choice of result.choices) {
    const p = choice.profile
    const flags = p.kind === 'video' ? `-f ${p.container} -q ${p.maxHeight ?? 'best'}` : `-f ${p.container}`
    const conv = choice.requiresConversion ? style.yellow(' converts locally') : ''
    out.push(`  ${style.green(choice.label.padEnd(44))} ${style.dark(flags)}${conv}`)
  }
  return out.join('\n')
}

/** Totals from the batch counters — exact for any size (the engine releases old finished jobs). */
export function summary(batch: BatchSnapshot, elapsedMs: number, sessionId: string, style: Style): string {
  const {succeeded, failed} = batch.jobs
  const unavailable = batch.preflight.unavailable
  const parts = [
    style.lime(`✓ ${succeeded} completed`),
    failed ? style.red(`✗ ${failed} failed`) : style.dim('✗ 0 failed'),
    unavailable ? style.yellow(`⊘ ${unavailable} unavailable`) : '',
    style.dim(`⏱ ${formatClock(elapsedMs / 1000) || '0:00'}`),
  ].filter(Boolean)
  const lines = [style.dark(`  ${'─'.repeat(10)} summary ${'─'.repeat(10)}`), `  ${parts.join('   ')}`]
  if (failed || unavailable) lines.push(style.dim(`  inspect:  mdc logs ${shortId(batch.id)}`))
  lines.push(style.dark(`  session ${sessionId}`))
  return lines.join('\n')
}

/** What to do about a failure, in plain words. */
export const HINT_TEXT: Readonly<Record<FailureHint, string>> = {
  'needs-sign-in': 'sign-in required — retry with --cookies <your browser>',
  private: 'private video',
  removed: 'removed or unavailable',
  'geo-blocked': 'blocked in your country',
  'members-only': 'members-only — needs the cookies of a member account (--cookies)',
  'not-started': 'live or premiere has not started',
  'unsupported-url': 'site or url not supported',
  'format-unavailable': 'the requested format is not offered',
  'retry-later': 'rate-limited by the site — try again later',
  'bot-check':
    "the site asks to confirm you're not a bot — it waits and retries; or retry with --cookies <your browser>",
  'cookies-unreadable':
    "couldn't read the browser's cookies (Safari: give the terminal Full Disk Access) — or try another browser",
  'damaged-source': 'the file is broken at the source — it is not downloaded again',
  'no-video': 'this post has pictures or text but no video',
  'live-now': 'a live stream on the air — download it once it ends, as a recording',
  'stream-only': 'offered only as a stream, which needs yt-dlp (not available here)',
}

/** "checking ▰▰▰▱▱ 12/50 · 10 ok · 2 unavailable" — the live preflight row. */
export function preflightLine(batch: BatchSnapshot, style: Style): string {
  const {total, checked, ok, unavailable} = batch.preflight
  const bad = unavailable ? style.yellow(` · ${unavailable} unavailable`) : ''
  return `${style.lime('◆')} ${style.dim(shortId(batch.id))} ${progressBar(total ? checked / total : undefined, 16, style)} ${style.cyan('CHECKING')} ${style.green(`${checked}/${total}`)} ${style.dim(`· ${ok} ok`)}${bad}`
}

/** Permanent line for a batch status change. */
export function batchLine(batch: BatchSnapshot, style: Style, width: number): string | undefined {
  const name = fit(batch.title ?? batch.url, Math.max(10, width - 40))
  switch (batch.status) {
    case 'scheduled':
      return `${style.dark('◆')} ${style.dim(shortId(batch.id))} ${style.dim('scheduled')} ${style.green(name)}${batch.position && batch.position > 1 ? style.dark(` (#${batch.position} in line)`) : ''}`
    case 'checking':
      return `${style.lime('◆')} ${style.dim(shortId(batch.id))} ${style.dim('checking')} ${style.green(name)}`
    case 'running': {
      const {ok, unavailable} = batch.preflight
      const skipped = unavailable ? style.yellow(` · ${unavailable} unavailable`) : ''
      return `${style.lime('◆')} ${style.dim(shortId(batch.id))} ${style.dim(batch.kind === 'playlist' ? 'playlist' : 'video')} ${style.green(name)} ${style.dim(`· ${ok} job${ok === 1 ? '' : 's'}`)}${skipped} ${style.dark(`→ ${batch.outDir}`)}`
    }
    default:
      return undefined
  }
}

const BATCH_STATUS_COLOR = {
  completed: 'lime',
  'completed-with-errors': 'yellow',
  failed: 'red',
  cancelled: 'yellow',
} as const

/** Closing report of a batch: its result and every item that couldn't be downloaded, with why. */
export function batchReport(
  batch: BatchSnapshot,
  unavailable: readonly PreflightItem[],
  style: Style,
  width: number,
): string {
  const tone = BATCH_STATUS_COLOR[batch.status as keyof typeof BATCH_STATUS_COLOR] ?? 'dim'
  const total = batch.preflight.total || batch.jobs.total
  const lines = [
    style.dark(`  ── batch ${batch.id} ──`),
    `  ${style[tone](batch.status.toUpperCase())}  ${style.green(fit(batch.title ?? batch.url, Math.max(10, width - 40)))} ${style.dim(`· ${batch.jobs.succeeded}/${total} succeeded`)}`,
  ]
  const shown = unavailable.slice(0, 50)
  for (const item of shown) {
    const why = item.error?.hint ? HINT_TEXT[item.error.hint] : (item.error?.message ?? 'unavailable')
    lines.push(
      `  ${style.red('✗')} ${style.dark(`#${item.index}`)} ${style.green(fit(item.title ?? item.url, Math.max(10, width - 60)))} ${style.dim('—')} ${style.yellow(why)}`,
    )
  }
  if (unavailable.length > shown.length)
    lines.push(style.dark(`    … ${unavailable.length - shown.length} more unavailable`))
  if (batch.error && batch.jobs.total === 0)
    lines.push(`  ${style.red(`[${batch.error.code}]`)} ${batch.error.message}`)
  return lines.join('\n')
}
