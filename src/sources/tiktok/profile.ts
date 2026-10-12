import {readPost, type TikTokPost} from './data.js'
import {TikTokError} from './errors.js'

/** One page of the listing: posts newer than `cursor` (ms), newest first. */
export type ListPage = (
  cursor: number,
  deviceId: string,
) => Promise<{readonly posts: readonly unknown[]; readonly more: boolean}>

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/**
 * No post is older than this: musical.ly's launch. Its videos moved into
 * TikTok (2018) keeping their dates, so veteran profiles reach back to 2014.
 */
export const EARLIEST_MS = Date.UTC(2014, 3, 1)
/** Fresh identities to try when the listing starts repeating itself. */
const IDENTITY_RESETS = 2
/** Week-steps over empty / repeated pages before concluding the listing is over. */
const MAX_STALLS = 8

export type WalkOptions = {
  readonly max: number
  readonly now?: (() => number) | undefined
  readonly newDeviceId: () => string
  readonly onProgress?: ((listed: number) => void) | undefined
  /** Posts already listed (newest first): the walk continues below the oldest of them. */
  readonly resume?: readonly TikTokPost[] | undefined
  /** Told at the end whether the profile's whole history was reached. */
  readonly onEnd?: ((complete: boolean) => void) | undefined
}

/**
 * Every post of a profile, newest first, walking the listing backwards in
 * time. The listing is known to repeat pages and to stall; this walk:
 *  - de-duplicates by id (a Map — O(1) per post, order kept);
 *  - on a page with nothing new, retries it once with a fresh identity, then
 *    steps the cursor back a week at a time instead of looping forever;
 *  - ignores pinned posts when moving the cursor (they are old but listed first,
 *    and following their date would skip everything in between).
 */
export async function walkProfile(listPage: ListPage, opts: WalkOptions): Promise<TikTokPost[]> {
  const found = new Map<string, TikTokPost>((opts.resume ?? []).map(post => [post.id, post]))
  let cursor = (opts.now ?? Date.now)()
  // continue below the oldest regular post already known
  for (const post of opts.resume ?? []) {
    if (!post.pinned && post.createdAt) cursor = Math.min(cursor, post.createdAt * 1000)
  }
  let complete = false
  let deviceId = opts.newDeviceId()
  let stalls = 0
  let resets = 0

  while (found.size < opts.max && cursor > EARLIEST_MS) {
    const page = await listPage(cursor, deviceId)
    let added = 0
    let oldest = Number.POSITIVE_INFINITY
    let oldestPinned = Number.POSITIVE_INFINITY
    for (const raw of page.posts) {
      const post = readPost(raw)
      const at = (post.createdAt ?? 0) * 1000
      if (post.pinned) oldestPinned = Math.min(oldestPinned, at)
      else oldest = Math.min(oldest, at)
      if (!found.has(post.id) && found.size < opts.max) {
        found.set(post.id, post)
        added++
      }
    }
    if (added > 0) opts.onProgress?.(found.size)
    if (page.posts.length === 0 && !page.more) {
      complete = true
      break
    }

    const next = Number.isFinite(oldest) ? oldest : oldestPinned
    if (added === 0) {
      stalls++
      if (stalls > MAX_STALLS) break
      if (resets < IDENTITY_RESETS && stalls === 1) {
        resets++
        deviceId = opts.newDeviceId()
        continue // same cursor, new identity
      }
      cursor = Math.min(cursor, Number.isFinite(next) ? next : cursor) - WEEK_MS
      continue
    }
    stalls = 0
    if (!page.more) {
      complete = true
      break
    }
    // strictly older than the last page, or the next one may repeat it
    cursor = Number.isFinite(next) && next < cursor ? next : cursor - WEEK_MS
  }
  opts.onEnd?.(complete || cursor <= EARLIEST_MS)
  if (found.size === 0 && cursor > EARLIEST_MS) {
    // nothing at all from a profile that has posts is a refusal, not an empty account
    throw new TikTokError('refused', 'TikTok returned no posts for this profile.')
  }
  return [...found.values()]
}
