import {MetaError} from './errors.js'

/**
 * Walking a cursor-paged listing (Instagram's timeline and stories, Facebook's
 * videos): the site hands a page and the cursor of the next, until it hands
 * none. The same guarantees TikTok's date-cursor walk gives, without the date
 * arithmetic that listing needs:
 *  - de-duplicated by id (a Map — O(1) per item, order kept);
 *  - a page that brings nothing new counts as a stall; a few in a row end the walk
 *    instead of looping on a cursor the site keeps repeating;
 *  - an incremental walk (`known`) stops after KNOWN_RUN known regular items in a
 *    row — newer items come first, so the rest are known too;
 *  - a walk can resume from a kept listing and its cursor, so chunks are never
 *    listed twice.
 */
export type CursorPage<T> = {
  readonly items: readonly T[]
  /** Cursor of the next page; undefined when this is the last. */
  readonly next: string | undefined
}

export type Listing<T> = {
  readonly items: T[]
  /** Where the walk stopped: the cursor to continue from (undefined at the end). */
  readonly cursor: string | undefined
  /** The end of the listing was reached. */
  readonly complete: boolean
  /** The walk stopped on known items (an incremental walk). */
  readonly caughtUp: boolean
}

/** Regular items in a row already known before an incremental walk stops: everything older is known too. */
export const KNOWN_RUN = 20
/** Pages adding nothing in a row before concluding the listing is over. */
const MAX_STALLS = 3

export type WalkCursorOptions<T> = {
  readonly max: number
  readonly idOf: (item: T) => string
  /** Pinned items are old but listed first: they never count towards "caught up". */
  readonly isPinned?: ((item: T) => boolean) | undefined
  /** A listing already had (and its cursor): the walk continues from there. */
  readonly resume?: {readonly items: readonly T[]; readonly cursor: string | undefined} | undefined
  /** Ids already had (a sync's folder). */
  readonly known?: ReadonlySet<string> | undefined
  readonly onProgress?: ((listed: number) => void) | undefined
  readonly site?: string | undefined
}

export async function walkCursor<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
  opts: WalkCursorOptions<T>,
): Promise<Listing<T>> {
  const found = new Map<string, T>((opts.resume?.items ?? []).map(item => [opts.idOf(item), item]))
  // a kept listing without a cursor (it stopped on known items) is continued from the top: new
  // items come first and known ones are de-duplicated
  let cursor = opts.resume?.cursor
  let stalls = 0
  let knownRun = 0
  let caughtUp = false
  let complete = false
  const seenCursors = new Set<string>()

  while (found.size < opts.max) {
    const page = await fetchPage(cursor)
    let added = 0
    for (const item of page.items) {
      const id = opts.idOf(item)
      if (!opts.isPinned?.(item)) {
        knownRun = opts.known?.has(id) ? knownRun + 1 : 0
        if (opts.known && knownRun >= KNOWN_RUN) caughtUp = true
      }
      if (!found.has(id) && found.size < opts.max) {
        found.set(id, item)
        added++
      }
    }
    if (added > 0) opts.onProgress?.(found.size)
    if (caughtUp) {
      cursor = page.next
      break
    }
    if (page.next === undefined) {
      complete = true
      cursor = undefined
      break
    }
    // the site handed the same cursor again, or a page with nothing new: don't loop on it
    if (added === 0 || seenCursors.has(page.next)) {
      if (++stalls >= MAX_STALLS) break
    } else stalls = 0
    seenCursors.add(page.next)
    cursor = page.next
  }
  if (found.size === 0 && !complete) {
    throw new MetaError('refused', `${opts.site ?? 'The site'} returned no items for this listing.`)
  }
  return {items: [...found.values()], cursor, complete, caughtUp}
}
