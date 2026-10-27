/**
 * `recordHls`: a live HLS stream (a sliding-window media playlist) recorded into one file, from the
 * oldest segment the window holds (`from: 'window'`, the default) or from the live edge (`'now'`), until
 * the playlist ends (EXT-X-ENDLIST), the user stops it (`stop`: what was recorded is kept and finalized),
 * `maxDuration` (default 12 h), or the stream goes offline (N reloads in a row with nothing new). A cancel
 * (`signal`) throws `cancelledError()` and keeps nothing worth keeping (the engine deletes the folder).
 *
 * The loop (recorder.md §3): reload the playlist every target duration (at least 1 s; half that after a
 * reload that brought nothing new, as hls.js does), take the segments whose media sequence is above the
 * last one taken (one integer subtraction locates the first new one in the window), fetch each into a
 * checked file and append it in order through `TrackAppender`, one segment at a time (real time: one is
 * enough). A media-sequence jump is a gap: counted, reported with its program date-time, and written as a
 * new period (the concat demuxer joins periods with contiguous timestamps). Segments the caller's `skip`
 * refuses (Twitch's stitched ads) are left out the same way, their seconds counted. A refused playlist
 * (401/403/410) asks `refreshUrl` for a fresh signed url. One ffmpeg -c copy at the end (`assembleHls`).
 *
 * n = segments recorded. Cost: O(1) per segment — one request, one append, O(1) progress; per reload one
 * request and O(w) parsing for a window of w segments (w bounded by the site, not by n). Memory: the
 * current window, a 4-key cache and one [period, bytes] pair per discontinuity period — never the list
 * of segments recorded, so it stays flat over a 12-hour recording (scripts/hls-record-bench.ts).
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import type {Executable} from '../../binaries/executable.js'
import type {HttpSession} from '../../sources/http.js'
import type {ErrorCode, JobProgress} from '../../types.js'
import {cancelledError, DownloadError} from '../errors.js'
import {TrackAppender} from './appender.js'
import {assembleHls, type HlsContainer} from './assemble.js'
import {HlsError} from './errors.js'
import {type HlsInit, type HlsMediaPlaylist, type HlsSegment, type ParseOptions, parsePlaylist} from './playlist.js'
import {fetchKey, fetchSegment, ivFor, KeyCache, verifySegment} from './segment.js'

/** Default cap of a recording: 12 hours (Isaac, recorder.md §7). */
export const DEFAULT_MAX_RECORDING = 12 * 3600
/** Reloads in a row that bring nothing new before the stream counts as offline. */
export const DEFAULT_EMPTY_RELOADS = 10
/** Refusals in a row (each followed by a refresh) before the recording gives up on the playlist. */
const REFUSALS_IN_A_ROW = 3
/** A playlist that answers nothing for this long is abandoned (and counted as an empty reload). */
const RELOAD_TIMEOUT_MS = 10_000
/**
 * A segment that sends no byte for this long is dropped and asked again. A download waits a minute
 * (STALL_MS); a live window (Twitch: ~30 s) would move past the next segments meanwhile.
 */
export const LIVE_STALL_MS = 10_000
/** Network retries of one segment before it counts as lost (a live segment soon leaves the window anyway). */
const DEFAULT_SEGMENT_RETRIES = 2

/**
 * A fresh signed url of the same media playlist (same variant), after the CDN refused the current one
 * (401/403/410: an expired token). `undefined`: the stream is over (the recording ends as offline).
 */
export type RefreshLive = (
  why: {readonly status: number; readonly attempt: number},
  signal: AbortSignal,
) => Promise<string | undefined>

/** Why a recording ended. */
export type HlsRecordEnd = 'endlist' | 'stopped' | 'max-duration' | 'offline' | 'refused'

export type HlsRecordEvent =
  /** The window moved past segments never seen (the reload came late, or the origin skipped). */
  | {
      readonly type: 'gap'
      readonly segments: number
      readonly after: number
      readonly at?: number | undefined
    }
  /** A segment listed but not recorded: EXT-X-GAP, or still failing after its retries. */
  | {readonly type: 'segment-lost'; readonly sequence: number; readonly code: ErrorCode | 'gap'}
  /** A segment the caller's `skip` left out (an ad). */
  | {readonly type: 'segment-skipped'; readonly sequence: number; readonly seconds: number}
  | {readonly type: 'refreshed'; readonly status: number; readonly attempt: number}
  /** The media sequence numbering restarted (a new session after a refresh): re-anchored by program date-time. */
  | {readonly type: 'rebased'; readonly from: number; readonly to: number}
  | {readonly type: 'reload-failed'; readonly message: string; readonly empty: number}
  | {readonly type: 'ended'; readonly reason: HlsRecordEnd}
  | {readonly type: 'assembling'; readonly periods: number}

export type HlsRecordOptions = {
  readonly session: HttpSession
  /** For messages ("Twitch segment answered 404"). */
  readonly site: string
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** The media playlist (one variant) to record. */
  readonly playlist: string
  /** Video or audio-only result: decides the container of the output. */
  readonly kind: 'video' | 'audio'
  /** The variant's CODECS: `mp4a` asks for aac_adtstoasc. */
  readonly codecs?: readonly string[] | undefined
  readonly workDir: string
  readonly ffmpeg: Executable
  /** Cancel: everything stops, `cancelledError()` is thrown, nothing is finalized. */
  readonly signal: AbortSignal
  /**
   * Stop: no new segment is started (the one in flight completes), the recording is finalized and
   * returned. Stopped before any segment was recorded, there is nothing to keep: `cancelledError()`.
   */
  readonly stop?: AbortSignal | undefined
  /** 'window' (default): from the oldest segment the window holds; 'now': from the newest one. */
  readonly from?: 'window' | 'now' | undefined
  /** Seconds of media recorded, or of wall clock since the start, whichever comes first. Default 12 h. */
  readonly maxDuration?: number | undefined
  /** Re-signs the playlist after a 401/403/410. Not given → the recording ends as `refused` (or fails if empty). */
  readonly refreshUrl?: RefreshLive | undefined
  /** Segments left out (an ad): counted in `skippedSeconds`, and a new period where they were. O(1) expected. */
  readonly skip?: ((segment: HlsSegment, playlist: HlsMediaPlaylist) => boolean) | undefined
  /** Reloads in a row with nothing new before the stream is taken as offline. Default 10. */
  readonly emptyReloads?: number | undefined
  /** Network retries of one segment before it is lost (a gap). Default 2, back off 0.5 → 1 s. */
  readonly segmentRetries?: number | undefined
  /** No byte for this long on a segment: drop it and ask again. Default LIVE_STALL_MS (10 s). */
  readonly stallMs?: number | undefined
  readonly parse?: ParseOptions | undefined
  /** Live progress (`live: true`, elapsed seconds, bytes; no fraction, no ETA). O(1) per call. */
  readonly onProgress: (progress: JobProgress) => void
  readonly onEvent?: ((event: HlsRecordEvent) => void) | undefined
  /** Injected clock and sleep (tests run a recording on a simulated clock). */
  readonly now?: (() => number) | undefined
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined
}

export type HlsRecordResult = {
  /** The assembled file in workDir/hls (mp4 | m4a | mp3 | ogg). */
  readonly filepath: string
  readonly container: HlsContainer
  readonly ended: HlsRecordEnd
  /** Segment bytes downloaded. */
  readonly bytes: number
  /** Σ EXTINF of the segments in the file. */
  readonly duration: number
  /** Segments in the file. */
  readonly segments: number
  /** Gaps: places where segments were lost (a window that moved past, EXT-X-GAP, a segment that kept failing). */
  readonly gaps: number
  /** Segments lost in those gaps (those known by number). */
  readonly lostSegments: number
  /** Segments `skip` left out, and their seconds (ads). */
  readonly skippedSegments: number
  readonly skippedSeconds: number
  readonly refreshes: number
  /** Unix ms of the start, and seconds of wall clock the recording took. */
  readonly startedAt: number
  readonly elapsed: number
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  delay(ms, undefined, {signal}).then(
    () => undefined,
    () => undefined,
  )

type Reload =
  | {readonly ok: true; readonly playlist: HlsMediaPlaylist}
  | {readonly ok: false; readonly status: number; readonly message: string}

const extensionFor = (p: HlsMediaPlaylist): string =>
  p.format === 'ts' ? 'ts' : p.format === 'fmp4' ? 'mp4' : p.format === 'packed-audio' ? p.extension || 'aac' : 'bin'

const initKey = (init: HlsInit | undefined): string =>
  init ? `${init.uri.split('?', 1)[0]}|${init.range?.offset ?? ''}|${init.range?.length ?? ''}` : ''

/** 0.5, 1, 2 … s. */
const backoff = (attempt: number): number => Math.min(4000, 500 * 2 ** attempt)

/** A program date-time that differs by more than this is another segment. */
const SAME_DATE_MS = 1000

/**
 * Record a live HLS media playlist. Throws `cancelledError()` on cancel (or a stop before anything was
 * recorded), HlsError / DownloadError when nothing could be recorded; once something is recorded, a
 * playlist that fails or keeps refusing ends the recording (finalized) instead of failing it.
 */
export async function recordHls(opts: HlsRecordOptions): Promise<HlsRecordResult> {
  if (opts.signal.aborted) throw cancelledError()
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const dir = path.join(opts.workDir, 'hls')
  const maxDuration = Math.max(1, opts.maxDuration ?? DEFAULT_MAX_RECORDING)
  const emptyLimit = Math.max(1, Math.floor(opts.emptyReloads ?? DEFAULT_EMPTY_RELOADS))
  const retries = Math.max(0, Math.floor(opts.segmentRetries ?? DEFAULT_SEGMENT_RETRIES))
  const stop = opts.stop

  // one signal for the waits between reloads: a stop or a cancel wakes them (one removable listener each)
  const wake = new AbortController()
  const onWake = () => wake.abort()
  opts.signal.addEventListener('abort', onWake, {once: true})
  stop?.addEventListener('abort', onWake, {once: true})
  const stopped = () => stop?.aborted === true

  const startedAt = now()
  let url = opts.playlist
  let refreshes = 0
  let refusedInRow = 0
  /** Refreshes asked by refused segments since the last segment fetched: one, then a refusal is a loss. */
  let segmentRefreshes = 0
  /** Last media sequence taken (recorded, skipped or lost), and its program date-time. */
  let lastSeq: number | undefined
  let lastDate: number | undefined
  let lastDiscontinuity: number | undefined
  let currentInit: HlsInit | undefined
  let lastInitKey: string | undefined
  /** The output's own numbering: the appender only ever sees it go up, whatever the site's does. */
  let outSeq = 0
  let outPeriod = 0
  let newPeriod = false
  let recorded = 0
  let recordedSeconds = 0
  let bytes = 0
  let inflight = 0
  let gaps = 0
  let lostSegments = 0
  let skippedSegments = 0
  let skippedSeconds = 0
  let lastSample: readonly [number, number] | undefined
  let speed: number | undefined
  const keys = new KeyCache(4)
  let appender: TrackAppender | undefined
  let format: HlsMediaPlaylist['format'] = 'unknown'
  let extension = ''

  const elapsed = () => Math.max(0, (now() - startedAt) / 1000)
  const report = () => {
    const downloaded = bytes + inflight
    const t = now()
    // bytes per second between samples at least a second apart: O(1), no history kept
    if (!lastSample) lastSample = [t, downloaded]
    else if (t - lastSample[0] >= 1000) {
      speed = ((downloaded - lastSample[1]) * 1000) / (t - lastSample[0])
      lastSample = [t, downloaded]
    }
    opts.onProgress({
      live: true,
      elapsedSec: elapsed(),
      bytes: downloaded,
      downloadedBytes: downloaded,
      speed,
      part: 1,
      totalParts: 1,
      fragmentIndex: recorded,
    })
  }
  const overCap = () => recordedSeconds >= maxDuration || elapsed() >= maxDuration

  /** One request for the playlist, its own timer and one listener on the cancel signal. */
  const reload = async (): Promise<Reload> => {
    const local = new AbortController()
    const onAbort = () => local.abort()
    opts.signal.addEventListener('abort', onAbort, {once: true})
    const timer = setTimeout(() => local.abort(), RELOAD_TIMEOUT_MS)
    try {
      const response = await opts.session.get(url, {headers: opts.headers, signal: local.signal, timeoutMs: Infinity})
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return {ok: false, status: response.status, message: `HTTP ${response.status}`}
      }
      const parsed = parsePlaylist(await response.text(), response.url || url, opts.parse)
      if (parsed.kind !== 'media') {
        throw new HlsError('not-hls', `The ${opts.site} live playlist is a master playlist.`)
      }
      return {ok: true, playlist: parsed}
    } catch (error) {
      if (opts.signal.aborted) throw cancelledError()
      // before anything is recorded a playlist that is not one is the answer; afterwards a bad reload
      if (error instanceof HlsError && recorded === 0) throw error
      return {ok: false, status: 0, message: (error as Error).message}
    } finally {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }
  }

  /** A refusal: re-sign through the caller. 'again' to reload at once, or why the recording ends. */
  const refresh = async (status: number): Promise<'again' | 'offline' | 'refused'> => {
    if (!opts.refreshUrl || refusedInRow >= REFUSALS_IN_A_ROW) return 'refused'
    refusedInRow++
    refreshes++
    try {
      const next = await opts.refreshUrl({status, attempt: refreshes}, opts.signal)
      if (next === undefined) return 'offline'
      url = next
      opts.onEvent?.({type: 'refreshed', status, attempt: refreshes})
      return 'again'
    } catch (error) {
      if (opts.signal.aborted) throw cancelledError()
      if (recorded === 0 && refusedInRow >= REFUSALS_IN_A_ROW) throw error
      opts.onEvent?.({type: 'reload-failed', message: (error as Error).message, empty: 0})
      return 'again'
    }
  }

  /**
   * Index of the first segment of `p` not taken yet: one subtraction while the numbering goes on. When
   * the program date-times say the numbers lie (a refresh that started a new session numbers the same
   * segments elsewhere) it is re-anchored by date instead: O(w), on such a reload only.
   */
  const firstNew = (p: HlsMediaPlaylist): number => {
    const n = p.segments.length
    if (lastSeq === undefined) return opts.from === 'now' ? Math.max(0, n - 1) : 0
    const idx = lastSeq + 1 - p.mediaSequence
    if (lastDate !== undefined && datesDisagree(p, idx, lastDate)) return rebase(p, lastSeq, lastDate)
    if (idx > n) return n // a stale copy: nothing new
    if (idx < 0) gap(-idx, p.segments[0]?.programDateTime)
    return Math.max(0, idx)
  }

  /** O(1): the segment the numbers call the last one taken (or the first new one) is not, by its date. */
  const datesDisagree = (p: HlsMediaPlaylist, idx: number, last: number): boolean => {
    const n = p.segments.length
    if (idx >= 1 && idx <= n) {
      const date = p.segments[idx - 1]?.programDateTime
      return date !== undefined && Math.abs(date - last) > SAME_DATE_MS
    }
    if (idx > n) {
      // the numbers say everything is old; the newest segment's date says otherwise
      const date = p.segments[n - 1]?.programDateTime
      return date !== undefined && date > last + SAME_DATE_MS
    }
    // the numbers say -idx segments were missed: the first one's date must be about that far ahead
    const first = p.segments[0]
    if (first?.programDateTime === undefined) return false
    return first.programDateTime - last < (-idx * first.duration * 1000) / 2
  }

  /** The segments dated after the last one taken (the newest run of them): O(w). */
  const rebase = (p: HlsMediaPlaylist, seq: number, last: number): number => {
    const n = p.segments.length
    let first = n
    for (let i = n - 1; i >= 0; i--) {
      const date = p.segments[i]?.programDateTime
      if (date === undefined || date <= last + SAME_DATE_MS / 2) break
      first = i
    }
    const to = (p.segments[first]?.sequence ?? p.mediaSequence + n) - 1
    if (to !== seq) {
      opts.onEvent?.({type: 'rebased', from: seq, to})
      lastSeq = to
    }
    return first
  }

  const gap = (segments: number, at: number | undefined) => {
    gaps++
    lostSegments += segments
    newPeriod = true
    opts.onEvent?.({type: 'gap', segments, after: lastSeq ?? -1, at})
  }

  const keyFor = (p: HlsMediaPlaylist, segment: HlsSegment) => {
    const key = p.keys[segment.key]
    if (!key) return Promise.resolve(undefined)
    return keys
      .get(key.uri, uri => fetchKey(opts.session, uri, {site: opts.site, headers: opts.headers, signal: opts.signal}))
      .then(k => ({key: k, iv: ivFor(key, segment.sequence)}))
  }

  /**
   * Fetch one segment into a checked file. Undefined: lost (gone, refused, kept failing). A refusal
   * (an expired signed url) re-signs the playlist and answers 'reload': the loop reads the fresh copy at
   * once and takes this segment from it (its numbering may differ). At most one refresh per segment run.
   */
  const fetchOne = async (
    p: HlsMediaPlaylist,
    segment: HlsSegment,
  ): Promise<
    | {readonly file: string; readonly bytes: number; readonly cipher: {key: Uint8Array; iv: Uint8Array} | undefined}
    | 'reload'
    | 'offline'
    | undefined
  > => {
    const part = path.join(dir, `main.s${segment.sequence}.part`)
    for (let attempt = 0; ; attempt++) {
      let counted = 0
      try {
        const cipher = segment.key >= 0 ? await keyFor(p, segment) : undefined
        const got = await fetchSegment(opts.session, segment.uri, part, {
          site: opts.site,
          headers: opts.headers,
          signal: opts.signal,
          range: segment.range,
          stallMs: opts.stallMs ?? LIVE_STALL_MS,
          onBytes: n => {
            inflight += n - counted
            counted = n
            report()
          },
        })
        inflight -= counted
        await verifySegment(part, got.bytes, p.format, opts.site, cipher)
        segmentRefreshes = 0
        return {file: part, bytes: got.bytes, cipher}
      } catch (error) {
        inflight -= counted
        if (opts.signal.aborted) throw cancelledError()
        const code: ErrorCode = error instanceof DownloadError ? error.code : 'network'
        if (code === 'disk-full' || (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC') {
          throw new DownloadError('disk-full', 'No space left on device.')
        }
        await fs.rm(part, {force: true})
        if (code === 'expired' && segmentRefreshes === 0) {
          // a signed url ran out: re-sign the playlist; this segment comes again from the fresh copy
          segmentRefreshes++
          const why = await refresh(403)
          if (why === 'again') return 'reload'
          if (why === 'offline') return 'offline'
        }
        if (attempt >= retries || (code !== 'network' && code !== 'unavailable')) {
          opts.onEvent?.({type: 'segment-lost', sequence: segment.sequence, code})
          return undefined
        }
        await sleep(backoff(attempt), wake.signal)
        if (opts.signal.aborted) throw cancelledError()
      }
    }
  }

  let ended: HlsRecordEnd | undefined
  let empty = 0
  try {
    await fs.rm(dir, {recursive: true, force: true})
    await fs.mkdir(dir, {recursive: true})
    report()
    while (ended === undefined) {
      if (opts.signal.aborted) throw cancelledError()
      if (stopped()) {
        ended = 'stopped'
        break
      }
      if (overCap()) {
        ended = 'max-duration'
        break
      }
      const reloadedAt = now()
      const got = await reload()
      if (!got.ok) {
        if (got.status === 401 || got.status === 403 || got.status === 410) {
          const next = await refresh(got.status)
          if (next === 'again') continue
          ended = next
          break
        }
        if (++empty >= emptyLimit) {
          if (recorded === 0 && got.status !== 404) {
            throw new DownloadError('network', `The ${opts.site} live playlist answered ${got.message}.`)
          }
          ended = 'offline'
          break
        }
        opts.onEvent?.({type: 'reload-failed', message: got.message, empty})
        report()
        await sleep(1000, wake.signal)
        continue
      }
      refusedInRow = 0
      const p = got.playlist
      if (!appender) {
        format = p.format
        extension = extensionFor(p)
        appender = await TrackAppender.open({
          dir,
          track: 'main',
          extension,
          first: 0,
          firstPeriod: 0,
          initFor: () => fetchInit(),
        })
      }
      const start = firstNew(p)
      let fresh = 0
      let reloadNow = false
      for (let i = start; i < p.segments.length; i++) {
        const segment = p.segments[i]
        if (!segment) break
        if (stopped()) {
          ended = 'stopped'
          break
        }
        if (overCap()) {
          ended = 'max-duration'
          break
        }
        fresh++
        if (segment.gap) {
          opts.onEvent?.({type: 'segment-lost', sequence: segment.sequence, code: 'gap'})
          gap(1, segment.programDateTime)
        } else if (opts.skip?.(segment, p)) {
          skippedSegments++
          skippedSeconds += segment.duration
          newPeriod = true
          opts.onEvent?.({type: 'segment-skipped', sequence: segment.sequence, seconds: segment.duration})
        } else {
          const one = await fetchOne(p, segment)
          if (one === 'reload') {
            reloadNow = true
            break
          }
          if (one === 'offline') {
            ended = 'offline'
            break
          }
          if (!one) gap(1, segment.programDateTime)
          else {
            const init = p.inits[segment.period]
            const key = initKey(init)
            if (recorded > 0 && (newPeriod || segment.discontinuity !== lastDiscontinuity || key !== lastInitKey)) {
              outPeriod++
            }
            newPeriod = false
            lastDiscontinuity = segment.discontinuity
            lastInitKey = key
            currentInit = init
            try {
              await appender.append({sequence: outSeq++, period: outPeriod, duration: segment.duration}, one.file, {
                fetchedBytes: one.bytes,
                cipher: one.cipher,
              })
              recorded++
              recordedSeconds += segment.duration
              bytes += one.bytes
            } catch (error) {
              // a segment that does not decrypt, or a period whose init segment kept failing: lost, not fatal
              if (opts.signal.aborted) throw cancelledError()
              if (error instanceof DownloadError && error.code === 'disk-full') throw error
              await fs.rm(one.file, {force: true})
              opts.onEvent?.({
                type: 'segment-lost',
                sequence: segment.sequence,
                code: error instanceof DownloadError ? error.code : 'unknown',
              })
              gap(1, segment.programDateTime)
            }
          }
        }
        lastSeq = segment.sequence
        if (segment.programDateTime !== undefined) lastDate = segment.programDateTime
        report()
      }
      if (ended !== undefined) break
      if (reloadNow) continue
      if (p.ended) {
        ended = 'endlist'
        break
      }
      empty = fresh > 0 ? 0 : empty + 1
      if (empty >= emptyLimit) {
        ended = 'offline'
        break
      }
      report()
      const base = Math.max(1000, p.targetDuration * 1000)
      const wait = (fresh > 0 ? base : base / 2) - (now() - reloadedAt)
      if (wait > 0) await sleep(wait, wake.signal)
    }
    if (opts.signal.aborted) throw cancelledError()
    const reason: HlsRecordEnd = ended ?? 'stopped'
    opts.onEvent?.({type: 'ended', reason})
    await appender?.close()
    const files = appender?.files ?? []
    if (recorded === 0 || files.length === 0) {
      if (reason === 'stopped') throw cancelledError()
      if (reason === 'refused') {
        throw new HlsError('refused', `The ${opts.site} live playlist was refused and could not be re-signed.`)
      }
      throw new DownloadError(
        'unavailable',
        reason === 'offline'
          ? `The ${opts.site} stream went offline before anything was recorded.`
          : `Nothing of this ${opts.site} stream could be recorded (every segment was lost or skipped).`,
      )
    }
    opts.onEvent?.({type: 'assembling', periods: files.length})
    const assembled = await assembleHls({
      ffmpeg: opts.ffmpeg,
      dir,
      kind: opts.kind,
      main: {files, format, extension},
      codecs: opts.codecs,
      signal: opts.signal,
      duration: recordedSeconds,
    })
    return {
      ...assembled,
      ended: reason,
      bytes,
      duration: recordedSeconds,
      segments: recorded,
      gaps,
      lostSegments,
      skippedSegments,
      skippedSeconds,
      refreshes,
      startedAt,
      elapsed: elapsed(),
    }
  } catch (error) {
    await appender?.close().catch(() => {})
    if (opts.signal.aborted) throw cancelledError()
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC') {
      throw new DownloadError('disk-full', 'No space left on device.')
    }
    throw error
  } finally {
    opts.signal.removeEventListener('abort', onWake)
    stop?.removeEventListener('abort', onWake)
  }

  /** The init segment of the period being entered (fMP4), fetched when its first segment is appended. */
  async function fetchInit(): Promise<string | undefined> {
    const init = currentInit
    if (!init) return undefined
    const file = path.join(dir, `main.init${outPeriod}.part`)
    for (let attempt = 0; ; attempt++) {
      try {
        const got = await fetchSegment(opts.session, init.uri, file, {
          site: opts.site,
          headers: opts.headers,
          signal: opts.signal,
          range: init.range,
          stallMs: opts.stallMs ?? LIVE_STALL_MS,
        })
        await verifySegment(file, got.bytes, 'init', opts.site)
        bytes += got.bytes
        return file
      } catch (error) {
        if (opts.signal.aborted) throw cancelledError()
        await fs.rm(file, {force: true})
        if (attempt >= retries) throw error
        await sleep(backoff(attempt), wake.signal)
      }
    }
  }
}
