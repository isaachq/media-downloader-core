/**
 * Appends a track's segments, in order, to one file per period (`<track>.p<period>.<ext>`), decrypting
 * AES-128 while streaming, and keeps the resume cursor. Usable on its own: a live recorder appends the
 * segments of its moving window the same way, keyed by media sequence numbers.
 *
 * Cost: O(1) per segment besides its bytes (one read stream of 64 KB chunks, positional writes to one
 * open file per period); memory O(64 KB). Opening on resume: one truncate and one stat per finished
 * period, O(P).
 */
import {createReadStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {DownloadError} from '../errors.js'
import {HlsError} from './errors.js'
import {decipherFor} from './segment.js'
import type {HlsTrack, HlsTrackCursor} from './state.js'

const CHUNK = 64 * 1024

/** The resume state no longer matches the files (a period file shorter than recorded, or gone). */
export class StaleResumeError extends Error {
  override readonly name = 'StaleResumeError'
}

export type AppendSegment = {
  readonly sequence: number
  readonly period: number
  /** EXTINF seconds, for `measured`. */
  readonly duration: number
}

export type AppenderOptions = {
  readonly dir: string
  readonly track: HlsTrack
  /** Period file extension ("ts", "mp4", "mp3"…). */
  readonly extension: string
  /** Sequence of the first segment, used when there is no cursor. */
  readonly first: number
  /** First period, used when there is no cursor. */
  readonly firstPeriod?: number | undefined
  readonly cursor?: HlsTrackCursor | undefined
  /**
   * The init segment file of a period (fMP4), fetched on demand: written first into a period file that
   * is still empty, then deleted. Undefined → the period has none.
   */
  readonly initFor?: ((period: number) => Promise<string | undefined>) | undefined
}

const isNoSpace = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC'

export class TrackAppender {
  readonly #dir: string
  readonly #track: HlsTrack
  readonly #extension: string
  readonly #initFor: AppenderOptions['initFor']
  #next: number
  #period: number
  #bytes: number
  #periods: Array<readonly [number, number]>
  #measured: {bytes: number; seconds: number}
  #skipped: number
  #file: fs.FileHandle | undefined
  #closed = false

  private constructor(opts: AppenderOptions) {
    const c = opts.cursor
    this.#dir = opts.dir
    this.#track = opts.track
    this.#extension = opts.extension
    this.#initFor = opts.initFor
    this.#next = c?.next ?? opts.first
    this.#period = c?.period ?? opts.firstPeriod ?? 0
    this.#bytes = c?.bytes ?? 0
    this.#periods = [...(c?.periods ?? [])]
    this.#measured = {bytes: c?.measured.bytes ?? 0, seconds: c?.measured.seconds ?? 0}
    this.#skipped = c?.skipped ?? 0
  }

  /**
   * An appender at `cursor` (or at the start). The current period file is truncated to the cursor's
   * length (whatever was appended after the last state write is redone); every finished period file
   * must still have its recorded length, or `StaleResumeError` is thrown and the caller starts over.
   */
  static async open(opts: AppenderOptions): Promise<TrackAppender> {
    const a = new TrackAppender(opts)
    for (const [period, bytes] of a.#periods) {
      const size = (await fs.stat(a.periodFile(period)).catch(() => undefined))?.size
      if (size !== bytes) throw new StaleResumeError(`${a.periodFile(period)} is ${size ?? 'missing'}, not ${bytes}`)
    }
    const current = a.periodFile(a.#period)
    const size = (await fs.stat(current).catch(() => undefined))?.size ?? 0
    if (size < a.#bytes) throw new StaleResumeError(`${current} is ${size}, not ${a.#bytes}`)
    if (opts.cursor && size > 0) {
      a.#file = await fs.open(current, 'r+')
      if (size > a.#bytes) await a.#file.truncate(a.#bytes)
    }
    return a
  }

  periodFile(period: number): string {
    return path.join(this.#dir, `${this.#track}.p${period}.${this.#extension}`)
  }

  get cursor(): HlsTrackCursor {
    return {
      next: this.#next,
      period: this.#period,
      bytes: this.#bytes,
      periods: [...this.#periods],
      measured: {...this.#measured},
      skipped: this.#skipped,
    }
  }

  /** Media sequence number of the next segment to append. */
  get next(): number {
    return this.#next
  }

  /** The period files written so far, in order (the current one last, when it has bytes). */
  get files(): string[] {
    const out = this.#periods.map(([p]) => this.periodFile(p))
    if (this.#bytes > 0) out.push(this.periodFile(this.#period))
    return out
  }

  /** Bytes in the period files (decrypted), the current one included. */
  get appendedBytes(): number {
    let total = this.#bytes
    for (const [, bytes] of this.#periods) total += bytes
    return total
  }

  async #enter(period: number): Promise<void> {
    if (period === this.#period && this.#file) return
    if (period !== this.#period) {
      await this.#file?.close()
      this.#file = undefined
      if (this.#bytes > 0) this.#periods.push([this.#period, this.#bytes])
      this.#period = period
      this.#bytes = 0
    }
    this.#file = await fs.open(this.periodFile(period), this.#bytes > 0 ? 'r+' : 'w')
  }

  async #write(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0 || !this.#file) return
    let done = 0
    while (done < chunk.length) {
      const {bytesWritten} = await this.#file.write(chunk, done, chunk.length - done, this.#bytes + done)
      done += bytesWritten
    }
    this.#bytes += chunk.length
  }

  /** Stream `file` (decrypting with `cipher`) into the current period; rolls the period back on failure. */
  async #copy(file: string, cipher: {readonly key: Uint8Array; readonly iv: Uint8Array} | undefined): Promise<void> {
    const before = this.#bytes
    const decipher = cipher ? decipherFor(cipher.key, cipher.iv) : undefined
    try {
      for await (const chunk of createReadStream(file, {highWaterMark: CHUNK})) {
        await this.#write(decipher ? decipher.update(chunk as Buffer) : (chunk as Buffer))
      }
      if (decipher) await this.#write(decipher.final())
    } catch (error) {
      this.#bytes = before
      await this.#file?.truncate(before).catch(() => {})
      if (isNoSpace(error)) throw new DownloadError('disk-full', 'No space left on device.')
      if (error instanceof Error && /bad decrypt|wrong final block/i.test(error.message)) {
        await fs.rm(file, {force: true})
        throw new HlsError('corrupt', 'A segment did not decrypt (bad padding).')
      }
      throw error
    }
  }

  /**
   * Append a fetched, verified segment file and delete it. Opens the next period file first when the
   * segment starts one (its init segment written first). O(bytes) I/O, O(1) otherwise.
   */
  async append(
    segment: AppendSegment,
    file: string,
    opts: {
      /** Network bytes of the segment (for `measured`). */
      readonly fetchedBytes: number
      readonly cipher?: {readonly key: Uint8Array; readonly iv: Uint8Array} | undefined
    },
  ): Promise<void> {
    this.#check(segment)
    await this.#enter(segment.period)
    if (this.#bytes === 0 && this.#initFor) {
      const init = await this.#initFor(segment.period)
      if (init) {
        await this.#copy(init, undefined)
        await fs.rm(init, {force: true})
      }
    }
    await this.#copy(file, opts.cipher)
    await fs.rm(file, {force: true})
    this.#next = segment.sequence + 1
    this.#measured.bytes += opts.fetchedBytes
    this.#measured.seconds += segment.duration
  }

  /** A segment left out (EXT-X-GAP, or missing with `missingSegments: 'skip'`): the cursor moves on. O(1). */
  skip(segment: AppendSegment): void {
    this.#check(segment)
    this.#next = segment.sequence + 1
    this.#skipped++
  }

  #check(segment: AppendSegment): void {
    if (this.#closed) throw new Error('The appender is closed.')
    if (segment.sequence < this.#next)
      throw new Error(`Segment ${segment.sequence} is behind the cursor ${this.#next}.`)
    if (segment.period < this.#period) throw new Error(`Period ${segment.period} is behind ${this.#period}.`)
  }

  /** Close the open period file; the files stay. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true
    const file = this.#file
    this.#file = undefined
    await file?.close()
  }
}
