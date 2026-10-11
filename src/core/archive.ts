import {createReadStream, createWriteStream} from 'node:fs'
import type {FileHandle} from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createInterface} from 'node:readline'
import type {FormatProfile} from '../types.js'
import {renameRetrying} from './files.js'
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

/** What a lookup needs — all the archive keeps in memory per entry. */
export type ArchiveHit = {readonly filepath: string; readonly sizeBytes: number}

type ArchiveRecord = {readonly op: 'put'; readonly entry: ArchiveEntry} | {readonly op: 'del'; readonly key: string}

/** In-memory index entry: the hit, plus the log line holding the full record. */
type Indexed = ArchiveHit & {readonly line: number}

/** "youtube:dQw4w9WgXcQ:video:mp4:1080" — same media + same profile = same file. */
export function archiveKey(extractor: string, mediaId: string, profile: FormatProfile): string {
  return `${extractor.toLowerCase()}:${mediaId}:${profileKey(profile)}`
}

/** Compact when the log holds this many more records than live entries. */
const COMPACT_SLACK = 1000

async function* records(file: string): AsyncGenerator<{readonly record: ArchiveRecord; readonly raw: string}> {
  try {
    await fs.access(file)
  } catch {
    return // first run
  }
  const lines = createInterface({
    input: createReadStream(file, {encoding: 'utf8'}),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  for await (const raw of lines) {
    if (!raw) continue
    try {
      yield {record: JSON.parse(raw) as ArchiveRecord, raw}
    } catch {
      // torn write from a crash
    }
  }
}

/**
 * Record of everything downloaded and validated, so re-adding a playlist
 * only fetches what's new or missing, and backups can be re-verified later
 * against the stored SHA-256.
 *
 * Storage is an append-only JSON-lines log: recording a download appends one
 * line (O(1)). Memory holds only a compact index (key → path, size, log
 * line); the full records (title, url, checksum…) stay on disk and are
 * streamed when needed. The log is compacted (streaming, two passes) when
 * superseded records pile up.
 */
export class DownloadArchive {
  #index = new Map<string, Indexed>()
  #records = 0
  #handle: FileHandle | undefined
  #opening: Promise<void> | undefined
  #writes: Promise<void> = Promise.resolve()

  constructor(readonly file: string) {}

  get size(): number {
    return this.#index.size
  }

  open(): Promise<void> {
    this.#opening ??= this.#open()
    return this.#opening
  }

  async #open(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), {recursive: true})
    for await (const {record} of records(this.file)) {
      const line = this.#records++
      if (record.op === 'put') {
        const {key, filepath, sizeBytes} = record.entry
        this.#index.set(key, {filepath, sizeBytes, line})
      } else if (record.op === 'del') {
        this.#index.delete(record.key)
      }
    }
    if (this.#records > this.#index.size + COMPACT_SLACK) await this.#compact()
    this.#handle = await fs.open(this.file, 'a')
  }

  /** Rewrite the log with only the latest record of each live key — streamed, constant memory. */
  async #compact(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.compact`
    const out = createWriteStream(tmp)
    const reindexed = new Map<string, Indexed>()
    let line = 0
    let written = 0
    for await (const {record, raw} of records(this.file)) {
      const current = line++
      if (record.op !== 'put') continue
      const live = this.#index.get(record.entry.key)
      if (live?.line !== current) continue // superseded or deleted
      if (!out.write(`${raw}\n`)) await new Promise<void>(resolve => out.once('drain', () => resolve()))
      reindexed.set(record.entry.key, {filepath: live.filepath, sizeBytes: live.sizeBytes, line: written++})
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
    await renameRetrying(tmp, this.file)
    this.#index = reindexed
    this.#records = written
  }

  /** The archived file for `key`, only if it still exists with the recorded size. */
  async find(key: string): Promise<ArchiveHit | undefined> {
    await this.open()
    const hit = this.#index.get(key)
    if (!hit) return undefined
    const stat = await fs.stat(hit.filepath).catch(() => undefined)
    return stat?.isFile() && stat.size === hit.sizeBytes
      ? {filepath: hit.filepath, sizeBytes: hit.sizeBytes}
      : undefined
  }

  async add(entry: Omit<ArchiveEntry, 'completedAt'>): Promise<ArchiveEntry> {
    await this.open()
    const full: ArchiveEntry = {...entry, completedAt: Date.now()}
    await this.#append({op: 'put', entry: full}, line => {
      this.#index.set(full.key, {filepath: full.filepath, sizeBytes: full.sizeBytes, line})
    })
    return full
  }

  async remove(key: string): Promise<void> {
    await this.open()
    if (!this.#index.has(key)) return
    await this.#append({op: 'del', key}, () => this.#index.delete(key))
  }

  /** Every live entry with its full record, streamed from disk (used by verification). */
  async entries(): Promise<ArchiveEntry[]> {
    await this.open()
    await this.#writes
    const entries: ArchiveEntry[] = []
    let line = 0
    for await (const {record} of records(this.file)) {
      const current = line++
      if (record.op === 'put' && this.#index.get(record.entry.key)?.line === current) entries.push(record.entry)
    }
    return entries
  }

  /** Flush pending writes and release the file handle and the index. */
  async close(): Promise<void> {
    if (!this.#opening) return
    await this.#opening.catch(() => {})
    await this.#writes
    await this.#handle?.close()
    this.#handle = undefined
    this.#opening = undefined
    this.#index.clear()
    this.#records = 0
  }

  /**
   * Writes are chained so concurrent jobs never interleave bytes of two
   * records; `apply` receives the record's line number and updates the
   * index as the line lands, so index and file always agree.
   */
  #append(record: ArchiveRecord, apply: (line: number) => void): Promise<void> {
    const text = `${JSON.stringify(record)}\n`
    const write = this.#writes.then(async () => {
      if (!this.#handle) throw new Error('Archive is closed.')
      await this.#handle.write(text)
      apply(this.#records++)
    })
    this.#writes = write.catch(() => {})
    return write
  }
}
