import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {ValidationIssueCode} from '../types.js'
import {renameRetrying} from './files.js'

/** A media whose file is broken where it comes from: not downloaded again. */
export type DamagedEntry = {
  /** "extractor:mediaId" when both are known, else "url:<url>". */
  readonly key: string
  readonly url: string
  readonly title?: string | undefined
  readonly extractor?: string | undefined
  readonly mediaId?: string | undefined
  /** What the check found (English, for logs and tooltips). */
  readonly reason: string
  /** The validation issues behind it. */
  readonly issues: readonly ValidationIssueCode[]
  readonly at: number
}

/**
 * Issues that say the file itself is broken — it doesn't decode, ends early,
 * runs shorter than announced, or can't be read at all. Codec or container
 * mismatches are not among them: those are about the conversion, not the source.
 */
export const SOURCE_DAMAGE: ReadonlySet<ValidationIssueCode> = new Set<ValidationIssueCode>([
  'file-empty',
  'probe-failed',
  'decode-failed',
  'decode-errors',
  'incomplete-decode',
  'duration-mismatch',
])

/** Whether these validation issues mean the source file is damaged. */
export const isSourceDamage = (issues: readonly ValidationIssueCode[]): boolean =>
  issues.length > 0 && issues.some(code => SOURCE_DAMAGE.has(code))

const mediaKey = (extractor: string, mediaId: string): string => `${extractor.toLowerCase()}:${mediaId}`
const urlKey = (url: string): string => `url:${url}`

export type DamagedLookup = {
  readonly url?: string | undefined
  readonly extractor?: string | undefined
  readonly mediaId?: string | undefined
}

/**
 * Media found damaged at the source, so they are never downloaded again:
 * `damaged.json` in the data folder, small (one line per broken video), kept
 * in memory and written atomically on every change. Looked up by media id
 * (same video, any link) and by url (a link whose id is not known yet).
 */
export class DamagedRegistry {
  #entries = new Map<string, DamagedEntry>()
  /** url → key, for lookups before the media id is known. */
  #byUrl = new Map<string, string>()
  #loading: Promise<void> | undefined
  #writes: Promise<void> = Promise.resolve()

  constructor(readonly file: string) {}

  load(): Promise<void> {
    this.#loading ??= this.#read()
    return this.#loading
  }

  async #read(): Promise<void> {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (!Array.isArray(saved)) return
      for (const entry of saved as DamagedEntry[]) {
        if (typeof entry?.key === 'string' && typeof entry.url === 'string') this.#index(entry)
      }
    } catch {
      // first run, or an unreadable file: nothing is known damaged
    }
  }

  get size(): number {
    return this.#entries.size
  }

  /** The record for a media, by id or by url; undefined when it isn't known damaged. */
  async find(lookup: DamagedLookup): Promise<DamagedEntry | undefined> {
    await this.load()
    if (lookup.extractor && lookup.mediaId) {
      const hit = this.#entries.get(mediaKey(lookup.extractor, lookup.mediaId))
      if (hit) return hit
    }
    const key = lookup.url ? this.#byUrl.get(lookup.url) : undefined
    return key ? this.#entries.get(key) : undefined
  }

  /** Newest first. */
  async list(): Promise<DamagedEntry[]> {
    await this.load()
    return [...this.#entries.values()].sort((a, b) => b.at - a.at)
  }

  async add(entry: Omit<DamagedEntry, 'key' | 'at'>): Promise<DamagedEntry> {
    await this.load()
    const key = entry.extractor && entry.mediaId ? mediaKey(entry.extractor, entry.mediaId) : urlKey(entry.url)
    const full: DamagedEntry = {...entry, key, at: Date.now()}
    this.#index(full)
    await this.#save()
    return full
  }

  /** Forget one (the user wants to try it again); false when it wasn't there. */
  async remove(key: string): Promise<boolean> {
    await this.load()
    const entry = this.#entries.get(key)
    if (!entry) return false
    this.#entries.delete(key)
    if (this.#byUrl.get(entry.url) === key) this.#byUrl.delete(entry.url)
    await this.#save()
    return true
  }

  #index(entry: DamagedEntry): void {
    this.#entries.set(entry.key, entry)
    this.#byUrl.set(entry.url, entry.key)
  }

  /** Writes are chained (never two at once) and atomic (temp file, then rename). */
  #save(): Promise<void> {
    const text = JSON.stringify([...this.#entries.values()], null, 1)
    const write = this.#writes.then(async () => {
      await fs.mkdir(path.dirname(this.file), {recursive: true})
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.writeFile(tmp, text)
      await renameRetrying(tmp, this.file)
    })
    this.#writes = write.catch(() => {})
    return write
  }
}
