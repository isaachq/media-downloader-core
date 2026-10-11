import * as path from 'node:path'
import {type RunOptions, type RunResult, run} from '../core/process.js'
import type {ExecutableSpec} from '../types.js'

/**
 * A program to start: a binary, or an interpreter plus fixed leading
 * arguments — e.g. `{command: 'python3', args: ['-m', 'yt_dlp']}` for a pip
 * install of yt-dlp.
 */
export type Executable = {
  readonly command: string
  readonly args: readonly string[]
}

export type {ExecutableSpec} from '../types.js'

export function toExecutable(spec: ExecutableSpec): Executable {
  return typeof spec === 'string' ? {command: spec, args: []} : {command: spec.command, args: spec.args ?? []}
}

export function invoke(exe: Executable, args: readonly string[], opts?: RunOptions): Promise<RunResult> {
  return run(exe.command, exe.args.length ? [...exe.args, ...args] : args, opts)
}

/** Human-readable form, for logs and diagnostics. */
export function describeExecutable(exe: Executable): string {
  return [exe.command, ...exe.args].join(' ')
}

/**
 * The file path of a plain binary, for tools that need a real path (yt-dlp's
 * --ffmpeg-location). Undefined for wrapped commands and bare PATH names.
 */
export function binaryPath(exe: Executable): string | undefined {
  return exe.args.length === 0 && path.isAbsolute(exe.command) ? exe.command : undefined
}
