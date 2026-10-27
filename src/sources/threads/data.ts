import {mediaOfV1} from '../instagram/data.js'
import type {PageRead} from '../meta/client.js'
import {MetaError} from '../meta/errors.js'
import type {CursorPage} from '../meta/listing.js'
import type {MetaMedia, MetaPost} from '../meta/post.js'
import {dig, findAllWithKey, isObject, type Json, jsonScripts, list, num, text} from '../meta/relay.js'
import {THREADS_ORIGIN, type ThreadsQueries} from './endpoints.js'
import {postUrl} from './links.js'

/**
 * Threads' data, reduced to MetaPost: the page's Relay preloaders (a post, a
 * profile and its first threads), the query ids and LSD token its own client
 * uses, and the threads tab's GraphQL pages. A post is a v1 item, the shape
 * Instagram's API answers (`pk`, `code`, `media_type`, `video_versions`,
 * `image_versions2`, `carousel_media`), so its media is read by the same
 * function Instagram's is. No HTML parsing anywhere: the page's JSON blocks,
 * found with indexOf (relay.ts).
 */

const MEDIA_CAROUSEL = 8
/** A text post (with or without a GIF or a link card): nothing of its own to download. */
const MEDIA_TEXT = 19
const PRELOADER_PREFIX = 'adp_'
const PRELOADER_MARK = 'RelayPreloader_'
/** Nodes a page walk visits at most: a 1.2 MB profile page has ~200,000. */
const WALK_LIMIT = 2_000_000

export type ThreadsQuery = {readonly id: string; readonly variables: Readonly<Record<string, unknown>>}

/** What a page embeds for its own client, as read in one walk. */
export type PageData = {
  /** Preloaded query results by query name (`__bbox.result`). */
  readonly results: ReadonlyMap<string, Json>
  /** The queries the page's client sent, by name: their id and variables. */
  readonly queries: ReadonlyMap<string, ThreadsQuery>
  readonly lsd?: string | undefined
  /** The parsed blocks, for a search the preloaders don't answer. */
  readonly scripts: readonly unknown[]
}

/**
 * One walk over every JSON block of a page (explicit stack, bounded): the
 * preloaders whose query is `wanted` (their results are not walked into —
 * they are what is kept), every `{queryID, queryName, variables}`, and the
 * LSD token. O(size of the page).
 */
export function readPageData(html: string, wanted: readonly string[]): PageData {
  const scripts = jsonScripts(html)
  const results = new Map<string, Json>()
  const queries = new Map<string, ThreadsQuery>()
  let lsd: string | undefined
  const stack: unknown[] = [...scripts]
  let visited = 0
  while (stack.length > 0 && visited++ < WALK_LIMIT) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      const head = node[0]
      if (typeof head === 'string') {
        if (head.startsWith(PRELOADER_PREFIX) && isObject(node[1])) {
          const mark = head.indexOf(PRELOADER_MARK)
          const name = mark > 0 ? head.slice(PRELOADER_PREFIX.length, mark) : ''
          const result = dig(node[1], '__bbox', 'result')
          if (wanted.includes(name) && isObject(result)) {
            if (!results.has(name)) results.set(name, result)
            continue
          }
        } else if (head === 'LSD' && isObject(node[2])) lsd ??= text(node[2]['token'])
      }
      for (const child of node) if (typeof child === 'object' && child !== null) stack.push(child)
    } else if (isObject(node)) {
      const id = text(node['queryID'])
      const name = text(node['queryName'])
      if (id && name && !queries.has(name)) {
        queries.set(name, {id, variables: isObject(node['variables']) ? node['variables'] : {}})
      }
      for (const key in node) {
        const child = node[key]
        if (typeof child === 'object' && child !== null) stack.push(child)
      }
    }
  }
  return {results, queries, lsd, scripts}
}

/** `pk` as a string (sent as a string, a number past 2^53 in some answers). */
const pkOf = (raw: Json): string | undefined => {
  const pk = raw['pk'] ?? raw['id']
  if (typeof pk === 'string') return pk.split('_', 1)[0] || undefined
  if (typeof pk === 'number' && Number.isFinite(pk)) return String(pk)
  return undefined
}

/** `mediaPresentationDuration="PT1M4.5S"` of a DASH manifest, in seconds. */
const DASH_DURATION = /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/

/**
 * One media item; a video's length from its DASH manifest when the item has
 * no `video_duration` (Threads sends none). O(size of the manifest).
 */
function mediaOf(raw: Json): MetaMedia | undefined {
  const media = mediaOfV1(raw)
  if (media?.kind !== 'video' || media.duration !== undefined) return media
  const match = DASH_DURATION.exec(text(raw['video_dash_manifest']) ?? '')
  if (!match) return media
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  return seconds > 0 ? {...media, duration: Math.round(seconds * 1000) / 1000} : media
}

/** A post from a v1 item: a video, a photo, a carousel of both, or a text post with no media. O(items). */
export function readThreadsPost(raw: unknown): MetaPost {
  if (!isObject(raw)) throw new MetaError('format-changed', 'Threads post is not an object.')
  const id = pkOf(raw)
  if (!id) throw new MetaError('format-changed', 'Threads post without an id.')
  const user = isObject(raw['user']) ? raw['user'] : {}
  const code = text(raw['code'])
  const author = text(user['username']) ?? ''
  const type = num(raw['media_type'])
  const items: MetaMedia[] = []
  if (type === MEDIA_CAROUSEL || Array.isArray(raw['carousel_media'])) {
    for (const child of list(raw['carousel_media'])) {
      const media = isObject(child) ? mediaOf(child) : undefined
      if (media) items.push(media)
    }
  } else if (type !== MEDIA_TEXT) {
    const media = mediaOf(raw)
    if (media) items.push(media)
  }
  const first = items[0]
  return {
    id,
    code,
    url: code ? postUrl(THREADS_ORIGIN, code, author || undefined) : `${THREADS_ORIGIN}/`,
    caption: text(dig(raw, 'caption', 'text')) ?? '',
    author,
    authorName: text(user['full_name']),
    createdAt: num(raw['taken_at']),
    items,
    cover: first?.kind === 'video' ? first.cover : undefined,
    pinned: dig(raw, 'text_post_app_info', 'pinned_post_info', 'is_pinned_to_profile') === true,
  }
}

/** Where Threads sends a visitor it won't show a page to: its login page, or home with `?error=invalid_post`. */
const WALL_PATH = /^\/(?:login|accounts\/login)(?:[/?#]|$)/
const INVALID_POST = /[?&]error=invalid_post(?:&|$)/

function wallOf(url: string): 'login' | 'invalid' | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (INVALID_POST.test(parsed.search)) return 'invalid'
  return WALL_PATH.test(parsed.pathname) ? 'login' : undefined
}

/**
 * A post Threads won't show: deleted, or its account private. A visitor
 * can't tell which (the site answers both alike); a signed-in session that
 * still gets it is told it is gone.
 */
function postGone(signedIn: boolean): MetaError {
  return signedIn
    ? new MetaError(
        'removed',
        'This Threads post does not exist any more (or its account is private and does not share it with you).',
      )
    : new MetaError(
        'login-required',
        'Threads does not show this post to visitors: it was deleted, or its account is private. A signed-in session (browser cookies) that follows the account can read it.',
      )
}

/**
 * A post page → its post: the post page's preloaded query (`data.media`),
 * matched by its code; else any post of the page with that code (a reply's
 * page carries its thread). A page that sends the visitor home or to the
 * login page is a post Threads won't show; a page without the data is the
 * gating shell or a changed page. O(size of the page).
 */
export function readPostPage(
  page: PageRead,
  code: string,
  opts: {readonly queries: ThreadsQueries; readonly signedIn: boolean},
): MetaPost {
  if (wallOf(page.url)) throw postGone(opts.signedIn)
  const data = readPageData(page.html, [opts.queries.post])
  const media = dig(data.results.get(opts.queries.post), 'data', 'media')
  if (media === null) throw postGone(opts.signedIn)
  if (isObject(media) && text(media['code']) === code) return readThreadsPost(media)
  // the page's own target is another post: the asked one among the page's thread items
  for (const node of findAllWithKey(data.scripts, 'code')) {
    if (text(node['code']) === code && 'media_type' in node) return readThreadsPost(node)
  }
  throw new MetaError(
    'format-changed',
    data.scripts.length === 0
      ? 'Threads answered with a page that has no data at all.'
      : isObject(media)
        ? `Threads' post page holds another post than ${code}.`
        : `Threads' post page came without the post (no ${opts.queries.post} result).`,
  )
}

export type ThreadsAccount = {
  readonly id: string
  readonly user: string
  readonly name?: string | undefined
  readonly isPrivate: boolean
  /** The token the page's client sends with its queries. */
  readonly lsd?: string | undefined
  /** The threads tab's query as the page's client sent it. */
  readonly tab?: ThreadsQuery | undefined
  /** The threads the page embeds (its first 4): what is listed should the query stop answering. */
  readonly firstPage: readonly MetaPost[]
}

/**
 * A profile page → the account (`data.user`: pk, private or not), its first
 * threads, the LSD token and the threads tab's query. A page that sends the
 * visitor to the login page is an account Threads won't show: unknown, or
 * kept for signed-in visitors. O(size of the page).
 */
export function readProfilePage(
  page: PageRead,
  user: string,
  opts: {readonly queries: ThreadsQueries; readonly signedIn: boolean},
): ThreadsAccount {
  if (wallOf(page.url)) {
    throw opts.signedIn
      ? new MetaError('removed', `There is no Threads account @${user} (or no longer).`)
      : new MetaError(
          'login-required',
          `Threads sent the visitor to its login page for @${user}: the account does not exist, or Threads shows it to signed-in accounts only (browser cookies).`,
        )
  }
  const {profile, threadsTab} = opts.queries
  const data = readPageData(page.html, [profile, threadsTab])
  const account = dig(data.results.get(profile), 'data', 'user')
  if (account === null) throw new MetaError('removed', `There is no Threads account @${user} (or no longer).`)
  if (!isObject(account)) {
    throw new MetaError(
      'format-changed',
      data.scripts.length === 0
        ? 'Threads answered with a page that has no data at all.'
        : `Threads' profile page came without the account (no ${profile} result).`,
    )
  }
  const id = pkOf(account)
  if (!id) throw new MetaError('format-changed', 'Threads account without an id.')
  const tab = data.results.get(threadsTab)
  return {
    id,
    user: text(account['username']) ?? user,
    name: text(account['full_name']),
    isPrivate: account['text_post_app_is_private'] === true,
    lsd: data.lsd,
    tab: data.queries.get(threadsTab),
    firstPage: tab ? readTabPage(tab, id).items : [],
  }
}

export type TabPage = CursorPage<MetaPost> & {
  /** Posts the page held, media or not (a page of text posts brings no items but is not empty). */
  readonly posts: number
}

/**
 * A page of the threads tab (`data.mediaData`): every post of every thread
 * that the owner wrote and that has media, in order (a self-thread carries
 * several posts; a repost or a quote is someone else's post and is left
 * out). O(posts of the page).
 */
export function readTabPage(json: unknown, ownerId: string): TabPage {
  const connection = dig(json, 'data', 'mediaData')
  if (connection === null) {
    throw new MetaError('login-required', 'Threads shows this account’s threads to signed-in accounts only.')
  }
  if (!isObject(connection)) {
    const errors = dig(json, 'errors')
    throw new MetaError(
      'format-changed',
      Array.isArray(errors)
        ? `Threads query failed: ${JSON.stringify(errors).slice(0, 200)}`
        : 'Threads listing without its threads (no data.mediaData).',
    )
  }
  const items: MetaPost[] = []
  let posts = 0
  for (const edge of list(connection['edges'])) {
    for (const entry of list(dig(edge, 'node', 'thread_items'))) {
      const raw = dig(entry, 'post')
      if (!isObject(raw)) continue
      posts++
      const owner = isObject(raw['user']) ? pkOf(raw['user']) : undefined
      if (owner !== undefined && owner !== ownerId) continue
      const post = readThreadsPost(raw)
      if (post.items.length > 0) items.push(post)
    }
  }
  const info = isObject(connection['page_info']) ? connection['page_info'] : {}
  return {items, posts, next: info['has_next_page'] === true ? text(info['end_cursor']) : undefined}
}
