import * as fs from 'node:fs'

export type Rect = {readonly x: number; readonly y: number; readonly width: number; readonly height: number}
export type WindowState = Rect & {readonly maximized: boolean}

export const MIN_SIZE = {width: 960, height: 640} as const
/** Big enough for every panel; beyond this a wider window only adds empty margins. */
const MAX_SIZE = {width: 1600, height: 1050} as const
/** Share of the screen's work area a first launch takes. */
const SCREEN_SHARE = 0.92
/** A saved window is restored only if at least this much of it is on a connected screen. */
const MIN_VISIBLE = 120

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** First launch: ~92% of the work area (capped), centered. */
export function defaultBounds(work: Rect): WindowState {
  const width = clamp(Math.round(work.width * SCREEN_SHARE), MIN_SIZE.width, Math.min(MAX_SIZE.width, work.width))
  const height = clamp(Math.round(work.height * SCREEN_SHARE), MIN_SIZE.height, Math.min(MAX_SIZE.height, work.height))
  return {
    x: work.x + Math.round((work.width - width) / 2),
    y: work.y + Math.round((work.height - height) / 2),
    width,
    height,
    maximized: false,
  }
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w >= MIN_VISIBLE && h >= MIN_VISIBLE ? w * h : 0
}

const isRect = (value: unknown): value is WindowState => {
  const v = value as Record<string, unknown> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    ['x', 'y', 'width', 'height'].every(key => Number.isFinite(v[key])) &&
    (v['maximized'] === undefined || typeof v['maximized'] === 'boolean')
  )
}

/**
 * Where the window opens: the saved bounds when they are still on a connected
 * screen (a monitor may have been unplugged), else the default for the
 * primary screen. O(displays).
 */
export function restoreBounds(saved: unknown, workAreas: readonly Rect[], primary: Rect): WindowState {
  if (!isRect(saved) || !workAreas.some(area => overlap(saved, area) > 0)) return defaultBounds(primary)
  return {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.max(MIN_SIZE.width, Math.round(saved.width)),
    height: Math.max(MIN_SIZE.height, Math.round(saved.height)),
    maximized: saved.maximized === true,
  }
}

/** Saved state, or undefined when missing or unreadable (never throws: start-up must not depend on it). */
export function readWindowState(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Atomic write (temp + rename); a failure only costs the remembered size. */
export function writeWindowState(file: string, state: WindowState): void {
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state))
    fs.renameSync(`${file}.tmp`, file)
  } catch {
    // read-only profile, full disk… the next launch uses the default size
  }
}
