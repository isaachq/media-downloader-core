/**
 * The resume file of an HLS download: `<dir>/state.json`, a constant-size cursor per track (P periods,
 * P small), rewritten whole with tmp + rename at most once per second (`StateWriter`).
 *
 * Order of writes makes it crash-safe without an fsync per segment: the period file is appended, then
 * (≤ 1/s) the cursor is written. A crash leaves the file longer than `bytes`, never shorter: resume
 * truncates it and redoes at most one second of segments.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {shortHash} from '../files.js'
import {type HlsMediaPlaylist, pathOf} from './playlist.js'

export type HlsTrack = 'main' | 'audio'

export type HlsTrackCursor = {
  /** Media sequence number of the first segment not yet appended. */
  readonly next: number
  /** Period whose file is being appended. */
  readonly period: number
  /** Valid length of that period's file: truncated to this on resume. */
  readonly bytes: number
  /** The finished periods' files, [period, length] (checked by one stat each on resume). */
  readonly periods: ReadonlyArray<readonly [period: number, bytes: number]>
  /** Media measured so far (network bytes, seconds of EXTINF): the forecast average survives a restart. */
  readonly measured: {readonly bytes: number; readonly seconds: number}
  readonly skipped: number
}

export type HlsResumeState = {
  readonly v: 1
  /** `playlistIdentity` of what is being downloaded: a mismatch drops the state and every file of the folder. */
  readonly id: string
  readonly tracks: Readonly<Partial<Record<HlsTrack, HlsTrackCursor>>>
}

export const STATE_FILE = 'state.json'

/**
 * The identity hash of a track set, query strings removed (tokens change on every refresh and restart):
 * the playlist path, its first sequence, segment count, and first and last segment paths, per track.
 * O(1): never the whole list.
 */
export function playlistIdentity(main: HlsMediaPlaylist, audio?: HlsMediaPlaylist | undefined): string {
  const part = (p: HlsMediaPlaylist) => {
    const first = p.segments[0]
    const last = p.segments[p.segments.length - 1]
    return [pathOf(p.url), p.mediaSequence, p.segments.length, first && pathOf(first.uri), last && pathOf(last.uri)]
  }
  return shortHash(JSON.stringify([part(main), audio ? part(audio) : null]))
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function cursorOf(value: unknown): HlsTrackCursor | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const c = value as Record<string, unknown>
  const measured = c['measured'] as Record<string, unknown> | undefined
  const periods = c['periods']
  if (
    !isCount(c['next']) ||
    !isCount(c['period']) ||
    !isCount(c['bytes']) ||
    !isCount(c['skipped']) ||
    typeof measured !== 'object' ||
    measured === null ||
    !isCount(measured['bytes']) ||
    !isSeconds(measured['seconds']) ||
    !Array.isArray(periods) ||
    !periods.every(p => Array.isArray(p) && p.length === 2 && isCount(p[0]) && isCount(p[1]))
  )
    return undefined
  return {
    next: c['next'],
    period: c['period'],
    bytes: c['bytes'],
    periods: periods as Array<[number, number]>,
    measured: {bytes: measured['bytes'], seconds: measured['seconds']},
    skipped: c['skipped'],
  }
}

/** Read and check the state; undefined when absent, corrupt or for another playlist. O(P). */
export async function readState(dir: string, id: string): Promise<HlsResumeState | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, STATE_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const s = raw as Record<string, unknown>
  if (s['v'] !== 1 || s['id'] !== id || typeof s['tracks'] !== 'object' || s['tracks'] === null) return undefined
  const tracks: Partial<Record<HlsTrack, HlsTrackCursor>> = {}
  for (const name of ['main', 'audio'] as const) {
    const value = (s['tracks'] as Record<string, unknown>)[name]
    if (value === undefined) continue
    const cursor = cursorOf(value)
    if (!cursor) return undefined
    tracks[name] = cursor
  }
  return {v: 1, id, tracks}
}

/** Write tmp + rename. O(P). */
export async function writeState(dir: string, state: HlsResumeState): Promise<void> {
  const file = path.join(dir, STATE_FILE)
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state))
  await fs.rename(tmp, file)
}

/**
 * Keeps the latest cursor of each track and writes the state at most once per `intervalMs` (and on
 * `flush`). O(1) per `update`; a write is O(P). Writes never overlap: a flush waits for the one running.
 */
export class StateWriter {
  readonly #dir: string
  readonly #id: string
  readonly #now: () => number
  readonly #intervalMs: number
  #tracks: Partial<Record<HlsTrack, HlsTrackCursor>>
  #last = Number.NEGATIVE_INFINITY
  #dirty = false
  #writing: Promise<void> = Promise.resolve()

  constructor(
    dir: string,
    id: string,
    opts: {
      readonly now?: (() => number) | undefined
      readonly intervalMs?: number | undefined
      readonly initial?: HlsResumeState | undefined
    } = {},
  ) {
    this.#dir = dir
    this.#id = id
    this.#now = opts.now ?? Date.now
    this.#intervalMs = opts.intervalMs ?? 1000
    this.#tracks = {...opts.initial?.tracks}
  }

  get state(): HlsResumeState {
    return {v: 1, id: this.#id, tracks: {...this.#tracks}}
  }

  update(track: HlsTrack, cursor: HlsTrackCursor): void {
    this.#tracks[track] = cursor
    this.#dirty = true
  }

  /** Writes when the last write is `intervalMs` old. */
  async maybeFlush(): Promise<void> {
    if (!this.#dirty || this.#now() - this.#last < this.#intervalMs) return
    await this.flush()
  }

  async flush(): Promise<void> {
    await this.#writing
    if (!this.#dirty) return
    this.#dirty = false
    this.#last = this.#now()
    const write = writeState(this.#dir, this.state)
    this.#writing = write.catch(() => {})
    await write
  }
}
