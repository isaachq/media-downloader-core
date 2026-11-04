import * as fs from 'node:fs/promises'
import {countSetItems} from '../mark.js'

export {countSetItems, type ResultMark, resultMark} from '../mark.js'

/** A finished record on disk: there as recorded, gone, or a file whose size moved. */
export type FinishedFile = 'ok' | 'missing' | 'changed'

/**
 * How many media files a finished path holds when it is a folder. A file is
 * not a set. One stat and one readdir of that folder.
 */
export async function finishedItemCount(filepath: string): Promise<number | undefined> {
  return (await finishedState({filepath})).items
}

/**
 * One finished record against the disk, for a page of the finished list: one stat, and
 * one readdir only when the path is a folder (a carousel or a slideshow). A folder is 'ok'
 * and carries its media count; a file is 'ok' when its size is the recorded one (or no
 * size was given), else 'changed'; nothing there is 'missing'. Replaces a stat for the
 * state plus another stat for the count: O(1) stats per row, never per download.
 */
export async function finishedState(entry: {
  readonly filepath: string
  readonly sizeBytes?: number | undefined
}): Promise<{readonly file: FinishedFile; readonly items?: number}> {
  const stat = await fs.stat(entry.filepath).catch(() => undefined)
  if (stat?.isDirectory()) {
    const names = await fs.readdir(entry.filepath).catch(() => [])
    return {file: 'ok', items: countSetItems(names)}
  }
  if (!stat?.isFile()) return {file: 'missing'}
  return {file: entry.sizeBytes === undefined || stat.size === entry.sizeBytes ? 'ok' : 'changed'}
}
