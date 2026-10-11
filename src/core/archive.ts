import {createReadStream} from 'node:fs'
import type {FileHandle} from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createInterface} from 'node:readline'
import type {FormatProfile} from '../types.js'
import {profileKey} from './formats.js'

export type ArchiveEntry = {
  readonly key: string
  readonly extractor: string
  readonly mediaId: string
  readonly profile: string
  readonly url: string
  readonly filepath: string
  readonly sizeBytes: number
  readonly title?: string | undefined
  readonly sha256?: string | undefined
  readonly duration?: number | undefined
  readonly completedAt: number
}

type ArchiveRecord = {readonly op: 'put'; readonly entry: ArchiveEntry} | {readonly op: 'del'; readonly key: string}

/** "youtube:dQw4w9WgXcQ:video:mp4:1080" — same media + same profile = same file. */
export function archiveKey(extractor: string, mediaId: string, profile: FormatProfile): string {
  return `${extractor.toLowerCase()}:${mediaId}:${profileKey(profile)}`
}

/** Compact when the log holds this many more records than live entries. */
const COMPACT_SLACK = 1000

/**
 * Record of everything downloaded and validated, so re-adding a playlist
 * only fetches what's new or missing, and backups can be re-verified later
 * against the stored SHA-256.
 *
 * Storage is an append-only JSON-lines log: recording a download appends one
 * line (O(1)) instead of rewriting the whole file, loading streams line by
 * line, and a torn last line after a crash is simply skipped. The log is
 * compacted on open when superseded records pile up.
 */
export class DownloadArchive {
  #entries = new Map<string, ArchiveEntry>()
  #records = 0
  #handle: FileHandle | undefined
  #opening: Promise<void> | undefined
  #writes: Promise<void> = Promise.resolve()

  constructor(readonly file: string) {}

  get size(): number {
    return this.#entries.size
  }

  open(): Promise<void> {
    this.#opening ??= this.#open()
    return this.#opening
  }

  async #open(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), {recursive: true})
    await this.#load()
    if (this.#records > this.#entries.size + COMPACT_SLACK) await this.#compact()
    this.#handle = await fs.open(this.file, 'a')
  }

  async #load(): Promise<void> {
    let stream: ReturnType<typeof createReadStream>
    try {
      await fs.access(this.file)
      stream = createReadStream(this.file, {encoding: 'utf8'})
    } catch {
      return // first run
    }
    const lines = createInterface({input: stream, crlfDelay: Number.POSITIVE_INFINITY})
    for await (const line of lines) {
      if (line.trim() === '') continue
      let record: ArchiveRecord
      try {
        record = JSON.parse(line) as ArchiveRecord
      } catch {
        continue // torn write from a crash
      }
      this.#records++
      if (record.op === 'put') this.#entries.set(record.entry.key, record.entry)
      else if (record.op === 'del') this.#entries.delete(record.key)
    }
  }

  async #compact(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.compact`
    const body = [...this.#entries.values()].map(entry => JSON.stringify({op: 'put', entry})).join('\n')
    await fs.writeFile(tmp, body ? `${body}\n` : '')
    await fs.rename(tmp, this.file)
    this.#records = this.#entries.size
  }

  /** The entry for `key`, only if its file still exists with the recorded size. */
  async find(key: string): Promise<ArchiveEntry | undefined> {
    await this.open()
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    const stat = await fs.stat(entry.filepath).catch(() => undefined)
    return stat?.isFile() && stat.size === entry.sizeBytes ? entry : undefined
  }

  async add(entry: Omit<ArchiveEntry, 'completedAt'>): Promise<ArchiveEntry> {
    await this.open()
    const full: ArchiveEntry = {...entry, completedAt: Date.now()}
    this.#entries.set(full.key, full)
    await this.#append({op: 'put', entry: full})
    return full
  }

  async remove(key: string): Promise<void> {
    await this.open()
    if (this.#entries.delete(key)) await this.#append({op: 'del', key})
  }

  async entries(): Promise<readonly ArchiveEntry[]> {
    await this.open()
    return [...this.#entries.values()]
  }

  /** Flush pending writes and release the file handle. */
  async close(): Promise<void> {
    if (!this.#opening) return
    await this.#opening.catch(() => {})
    await this.#writes
    await this.#handle?.close()
    this.#handle = undefined
    this.#opening = undefined
    this.#entries.clear()
    this.#records = 0
  }

  /** Writes are chained so concurrent jobs never interleave bytes of two records. */
  #append(record: ArchiveRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const write = this.#writes.then(async () => {
      if (!this.#handle) throw new Error('Archive is closed.')
      await this.#handle.write(line)
      this.#records++
    })
    this.#writes = write.catch(() => {})
    return write
  }
}
