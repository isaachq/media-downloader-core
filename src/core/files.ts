import {createHash} from 'node:crypto'
import {createReadStream, createWriteStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {Readable, Transform} from 'node:stream'
import * as streams from 'node:stream/promises'
import type {ReadableStream as WebReadableStream} from 'node:stream/web'
import {setTimeout as sleep} from 'node:timers/promises'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * Make a string safe as a file / folder name on both macOS and Windows, so a
 * backup copied between machines keeps working.
 */
export function sanitizeFilename(name: string, maxLength = 120): string {
  let clean = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '') // Windows drops trailing dots and spaces
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`
  if (clean.length > maxLength) clean = clean.slice(0, maxLength).trimEnd()
  return clean || 'untitled'
}

/**
 * How finished files and playlist folders are named.
 *  - 'portable' (default): ASCII letters, digits and hyphens only — what car
 *    stereos, TVs and FAT32 USB sticks read reliably.
 *  - 'original': the title as is (accents, symbols, emoji), made safe for
 *    macOS and Windows.
 */
export type FileNameStyle = 'portable' | 'original'

// letters NFKD can't split into "base + accent"
const TRANSLITERATE: Readonly<Record<string, string>> = {
  ß: 'ss',
  ẞ: 'SS',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ø: 'o',
  Ø: 'O',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ð: 'd',
  Ð: 'D',
  þ: 'th',
  Þ: 'Th',
  ı: 'i',
  ŋ: 'ng',
  Ŋ: 'NG',
}
const TRANSLITERABLE = new RegExp(`[${Object.keys(TRANSLITERATE).join('')}]`, 'g')

/**
 * "Canción Ñandú — ¡Live! 🎸 (2024)" → "Cancion-Nandu-Live-2024". O(n):
 * NFKD splits accented letters and compatibility forms (full-width, ligatures,
 * circled digits) into ASCII + marks, the marks are dropped, apostrophes
 * vanish ("Don't" → "Dont") and every other run of non-alphanumerics becomes
 * one hyphen. Scripts with no ASCII form (Japanese, Cyrillic…) end up empty —
 * callers fall back to the media id.
 */
export function portableName(text: string, maxLength = 120): string {
  let name = text
    .normalize('NFKD')
    .replace(TRANSLITERABLE, char => TRANSLITERATE[char] ?? '')
    .replace(/\p{M}+/gu, '')
    .replace(/['’‘`´]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (name.length > maxLength) name = name.slice(0, maxLength).replace(/-+$/, '')
  return WINDOWS_RESERVED.test(name) ? `${name}-file` : name
}

/** A folder name for a playlist / profile title. */
export function folderName(title: string, style: FileNameStyle): string {
  return style === 'portable' ? portableName(title, 100) || 'Playlist' : sanitizeFilename(title, 100)
}

/**
 * The name of a finished file without its extension:
 *   portable  "001-Song-Title-k1gsZ-OsGpI"
 *   original  "001 - Song Title [k1gsZ-OsGpI]"
 */
export function mediaFileStem(
  style: FileNameStyle,
  media: {readonly title: string; readonly id?: string | undefined; readonly index?: number | undefined},
): string {
  const index = media.index === undefined ? undefined : String(media.index).padStart(3, '0')
  if (style === 'original') {
    const id = media.id ? ` [${sanitizeFilename(media.id, 40)}]` : ''
    return `${index ? `${index} - ` : ''}${sanitizeFilename(media.title, 150)}${id}`
  }
  const parts = [index, portableName(media.title, 120), media.id ? portableName(media.id, 40) : undefined]
  return parts.filter(Boolean).join('-') || 'media'
}

/** "file.mp4" → "file (2).mp4" while the name is taken. */
export async function uniquePath(target: string): Promise<string> {
  const ext = path.extname(target)
  const stem = target.slice(0, target.length - ext.length)
  let candidate = target
  for (let n = 2; ; n++) {
    try {
      await fs.access(candidate)
      candidate = `${stem} (${n})${ext}`
    } catch {
      return candidate
    }
  }
}

/** Errors Windows raises while another process briefly holds a file (antivirus scan, indexer, a process just exited). */
const TRANSIENT_LOCKS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 12 // 50 ms doubling, capped at 1 s: ~9 s in all

/**
 * `fs.rename` that waits out Windows' short-lived locks: right after an .exe
 * is written or run, Defender scans it and renaming its folder fails with
 * EPERM for a moment. Elsewhere those errors are real (permissions) and are
 * thrown at once.
 */
export async function renameRetrying(
  from: string,
  to: string,
  deps: {
    readonly platform?: NodeJS.Platform
    readonly rename?: (from: string, to: string) => Promise<void>
    readonly sleep?: (ms: number) => Promise<unknown>
  } = {},
): Promise<void> {
  const rename = deps.rename ?? fs.rename
  const windows = (deps.platform ?? process.platform) === 'win32'
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!windows || !TRANSIENT_LOCKS.has(code) || attempt >= RENAME_ATTEMPTS) throw error
      await (deps.sleep ?? sleep)(Math.min(1000, 50 * 2 ** (attempt - 1)))
    }
  }
}

/** Delete, retrying the same Windows locks (Node's own retry for rm). */
export const removeRetrying = (target: string) =>
  fs.rm(target, {recursive: true, force: true, maxRetries: 8, retryDelay: 100})

/**
 * Move a validated file into its final folder. Rename when on the same
 * volume (instant, atomic); otherwise copy → verify size → rename → delete,
 * so a disconnected external drive never leaves a truncated file under the
 * final name.
 */
export async function moveIntoPlace(source: string, destination: string): Promise<string> {
  await fs.mkdir(path.dirname(destination), {recursive: true})
  const target = await uniquePath(destination)
  try {
    await renameRetrying(source, target)
    return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }

  const partial = `${target}.partial`
  if ((await fs.stat(source)).isDirectory()) {
    // a folder of files (a slideshow's images) on another volume: copy it whole, then swap it in
    try {
      await fs.cp(source, partial, {recursive: true, errorOnExist: true})
      await renameRetrying(partial, target)
    } catch (error) {
      await fs.rm(partial, {recursive: true, force: true})
      throw error
    }
    await fs.rm(source, {recursive: true, force: true})
    return target
  }
  try {
    await fs.copyFile(source, partial)
    const [a, b] = await Promise.all([fs.stat(source), fs.stat(partial)])
    if (a.size !== b.size) throw new Error(`Incomplete copy (${b.size} of ${a.size} bytes).`)
    await renameRetrying(partial, target)
  } catch (error) {
    await fs.rm(partial, {force: true})
    throw error
  }
  await fs.rm(source, {force: true})
  return target
}

/** Earliest believable publication date (before it, a timestamp is a placeholder). */
const EARLIEST_PUBLISHED_S = Date.UTC(1990, 0, 1) / 1000

/**
 * When a media item was published, in unix seconds: its exact timestamp, else
 * noon UTC of its YYYYMMDD day (the same calendar day in nearly every time
 * zone). Undefined when unknown or implausible (zero, far future).
 */
export function publishedSeconds(info: {
  readonly publishedAt?: number | null | undefined
  readonly uploadDate?: string | null | undefined
}): number | undefined {
  const latest = Date.now() / 1000 + 86_400
  const at = info.publishedAt
  if (typeof at === 'number' && Number.isFinite(at) && at >= EARLIEST_PUBLISHED_S && at <= latest) return Math.floor(at)
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(info.uploadDate ?? '')
  if (!day) return undefined
  const noon = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12) / 1000
  return noon >= EARLIEST_PUBLISHED_S && noon <= latest ? noon : undefined
}

/**
 * Date a finished file by its publication: its modification time becomes the
 * day it was published, so sorting a folder by date sorts by publication.
 * (Creation time can't be set portably; the date tag inside carries it too.)
 */
export async function stampPublished(file: string, seconds: number): Promise<void> {
  await fs.utimes(file, seconds, seconds)
}

/** Short stable hash — names a job's work folder so a retry resumes its .part files. */
export function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** Free bytes on the volume holding `dir`, or undefined if the platform can't tell. */
export async function freeSpace(dir: string): Promise<number | undefined> {
  try {
    await fs.mkdir(dir, {recursive: true})
    const stats = await fs.statfs(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return undefined
  }
}

/** SHA-256 of a file on the calling thread. Use `HashPool` for large files. */
/** Lowercase hexadecimal SHA-256 digest. */
export type Sha256Hex = string

export async function sha256File(file: string, signal?: AbortSignal): Promise<Sha256Hex> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, {highWaterMark: 1024 * 1024, ...(signal && {signal})})) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** Write a web stream (fetch body) to `dest`, hashing it on the way. Nothing is buffered in memory. */
export async function sha256Stream(
  body: ReadableStream<Uint8Array>,
  dest: string,
  signal?: AbortSignal | undefined,
): Promise<Sha256Hex> {
  const hash = createHash('sha256')
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await streams.pipeline(
    Readable.fromWeb(body as WebReadableStream<Uint8Array>),
    tap,
    createWriteStream(dest),
    signal ? {signal} : {},
  )
  return hash.digest('hex')
}

/** Write via tmp + rename: readers see either the old or the new content, never half. */
export async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), {recursive: true})
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, data)
  await renameRetrying(tmp, file)
}

/** True if `child` is inside `parent` (after resolving `..`). */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
