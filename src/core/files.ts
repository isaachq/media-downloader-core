import {createHash} from 'node:crypto'
import {createReadStream, createWriteStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {Readable, Transform} from 'node:stream'
import * as streams from 'node:stream/promises'
import type {ReadableStream as WebReadableStream} from 'node:stream/web'

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
    await fs.rename(source, target)
    return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }

  const partial = `${target}.partial`
  try {
    await fs.copyFile(source, partial)
    const [a, b] = await Promise.all([fs.stat(source), fs.stat(partial)])
    if (a.size !== b.size) throw new Error(`Incomplete copy (${b.size} of ${a.size} bytes).`)
    await fs.rename(partial, target)
  } catch (error) {
    await fs.rm(partial, {force: true})
    throw error
  }
  await fs.rm(source, {force: true})
  return target
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
  await fs.rename(tmp, file)
}

/** True if `child` is inside `parent` (after resolving `..`). */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
