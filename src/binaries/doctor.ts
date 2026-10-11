import {constants} from 'node:fs'
import * as fs from 'node:fs/promises'
import {freeSpace} from '../core/files.js'
import {cpuCount, maxConcurrency} from '../core/pool.js'
import {type CapabilityKind, inspectFfmpeg} from './capabilities.js'
import {describeExecutable} from './executable.js'
import type {BinaryManager, ResolvedTool, ToolName, ToolSource} from './manager.js'

/** yt-dlp older than this is likely broken for YouTube. */
const YT_DLP_MAX_AGE_DAYS = 90
const MIN_NODE_MAJOR = 20
const LOW_SPACE_BYTES = 2 * 1024 ** 3

export type CheckState = 'ok' | 'warn' | 'fail'

export type ToolReport = {
  readonly name: ToolName
  readonly state: CheckState
  readonly command?: string | undefined
  readonly version?: string | undefined
  readonly source?: ToolSource | undefined
  /** ffmpeg only: requirements its build doesn't meet. */
  readonly missing?: Readonly<Record<CapabilityKind, readonly string[]>> | undefined
  readonly notes: readonly string[]
}

export type Diagnosis = {
  /** Every tool usable and nothing failing — downloads can start. */
  readonly ready: boolean
  readonly platform: string
  readonly cpus: number
  readonly maxConcurrency: number
  readonly node: string
  readonly dataDir: {readonly path: string; readonly state: CheckState; readonly freeBytes?: number | undefined}
  readonly tools: readonly ToolReport[]
}

/** "2026.08.19" → age in days, or undefined for non-date versions (pip / git builds). */
export function ytDlpAgeDays(version: string, now = Date.now()): number | undefined {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version)
  if (!match) return undefined
  const released = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Math.floor((now - released) / 86_400_000)
}

function toolReport(name: ToolName, tool: ResolvedTool | undefined, notes: string[], state?: CheckState): ToolReport {
  if (!tool) return {name, state: 'fail', notes: ['Not installed — run `mdc setup`.', ...notes]}
  return {
    name,
    state: state ?? 'ok',
    command: describeExecutable(tool.exe),
    version: tool.version,
    source: tool.source,
    notes,
  }
}

async function writable(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, {recursive: true})
    await fs.access(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Check everything a download needs, without changing anything. */
export async function diagnose(manager: BinaryManager, dataDir: string): Promise<Diagnosis> {
  const [ytDlp, ffmpeg, ffprobe, canWrite, free] = await Promise.all([
    manager.locate('yt-dlp'),
    manager.locate('ffmpeg'),
    manager.locate('ffprobe'),
    writable(dataDir),
    freeSpace(dataDir),
  ])

  const ytNotes: string[] = []
  let ytState: CheckState | undefined
  const age = ytDlp && ytDlpAgeDays(ytDlp.version)
  if (age !== undefined && age > YT_DLP_MAX_AGE_DAYS) {
    ytState = 'warn'
    ytNotes.push(`${age} days old — sites change often; run \`mdc update\`.`)
  }

  const ffNotes: string[] = []
  let ffState: CheckState | undefined
  const caps = ffmpeg && (await inspectFfmpeg(ffmpeg.exe))
  if (ffmpeg && !caps) {
    ffState = 'fail'
    ffNotes.push('Could not list codecs.')
  }
  const missingCount = caps ? Object.values(caps.missing).flat().length : 0
  if (missingCount > 0) {
    ffState = 'fail'
    ffNotes.push(`Build lacks ${missingCount} required codec(s)/format(s) — run \`mdc setup --force\`.`)
  }

  const nodeMajor = Number(process.versions.node.split('.', 1)[0])
  if (nodeMajor < MIN_NODE_MAJOR) {
    ytState = 'warn'
    ytNotes.push(`Node ${process.versions.node} is too old as yt-dlp's JavaScript runtime (needs ${MIN_NODE_MAJOR}+).`)
  }

  const tools = [
    toolReport('yt-dlp', ytDlp, ytNotes, ytState),
    {...toolReport('ffmpeg', ffmpeg, ffNotes, ffState), missing: caps?.missing},
    toolReport('ffprobe', ffprobe, []),
  ]
  const dataState: CheckState = !canWrite ? 'fail' : free !== undefined && free < LOW_SPACE_BYTES ? 'warn' : 'ok'

  return {
    ready: dataState !== 'fail' && tools.every(tool => tool.state !== 'fail'),
    platform: `${process.platform}-${process.arch}`,
    cpus: cpuCount(),
    maxConcurrency: maxConcurrency(),
    node: process.versions.node,
    dataDir: {path: dataDir, state: dataState, freeBytes: free},
    tools,
  }
}

export type SetupResult = {
  readonly installed: readonly string[]
  readonly before: Diagnosis
  readonly after: Diagnosis
}

/**
 * Bring the environment to "ready": install yt-dlp and/or ffmpeg when they
 * are missing, outdated or incapable (or always, with `force`), then
 * diagnose again to prove the result.
 */
export async function setup(
  manager: BinaryManager,
  dataDir: string,
  opts: Parameters<BinaryManager['install']>[1] & {readonly force?: boolean | undefined} = {},
): Promise<SetupResult> {
  const before = await diagnose(manager, dataDir)
  const needs = (name: ToolName) => opts.force || before.tools.find(tool => tool.name === name)?.state !== 'ok'
  const installed: string[] = []

  if (needs('yt-dlp')) installed.push(`yt-dlp ${(await manager.install('yt-dlp', opts)).version}`)
  if (needs('ffmpeg') || needs('ffprobe')) installed.push(`ffmpeg ${(await manager.install('ffmpeg', opts)).version}`)

  manager.invalidate()
  return {installed, before, after: await diagnose(manager, dataDir)}
}
