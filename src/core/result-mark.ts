import * as fs from 'node:fs/promises'

/** What one result shows: a set's count, or a single item's duration. */
export type ResultMark =
  | {readonly kind: 'count'; readonly count: number}
  | {readonly kind: 'duration'; readonly seconds: number}

/**
 * A set is more than one item, and its count replaces a duration: a carousel's
 * duration is one clip's length. One item keeps its duration. O(1).
 */
export function resultMark(input: {
  readonly count?: number | undefined
  readonly duration?: number | undefined
}): ResultMark | undefined {
  const count = input.count
  if (count !== undefined && count > 1) return {kind: 'count', count}
  const seconds = input.duration
  if (seconds !== undefined && seconds > 0) return {kind: 'duration', seconds}
  return undefined
}

/** Extensions of one finished folder that are items of the set. */
const MEDIA_EXT = new Set([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'm4a',
  'mp3',
  'opus',
  'ogg',
  'flac',
  'wav',
  'aac',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'heic',
])

/** Media names in one folder. One pass over that folder's names. */
export function countSetItems(names: readonly string[]): number {
  let count = 0
  for (const name of names) {
    const dot = name.lastIndexOf('.')
    if (dot > 0 && MEDIA_EXT.has(name.slice(dot + 1).toLowerCase())) count++
  }
  return count
}

/**
 * How many media files a finished path holds when it is a folder. A file is
 * not a set. One stat and one readdir of that folder.
 */
export async function finishedItemCount(filepath: string): Promise<number | undefined> {
  const stat = await fs.stat(filepath).catch(() => undefined)
  if (!stat?.isDirectory()) return undefined
  const names = await fs.readdir(filepath).catch(() => [])
  return countSetItems(names)
}
