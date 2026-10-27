/**
 * `downloadHls`: an HLS VOD (or track) into one file. k workers fetch segments ahead of one appender per
 * track (a reorder window of W = 2k), each segment to `<track>.s<sequence>.part` → checked → renamed
 * `.done` → appended in order to its period file and deleted; the cursor is saved at most once per
 * second; one ffmpeg -c copy at the end (`assembleHls`).
 *
 * n = segments. Cost: O(1) per segment — 1 request, ≤ 1 constant-size state write per second, O(1)
 * progress, O(k) wake-ups with k ≤ ⌊CPUs/2⌋; ≤ k requests in flight, ≤ W segment files on disk, memory
 * O(n) for the parsed list + O(k × 64 KB). Requests: 1 per track playlist + n segments + 1 per distinct
 * key + 1 init per period + ≤ the refresh budget (each O(n) to re-check). Resume: one readdir + a Set.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import type {Executable} from '../../binaries/executable.js'
import type {HttpSession} from '../../sources/http.js'
import type {ErrorCode, JobProgress} from '../../types.js'
import {cancelledError, DownloadError} from '../errors.js'
import {maxConcurrency} from '../pool.js'
import {StaleResumeError, TrackAppender} from './appender.js'
import {assembleHls, type HlsContainer} from './assemble.js'
import {HlsError} from './errors.js'
import {
  fetchPlaylist,
  type HlsMediaPlaylist,
  type HlsSegment,
  isOpenEnded,
  type ParseOptions,
  pathOf,
} from './playlist.js'
import {fetchKey, fetchSegment, ivFor, KeyCache, verifySegment} from './segment.js'
import {type HlsResumeState, type HlsTrack, playlistIdentity, readState, StateWriter} from './state.js'

/**
 * Called when the CDN refuses a segment or key with 401/403 (a signed playlist expired mid-download:
 * SoundCloud's CloudFront policy, a Bluesky session parameter). Returns a fresh, re-signed url of the
 * SAME media playlist (same variant). Called at most the refresh budget per download; concurrent
 * refusals share one call. Not given → a refusal fails the download as 'expired'.
 */
export type RefreshPlaylist = (
  why: {readonly status: number; readonly segment: number; readonly attempt: number},
  signal: AbortSignal,
) => Promise<string>

export type HlsTrackInput = {
  /** Media playlist url, or the playlist already parsed (no second request). */
  readonly playlist: string | HlsMediaPlaylist
  readonly refresh?: RefreshPlaylist | undefined
}

export type HlsEvent =
  | {readonly type: 'resumed'; readonly track: HlsTrack; readonly next: number; readonly of: number}
  | {readonly type: 'refreshed'; readonly track: HlsTrack; readonly attempt: number; readonly status: number}
  | {
      readonly type: 'segment-retry'
      readonly track: HlsTrack
      readonly index: number
      readonly attempt: number
      readonly code: ErrorCode
    }
  | {
      readonly type: 'segment-skipped'
      readonly track: HlsTrack
      readonly index: number
      readonly reason: 'gap' | 'missing'
    }
  | {readonly type: 'assembling'; readonly periods: number; readonly tracks: number}

export type {HlsTrack} from './state.js'

export type HlsDownloadOptions = {
  /** The Source's session: cookies, user agent; every request of the download goes through it. */
  readonly session: HttpSession
  /** For messages ("Twitch segment 1234 answered 404"). */
  readonly site: string
  /** Extra headers for playlists, keys and segments (a Referer / Origin). */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** The main track (video+audio muxed, video only with `audio`, or audio only). */
  readonly main: HlsTrackInput
  /** A demuxed audio track (VariantChoice.audio), muxed in with -c copy. */
  readonly audio?: HlsTrackInput | undefined
  /** Video or audio-only result: decides the container of the output. */
  readonly kind: 'video' | 'audio'
  /** The variant's CODECS (VariantChoice.variant.codecs): `mp4a` asks for aac_adtstoasc. */
  readonly codecs?: readonly string[] | undefined
  /** The job's work folder (deterministic per url + profile: a retry or a restart resumes). */
  readonly workDir: string
  readonly ffmpeg: Executable
  readonly signal: AbortSignal
  /** Segments fetched at once inside this download. Default 3; clamped to [1, ⌊CPUs/2⌋]. */
  readonly concurrency?: number | undefined
  /** Applied while parsing urls given as strings (and on every refresh). */
  readonly parse?: ParseOptions | undefined
  /** Refresh budget per download. Default max(3, ⌈duration / 1 h⌉ + 1). */
  readonly maxRefreshes?: number | undefined
  /** Network retries per segment before the download fails (resumable). Default 5, backoff 1 → 16 s. */
  readonly segmentRetries?: number | undefined
  /**
   * A segment still missing (404/410) after its retries: 'fail' (default — the file would be shorter than
   * the site says and fail validation anyway) or 'skip' (a gap, counted in `HlsResult.skipped`).
   * EXT-X-GAP segments are always skipped without a request.
   */
  readonly missingSegments?: 'fail' | 'skip' | undefined
  /** Seed for the progress total before the first segments are measured (VariantChoice.estimatedBytes). */
  readonly expectedBytes?: number | undefined
  /** No byte for this long on a segment: abort it and retry. Default STALL_MS (60 s). */
  readonly stallMs?: number | undefined
  /** Discard any resume state (SourceDownload.fresh after a failed attempt). */
  readonly fresh?: boolean | undefined
  /** Job progress. Called per chunk, O(1); the engine throttles events. */
  readonly onProgress: (progress: JobProgress) => void
  /** Notable events, for the trace log and tests. */
  readonly onEvent?: ((event: HlsEvent) => void) | undefined
  /** Injected clock and sleep for tests. */
  readonly now?: (() => number) | undefined
  readonly sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined
}

export type HlsResult = {
  /** The assembled file in workDir/hls (mp4 | m4a | mp3 | ogg). */
  readonly filepath: string
  readonly container: HlsContainer
  /** Segment bytes downloaded (both tracks, earlier runs of a resumed download included). */
  readonly bytes: number
  /** Σ EXTINF of the segments in the file: what the engine can check the file against when the site gives no duration. */
  readonly duration: number
  readonly segments: number
  readonly skipped: number
  readonly refreshes: number
}

const DEFAULT_RETRIES = 5

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  delay(ms, undefined, {signal}).then(
    () => undefined,
    () => undefined,
  )

/** The refresh budget for a playlist `duration` seconds long: max(3, ⌈duration / 1 h⌉ + 1). */
export const refreshBudget = (duration: number): number => Math.max(3, Math.ceil(duration / 3600) + 1)

/** Segment fetches at once: `requested` (default 3) within [1, ⌊CPUs/2⌋]. */
export const segmentConcurrency = (requested: number | undefined, cpus?: number): number =>
  Math.max(1, Math.min(Math.floor(requested ?? 3) || 1, maxConcurrency(cpus)))

/** Same playlist after a refresh: same count and, per index, the same uri path. O(n). */
export function samePlaylist(a: HlsMediaPlaylist, b: HlsMediaPlaylist): boolean {
  if (a.segments.length !== b.segments.length || a.mediaSequence !== b.mediaSequence) return false
  for (let i = 0; i < a.segments.length; i++) {
    const x = a.segments[i]
    const y = b.segments[i]
    if (!x || !y || pathOf(x.uri) !== pathOf(y.uri)) return false
  }
  return true
}

/** Extension of a track's period files. */
const extensionFor = (p: HlsMediaPlaylist): string =>
  p.format === 'ts' ? 'ts' : p.format === 'fmp4' ? 'mp4' : p.format === 'packed-audio' ? p.extension || 'aac' : 'bin'

/**
 * Bytes per second over the last ~10 s, from ≤ 11 samples at least a second apart (the `WorkMeter` approach); O(1) per update.
 */
class SpeedMeter {
  readonly #samples: Array<readonly [number, number]> = []

  sample(now: number, bytes: number): number | undefined {
    const last = this.#samples[this.#samples.length - 1]
    if (!last || now - last[0] >= 1000) {
      this.#samples.push([now, bytes])
      while (this.#samples.length > 11) this.#samples.shift()
    }
    const oldest = this.#samples[0]
    if (!oldest || now - oldest[0] <= 0) return undefined
    return ((bytes - oldest[1]) * 1000) / (now - oldest[0])
  }
}

type TrackRun = {
  readonly name: HlsTrack
  readonly part: number
  playlist: HlsMediaPlaylist
  readonly refresh: RefreshPlaylist | undefined
  /** Bumped by every successful refresh: a refusal of a url older than the current playlist just retries. */
  generation: number
  refreshing: Promise<void> | undefined
  /** Bytes downloaded for this track (resumed + this run), network side. */
  base: number
  /** Bytes of the segments in flight. */
  inflight: number
  appended: number
}

const MISSING = Symbol('missing')
const GAP = Symbol('gap')
type Ready = {readonly file: string; readonly bytes: number} | typeof MISSING | typeof GAP

/**
 * Download an HLS VOD into one file. O(1) per segment (one request, ≤ 1 state write per second, O(1)
 * progress); memory O(n) for the parsed list + O(k) streams; disk peak 2× the media + W segments.
 * Open-ended playlists (live) are refused as `live-now` before any segment is requested. Throws
 * HlsError / DownloadError; a cancel throws `cancelledError()` and keeps the folder for resume.
 */
export async function downloadHls(opts: HlsDownloadOptions): Promise<HlsResult> {
  if (opts.signal.aborted) throw cancelledError()
  const dir = path.join(opts.workDir, 'hls')
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const k = segmentConcurrency(opts.concurrency)
  const window = 2 * k
  const retries = Math.max(0, opts.segmentRetries ?? DEFAULT_RETRIES)

  // one controller for the whole download, linked to the job's signal by one listener (removed at the end)
  const stop = new AbortController()
  const onAbort = () => stop.abort(opts.signal.reason)
  opts.signal.addEventListener('abort', onAbort, {once: true})
  try {
    const load = async (input: HlsTrackInput): Promise<HlsMediaPlaylist> => {
      if (typeof input.playlist !== 'string') return input.playlist
      const p = await fetchPlaylist(opts.session, input.playlist, {
        site: opts.site,
        headers: opts.headers,
        signal: stop.signal,
        parse: opts.parse,
      })
      if (p.kind !== 'media') throw new HlsError('not-hls', `The ${opts.site} media playlist is a master playlist.`)
      return p
    }
    const main = await load(opts.main)
    const audio = opts.audio ? await load(opts.audio) : undefined
    for (const p of [main, audio]) {
      // scope decision: live streams are never downloaded
      if (p && isOpenEnded(p)) {
        throw new HlsError('live', `This ${opts.site} stream is live (its playlist has no end): not downloaded.`)
      }
      if (p && p.segments.length === 0) throw new HlsError('empty', `The ${opts.site} playlist lists no media.`)
    }
    try {
      return await run(opts, {dir, now, sleep, window, k, retries, stop: stop.signal}, main, audio, false)
    } catch (error) {
      if (!(error instanceof StaleResumeError)) throw error
      // the files no longer match the cursor: start over once, from nothing
      return await run(opts, {dir, now, sleep, window, k, retries, stop: stop.signal}, main, audio, true)
    }
  } catch (error) {
    if (opts.signal.aborted) throw cancelledError()
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC') {
      throw new DownloadError('disk-full', 'No space left on device.')
    }
    throw error
  } finally {
    opts.signal.removeEventListener('abort', onAbort)
  }
}

type RunContext = {
  readonly dir: string
  readonly now: () => number
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly window: number
  readonly k: number
  readonly retries: number
  readonly stop: AbortSignal
}

async function run(
  opts: HlsDownloadOptions,
  ctx: RunContext,
  main: HlsMediaPlaylist,
  audio: HlsMediaPlaylist | undefined,
  forceFresh: boolean,
): Promise<HlsResult> {
  const {dir, now} = ctx
  const id = playlistIdentity(main, audio)
  await fs.mkdir(dir, {recursive: true})
  let state: HlsResumeState | undefined = opts.fresh || forceFresh ? undefined : await readState(dir, id)
  if (!state) {
    // another playlist, a corrupt state or a fresh start: nothing in the folder can be trusted
    await fs.rm(dir, {recursive: true, force: true})
    await fs.mkdir(dir, {recursive: true})
    state = undefined
  }
  // the finished segments a previous run left waiting for their turn: one readdir, one Set
  const done = new Set((await fs.readdir(dir)).filter(name => name.endsWith('.done')))
  const writer = new StateWriter(dir, id, {now, initial: state})
  const keys = new KeyCache(4)
  const speed = new SpeedMeter()
  const budget = opts.maxRefreshes ?? refreshBudget(main.duration)
  let refreshes = 0
  let lastFraction = 0
  const tracks: TrackRun[] = [main, audio].flatMap((p, i) => {
    if (!p) return []
    const name: HlsTrack = i === 0 ? 'main' : 'audio'
    const measured = state?.tracks[name]?.measured.bytes ?? 0
    return [
      {
        name,
        part: i + 1,
        playlist: p,
        refresh: i === 0 ? opts.main.refresh : opts.audio?.refresh,
        generation: 0,
        refreshing: undefined,
        base: measured,
        inflight: 0,
        appended: 0,
      },
    ]
  })
  const totalParts = tracks.length

  const forecast = (): number | undefined => {
    let total = 0
    for (const t of tracks) {
      if (t.playlist.byteLength !== undefined) {
        total += t.playlist.byteLength
        continue
      }
      const m = writer.state.tracks[t.name]?.measured
      if (!m || m.seconds <= 0 || m.bytes <= 0) return opts.expectedBytes
      total += (m.bytes / m.seconds) * t.playlist.duration
    }
    return Math.ceil(total)
  }
  let total = forecast()
  const report = (track: TrackRun) => {
    let downloaded = 0
    for (const t of tracks) downloaded += t.base + t.inflight
    const t = now()
    const bps = speed.sample(t, downloaded)
    const totalBytes = total !== undefined ? Math.max(total, downloaded) : undefined
    const fraction = totalBytes ? Math.max(lastFraction, Math.min(1, downloaded / totalBytes)) : undefined
    if (fraction !== undefined) lastFraction = fraction
    opts.onProgress({
      fraction,
      downloadedBytes: downloaded,
      totalBytes,
      speed: bps,
      eta: bps && totalBytes ? Math.max(0, (totalBytes - downloaded) / bps) : undefined,
      part: track.part,
      totalParts,
      fragmentIndex: track.appended,
      fragmentCount: track.playlist.segments.length,
    })
  }

  const refreshTrack = async (track: TrackRun, status: number, segment: number, generation: number) => {
    if (track.generation !== generation) return // already refreshed since this request went out
    if (track.refreshing) return track.refreshing
    if (!track.refresh) {
      throw new HlsError('refused', `The ${opts.site} media was refused (HTTP ${status}) and cannot be re-signed.`)
    }
    if (refreshes >= budget) {
      throw new HlsError('refused', `The ${opts.site} media was refused again after ${refreshes} refreshes.`)
    }
    refreshes++
    const attempt = refreshes
    const refresh = track.refresh
    track.refreshing = (async () => {
      const url = await refresh({status, segment, attempt}, ctx.stop)
      const next = await fetchPlaylist(opts.session, url, {
        site: opts.site,
        headers: opts.headers,
        signal: ctx.stop,
        parse: opts.parse,
      })
      if (next.kind !== 'media' || !samePlaylist(track.playlist, next)) {
        throw new HlsError('changed', `The refreshed ${opts.site} playlist is not the one being downloaded.`)
      }
      track.playlist = next
      track.generation++
      opts.onEvent?.({type: 'refreshed', track: track.name, attempt, status})
    })().finally(() => {
      track.refreshing = undefined
    })
    return track.refreshing
  }

  const keyFor = (track: TrackRun, segment: HlsSegment) => {
    const key = track.playlist.keys[segment.key]
    if (!key) return Promise.resolve(undefined)
    return keys
      .get(key.uri, uri => fetchKey(opts.session, uri, {site: opts.site, headers: opts.headers, signal: ctx.stop}))
      .then(bytes => ({key: bytes, iv: ivFor(key, segment.sequence)}))
  }

  const appenders = new Map<HlsTrack, TrackAppender>()
  for (const track of tracks) {
    await runTrack(track)
  }
  await writer.flush()

  const files = tracks.map(t => ({
    files: appenders.get(t.name)?.files ?? [],
    format: t.playlist.format,
    extension: t.playlist.extension,
  }))
  const [mainFiles, audioFiles] = files
  if (!mainFiles) throw new HlsError('empty', 'Nothing was downloaded.')
  opts.onEvent?.({
    type: 'assembling',
    periods: files.reduce((n, f) => n + f.files.length, 0),
    tracks: files.length,
  })
  const duration = tracks.reduce((s, t) => s + (writer.state.tracks[t.name]?.measured.seconds ?? 0), 0)
  const mainSeconds = writer.state.tracks.main?.measured.seconds ?? duration
  const assembled = await assembleHls({
    ffmpeg: opts.ffmpeg,
    dir,
    kind: opts.kind,
    main: mainFiles,
    audio: audioFiles,
    codecs: opts.codecs,
    signal: ctx.stop,
    duration: mainSeconds,
  })
  await fs.rm(path.join(dir, 'state.json'), {force: true})
  let bytes = 0
  let segments = 0
  let skipped = 0
  for (const t of tracks) {
    bytes += t.base
    segments += t.playlist.segments.length
    skipped += writer.state.tracks[t.name]?.skipped ?? 0
  }
  return {...assembled, bytes, duration: mainSeconds, segments, skipped, refreshes}

  // ── one track: k workers ahead of one appender
  async function runTrack(track: TrackRun): Promise<void> {
    const segs = () => track.playlist.segments
    const n = segs().length
    const first = segs()[0]?.sequence ?? 0
    const cursor = writer.state.tracks[track.name]
    const appender = await TrackAppender.open({
      dir,
      track: track.name,
      extension: extensionFor(track.playlist),
      first,
      firstPeriod: segs()[0]?.period ?? 0,
      cursor,
      initFor: period => fetchInit(track, period),
    })
    appenders.set(track.name, appender)
    const start = Math.max(0, Math.min(n, appender.next - first))
    track.appended = start
    if (cursor && start > 0) opts.onEvent?.({type: 'resumed', track: track.name, next: start, of: n})
    if (start >= n) {
      await appender.close()
      return
    }

    let nextFetch = start
    let nextAppend = start
    const ready = new Map<number, Ready>()
    let failure: unknown
    let waiters: Array<() => void> = []
    const changed = () => {
      const w = waiters
      waiters = []
      for (const wake of w) wake()
    }
    const nextChange = () => new Promise<void>(resolve => waiters.push(resolve))
    const local = new AbortController()
    const onStop = () => {
      local.abort(ctx.stop.reason)
      changed()
    }
    ctx.stop.addEventListener('abort', onStop, {once: true})
    const fail = (error: unknown) => {
      failure ??= error
      if (!local.signal.aborted) local.abort(error)
      changed()
    }

    const worker = async (): Promise<void> => {
      while (failure === undefined && !local.signal.aborted) {
        if (nextFetch >= n) return
        if (nextFetch >= nextAppend + ctx.window) {
          await nextChange()
          continue
        }
        const i = nextFetch++
        const segment = segs()[i]
        if (!segment) return
        let result: Ready
        try {
          result = segment.gap ? GAP : await fetchOne(track, segment, local.signal)
        } catch (error) {
          fail(error)
          return
        }
        ready.set(i, result)
        changed()
      }
    }

    const appendAll = async (): Promise<void> => {
      while (nextAppend < n) {
        if (failure !== undefined || local.signal.aborted) return
        const entry = ready.get(nextAppend)
        if (entry === undefined) {
          await nextChange()
          continue
        }
        ready.delete(nextAppend)
        const segment = segs()[nextAppend]
        if (!segment) return
        if (entry === GAP || entry === MISSING) {
          appender.skip(segment)
          opts.onEvent?.({
            type: 'segment-skipped',
            track: track.name,
            index: segment.index,
            reason: entry === GAP ? 'gap' : 'missing',
          })
        } else {
          const cipher = segment.key >= 0 ? await keyFor(track, segment) : undefined
          await appender.append(segment, entry.file, {fetchedBytes: entry.bytes, cipher})
        }
        nextAppend++
        track.appended = nextAppend
        writer.update(track.name, appender.cursor)
        await writer.maybeFlush()
        changed()
        if (total === undefined || track.playlist.byteLength === undefined) total = forecast() ?? total
        report(track)
      }
    }

    try {
      const workers = Array.from({length: Math.min(ctx.k, n - start)}, () => worker())
      try {
        await appendAll()
      } catch (error) {
        fail(error)
      }
      changed()
      await Promise.all(workers)
    } finally {
      ctx.stop.removeEventListener('abort', onStop)
      writer.update(track.name, appender.cursor)
      await appender.close()
      await writer.flush().catch(() => {})
    }
    if (ctx.stop.aborted) throw cancelledError()
    if (failure !== undefined) throw failure
  }

  async function fetchInit(track: TrackRun, period: number): Promise<string | undefined> {
    const init = track.playlist.inits[period]
    if (!init) return undefined
    const file = path.join(dir, `${track.name}.init${period}.part`)
    for (let attempt = 0; ; attempt++) {
      const generation = track.generation
      try {
        const current = track.playlist.inits[period] ?? init
        const got = await fetchSegment(opts.session, current.uri, file, {
          site: opts.site,
          headers: opts.headers,
          signal: ctx.stop,
          range: current.range,
          stallMs: opts.stallMs,
        })
        await verifySegment(file, got.bytes, 'init', opts.site)
        track.base += got.bytes
        return file
      } catch (error) {
        if (ctx.stop.aborted) throw error
        const code = error instanceof DownloadError ? error.code : 'network'
        if (code === 'expired') {
          await refreshTrack(track, 403, -1, generation)
          continue
        }
        if (error instanceof HlsError && error.reason === 'corrupt') await fs.rm(file, {force: true})
        if (attempt >= ctx.retries || (code !== 'network' && code !== 'unavailable')) throw error
        await ctx.sleep(backoff(attempt), ctx.stop)
      }
    }
  }

  async function fetchOne(track: TrackRun, segment: HlsSegment, signal: AbortSignal): Promise<Ready> {
    const doneName = `${track.name}.s${segment.sequence}.done`
    const doneFile = path.join(dir, doneName)
    if (done.has(doneName)) {
      done.delete(doneName)
      const size = (await fs.stat(doneFile).catch(() => undefined))?.size
      if (size) {
        track.base += size
        return {file: doneFile, bytes: size}
      }
    }
    const part = path.join(dir, `${track.name}.s${segment.sequence}.part`)
    let counted = 0
    const count = (bytes: number) => {
      track.inflight += bytes - counted
      counted = bytes
      report(track)
    }
    let attempt = 0
    try {
      for (;;) {
        const generation = track.generation
        // the url as the current playlist has it: a refresh swaps the list under the workers
        const current = track.playlist.segments[segment.index] ?? segment
        try {
          const cipher = current.key >= 0 ? await keyFor(track, current) : undefined
          const got = await fetchSegment(opts.session, current.uri, part, {
            site: opts.site,
            headers: opts.headers,
            signal,
            range: current.range,
            stallMs: opts.stallMs,
            onBytes: count,
          })
          await verifySegment(part, got.bytes, track.playlist.format, opts.site, cipher)
          await fs.rename(part, doneFile)
          track.inflight -= counted
          counted = 0
          track.base += got.bytes
          return {file: doneFile, bytes: got.bytes}
        } catch (error) {
          if (signal.aborted) throw error
          if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC') throw error
          const code: ErrorCode = error instanceof DownloadError ? error.code : 'network'
          if (code === 'disk-full' || code === 'cancelled') throw error
          if (code === 'expired') {
            // not counted against the segment's retries
            await refreshTrack(track, 403, segment.index, generation)
            continue
          }
          if (error instanceof HlsError && error.reason === 'corrupt') {
            await fs.rm(part, {force: true})
            count(0)
          }
          if (code !== 'network' && code !== 'unavailable') throw error
          if (attempt >= ctx.retries) {
            if (code === 'unavailable') {
              if (opts.missingSegments === 'skip') {
                await fs.rm(part, {force: true})
                return MISSING
              }
              throw new HlsError(
                'missing',
                `${opts.site} segment ${segment.index + 1} of ${track.playlist.segments.length} is missing.`,
              )
            }
            if (error instanceof HlsError) throw error
            throw new DownloadError(
              'network',
              `${opts.site} segment ${segment.index + 1} failed ${attempt + 1} times: ${(error as Error).message}`,
            )
          }
          opts.onEvent?.({type: 'segment-retry', track: track.name, index: segment.index, attempt: attempt + 1, code})
          await ctx.sleep(backoff(attempt), signal)
          attempt++
        }
      }
    } finally {
      track.inflight -= counted
    }
  }
}

/** 1, 2, 4, 8, 16 s. */
const backoff = (attempt: number): number => Math.min(16_000, 1000 * 2 ** attempt)
