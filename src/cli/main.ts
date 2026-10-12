import {readFileSync} from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {BinaryError} from '../binaries/sources.js'
import {searchTrace} from '../core/trace-log.js'
import {MediaDownloader} from '../downloader.js'
import {BatchScheduler} from '../scheduler.js'
import {type SubscriptionView, SyncManager} from '../sync/manager.js'
import {isDue, type SyncRun} from '../sync/subscriptions.js'
import type {BatchSnapshot, BinaryPaths, ExecutableSpec} from '../types.js'
import {formatBytes} from '../util/units.js'
import {type Command, type GlobalOptions, HELP, parseCli} from './args.js'
import {banner, bootSequence} from './banner.js'
import {Dashboard} from './dashboard.js'
import {defaultDataDir, defaultDownloadDir} from './paths.js'
import {analysisReport, batchReport, doctorReport, logLine, progressBar, summary, traceLine} from './render.js'
import {createStyle, type Output, processOutput, type Style, wantsColor} from './term.js'

export const EXIT = {ok: 0, failures: 1, usage: 2, notReady: 3, interrupted: 130} as const

export type Io = {
  readonly out: Output
  readonly err: Output
  readonly env: NodeJS.ProcessEnv
}

type Context = {
  readonly io: Io
  readonly global: GlobalOptions
  readonly style: Style
  readonly dataDir: string
  readonly version: string
}

/** Walk up from this file to our package.json — works from src/ (tsx) and dist/ (bundle). */
export function packageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {name?: string; version?: string}
      if (pkg.name === 'media-downloader-core' && pkg.version) return pkg.version
    } catch {
      // not here — keep walking up
    }
    dir = path.dirname(dir)
  }
  return '0.0.0'
}

/** MDC_BINARIES='{"ytDlp": {"command": "python3", "args": ["-m", "yt_dlp"]}}' — advanced override. */
export function binariesFromEnv(env: NodeJS.ProcessEnv): BinaryPaths | string | undefined {
  const raw = env['MDC_BINARIES']
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'MDC_BINARIES is not valid JSON'
  }
  const isSpec = (value: unknown): value is ExecutableSpec =>
    typeof value === 'string' ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as {command?: unknown}).command === 'string' &&
      ((value as {args?: unknown}).args === undefined ||
        (Array.isArray((value as {args?: unknown}).args) &&
          (value as {args: unknown[]}).args.every(arg => typeof arg === 'string'))))
  if (typeof parsed !== 'object' || parsed === null) return 'MDC_BINARIES must be an object'
  const result: Record<string, ExecutableSpec> = {}
  for (const key of ['ytDlp', 'ffmpeg', 'ffprobe'] as const) {
    const value = (parsed as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (!isSpec(value)) return `MDC_BINARIES.${key} must be a path or {command, args}`
    result[key] = value
  }
  return result
}

function engine(ctx: Context, extra: Partial<ConstructorParameters<typeof MediaDownloader>[0]> = {}): MediaDownloader {
  const binaries = binariesFromEnv(ctx.io.env)
  if (typeof binaries === 'string') throw new UsageError(binaries)
  // test hook, as in the app: TikTok served by a local fake, without pacing delays
  const tiktokOrigin = ctx.io.env['MDC_TIKTOK_ORIGIN']
  return new MediaDownloader({
    dataDir: ctx.dataDir,
    ...(binaries && {binaries}),
    ...(tiktokOrigin && {tiktok: {origin: tiktokOrigin, pacing: {spacingMs: 0, jitterMs: 0}}}),
    ...extra,
  })
}

class UsageError extends Error {}

const line = (out: Output, text = '') => out.write(`${text}\n`)
const json = (out: Output, value: unknown) => out.write(`${JSON.stringify(value)}\n`)

function intro(ctx: Context): void {
  if (ctx.global.json || ctx.global.quiet) return
  ctx.io.out.write(banner(ctx.style, ctx.io.out.columns, ctx.version))
  line(ctx.io.out)
}

async function boot(ctx: Context, dl: MediaDownloader): Promise<boolean> {
  try {
    const bins = await dl.resolveBinaries()
    if (!ctx.global.json && !ctx.global.quiet) {
      line(
        ctx.io.out,
        bootSequence(ctx.style, [
          {label: 'session', value: dl.sessionId},
          {label: 'threads', value: `${dl.concurrency} of ${MediaDownloader.cpuCount()} cpus (max N/2)`},
          {label: 'yt-dlp', value: `${bins.ytDlp.version} · ${bins.ytDlp.source}`},
          {label: 'ffmpeg', value: `${bins.ffmpeg.version} · ${bins.ffmpeg.source}`},
          {label: 'validate', value: dl.validation},
        ]),
      )
      line(ctx.io.out)
    }
    return true
  } catch (error) {
    if (!(error instanceof BinaryError)) throw error
    if (ctx.global.json) json(ctx.io.out, {type: 'error', code: 'binary-missing', message: error.message})
    else line(ctx.io.err, `${ctx.style.red('✗')} ${error.message}`)
    return false
  }
}

// ─── commands ───────────────────────────────────────────────────────────────

async function doctor(ctx: Context): Promise<number> {
  const dl = engine(ctx)
  try {
    const diagnosis = await dl.diagnose()
    if (ctx.global.json) json(ctx.io.out, diagnosis)
    else {
      intro(ctx)
      line(ctx.io.out, doctorReport(diagnosis, ctx.style))
    }
    return diagnosis.ready ? EXIT.ok : EXIT.notReady
  } finally {
    await dl.dispose()
  }
}

async function setupCommand(ctx: Context, force: boolean): Promise<number> {
  const dl = engine(ctx)
  const {out} = ctx.io
  const live = out.isTTY && !ctx.global.json
  let lastStage = ''
  try {
    intro(ctx)
    const result = await dl.setup({
      force,
      onProgress: p => {
        if (ctx.global.json) return json(out, {type: 'progress', ...p})
        const label = `${p.tool} ${p.version ?? ''}`.trim()
        if (p.stage === 'downloading' && p.transfer && live) {
          const fraction = p.transfer.total ? p.transfer.received / p.transfer.total : undefined
          out.write(
            `\r  ${ctx.style.dim(label.padEnd(16))} ${progressBar(fraction, 24, ctx.style)} ${ctx.style.green(formatBytes(p.transfer.received).padStart(8))} ${ctx.style.dark(p.asset ?? '')}   `,
          )
          return
        }
        const key = `${p.tool}:${p.stage}:${p.asset ?? ''}`
        if (key === lastStage) return
        lastStage = key
        if (live) out.write('\r\x1b[2K')
        line(
          out,
          `  ${ctx.style.dark('»')} ${ctx.style.dim(label.padEnd(16))} ${ctx.style.green(p.stage)}${p.asset ? ctx.style.dark(` ${p.asset}`) : ''}`,
        )
      },
    })
    if (ctx.global.json) json(out, {type: 'result', ...result})
    else {
      if (live) out.write('\r\x1b[2K')
      line(
        out,
        result.installed.length
          ? `\n  ${ctx.style.lime('installed')} ${ctx.style.green(result.installed.join(', '))}\n`
          : `\n  ${ctx.style.dim('nothing to install')}\n`,
      )
      line(out, doctorReport(result.after, ctx.style))
    }
    return result.after.ready ? EXIT.ok : EXIT.notReady
  } finally {
    await dl.dispose()
  }
}

async function update(ctx: Context): Promise<number> {
  const dl = engine(ctx)
  try {
    const result = await dl.updateYtDlp()
    if (ctx.global.json) json(ctx.io.out, result)
    else
      line(
        ctx.io.out,
        result.updated
          ? `${ctx.style.lime('✓')} yt-dlp updated to ${result.version}`
          : `${ctx.style.dim('✓')} yt-dlp ${result.version} is current`,
      )
    return EXIT.ok
  } finally {
    await dl.dispose()
  }
}

async function info(ctx: Context, url: string): Promise<number> {
  const dl = engine(ctx)
  try {
    if (!(await boot(ctx, dl))) return EXIT.notReady
    const result = await dl.analyze(url)
    if (ctx.global.json) json(ctx.io.out, result)
    else line(ctx.io.out, analysisReport(result, ctx.style, ctx.io.out.columns))
    return EXIT.ok
  } finally {
    await dl.dispose()
  }
}

async function get(ctx: Context, command: Extract<Command, {name: 'get'}>): Promise<number> {
  const dl = engine(ctx, {
    ...(command.threads && {concurrency: command.threads}),
    ...(command.validation && {validation: command.validation}),
    ...(command.cookies && {cookiesFromBrowser: command.cookies}),
  })
  const scheduler = new BatchScheduler(dl, {preflight: command.check})
  const {out, err} = ctx.io
  const started = Date.now()
  let interrupted = false
  const onInterrupt = () => {
    if (interrupted) process.exit(EXIT.interrupted) // second Ctrl+C: force
    interrupted = true
    line(
      err,
      `\n${ctx.style.yellow('■ interrupt')} ${ctx.style.dim('— stopping; partial downloads are kept and resume next time (Ctrl+C again to force)')}`,
    )
    void scheduler.dispose().then(() => dl.dispose())
  }
  process.once('SIGINT', onInterrupt)

  const dashboard = ctx.global.json ? undefined : new Dashboard(out, ctx.style, ctx.global.verbose)
  try {
    intro(ctx)
    if (!(await boot(ctx, dl))) return EXIT.notReady
    if (ctx.global.json) {
      scheduler.on('batch', batch => json(out, {type: 'batch', ...batch}))
      scheduler.on('item', (batchId, item) => json(out, {type: 'item', batchId, ...item}))
      dl.on('job', snapshot => json(out, {type: 'job', ...snapshot}))
      dl.on('log', entry => json(out, {type: 'log', ...entry}))
    } else {
      let lastStatus: BatchSnapshot['status'] | undefined
      scheduler.on('batch', batch => {
        if (batch.status === 'checking') dashboard?.preflight(batch)
        if (batch.status === lastStatus) return
        lastStatus = batch.status
        dashboard?.batch(batch)
      })
      scheduler.on('item', (_batchId, item) => dashboard?.item(item))
      dl.on('job', snapshot => {
        dashboard?.job(snapshot)
        dashboard?.setQueued(dl.stats.queued)
      })
      dl.on('log', entry => dashboard?.log(entry))
    }

    const outDir = path.resolve(command.out ?? defaultDownloadDir())
    const scheduled = scheduler.schedule({url: command.url, profile: command.profile, outDir, items: command.items})
    await scheduler.whenIdle()
    // stop streaming before the summary, so it is always the last line (shutdown logs go to the trace file)
    scheduler.removeAllListeners('batch')
    scheduler.removeAllListeners('item')
    dl.removeAllListeners('job')
    dl.removeAllListeners('log')
    dashboard?.stop()

    const batch = scheduler.batch(scheduled.id)!
    const unavailable = scheduler.items(batch.id).filter(item => item.state === 'unavailable')
    if (ctx.global.json) {
      json(out, {
        type: 'summary',
        sessionId: dl.sessionId,
        batchId: batch.id,
        status: batch.status,
        jobs: batch.jobs,
        preflight: batch.preflight,
        elapsedMs: Date.now() - started,
      })
    } else {
      line(out, `\n${batchReport(batch, unavailable, ctx.style, out.columns)}`)
      line(out, summary(batch, Date.now() - started, dl.sessionId, ctx.style))
    }

    if (interrupted || batch.status === 'cancelled') return EXIT.interrupted
    return batch.status === 'completed' ? EXIT.ok : EXIT.failures
  } finally {
    dashboard?.stop()
    process.removeListener('SIGINT', onInterrupt)
    await scheduler.dispose()
    await dl.dispose()
  }
}

async function verify(ctx: Context): Promise<number> {
  const dl = engine(ctx)
  try {
    const checks = await dl.verifyArchive((done, total) => {
      if (ctx.io.out.isTTY && !ctx.global.json)
        ctx.io.out.write(`\r  ${progressBar(done / total, 24, ctx.style)} ${done}/${total}`)
    })
    const bad = checks.filter(check => !check.ok)
    if (ctx.global.json) json(ctx.io.out, checks)
    else {
      if (ctx.io.out.isTTY) ctx.io.out.write('\r\x1b[2K')
      for (const check of bad)
        line(ctx.io.out, `${ctx.style.red('✗')} ${ctx.style.yellow(check.problem ?? '')} ${check.entry.filepath}`)
      line(
        ctx.io.out,
        `${bad.length ? ctx.style.red(`✗ ${bad.length} problem(s)`) : ctx.style.lime('✓ archive intact')} ${ctx.style.dim(`· ${checks.length} files checked`)}`,
      )
    }
    return bad.length ? EXIT.failures : EXIT.ok
  } finally {
    await dl.dispose()
  }
}

async function logs(ctx: Context, id: string, limit?: number): Promise<number> {
  const {entries, total} = await searchTrace(path.join(ctx.dataDir, 'logs'), id, {limit})
  for (const entry of entries) {
    if (ctx.global.json) json(ctx.io.out, entry)
    else line(ctx.io.out, ctx.global.verbose ? traceLine(entry, ctx.style) : logLine(entry, ctx.style))
  }
  if (!ctx.global.json) {
    line(
      ctx.io.out,
      total
        ? ctx.style.dark(`\n  ${entries.length} of ${total} entries for ${id}`)
        : ctx.style.yellow(`no entries for ${id}`),
    )
  }
  return total ? EXIT.ok : EXIT.failures
}

/** An account by id (or the start of one) or @name. */
function findSubscription(list: readonly SubscriptionView[], target: string): SubscriptionView | string {
  const name = target.replace(/^@/, '').toLowerCase()
  const matches = list.filter(item => item.id.startsWith(target) || item.user.toLowerCase() === name)
  if (matches.length === 1) return matches[0]!
  return matches.length === 0
    ? `no sync matches "${target}" (see mdc sync list)`
    : `"${target}" matches ${matches.length} syncs: use the id`
}

const scheduleText = (schedule: SubscriptionView['schedule']): string =>
  schedule.every === 'day'
    ? `daily ${schedule.at}`
    : schedule.every === 'hours'
      ? `every ${schedule.hours} h`
      : 'on demand'

function runText(run: SyncRun, style: Style): string {
  const when = new Date(run.startedAt).toLocaleString()
  const parts = [
    `${run.new} new`,
    run.status === 'running' ? 'downloading' : `${run.downloaded} downloaded`,
    ...(run.failed ? [style.red(`${run.failed} failed`)] : []),
    `${run.inFolder} in the folder`,
    ...(run.gone ? [style.yellow(`${run.gone} gone from TikTok`)] : []),
  ]
  const status = run.status === 'done' ? style.lime('✓') : run.status === 'running' ? style.cyan('…') : style.red('✗')
  return `${status} ${style.dim(when)} ${parts.join(' · ')}${run.error ? ` ${style.red(run.error)}` : ''}`
}

async function syncCommand(ctx: Context, command: Extract<Command, {name: 'sync'}>): Promise<number> {
  const dl = engine(ctx)
  const scheduler = new BatchScheduler(dl)
  const sync = new SyncManager(dl, scheduler)
  const {out, err} = ctx.io
  try {
    if (command.action === 'list') {
      const list = await sync.list()
      if (ctx.global.json) {
        for (const item of list) json(out, item)
        return EXIT.ok
      }
      if (list.length === 0) line(out, ctx.style.dim('no synced accounts yet — mdc sync add @name --folder <dir>'))
      for (const item of list) {
        line(out, `${ctx.style.lime(`@${item.user}`)} ${ctx.style.dark(item.id.slice(0, 8))} → ${item.folder}`)
        line(
          out,
          `  ${ctx.style.dim(`${item.profile.container} · ${scheduleText(item.schedule)}${item.nextRunAt ? ` · next ${new Date(item.nextRunAt).toLocaleString()}` : ''}`)}`,
        )
        if (item.runs[0]) line(out, `  ${runText(item.runs[0], ctx.style)}`)
      }
      return EXIT.ok
    }
    if (command.action === 'add') {
      const added = await sync.add({
        url: command.account,
        folder: path.resolve(command.folder),
        profile: command.profile,
        schedule: command.schedule,
      })
      if (ctx.global.json) json(out, added)
      else
        line(
          out,
          `${ctx.style.lime('✓')} following @${added.user} into ${added.folder} ${ctx.style.dim(`(${scheduleText(added.schedule)}; id ${added.id.slice(0, 8)})`)}`,
        )
      return EXIT.ok
    }
    const list = await sync.list()
    if (command.action === 'remove') {
      const found = findSubscription(list, command.target)
      if (typeof found === 'string') throw new UsageError(found)
      await sync.remove(found.id)
      if (!ctx.global.json)
        line(
          out,
          `${ctx.style.lime('✓')} stopped following @${found.user} ${ctx.style.dim('(its folder is left as it is)')}`,
        )
      return EXIT.ok
    }

    // run
    let targets: SubscriptionView[] = list
    if (command.target) {
      const found = findSubscription(list, command.target)
      if (typeof found === 'string') throw new UsageError(found)
      targets = [found]
    } else if (command.due) targets = list.filter(item => isDue(item))
    if (targets.length === 0) {
      if (!ctx.global.json && !ctx.global.quiet)
        line(out, ctx.style.dim(command.due ? 'nothing due' : 'no synced accounts yet'))
      return EXIT.ok
    }
    if (!(await boot(ctx, dl))) return EXIT.notReady
    let problems = 0
    for (const item of targets) {
      if (!ctx.global.json)
        line(
          out,
          `${ctx.style.cyan('»')} @${item.user} ${ctx.style.dim(`→ ${item.folder}${command.deep ? ' · full check' : ''}`)}`,
        )
      try {
        if (command.dryRun) {
          const plan = await sync.check(item.id, {deep: command.deep})
          if (ctx.global.json) json(out, {type: 'plan', id: item.id, ...plan})
          else {
            line(
              out,
              `  ${plan.entries.length} new · ${plan.inFolder} in the folder · ${plan.listed} listed${plan.caughtUp ? ' (incremental)' : ''}${plan.gone.length ? ctx.style.yellow(` · ${plan.gone.length} gone from TikTok`) : ''}`,
            )
            for (const entry of plan.entries.slice(0, 20)) line(out, `  ${ctx.style.dark('+')} ${entry.title}`)
            if (plan.entries.length > 20) line(out, ctx.style.dark(`  … and ${plan.entries.length - 20} more`))
          }
          continue
        }
        const run = await sync.run(item.id, {deep: command.deep, trigger: command.due ? 'schedule' : 'cli'})
        const done = (await sync.whenDone(item.id, run.id)) ?? run
        if (ctx.global.json) json(out, {type: 'run', subscription: item.id, ...done})
        else line(out, `  ${runText(done, ctx.style)}`)
        if (done.status !== 'done' || done.failed > 0) problems++
      } catch (error) {
        problems++
        const message = error instanceof Error ? error.message : String(error)
        if (ctx.global.json) json(out, {type: 'error', id: item.id, message})
        else line(err, `  ${ctx.style.red('✗')} ${message}`)
      }
    }
    return problems ? EXIT.failures : EXIT.ok
  } finally {
    sync.dispose()
    await scheduler.dispose()
    await dl.dispose()
  }
}

// ─── entry ──────────────────────────────────────────────────────────────────

export async function main(
  argv: readonly string[],
  io: Io = {out: processOutput(process.stdout), err: processOutput(process.stderr), env: process.env},
): Promise<number> {
  const parsed = parseCli(argv)
  if (!parsed.ok) {
    io.err.write(`mdc: ${parsed.error}\nrun "mdc --help" for usage\n`)
    return EXIT.usage
  }
  const {command, global} = parsed
  const ctx: Context = {
    io,
    global,
    style: createStyle(!global.json && wantsColor(io.out.isTTY, io.env, global.color)),
    dataDir: path.resolve(global.dataDir ?? defaultDataDir(io.env)),
    version: packageVersion(),
  }

  try {
    switch (command.name) {
      case 'version':
        line(io.out, ctx.version)
        return EXIT.ok
      case 'help':
        if (!global.quiet) io.out.write(banner(ctx.style, io.out.columns, ctx.version))
        line(io.out, `\n${HELP}`)
        return EXIT.ok
      case 'doctor':
        return await doctor(ctx)
      case 'setup':
        return await setupCommand(ctx, command.force)
      case 'update':
        return await update(ctx)
      case 'info':
        return await info(ctx, command.url)
      case 'get':
        return await get(ctx, command)
      case 'verify':
        return await verify(ctx)
      case 'logs':
        return await logs(ctx, command.id, command.limit)
      case 'sync':
        return await syncCommand(ctx, command)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err.write(`mdc: ${error.message}\n`)
      return EXIT.usage
    }
    const message = error instanceof Error ? error.message : String(error)
    if (global.json) json(io.out, {type: 'error', message})
    else io.err.write(`${ctx.style.red('✗')} ${message}\n`)
    return EXIT.failures
  }
}
