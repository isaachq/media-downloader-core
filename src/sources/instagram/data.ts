import {MetaError} from '../meta/errors.js'
import type {CursorPage} from '../meta/listing.js'
import type {MetaImage, MetaMedia, MetaPost, MetaVideo} from '../meta/post.js'
import {dig, findWithKey, isObject, type Json, jsonScripts, list, num, text} from '../meta/relay.js'
import type {Rendition} from '../renditions.js'
import {postUrl, storiesUrl} from './links.js'

/**
 * Instagram's data in its two shapes, both reduced to MetaPost:
 *  - the "v1" item (`pk`, `code`, `media_type`, `video_versions`,
 *    `image_versions2`, `carousel_media`), what the API and the timeline
 *    query answer, and what a post page embeds;
 *  - the GraphQL node (`shortcode`, `is_video`, `video_url`, `display_url`,
 *    `edge_sidecar_to_children`), what the profile info and the post query answer.
 * Plus the account and page shapes around them. No HTML parsing anywhere.
 */

export const PUBLIC_ORIGIN = 'https://www.instagram.com'

// ─── Status ─────────────────────────────────────────────────────────────────

/** `status: "fail"` answers and their `message`, as the engine's problems. */
export function checkStatus(json: unknown): void {
  if (!isObject(json)) throw new MetaError('format-changed', 'Instagram answered with no data.')
  if (json['status'] !== 'fail' && json['require_login'] !== true) return
  const message = text(json['message']) ?? ''
  const why = message.toLowerCase()
  if (why.includes('login') || json['require_login'] === true) {
    throw new MetaError('login-required', 'Instagram asks to sign in for this.')
  }
  if (why.includes('checkpoint') || why.includes('challenge')) {
    throw new MetaError('challenge', 'Instagram asks for a verification.')
  }
  if (why.includes('wait a few') || why.includes('rate limit')) {
    throw new MetaError('refused', 'Instagram asks to wait a few minutes.')
  }
  if (why.includes('not found') || why.includes('does not exist') || why.includes('unavailable')) {
    throw new MetaError('removed', 'This Instagram post or account no longer exists.')
  }
  throw new MetaError('refused', `Instagram answered: ${message || 'fail'}.`)
}

// ─── v1 items ───────────────────────────────────────────────────────────────

const MEDIA_VIDEO = 2
const MEDIA_CAROUSEL = 8

/** `pk` as a string: Instagram sends it as a number past 2^53 in some answers, as a string in others. */
const pkOf = (raw: Json): string | undefined => {
  const pk = raw['pk'] ?? raw['id']
  if (typeof pk === 'string') return pk.split('_', 1)[0] || undefined
  if (typeof pk === 'number' && Number.isFinite(pk)) return String(pk)
  return undefined
}

function renditionsOfVersions(versions: unknown, fallbackWidth: number, fallbackHeight: number): Rendition[] {
  const seen = new Set<string>()
  const found: Rendition[] = []
  for (const version of list(versions)) {
    if (!isObject(version)) continue
    const url = text(version['url'])
    if (!url || seen.has(url)) continue
    seen.add(url)
    const width = num(version['width']) ?? fallbackWidth
    const height = num(version['height']) ?? fallbackHeight
    found.push({
      codec: 'h264', // Instagram's progressive files are H.264 + AAC
      width,
      height,
      resolution: Math.min(width, height) || Math.max(width, height),
      bitrate: num(version['bandwidth']) ?? 0,
      urls: [url],
    })
  }
  return found
}

function imageOf(raw: Json, id: string): MetaImage | undefined {
  const candidates = list(dig(raw, 'image_versions2', 'candidates'))
    .filter(isObject)
    .map(c => ({url: text(c['url']), width: num(c['width']) ?? 0, height: num(c['height']) ?? 0}))
    .filter((c): c is {url: string; width: number; height: number} => c.url !== undefined)
    .sort((a, b) => b.width * b.height - a.width * a.height)
  if (candidates.length === 0) return undefined
  const best = candidates[0]!
  return {kind: 'image', id, urls: [...new Set(candidates.map(c => c.url))], width: best.width, height: best.height}
}

function mediaOfV1(raw: Json): MetaMedia | undefined {
  const id = pkOf(raw) ?? ''
  const width = num(raw['original_width']) ?? 0
  const height = num(raw['original_height']) ?? 0
  if (num(raw['media_type']) === MEDIA_VIDEO || Array.isArray(raw['video_versions'])) {
    const renditions = renditionsOfVersions(raw['video_versions'], width, height)
    const image = imageOf(raw, id)
    const video: MetaVideo = {
      kind: 'video',
      id,
      renditions,
      duration: num(raw['video_duration']) || undefined,
      width: width || renditions[0]?.width || 0,
      height: height || renditions[0]?.height || 0,
      cover: image?.urls[0],
    }
    return video
  }
  return imageOf(raw, id)
}

/** A post from a v1 item (an API answer, a timeline node, a post page, a story). */
export function readV1Item(raw: unknown, opts: {readonly story?: boolean | undefined} = {}): MetaPost {
  if (!isObject(raw)) throw new MetaError('format-changed', 'Instagram item is not an object.')
  const id = pkOf(raw)
  if (!id) throw new MetaError('format-changed', 'Instagram item without an id.')
  const user = isObject(raw['user']) ? raw['user'] : isObject(raw['owner']) ? raw['owner'] : {}
  const code = text(raw['code'])
  const author = text(user['username']) ?? ''
  const items: MetaMedia[] = []
  if (num(raw['media_type']) === MEDIA_CAROUSEL || Array.isArray(raw['carousel_media'])) {
    for (const child of list(raw['carousel_media'])) {
      const media = isObject(child) ? mediaOfV1(child) : undefined
      if (media) items.push(media)
    }
  } else {
    const media = mediaOfV1(raw)
    if (media) items.push(media)
  }
  const pinned = list(raw['timeline_pinned_user_ids']).length > 0
  return {
    id,
    code,
    url: opts.story
      ? storiesUrl(PUBLIC_ORIGIN, author || '_', id)
      : code
        ? postUrl(PUBLIC_ORIGIN, code)
        : `${PUBLIC_ORIGIN}/`,
    caption: text(dig(raw, 'caption', 'text')) ?? '',
    author,
    authorName: text(user['full_name']),
    createdAt: num(raw['taken_at']),
    expiresAt: opts.story ? num(raw['expiring_at']) : undefined,
    items,
    cover: items[0]?.kind === 'video' ? items[0].cover : undefined,
    pinned,
    story: opts.story || undefined,
  }
}

// ─── GraphQL nodes ──────────────────────────────────────────────────────────

function mediaOfNode(node: Json): MetaMedia | undefined {
  const id = text(node['id']) ?? ''
  const width = num(dig(node, 'dimensions', 'width')) ?? 0
  const height = num(dig(node, 'dimensions', 'height')) ?? 0
  const display = text(node['display_url'])
  const resources = list(node['display_resources'])
    .filter(isObject)
    .map(r => text(r['src']))
    .filter((u): u is string => u !== undefined)
  const urls = [...new Set([display, ...resources.reverse()].filter((u): u is string => u !== undefined))]
  if (node['is_video'] === true || text(node['video_url'])) {
    const video = text(node['video_url'])
    const video1: MetaVideo = {
      kind: 'video',
      id,
      renditions: video
        ? [
            {
              codec: 'h264',
              width,
              height,
              resolution: Math.min(width, height) || Math.max(width, height),
              bitrate: 0,
              urls: [video],
            },
          ]
        : [],
      duration: num(node['video_duration']) || undefined,
      width,
      height,
      cover: display ?? text(node['thumbnail_src']),
    }
    return video1
  }
  if (urls.length === 0) return undefined
  return {kind: 'image', id, urls, width, height}
}

/** A post from a GraphQL node (a profile's first posts, the post query). */
export function readGraphNode(node: unknown): MetaPost {
  if (!isObject(node)) throw new MetaError('format-changed', 'Instagram node is not an object.')
  const id = text(node['id'])
  if (!id) throw new MetaError('format-changed', 'Instagram node without an id.')
  const owner = isObject(node['owner']) ? node['owner'] : {}
  const code = text(node['shortcode'])
  const children = list(dig(node, 'edge_sidecar_to_children', 'edges'))
  const items: MetaMedia[] = []
  if (children.length > 0) {
    for (const edge of children) {
      const media = isObject(edge) && isObject(edge['node']) ? mediaOfNode(edge['node']) : undefined
      if (media) items.push(media)
    }
  } else {
    const media = mediaOfNode(node)
    if (media) items.push(media)
  }
  return {
    id,
    code,
    url: code ? postUrl(PUBLIC_ORIGIN, code) : `${PUBLIC_ORIGIN}/`,
    caption:
      text(dig(node, 'edge_media_to_caption', 'edges', 0, 'node', 'text')) ?? text(node['accessibility_caption']) ?? '',
    author: text(owner['username']) ?? '',
    authorName: text(owner['full_name']),
    createdAt: num(node['taken_at_timestamp']),
    items,
    cover: text(node['display_url']) ?? text(node['thumbnail_src']),
    pinned: list(node['pinned_for_users']).length > 0,
  }
}

// ─── Accounts and pages ─────────────────────────────────────────────────────

export type InstagramAccount = {
  readonly id: string
  readonly user: string
  readonly name?: string | undefined
  readonly isPrivate: boolean
  /** How many posts the profile counts. */
  readonly mediaCount?: number | undefined
  /** The first posts, with the cursor of the rest (GraphQL shape). */
  readonly firstPage: CursorPage<MetaPost>
}

/** `web_profile_info` → the account. */
export function readProfileInfo(json: unknown): InstagramAccount {
  checkStatus(json)
  const user = dig(json, 'data', 'user')
  if (user === null) throw new MetaError('removed', 'This Instagram account does not exist.')
  if (!isObject(user)) throw new MetaError('format-changed', 'Instagram profile info without its user.')
  const id = text(user['id']) ?? (typeof user['id'] === 'number' ? String(user['id']) : undefined)
  const username = text(user['username'])
  if (!id || !username) throw new MetaError('format-changed', 'Instagram profile info without an id.')
  const timeline = isObject(user['edge_owner_to_timeline_media']) ? user['edge_owner_to_timeline_media'] : {}
  const items: MetaPost[] = []
  for (const edge of list(timeline['edges'])) {
    if (isObject(edge) && isObject(edge['node'])) items.push(readGraphNode(edge['node']))
  }
  const pageInfo = isObject(timeline['page_info']) ? timeline['page_info'] : {}
  return {
    id,
    user: username,
    name: text(user['full_name']),
    isPrivate: user['is_private'] === true,
    mediaCount: num(timeline['count']),
    firstPage: {items, next: pageInfo['has_next_page'] === true ? text(pageInfo['end_cursor']) : undefined},
  }
}

/**
 * A page of a profile's posts, from either listing API: the timeline query
 * (`…graphql_connection.edges[].node`, `page_info`) or the signed-in feed
 * (`items`, `more_available`, `next_max_id`). Both hand v1 items.
 */
export function readTimelinePage(json: unknown): CursorPage<MetaPost> {
  checkStatus(json)
  if (isObject(json) && Array.isArray(json['items'])) {
    const items = json['items'].map(item => readV1Item(item))
    const more = json['more_available'] === true
    return {items, next: more ? text(json['next_max_id']) : undefined}
  }
  const connection = findWithKey([json], 'edges')
  if (!connection) {
    if (isObject(json) && Array.isArray(json['errors'])) {
      throw new MetaError('format-changed', `Instagram query failed: ${JSON.stringify(json['errors']).slice(0, 200)}`)
    }
    throw new MetaError('format-changed', 'Instagram listing without its edges.')
  }
  const items: MetaPost[] = []
  for (const edge of list(connection['edges'])) {
    if (isObject(edge) && isObject(edge['node'])) items.push(readV1Item(edge['node']))
  }
  const pageInfo = isObject(connection['page_info']) ? connection['page_info'] : {}
  return {items, next: pageInfo['has_next_page'] === true ? text(pageInfo['end_cursor']) : undefined}
}

/** The post query → a post; `null` means gone or private. */
export function readPostQuery(json: unknown): MetaPost {
  checkStatus(json)
  const media = dig(json, 'data', 'xdt_shortcode_media')
  if (media === null) throw new MetaError('removed', 'This Instagram post no longer exists, or is private.')
  if (media === undefined) {
    if (isObject(json) && Array.isArray(json['errors'])) {
      throw new MetaError(
        'format-changed',
        `Instagram post query failed: ${JSON.stringify(json['errors']).slice(0, 200)}`,
      )
    }
    throw new MetaError('format-changed', 'Instagram post query without its media.')
  }
  return readGraphNode(media)
}

const GONE = /Sorry, this page isn't available|Page Not Found|content isn't available/i
/** The login wall / "wait a few minutes" page is the bare app shell: no post data, a title of just "Instagram". */
const BARE_SHELL = /<title>\s*Instagram\s*<\/title>/

/**
 * A post page: the v1 item the page embeds for its own player — as
 * `xig_polaris_media.if_not_gated_logged_out` for a visitor without a session
 * (yt-dlp's route since 2026-07), or `xdt_api__v1__media__shortcode__web_info`.
 * A redirect to the login page, or the bare app shell, is a challenge (a
 * browser, or a signed-in session, gets the page); a "page isn't available"
 * is a removed post.
 */
export function readPostPage(page: {readonly html: string; readonly url: string}): MetaPost {
  if (/\/accounts\/login/.test(page.url)) throw new MetaError('challenge', 'Instagram asked to log in.')
  const scripts = jsonScripts(page.html)
  const polaris = dig(findWithKey(scripts, 'xig_polaris_media'), 'xig_polaris_media', 'if_not_gated_logged_out')
  if (isObject(polaris)) return readV1Item(polaris)
  const info = findWithKey(scripts, 'xdt_api__v1__media__shortcode__web_info')
  const items = list(dig(info, 'xdt_api__v1__media__shortcode__web_info', 'items'))
  if (items.length > 0) return readV1Item(items[0])
  if (GONE.test(page.html)) throw new MetaError('removed', 'This Instagram post no longer exists.')
  if (/\/challenge\/|checkpoint_required/.test(page.html)) {
    throw new MetaError('challenge', 'Instagram asks for a verification.')
  }
  if (scripts.length === 0 && /login/i.test(page.html) && page.html.length < 200_000) {
    throw new MetaError('challenge', 'Instagram asked to log in.')
  }
  if (BARE_SHELL.test(page.html)) throw new MetaError('challenge', 'Instagram showed its login wall.')
  throw new MetaError('format-changed', 'Instagram post page without its media data.')
}

// ─── The anonymous routes ───────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * The numeric media id (`pk`) the app API wants, from a link's shortcode: the
 * code is the id in base 64 over Instagram's own alphabet. Very long codes
 * (private posts) carry the owner's id in their last 28 characters.
 */
export function codeToPk(code: string): string {
  let n = 0n
  for (const ch of code.length > 28 ? code.slice(0, -28) : code) {
    const digit = ALPHABET.indexOf(ch)
    if (digit < 0) throw new MetaError('format-changed', `Unexpected character in the Instagram code ${code}.`)
    n = n * 64n + BigInt(digit)
  }
  return n.toString()
}

/**
 * The embed page (`/p/<code>/embed/captioned/`): its script hands the post to
 * the embed as `"contextJSON":"<escaped json>"` → `gql_data.shortcode_media`
 * (older embeds: `__additionalDataLoaded('extra', {...})`). A GraphQL node.
 */
export function readEmbedPage(page: {readonly html: string; readonly url: string}): MetaPost {
  if (/\/accounts\/login|\/challenge\//.test(page.url)) {
    throw new MetaError('challenge', 'Instagram sent the embed to its login page.')
  }
  let gql: unknown
  try {
    const escaped = /"contextJSON":"((?:[^"\\]|\\.)*)"/.exec(page.html)
    if (escaped) gql = dig(JSON.parse(JSON.parse(`"${escaped[1]}"`) as string), 'gql_data')
    else {
      const extra = /__additionalDataLoaded\('extra',\s*(\{.*?\})\);\s*<\/script>/s.exec(page.html)
      if (extra) gql = JSON.parse(extra[1]!)
    }
  } catch (error) {
    throw new MetaError('format-changed', `Unreadable Instagram embed data: ${String(error)}`)
  }
  if (!isObject(gql)) {
    if (GONE.test(page.html)) throw new MetaError('removed', 'This Instagram post no longer exists.')
    if (/This Account is Private|private account/i.test(page.html)) {
      throw new MetaError('private', 'This Instagram account is private.')
    }
    if (BARE_SHELL.test(page.html) || /\/accounts\/login|checkpoint_required|login_form/.test(page.html)) {
      throw new MetaError('challenge', 'Instagram showed the embed its login wall.')
    }
    throw new MetaError('format-changed', 'Instagram embed without its post data.')
  }
  const node = 'shortcode_media' in gql ? gql['shortcode_media'] : gql['xdt_shortcode_media']
  if (node === null) throw new MetaError('removed', 'This Instagram post no longer exists, or is private.')
  return readGraphNode(node)
}

/** The app API's `media/<pk>/info/` answer: `{items: [item]}`. */
export function readMediaInfo(json: unknown): MetaPost {
  checkStatus(json)
  const items = list(dig(json, 'items'))
  if (items.length === 0) throw new MetaError('removed', 'This Instagram post no longer exists, or is private.')
  return readV1Item(items[0])
}

/** `reels_media` → the stories of the asked reel (a user id or `highlight:<id>`), newest last as Instagram lists them. */
export function readReelsMedia(
  json: unknown,
  reelId: string,
): {readonly items: MetaPost[]; readonly title?: string | undefined} {
  checkStatus(json)
  const reel =
    dig(json, 'reels', reelId) ??
    list(dig(json, 'reels_media')).find(r => isObject(r) && String(r['id']) === reelId) ??
    list(dig(json, 'reels_media'))[0]
  if (!isObject(reel)) return {items: []}
  const items = list(reel['items']).map(item => readV1Item(item, {story: true}))
  return {items, title: text(reel['title'])}
}
