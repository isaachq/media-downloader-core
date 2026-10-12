import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {Executable} from '../binaries/executable.js'
import type {DownloadArchive} from '../core/archive.js'
import {AUDIO_CONTAINERS, VIDEO_CONTAINERS} from '../core/formats.js'
import {ffprobe} from '../core/validate.js'
import type {FormatProfile} from '../types.js'

/** A TikTok post id: 15–22 digits (today's are 19). */
const ID_IN_NAME = /(\d{15,22})(?!.*\d{15,22})/
/** Media a folder of posts holds (a slideshow's folder counts too). */
const MEDIA = /\.(mp4|m4a|mp3|webm|mkv|opus|flac|wav|aac|ogg|mov)$/i
/** Files probed at once when a name carries no id. */
const PROBES = 4

export type FolderScan = {
  /** Post id → the file (or slideshow folder) that holds it. */
  readonly ids: ReadonlyMap<string, string>
  /** Media files with no id found in their name, archive record or tags. */
  readonly unknown: readonly string[]
  /** How each id was found. */
  readonly byName: number
  readonly byArchive: number
  readonly byTags: number
  /** Media files per extension ("mp4" → 835); slideshow folders don't count. */
  readonly formats: ReadonlyMap<string, number>
}

/** The format a folder's files are in, before anything is synced into it. */
export type FolderFormat = {
  /** Media files in the folder. */
  readonly files: number
  /** Their extensions, most files first: one when the folder is consistent. */
  readonly formats: readonly string[]
}

const extensionOf = (name: string): string => path.extname(name).slice(1).toLowerCase()

const byCount = (counts: ReadonlyMap<string, number>): string[] =>
  [...counts].sort((a, b) => b[1] - a[1]).map(([format]) => format)

/** Which formats a folder's media files are in — a quick look (names only), for choosing a sync's format. */
export async function folderFormat(folder: string): Promise<FolderFormat> {
  const counts = new Map<string, number>()
  let files = 0
  for (const entry of await readFolder(folder)) {
    if (!entry.isFile() || entry.name.startsWith('.') || !MEDIA.test(entry.name)) continue
    files++
    counts.set(extensionOf(entry.name), (counts.get(extensionOf(entry.name)) ?? 0) + 1)
  }
  return {files, formats: byCount(counts)}
}

/**
 * The profile a sync into this folder downloads: a folder holds one format,
 * so a folder that has files decides it (an MP4 folder gets MP4, never MP3
 * next to them); an empty one takes `requested`. A problem (mixed formats,
 * a format sync can't produce, a request that differs) is the message to show.
 */
export function syncProfile(
  found: FolderFormat,
  requested: FormatProfile | undefined,
  fallback: FormatProfile,
): {readonly profile: FormatProfile} | {readonly problem: string} {
  if (found.formats.length === 0) return {profile: requested ?? fallback}
  const names = (formats: readonly string[]) => formats.map(format => format.toUpperCase()).join(', ')
  if (found.formats.length > 1) {
    return {
      problem: `The folder mixes ${names(found.formats)} files: a synced folder holds one format. Choose a folder with one.`,
    }
  }
  const container = found.formats[0]!
  if (requested && requested.container !== container) {
    return {
      problem: `The folder holds ${container.toUpperCase()} files: its sync downloads ${container.toUpperCase()} too, not ${requested.container.toUpperCase()}.`,
    }
  }
  if (requested) return {profile: requested}
  if ((VIDEO_CONTAINERS as readonly string[]).includes(container)) {
    return {profile: {kind: 'video', container: container as (typeof VIDEO_CONTAINERS)[number]}}
  }
  if ((AUDIO_CONTAINERS as readonly string[]).includes(container)) {
    return {profile: {kind: 'audio', container: container as (typeof AUDIO_CONTAINERS)[number]}}
  }
  return {problem: `The folder holds ${names(found.formats)} files, a format sync doesn't download.`}
}

/** A scan's formats, in `folderFormat`'s terms. */
export const scanFormat = (scan: FolderScan): FolderFormat => ({
  files: [...scan.formats.values()].reduce((sum, count) => sum + count, 0),
  formats: byCount(scan.formats),
})

async function readFolder(folder: string) {
  return fs.readdir(folder, {withFileTypes: true}).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
}

/**
 * Which posts a folder already holds — the ids a sync compares against.
 * In order of cost: the id in the file name (the app's names end with it:
 * "title-<id>.mp4", "Title [<id>].mp4"); the archive's records of files in
 * the folder; and, only for media whose name has no id (renamed files), the
 * post link the app writes into each file's tags (ffprobe, a few at a time).
 */
export async function scanFolder(
  folder: string,
  opts: {
    readonly archive?: DownloadArchive | undefined
    readonly extractor?: string | undefined
    readonly ffprobe?: Executable | undefined
    readonly signal?: AbortSignal | undefined
  } = {},
): Promise<FolderScan> {
  const ids = new Map<string, string>()
  let byName = 0
  let byArchive = 0
  let byTags = 0
  const entries = await readFolder(folder)
  const formats = new Map<string, number>()
  const nameless: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const file = path.join(folder, entry.name)
    const isMedia = entry.isDirectory() || MEDIA.test(entry.name)
    if (!isMedia) continue
    if (entry.isFile()) formats.set(extensionOf(entry.name), (formats.get(extensionOf(entry.name)) ?? 0) + 1)
    const id = ID_IN_NAME.exec(entry.name)?.[1]
    if (id) {
      if (!ids.has(id)) byName++
      ids.set(id, file)
    } else if (entry.isFile()) nameless.push(file)
  }

  if (opts.archive) {
    const inside = path.resolve(folder) + path.sep
    for (let offset = 0; ; offset += 500) {
      const page = await opts.archive.list({offset, limit: 500})
      for (const record of page.entries) {
        if (opts.extractor && record.extractor !== opts.extractor) continue
        if (!path.resolve(record.filepath).startsWith(inside) || ids.has(record.mediaId)) continue
        // only while the file is still there: a deleted file is not "had"
        if (
          !(await fs.stat(record.filepath).then(
            () => true,
            () => false,
          ))
        )
          continue
        ids.set(record.mediaId, record.filepath)
        byArchive++
      }
      if (offset + page.entries.length >= page.total || page.entries.length === 0) break
    }
  }

  const unknown: string[] = []
  const placed = new Set(ids.values())
  const remaining = nameless.filter(file => !placed.has(file))
  if (opts.ffprobe && remaining.length > 0) {
    let next = 0
    const worker = async () => {
      for (let i = next++; i < remaining.length; i = next++) {
        opts.signal?.throwIfAborted()
        const file = remaining[i]!
        const tags = await ffprobe(opts.ffprobe!, file, opts.signal)
          .then(probe => Object.values(probe.format?.tags ?? {}).join(' '))
          .catch(() => '')
        const id = /\/(?:video|photo)\/(\d{15,22})/.exec(tags)?.[1]
        if (id && !ids.has(id)) {
          ids.set(id, file)
          byTags++
        } else if (!id) unknown.push(file)
      }
    }
    await Promise.all(Array.from({length: Math.min(PROBES, remaining.length)}, worker))
  } else unknown.push(...remaining)

  return {ids, unknown, byName, byArchive, byTags, formats}
}
