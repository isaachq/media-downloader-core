import {createReadStream, createWriteStream} from 'node:fs'
import type {FileHandle} from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {createInterface} from 'node:readline'
import type {FormatProfile, SlideshowOptions, ValidationLevel} from '../types.js'
import {endsMidLine, removeLeftovers, renameRetrying, syncFile} from './files.js'
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
  /** The integrity check the file passed ('none': only its checksum was taken). Absent in older records. */
  readonly validation?: ValidationLevel | undefined
  /** The batch it was downloaded in, and that batch's name (absent in older records). */
  readonly batchId?: string | undefined
  readonly batchTitle?: string | undefined
  /**
   * The check after its batch found the file broken where it comes from
   * (what it found, in English): it is kept, and never downloaded again.
   */
  readonly damaged?: string | undefined
  /**
   * A photo post kept as a folder: of its images ('images'), or of its images
   * and soundtrack ('images-audio'). Absent for everything else, a photo post
   * made an MP4 included (and in records older than 1.14.7).
   */
  readonly slideshow?: ArchiveSlideshow | undefined
  readonly completedAt: number
}

/** What a photo post was kept as when it is a folder (see `ArchiveEntry.slideshow`). */
export type ArchiveSlideshow = Exclude<SlideshowOptions['mode'], 'video'>

/** Order of a page of finished downloads. */
export type ArchiveSort = 'newest' | 'oldest' | 'largest' | 'smallest'

/** A page of finished downloads, newest first (see `DownloadArchive.list`). */
export type ArchiveQuery = {
  /** Matching entries to skip, newest first. Default 0. */
  readonly offset?: number | undefined
  /** Entries per page, 1–500. Default 50. */
  readonly limit?: number | undefined
  /** Words that must all appear in the title or file name; case and accents are ignored. */
  readonly search?: string | undefined
  /** Only the files of this batch. */
  readonly batchId?: string | undefined
  /** Only the entries this accepts (a host's own filter: a site, a size range, an integrity state). */
  readonly match?: ((entry: ArchiveEntry) => boolean) | undefined
  /** Default 'newest' (by when each file finished). */
  readonly sort?: ArchiveSort | undefined
}

/** The batches finished files came from, for grouping a history (see `DownloadArchive.groups`). */
export type ArchiveGroup = {
  readonly batchId: string
  readonly title?: string | undefined
  readonly count: number
  readonly bytes: number
  /** When its newest file finished. */
  readonly lastCompletedAt: number
}

/** Every entry a query matches, in its order (see `DownloadArchive.matching`). */
export type ArchiveMatches = {
  readonly entries: readonly ArchiveEntry[]
  /** Their bytes. */
  readonly bytes: number
}

export type ArchivePage = {
  readonly entries: readonly ArchiveEntry[]
  /** Entries matching the search (all of them without one). */
  readonly total: number
  /** Bytes of the matching entries. */
  readonly bytes: number
}

/** What a lookup needs — all the archive keeps in memory per entry. */
export type ArchiveHit = {readonly filepath: string; readonly sizeBytes: number}

type ArchiveRecord = {readonly op: 'put'; readonly entry: ArchiveEntry} | {readonly op: 'del'; readonly key: string}

/** In-memory index entry: the hit, plus the log line holding the full record. */
type Indexed = ArchiveHit & {readonly line: number}

/**
 * What a photo post becomes with this profile when it is not a single file:
 * the mode for 'images' / 'images-audio' with a video profile, else undefined
 * (an MP4 of the images, or its soundtrack with an audio profile). O(1).
 */
export function archiveSlideshow(
  profile: FormatProfile,
  mode: SlideshowOptions['mode'] | undefined,
): ArchiveSlideshow | undefined {
  return profile.kind === 'video' && (mode === 'images' || mode === 'images-audio') ? mode : undefined
}

/**
 * "youtube:dQw4w9WgXcQ:video:mp4:1080" — same media + same profile = same file.
 * A photo post kept as a folder adds its mode ("tiktok:7693…:video:mp4:best#images"):
 * an MP4 of its images, its images, and its images with their sound are three
 * different results. Pass `slideshow` only for an item known to be a photo
 * post; every other key is the one older versions wrote, so their records
 * keep matching with no migration. O(1).
 */
export function archiveKey(
  extractor: string,
  mediaId: string,
  profile: FormatProfile,
  slideshow?: SlideshowOptions['mode'] | undefined,
): string {
  const kept = archiveSlideshow(profile, slideshow)
  return `${extractor.toLowerCase()}:${mediaId}:${profileKey(profile)}${kept ? `#${kept}` : ''}`
}

/** Lower case without accents: "Canción" and "cancion" find each other. */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()

/** Compact when the log holds this many more records than live entries. */
const COMPACT_SLACK = 1000

/**
 * A log line read back as a record, or undefined when it can't be one: a
 * torn write, a line of another shape, an operation of a newer version.
 * Records of older versions load as they are (the fields added since are
 * optional); a record missing its size or time gets 0, so it still lists
 * and sorts. Fields this version doesn't know are kept (the raw line is what
 * compaction writes back).
 */
export function parseArchiveLine(raw: string): ArchiveRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as {op?: unknown; key?: unknown; entry?: unknown}
  if (record.op === 'del') return typeof record.key === 'string' ? {op: 'del', key: record.key} : undefined
  if (record.op !== 'put' || typeof record.entry !== 'object' || record.entry === null) return undefined
  const entry = record.entry as Partial<Record<keyof ArchiveEntry, unknown>>
  if (typeof entry.key !== 'string' || typeof entry.filepath !== 'string') return undefined
  if (Number.isFinite(entry.sizeBytes) && Number.isFinite(entry.completedAt)) return record as ArchiveRecord
  return {
    op: 'put',
    entry: {
      ...(entry as unknown as ArchiveEntry),
      sizeBytes: Number.isFinite(entry.sizeBytes) ? (entry.sizeBytes as number) : 0,
      completedAt: Number.isFinite(entry.completedAt) ? (entry.completedAt as number) : 0,
    },
  }
}

/**
 * The records of a log, in order. Lines that aren't records are skipped
 * here — by every reader alike, so record numbers agree between passes —
 * and handed to `rejected` when given.
 */
async function* records(
  file: string,
  rejected?: (raw: string) => void,
): AsyncGenerator<{readonly record: ArchiveRecord; readonly raw: string}> {
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
    if (!raw.trim()) continue
    const record = parseArchiveLine(raw)
    if (record) yield {record, raw}
    else rejected?.(raw)
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
  /** The log ends mid-line (a write cut short): the next append starts a new line first. */
  #torn = false
  /**
   * Full records by key, oldest first — only once `list()` has been used (the
   * index alone serves downloads), then kept in step with every add / remove,
   * so a list of finished files never re-reads the log.
   */
  #full: Map<string, ArchiveEntry> | undefined
  #fullLoading: Promise<Map<string, ArchiveEntry>> | undefined
  #fullBytes = 0
  /** `#full` newest first (by completedAt), rebuilt on the first list() after a change. */
  #newestFirst: ArchiveEntry[] | undefined
  /** `#full` in the other orders, each built on first use after a change. */
  readonly #sorted = new Map<ArchiveSort, readonly ArchiveEntry[]>()
  /** Bumped by every add / update / remove: a host caches what it derives from the archive by it. */
  #version = 0
  /** Folded title + file name + SHA-256 per entry, for searching (computed once per entry). */
  readonly #haystacks = new WeakMap<ArchiveEntry, string>()

  constructor(readonly file: string) {}

  get size(): number {
    return this.#index.size
  }

  /** Changes with every add, update and removal (not with a compaction, which changes no entry). */
  get version(): number {
    return this.#version
  }

  open(): Promise<void> {
    this.#opening ??= this.#open()
    return this.#opening
  }

  async #open(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), {recursive: true})
    // a compaction a crash cut short: the log itself was never replaced
    await removeLeftovers(this.file, '.compact')
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
    this.#torn = await endsMidLine(this.file)
    this.#handle = await fs.open(this.file, 'a')
  }

  /** Where lines that aren't records go when a compaction leaves them out: kept, never dropped. */
  get rejectedFile(): string {
    return `${this.file}.rejected`
  }

  /**
   * Rewrite the log with only the latest record of each live key — streamed,
   * constant memory. The new log is on the disk before it replaces the old
   * one (a power cut leaves one or the other, whole); lines that aren't
   * records are moved to `rejectedFile`, not dropped.
   */
  async #compact(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.compact`
    const out = createWriteStream(tmp)
    const reindexed = new Map<string, Indexed>()
    const rejected: string[] = []
    let line = 0
    let written = 0
    for await (const {record, raw} of records(this.file, text => rejected.push(text))) {
      const current = line++
      if (record.op !== 'put') continue
      const live = this.#index.get(record.entry.key)
      if (live?.line !== current) continue // superseded or deleted
      if (!out.write(`${raw}\n`)) await new Promise<void>(resolve => out.once('drain', () => resolve()))
      reindexed.set(record.entry.key, {filepath: live.filepath, sizeBytes: live.sizeBytes, line: written++})
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
    if (rejected.length > 0) await fs.appendFile(this.rejectedFile, `${rejected.join('\n')}\n`)
    await syncFile(tmp)
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
    // a folder (a slideshow's images) counts while it is there; a file must keep its size
    const present = stat?.isDirectory() || (stat?.isFile() && stat.size === hit.sizeBytes)
    return present ? {filepath: hit.filepath, sizeBytes: hit.sizeBytes} : undefined
  }

  async add(entry: Omit<ArchiveEntry, 'completedAt'>): Promise<ArchiveEntry> {
    await this.open()
    const full: ArchiveEntry = {...entry, completedAt: Date.now()}
    await this.#append({op: 'put', entry: full}, line => {
      this.#index.set(full.key, {filepath: full.filepath, sizeBytes: full.sizeBytes, line})
      this.#forget(full.key)
      if (this.#full) {
        this.#full.set(full.key, full) // re-added keys move to the newest end, as in the log
        this.#fullBytes += full.sizeBytes
      }
    })
    return full
  }

  async remove(key: string): Promise<void> {
    await this.open()
    if (!this.#index.has(key)) return
    await this.#append({op: 'del', key}, () => {
      this.#index.delete(key)
      this.#forget(key)
    })
  }

  /** Forget several records in one write; how many were there. O(k). */
  async removeMany(keys: Iterable<string>): Promise<number> {
    await this.open()
    const present = [...new Set(keys)].filter(key => this.#index.has(key))
    if (present.length === 0) return 0
    await this.#appendAll(
      present.map(key => ({op: 'del', key})),
      () => {
        for (const key of present) {
          this.#index.delete(key)
          this.#forget(key)
        }
      },
    )
    return present.length
  }

  /**
   * Change what is known about a finished file (its check, a damage found
   * later) — when it finished stays as it was. Undefined when there is no such record.
   */
  async update(
    key: string,
    patch: Partial<Pick<ArchiveEntry, 'validation' | 'damaged' | 'sha256'>>,
  ): Promise<ArchiveEntry | undefined> {
    const current = (await this.#loadFull()).get(key)
    if (!current) return undefined
    const next: ArchiveEntry = {...current, ...patch}
    await this.#append({op: 'put', entry: next}, line => {
      this.#index.set(key, {filepath: next.filepath, sizeBytes: next.sizeBytes, line})
      // same place in the history: Map.set on a present key keeps its position
      this.#full?.set(key, next)
      this.#newestFirst = undefined
      this.#sorted.clear()
    })
    return next
  }

  /**
   * Finished downloads, newest first, a page at a time, optionally filtered.
   * The first call reads the log once (streamed); later calls are served from
   * memory and follow every add / remove — O(page) without a filter (sorted
   * views are kept until the next change), O(n) with one (each entry's
   * folded text is computed once).
   */
  async list(query: ArchiveQuery = {}): Promise<ArchivePage> {
    const {entries, bytes} = await this.matching(query)
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const limit = Math.min(500, Math.max(1, Math.floor(query.limit ?? 50)))
    return {entries: entries.slice(offset, offset + limit), total: entries.length, bytes}
  }

  /**
   * Every entry a query matches, in its order, and their bytes — one pass,
   * O(n) (O(1) without a filter: the sorted view is shared, never copied). A
   * host that needs all of them (an export, an action on all shown) asks once
   * instead of paging, which would filter everything again per page.
   * `offset` and `limit` are ignored. The array must not be modified.
   */
  async matching(query: Omit<ArchiveQuery, 'offset' | 'limit'> = {}): Promise<ArchiveMatches> {
    const full = await this.#loadFull()
    // insertion order is nearly newest-last already: the stable sort is close to linear
    this.#newestFirst ??= [...full.values()].reverse().sort((a, b) => b.completedAt - a.completedAt)
    const ordered = this.#ordered(query.sort ?? 'newest', this.#newestFirst)
    const words = fold(query.search ?? '')
      .split(/\s+/)
      .filter(Boolean)
    const {batchId, match} = query
    let matching: readonly ArchiveEntry[] = ordered
    let bytes = this.#fullBytes
    if (words.length > 0 || batchId !== undefined || match !== undefined) {
      const kept: ArchiveEntry[] = []
      bytes = 0
      for (const entry of ordered) {
        if (batchId !== undefined && entry.batchId !== batchId) continue
        if (match && !match(entry)) continue
        if (words.length > 0) {
          const haystack = this.#haystack(entry)
          if (!words.every(word => haystack.includes(word))) continue
        }
        kept.push(entry)
        bytes += entry.sizeBytes
      }
      matching = kept
    }
    return {entries: matching, bytes}
  }

  /** The loaded entries in one order, kept until the next change: a page of a size sort doesn't sort again. */
  #ordered(sort: ArchiveSort, newest: readonly ArchiveEntry[]): readonly ArchiveEntry[] {
    if (sort === 'newest') return newest
    let view = this.#sorted.get(sort)
    if (!view) {
      // stable sorts of the newest-first view: ties keep the order they always had
      view =
        sort === 'oldest'
          ? [...newest].reverse()
          : sort === 'largest'
            ? [...newest].sort((a, b) => b.sizeBytes - a.sizeBytes)
            : [...newest].sort((a, b) => a.sizeBytes - b.sizeBytes)
      this.#sorted.set(sort, view)
    }
    return view
  }

  /** The batches the finished files came from, newest first — O(n) over the loaded records. */
  async groups(): Promise<ArchiveGroup[]> {
    const groups = new Map<
      string,
      {batchId: string; title?: string | undefined; count: number; bytes: number; lastCompletedAt: number}
    >()
    for (const entry of (await this.#loadFull()).values()) {
      if (!entry.batchId) continue
      const group = groups.get(entry.batchId) ?? {
        batchId: entry.batchId,
        title: entry.batchTitle,
        count: 0,
        bytes: 0,
        lastCompletedAt: 0,
      }
      group.count++
      group.bytes += entry.sizeBytes
      group.lastCompletedAt = Math.max(group.lastCompletedAt, entry.completedAt)
      group.title ??= entry.batchTitle
      groups.set(entry.batchId, group)
    }
    return [...groups.values()].sort((a, b) => b.lastCompletedAt - a.lastCompletedAt)
  }

  /** Every live entry with its full record, streamed from disk (used by verification). */
  async entries(): Promise<ArchiveEntry[]> {
    await this.open()
    await this.#writes
    return this.#live()
  }

  async #live(): Promise<ArchiveEntry[]> {
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
    this.#full = undefined
    this.#fullLoading = undefined
    this.#fullBytes = 0
    this.#newestFirst = undefined
    this.#sorted.clear()
  }

  /**
   * Load the full records once. It runs inside the write chain, so no record
   * lands between reading the log and following later writes.
   */
  #loadFull(): Promise<Map<string, ArchiveEntry>> {
    if (this.#full) return Promise.resolve(this.#full)
    this.#fullLoading ??= this.open().then(() => {
      const load = this.#writes.then(async () => {
        const full = new Map<string, ArchiveEntry>()
        let bytes = 0
        for (const entry of await this.#live()) {
          full.set(entry.key, entry)
          bytes += entry.sizeBytes
        }
        this.#full = full
        this.#fullBytes = bytes
        this.#newestFirst = undefined
        this.#sorted.clear()
        return full
      })
      this.#writes = load.then(
        () => {},
        () => {},
      )
      // a failed read is tried again next time
      return load.catch(error => {
        this.#fullLoading = undefined
        throw error
      })
    })
    return this.#fullLoading
  }

  /** Drop a key from the loaded records (before a re-add or on removal). */
  #forget(key: string): void {
    this.#newestFirst = undefined
    this.#sorted.clear()
    const old = this.#full?.get(key)
    if (!old) return
    this.#full!.delete(key)
    this.#fullBytes -= old.sizeBytes
  }

  #haystack(entry: ArchiveEntry): string {
    let text = this.#haystacks.get(entry)
    if (text === undefined) {
      // the file's SHA-256 too: a fingerprint (or its first characters) finds the file it belongs to
      text = fold(`${entry.title ?? ''} ${path.basename(entry.filepath)} ${entry.sha256 ?? ''}`)
      this.#haystacks.set(entry, text)
    }
    return text
  }

  /**
   * Writes are chained so concurrent jobs never interleave bytes of two
   * records; `apply` receives the record's line number and updates the
   * index as the line lands, so index and file always agree.
   */
  #append(record: ArchiveRecord, apply: (line: number) => void): Promise<void> {
    return this.#appendAll([record], line => apply(line))
  }

  /**
   * Append records in one write. A write that fails may have left part of a
   * line: the next one starts on a new line, so the records after it are
   * never glued to the torn one.
   */
  #appendAll(batch: readonly ArchiveRecord[], apply: (firstLine: number) => void): Promise<void> {
    const text = batch.map(record => `${JSON.stringify(record)}\n`).join('')
    const write = this.#writes.then(async () => {
      if (!this.#handle) throw new Error('Archive is closed.')
      try {
        await this.#handle.write(this.#torn ? `\n${text}` : text)
      } catch (error) {
        this.#torn = true
        throw error
      }
      this.#torn = false
      apply(this.#records)
      this.#records += batch.length
      this.#version++
    })
    this.#writes = write.catch(() => {})
    return write
  }
}
