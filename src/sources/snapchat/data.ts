import {MetaError} from '../meta/errors.js'
import {snapchatUrl} from './links.js'

/**
 * Reading Snapchat's public pages: every one is a Next.js page whose data is
 * in `__NEXT_DATA__` → `props.pageProps`. What they held when this was
 * written (verified live 2026-10-26, anonymous; samples in `.local/snapchat/`):
 *  - a profile (`/@u`, also `/@u/<snapId>`): `userProfile` with `$case`
 *    `publicProfileInfo` (or `userInfo`: a private account, nothing shown);
 *    `story` (the live 24-hour story, or null) with `snapList[]`;
 *    `curatedHighlights[]` each with `highlightId.value`, `storyTitle.value`
 *    and `snapList[]` (whose `snapId.value` are all ""); `spotlightHighlights[]`
 *    (one snap each, `storyId.value` = the spotlight id; empty placeholders
 *    with `storyId: null` and `snapList: []`) and `spotlightStoryMetadata[]`,
 *    the same length and order, with `videoMetadata`; the cursors
 *    `curatedHighlightsCursor` / `spotlightHighlightsCursor`, non-empty when
 *    the profile has more than the page embeds (no anonymous way to page on:
 *    the web client never sends them);
 *  - a story snap's page: the profile's props, `showSnapExpiredToast` true
 *    when the snap named is gone;
 *  - a highlight (`/@u/highlight/<id>`): `highlight` (a curated highlight's
 *    shape) and `publicUserProfile.username`;
 *  - a spotlight (`/@u/spotlight/<id>`): `videoMetadata` (the one asked for)
 *    and `spotlightFeed.spotlightStories[]`: the one asked for and ~24
 *    recommendations of other creators, selected by id, never listed;
 *  - a snap: `snapMediaType` 0 a picture (JPEG), 1 a video (progressive MP4),
 *    `snapUrls.mediaUrl` (unsigned, stable, no Referer needed),
 *    `timestampInSec.value` (unix seconds, a string).
 * Missing data where it is expected is 'format-changed': the engine hands
 * the url to yt-dlp (which reads spotlights).
 */

/** One snap, spotlight or highlight snap: one item to download. */
export type SnapItem = {
  /** The archive id: a spotlight's or a story snap's id; `<highlight id>-<n>` for a highlight's n-th snap. */
  readonly id: string
  /** The entry's link (one `parseSnapchatLink` reads back to this item). */
  readonly url: string
  readonly kind: 'video' | 'image'
  /** The media exactly as the page serves it (a spotlight's `contentUrl`, a snap's `snapUrls.mediaUrl`). */
  readonly mediaUrl: string
  /** The account's username. */
  readonly user: string
  /** Its display name. */
  readonly userName?: string | undefined
  readonly title: string
  readonly thumbnail?: string | undefined
  /** Unix seconds. */
  readonly publishedAt?: number | undefined
  /** Seconds (spotlights only: snaps don't say). */
  readonly duration?: number | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
}

export type SnapProfile = {
  readonly kind: 'profile'
  readonly user: string
  readonly userName?: string | undefined
  readonly story: readonly SnapItem[]
  readonly highlights: readonly SnapItem[]
  readonly spotlights: readonly SnapItem[]
  /** A cursor says the profile has more than the page embeds. */
  readonly more: boolean
}

export type SnapHighlight = {
  readonly kind: 'highlight'
  readonly id: string
  readonly user: string
  readonly title?: string | undefined
  readonly items: readonly SnapItem[]
}

/** One item's page: a spotlight's, or a story snap's (with the rest of that story). */
export type SnapSingle = {readonly kind: 'single'; readonly items: readonly SnapItem[]}

export type SnapPage = SnapProfile | SnapHighlight | SnapSingle

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
/** `{value: "…"}`, Snapchat's wrapper for optional strings. */
const wrapped = (value: unknown): string | undefined => (isObject(value) ? text(value['value']) : undefined)
const numeric = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value ? Number(value) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export const changed = (what: string): MetaError => new MetaError('format-changed', `Snapchat: ${what}`)

/**
 * `props.pageProps` of a page's `__NEXT_DATA__`: the script found with
 * indexOf (no regular expression over a page of up to 1 MB), parsed once.
 * O(size of the page).
 */
export function readNextData(html: string, marker: string): Json {
  const at = html.indexOf(marker)
  if (at < 0) throw changed('the page has no __NEXT_DATA__ any more.')
  const start = html.indexOf('>', at) + 1
  const end = start > 0 ? html.indexOf('</script>', start) : -1
  if (end < 0) throw changed('the page data is cut short.')
  let data: unknown
  try {
    data = JSON.parse(html.slice(start, end))
  } catch {
    throw changed('the page data is not JSON.')
  }
  const props = isObject(data) ? data['props'] : undefined
  const pageProps = isObject(props) ? props['pageProps'] : undefined
  if (!isObject(pageProps)) throw changed('the page data has no pageProps.')
  return pageProps
}

const day = (seconds: number | undefined): string | undefined =>
  seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : undefined
const minute = (seconds: number | undefined): string | undefined =>
  seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : undefined

/** Snapchat's placeholder names: a spotlight without words of its own. */
const GENERIC_NAMES: ReadonlySet<string> = new Set(['Spotlight Snap'])

/** A spotlight's words: its caption, else its name unless generic, else "<user> spotlight <date>". */
function spotlightTitle(meta: Json | undefined, user: string, published: number | undefined): string {
  const caption = text(meta?.['embeddedTextCaption'])?.trim()
  if (caption) return caption
  const name = text(meta?.['name'])?.trim()
  if (name && !GENERIC_NAMES.has(name)) return name
  return [user, 'spotlight', day(published)].filter(Boolean).join(' ')
}

/**
 * A spotlight from its story (one snap) and its `videoMetadata`; undefined for
 * an empty placeholder. The media is the metadata's `contentUrl` as served
 * (the snap's own `mediaUrl` when there is none). O(1).
 */
function spotlightItem(story: Json | undefined, meta: Json | undefined, fallbackUser: string): SnapItem | undefined {
  const id = wrapped(story?.['storyId'])
  const snap = arrayOf(story?.['snapList']).find(isObject)
  const urls = isObject(snap?.['snapUrls']) ? snap['snapUrls'] : undefined
  const mediaUrl = text(meta?.['contentUrl']) ?? text(urls?.['mediaUrl'])
  if (!id || !mediaUrl) return undefined
  const creator = isObject(meta?.['creator']) ? meta['creator'] : undefined
  const person = isObject(creator?.['personCreator']) ? creator['personCreator'] : undefined
  const user = text(person?.['username']) ?? fallbackUser
  const uploaded = numeric(meta?.['uploadDateMs'])
  const publishedAt = uploaded ? Math.floor(uploaded / 1000) : numeric(wrapped(snap?.['timestampInSec']))
  const duration = numeric(meta?.['durationMs'])
  return {
    id,
    url: snapchatUrl({kind: 'spotlight', id, user}),
    kind: snap?.['snapMediaType'] === 0 ? 'image' : 'video',
    mediaUrl,
    user,
    userName: text(person?.['name']),
    title: spotlightTitle(meta, user, publishedAt),
    thumbnail: text(meta?.['thumbnailUrl']) ?? wrapped(urls?.['mediaPreviewUrl']),
    publishedAt,
    duration: duration ? duration / 1000 : undefined,
    width: numeric(meta?.['width']),
    height: numeric(meta?.['height']),
  }
}

/** A snap of a story or a highlight, or undefined without media. O(1). */
function snapItem(
  snap: unknown,
  identity: {readonly id: string; readonly url: string; readonly title: string},
  user: string,
  userName: string | undefined,
): SnapItem | undefined {
  if (!isObject(snap)) return undefined
  const urls = isObject(snap['snapUrls']) ? snap['snapUrls'] : undefined
  const mediaUrl = text(urls?.['mediaUrl'])
  if (!mediaUrl) return undefined
  return {
    ...identity,
    kind: snap['snapMediaType'] === 0 ? 'image' : 'video',
    mediaUrl,
    user,
    userName,
    thumbnail: wrapped(urls?.['mediaPreviewUrl']),
    publishedAt: numeric(wrapped(snap['timestampInSec'])),
  }
}

/** The live story's snaps, in the order the site plays them. O(snaps). */
function storySnaps(story: unknown, user: string, userName: string | undefined): SnapItem[] {
  const items: SnapItem[] = []
  for (const snap of arrayOf(isObject(story) ? story['snapList'] : undefined)) {
    const id = isObject(snap) ? wrapped(snap['snapId']) : undefined
    if (!id) continue
    const published = numeric(isObject(snap) ? wrapped(snap['timestampInSec']) : undefined)
    const title = [user, 'story', minute(published)].filter(Boolean).join(' ')
    const item = snapItem(snap, {id, url: snapchatUrl({kind: 'snap', user, id}), title}, user, userName)
    if (item) items.push(item)
  }
  return items
}

/**
 * A highlight's snaps: they have no ids on the site, so each is named by the
 * highlight and its place in it (`snapIndex` + 1, what the web shows).
 * O(snaps).
 */
function highlightSnaps(highlight: Json, highlightId: string, user: string, userName?: string): SnapItem[] {
  const name = wrapped(highlight['storyTitle']) ?? 'Highlight'
  const items: SnapItem[] = []
  const list = arrayOf(highlight['snapList'])
  for (let i = 0; i < list.length; i++) {
    const snap = list[i]
    const at = isObject(snap) && typeof snap['snapIndex'] === 'number' ? snap['snapIndex'] : i
    const index = Math.max(0, Math.floor(at)) + 1
    const identity = {
      id: `${highlightId}-${index}`,
      url: snapchatUrl({kind: 'highlight', user, id: highlightId, index}),
      title: `${name} #${index}`,
    }
    const item = snapItem(snap, identity, user, userName)
    if (item) items.push(item)
  }
  return items
}

/** A private account (`userInfo`): Snapchat shows it to its friends, in the app only. */
function privateAccount(pageProps: Json): boolean {
  const profile = pageProps['userProfile']
  return isObject(profile) && profile['$case'] === 'userInfo'
}

const PRIVATE = (user: string) =>
  new MetaError('private', `@${user} is a private Snapchat account: Snapchat shows it only to its friends, in the app.`)

/** A profile page as its items. O(items embedded): ~150 at most (the page's own bound). */
export function readProfile(pageProps: Json, linkUser: string): SnapProfile {
  if (privateAccount(pageProps)) throw PRIVATE(linkUser)
  const profile = pageProps['userProfile']
  const info = isObject(profile) ? profile['publicProfileInfo'] : undefined
  if (!isObject(profile) || profile['$case'] !== 'publicProfileInfo' || !isObject(info)) {
    throw changed('the profile page has no public profile.')
  }
  if (!('story' in pageProps) && !('curatedHighlights' in pageProps) && !('spotlightHighlights' in pageProps)) {
    throw changed('the profile page has none of its story, highlights or spotlights.')
  }
  const user = text(info['username']) ?? linkUser
  const userName = text(info['title'])
  const highlights: SnapItem[] = []
  for (const highlight of arrayOf(pageProps['curatedHighlights'])) {
    if (!isObject(highlight)) continue
    const id = wrapped(highlight['highlightId'])
    if (id) highlights.push(...highlightSnaps(highlight, id, user, userName))
  }
  const metadata = arrayOf(pageProps['spotlightStoryMetadata'])
  const slots = arrayOf(pageProps['spotlightHighlights'])
  const spotlights: SnapItem[] = []
  // the metadata array is aligned with the spotlights by index (placeholders included)
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const meta = metadata[i]
    const video = isObject(meta) && isObject(meta['videoMetadata']) ? meta['videoMetadata'] : undefined
    const item = spotlightItem(isObject(slot) ? slot : undefined, video, user)
    if (item) spotlights.push(item)
  }
  return {
    kind: 'profile',
    user,
    userName,
    story: storySnaps(pageProps['story'], user, userName),
    highlights,
    spotlights,
    more: Boolean(text(pageProps['curatedHighlightsCursor']) || text(pageProps['spotlightHighlightsCursor'])),
  }
}

/** A highlight's page. O(snaps). */
export function readHighlight(pageProps: Json, linkUser: string, linkId: string): SnapHighlight {
  if (privateAccount(pageProps)) throw PRIVATE(linkUser)
  const highlight = pageProps['highlight']
  if (!isObject(highlight)) throw changed('the highlight page has no highlight.')
  const owner = isObject(pageProps['publicUserProfile']) ? pageProps['publicUserProfile'] : undefined
  const user = text(owner?.['username']) ?? linkUser
  const id = wrapped(highlight['highlightId']) ?? text(pageProps['highlightId']) ?? linkId
  return {
    kind: 'highlight',
    id,
    user,
    title: wrapped(highlight['storyTitle']),
    items: highlightSnaps(highlight, id, user, text(owner?.['title'])),
  }
}

/** A story snap's page: its story's snaps (the one asked for among them, unless it expired). O(snaps). */
export function readSnapPage(pageProps: Json, linkUser: string): SnapSingle {
  if (privateAccount(pageProps)) throw PRIVATE(linkUser)
  if (!('story' in pageProps) && !('showSnapExpiredToast' in pageProps)) {
    throw changed('the story page has no story.')
  }
  const profile = pageProps['userProfile']
  const info = isObject(profile) && isObject(profile['publicProfileInfo']) ? profile['publicProfileInfo'] : undefined
  const user = text(info?.['username']) ?? linkUser
  if (pageProps['showSnapExpiredToast'] === true) return {kind: 'single', items: []}
  return {kind: 'single', items: storySnaps(pageProps['story'], user, text(info?.['title']))}
}

/**
 * A spotlight's page: the entry of its feed with this id (the others are
 * recommendations), else the page's own `videoMetadata`. O(feed), 25 entries.
 */
export function readSpotlight(pageProps: Json, id: string, linkUser: string | undefined): SnapSingle {
  const feed = isObject(pageProps['spotlightFeed']) ? pageProps['spotlightFeed'] : undefined
  const own = isObject(pageProps['videoMetadata']) ? pageProps['videoMetadata'] : undefined
  if (!feed && !own) throw changed('the spotlight page has neither its feed nor its video.')
  const fallbackUser = linkUser ?? 'snapchat'
  for (const entry of arrayOf(feed?.['spotlightStories'])) {
    if (!isObject(entry) || !isObject(entry['story'])) continue
    if (wrapped(entry['story']['storyId']) !== id) continue
    const metadata = isObject(entry['metadata']) ? entry['metadata'] : undefined
    const video = isObject(metadata?.['videoMetadata']) ? metadata['videoMetadata'] : own
    const item = spotlightItem(entry['story'], video, fallbackUser)
    if (item) return {kind: 'single', items: [item]}
  }
  // not in the feed: the page's own video, when it has one
  const item = own ? spotlightItem({storyId: {value: id}}, own, fallbackUser) : undefined
  if (!item) throw changed('the spotlight page does not hold this spotlight.')
  return {kind: 'single', items: [item]}
}
