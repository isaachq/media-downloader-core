/**
 * Bluesky urls in all their shapes, reduced to what they point at:
 *   /profile/<actor>/post/<rkey>  (…/quotes, …/likes, …/reposted-by)        → post
 *   /profile/<actor>  /profile/<actor>/media|video|posts|replies             → profile (its media posts)
 *   at://<actor>/app.bsky.feed.post/<rkey>                                   → post
 * on bsky.app (www., main.bsky.dev and staging.bsky.app too), where the actor
 * is a handle (`jay.bsky.team`) or a DID (`did:plc:…`, `did:web:…`). Feeds,
 * lists and starter packs are not read. No request: everything is in the
 * link. O(L) for its length.
 */
export type BlueskyLink =
  | {readonly kind: 'post'; readonly actor: string; readonly rkey: string}
  | {readonly kind: 'profile'; readonly actor: string}

/** A handle: dot-separated labels, at least two (lower case once read). */
const HANDLE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.%-]+(?::[a-z0-9.%-]+)*)$/
/** A record key: usually a 13-character TID. */
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/
const POST_COLLECTION = 'app.bsky.feed.post'
const HOSTS: ReadonlySet<string> = new Set(['bsky.app', 'www.bsky.app', 'main.bsky.dev', 'staging.bsky.app'])
/** Tabs of a profile page: each is read as the profile's media posts. */
const PROFILE_TABS: ReadonlySet<string> = new Set(['media', 'video', 'posts', 'replies'])
/** Pages of one post: the post itself. */
const POST_TABS: ReadonlySet<string> = new Set(['quotes', 'likes', 'reposted-by'])

export function isBlueskyHost(host: string): boolean {
  return HOSTS.has(host)
}

/** A handle or DID as the API takes it (lower case); undefined when it is neither. O(L). */
export function actorOf(raw: string): string | undefined {
  const actor = raw.trim().toLowerCase()
  if (actor.startsWith('did:')) return DID.test(actor) ? actor : undefined
  const handle = actor.startsWith('@') ? actor.slice(1) : actor
  return HANDLE.test(handle) ? handle : undefined
}

const rkeyOf = (raw: string | undefined): string | undefined =>
  raw && raw !== '.' && raw !== '..' && RKEY.test(raw) ? raw : undefined

/** What a url points at, or undefined when it isn't a Bluesky url this module understands. */
export function parseBlueskyLink(raw: string, extraHost?: string): BlueskyLink | undefined {
  const value = raw.trim()
  if (value.startsWith('at://')) return parseAtUri(value)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const host = url.hostname.toLowerCase()
  if (!isBlueskyHost(host) && host !== extraHost) return undefined
  let parts: string[]
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return undefined
  }
  const [first, second, third, fourth, fifth] = parts
  if (first !== 'profile' || !second) return undefined
  const actor = actorOf(second)
  if (!actor) return undefined
  if (!third) return {kind: 'profile', actor}
  if (PROFILE_TABS.has(third) && !fourth) return {kind: 'profile', actor}
  if (third !== 'post') return undefined
  const rkey = rkeyOf(fourth)
  if (!rkey || (fifth !== undefined && !POST_TABS.has(fifth)) || parts.length > 5) return undefined
  return {kind: 'post', actor, rkey}
}

/** `at://<actor>/app.bsky.feed.post/<rkey>`; another collection is not a post. O(L). */
function parseAtUri(uri: string): BlueskyLink | undefined {
  const [authority, collection, rkey, ...rest] = uri.slice('at://'.length).split('/')
  const actor = authority ? actorOf(authority) : undefined
  if (!actor || rest.length > 0) return undefined
  if (collection === undefined || collection === '') return {kind: 'profile', actor}
  const key = rkeyOf(rkey)
  return collection === POST_COLLECTION && key ? {kind: 'post', actor, rkey: key} : undefined
}

/** The record key of an at-uri (its last segment). O(L). */
export function rkeyOfUri(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1)
}

export function atUri(actor: string, rkey: string): string {
  return `at://${actor}/${POST_COLLECTION}/${rkey}`
}

/** The web app's link of a post. */
export function postUrl(origin: string, actor: string, rkey: string): string {
  return `${origin}/profile/${actor}/post/${rkey}`
}

export function profileUrl(origin: string, actor: string): string {
  return `${origin}/profile/${actor}`
}

/** A listing url (a profile): batches cap these unless told otherwise. */
export function isBlueskyListing(url: string): boolean {
  return parseBlueskyLink(url)?.kind === 'profile'
}
