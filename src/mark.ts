/**
 * What one result shows, pure: no Node built-ins, so a renderer (Electron, Hermes) imports
 * it as `media-downloader-core/mark` instead of keeping its own copy of the rule.
 * O(1) per result; `countSetItems` is one pass over one folder's names.
 */

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
const MEDIA_EXT: ReadonlySet<string> = new Set([
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
