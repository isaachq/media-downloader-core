import {MetaError} from '../meta/errors.js'
import type {MetaPost} from '../meta/post.js'
import {dig, isObject, list, num, text} from '../meta/relay.js'
import type {Rendition} from '../renditions.js'
import {clipUrl} from './links.js'

/**
 * Twitch's GraphQL answers read into what the source needs, and nothing more:
 * a clip (its signed progressive MP4s by quality), a page of a channel's
 * clips, and the errors GraphQL puts beside its data. Every reader is O(size
 * of the answer) and never trusts a shape it did not check.
 */
export type TwitchClip = {
  /** The numeric id (what yt-dlp records too: the archive matches either way). */
  readonly id: string
  readonly slug: string
  readonly url: string
  readonly title: string
  /** The broadcaster's login and display name. */
  readonly channel: string | undefined
  readonly channelName: string | undefined
  /** Unix seconds. */
  readonly createdAt: number | undefined
  /** Seconds. */
  readonly duration: number | undefined
  readonly thumbnail: string | undefined
  readonly width: number
  readonly height: number
  /** Signed: each URL carries its `sig` and `token`. */
  readonly renditions: readonly Rendition[]
  /** When the token signing those URLs runs out (ms). */
  readonly expiresAt: number | undefined
  /** Why nobody can download it as read (a forbidden token, no encodings), when that is so. */
  readonly problem?: MetaError | undefined
}

export type ClipsPage = {
  readonly channel: {readonly login: string; readonly name: string | undefined}
  readonly clips: readonly TwitchClip[]
  /** The next page's cursor; undefined on the last page. */
  readonly next: string | undefined
}

/** How long a token may be trusted before it runs out: re-read 10 minutes ahead. */
const TOKEN_MARGIN_MS = 10 * 60_000
const HEVC = /^(?:hvc1|hev1)/i
const HEVC_PATH = /\/hevc\/(\d{3,4})\//

/**
 * The GraphQL `errors` of an answer as this module's errors (the body is an
 * object for one query, an array of them for a batch). Undefined when there
 * are none. An integrity check is a verification this library does not
 * solve (`challenge`: yt-dlp takes over for a while); an unknown field,
 * argument, type or a persisted query that is gone is a change on Twitch's
 * side (`format-changed`); a timeout of theirs is `refused` (retried). O(e).
 */
export function gqlProblem(body: unknown, path?: string): MetaError | undefined {
  const root = Array.isArray(body) ? body[0] : body
  const errors = list(dig(root, 'errors')).filter(
    error => path === undefined || list(dig(error, 'path')).length === 0 || list(dig(error, 'path')).includes(path),
  )
  if (errors.length === 0) return undefined
  const first = errors[0]
  const message = text(dig(first, 'message')) ?? 'an error'
  const code = text(dig(first, 'extensions', 'code')) ?? ''
  if (code === 'IntegrityCheckFailed' || /integrity/i.test(message) || dig(root, 'extensions', 'challenge')) {
    return new MetaError(
      'challenge',
      'Twitch asked for an integrity check (a token its web page makes in the browser): try again in a few minutes.',
    )
  }
  if (/timeout|service error|service unavailable|internal/i.test(message)) {
    return new MetaError('refused', `Twitch answered "${message}".`)
  }
  return new MetaError('format-changed', `Twitch: GraphQL answered "${message}"${code ? ` (${code})` : ''}.`)
}

/** `data` of a GraphQL answer (one query's, or the first of a batch's). */
export function gqlData(body: unknown): unknown {
  return dig(Array.isArray(body) ? body[0] : body, 'data')
}

/**
 * One clip node (a `clip(slug)` answer or a listing edge's node); undefined
 * when it isn't one. Encodings: the top-level `videoQualities` (H.264, 1080p
 * down to 360p) and the landscape assets' (the portrait asset is another
 * framing of the clip, not another size of it: left out), each signed with the
 * clip's one token; the HEVC file the token names (1440p on new clips) as one
 * more. O(q) for q qualities.
 */
export function readClip(node: unknown): TwitchClip | undefined {
  const id = text(dig(node, 'id')) ?? (typeof dig(node, 'id') === 'number' ? String(dig(node, 'id')) : undefined)
  const slug = text(dig(node, 'slug'))
  if (!id || !slug) return undefined
  const channel = text(dig(node, 'broadcaster', 'login'))
  const token = readToken(dig(node, 'playbackAccessToken'))
  const qualities = [
    ...list(dig(node, 'videoQualities')),
    ...list(dig(node, 'assets'))
      .filter(asset => (num(dig(asset, 'aspectRatio')) ?? 1) >= 1)
      .flatMap(asset => list(dig(asset, 'videoQualities'))),
  ]
  const seen = new Set<string>()
  const renditions: Rendition[] = []
  let width = 0
  let height = 0
  for (const quality of qualities) {
    const source = text(dig(quality, 'sourceURL'))
    if (!source || seen.has(source)) continue
    seen.add(source)
    const rendition = toRendition(quality, source, token)
    if (!rendition) continue
    renditions.push(rendition)
    if (rendition.width * rendition.height > width * height) {
      width = rendition.width
      height = rendition.height
    }
  }
  const hevc = token?.clipUri && !seen.has(token.clipUri) ? HEVC_PATH.exec(token.clipUri) : null
  if (token?.clipUri && hevc && renditions.length > 0) {
    const resolution = Number(hevc[1])
    const landscape = width >= height
    const long = Math.round((resolution * 16) / 9)
    renditions.push({
      codec: 'h265',
      width: landscape ? long : resolution,
      height: landscape ? resolution : long,
      resolution,
      bitrate: 0,
      urls: [sign(token.clipUri, token)],
    })
  }
  const problem = token?.forbidden
    ? new MetaError(
        'login-required',
        `Twitch keeps this clip for some viewers only${token.reason ? ` (${token.reason})` : ''}: it needs a signed-in account that may watch it.`,
      )
    : !token
      ? new MetaError('format-changed', 'Twitch: the clip came without its playback token.')
      : renditions.length === 0
        ? new MetaError('format-changed', 'Twitch: the clip came without a downloadable encoding.')
        : undefined
  const created = text(dig(node, 'createdAt'))
  const createdMs = created ? Date.parse(created) : Number.NaN
  return {
    id,
    slug,
    url: text(dig(node, 'url')) ?? clipUrl(channel, slug),
    title: text(dig(node, 'title')) ?? '',
    channel,
    channelName: text(dig(node, 'broadcaster', 'displayName')),
    createdAt: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : undefined,
    duration: num(dig(node, 'durationSeconds')),
    thumbnail: text(dig(node, 'thumbnailURL')),
    width,
    height,
    renditions,
    expiresAt: token?.expires !== undefined ? token.expires * 1000 - TOKEN_MARGIN_MS : undefined,
    ...(problem && {problem}),
  }
}

/**
 * A `clip(slug)` answer: the clip, or why not. `clip: null` without an error
 * is a clip that is gone (deleted, or never there). O(size).
 */
export function readClipAnswer(body: unknown, alias = 'clip'): TwitchClip | MetaError {
  const node = dig(gqlData(body), alias)
  if (node === null || node === undefined) {
    return gqlProblem(body, alias) ?? new MetaError('removed', 'This Twitch clip was deleted (or never existed).')
  }
  return readClip(node) ?? new MetaError('format-changed', 'Twitch: a clip came without its id or slug.')
}

/**
 * One page of a channel's clips. `user: null` is a channel that is not there;
 * `clips: null` with an error (an integrity check past page 1 on the web
 * player's client id) is that error. The cursor is the last edge's; there is
 * none past the last page. O(page).
 */
export function readClipsPage(body: unknown): ClipsPage {
  const user = dig(gqlData(body), 'user')
  if (user === null) {
    throw gqlProblem(body) ?? new MetaError('removed', 'There is no Twitch channel by that name (or no longer).')
  }
  const clips = dig(user, 'clips')
  if (!isObject(user) || !isObject(clips)) {
    throw gqlProblem(body) ?? new MetaError('format-changed', 'Twitch: the channel’s clips came without a listing.')
  }
  const login = text(dig(user, 'login'))
  if (!login) throw new MetaError('format-changed', 'Twitch: the channel came without its login.')
  const edges = list(dig(clips, 'edges'))
  const read: TwitchClip[] = []
  for (const edge of edges) {
    const clip = readClip(dig(edge, 'node'))
    if (clip) read.push(clip)
  }
  const cursor = text(dig(edges.at(-1), 'cursor'))
  const more = dig(clips, 'pageInfo', 'hasNextPage') === true
  return {
    channel: {login, name: text(dig(user, 'displayName'))},
    clips: read,
    next: more && cursor ? cursor : undefined,
  }
}

/** A clip as the shared Meta download and summaries take it: one video. O(1). */
export function toMetaPost(clip: TwitchClip): MetaPost {
  return {
    id: clip.id,
    url: clip.url,
    caption: clip.title,
    author: clip.channel ?? '',
    authorName: clip.channelName,
    createdAt: clip.createdAt,
    items: [
      {
        kind: 'video',
        id: clip.slug,
        renditions: clip.renditions,
        duration: clip.duration,
        width: clip.width,
        height: clip.height,
        cover: clip.thumbnail,
      },
    ],
    cover: clip.thumbnail,
    pinned: false,
  }
}

type Token = {
  readonly signature: string
  readonly value: string
  readonly forbidden: boolean
  readonly reason: string | undefined
  readonly clipUri: string | undefined
  /** Unix seconds. */
  readonly expires: number | undefined
}

/** `playbackAccessToken`: its signature, and what its JSON value says. O(size). */
function readToken(raw: unknown): Token | undefined {
  const signature = text(dig(raw, 'signature'))
  const value = text(dig(raw, 'value'))
  if (!signature || !value) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    parsed = undefined
  }
  return {
    signature,
    value,
    forbidden: dig(parsed, 'authorization', 'forbidden') === true,
    reason: text(dig(parsed, 'authorization', 'reason')),
    clipUri: text(dig(parsed, 'clip_uri')),
    expires: num(dig(parsed, 'expires')),
  }
}

/** A file URL with the token's signature, as the web player asks for it. O(L). */
function sign(url: string, token: Token): string {
  return `${url}${url.includes('?') ? '&' : '?'}sig=${encodeURIComponent(token.signature)}&token=${encodeURIComponent(token.value)}`
}

/** One `ClipVideoQuality`; sizes from its fields, else from its quality (the short side). O(1). */
function toRendition(quality: unknown, source: string, token: Token | undefined): Rendition | undefined {
  if (!token) return undefined
  const named = num(dig(quality, 'quality'))
  const width = num(dig(quality, 'width')) ?? (named ? Math.round((named * 16) / 9) : 0)
  const height = num(dig(quality, 'height')) ?? named ?? 0
  const resolution = width && height ? Math.min(width, height) : (named ?? 0)
  if (!resolution) return undefined
  const codecs = text(dig(quality, 'codecs')) ?? ''
  return {
    codec: HEVC.test(codecs) || source.includes('/hevc/') ? 'h265' : 'h264',
    width,
    height,
    resolution,
    bitrate: num(dig(quality, 'bitrate')) ?? 0,
    urls: [sign(source, token)],
  }
}

/** A channel's stream while it is on the air: what a recorder needs to start. */
export type TwitchLiveStream = {
  readonly id: string
  readonly login: string
  readonly title: string | undefined
  /** Unix seconds. */
  readonly startedAt: number | undefined
  /** "live", or "rerun" (a past broadcast replayed live). */
  readonly type: string | undefined
}

/**
 * A `channelStreamQuery` answer: the channel's live stream, or undefined when
 * it is offline. `user: null` is a channel that is not there (`removed`).
 * Live detection on its own, for the live recorder that comes with the core's
 * HLS module. O(1).
 */
export function readLiveStream(body: unknown): TwitchLiveStream | undefined {
  const user = dig(gqlData(body), 'user')
  if (user === null) {
    throw gqlProblem(body) ?? new MetaError('removed', 'There is no Twitch channel by that name (or no longer).')
  }
  const login = text(dig(user, 'login'))
  if (!isObject(user) || !login) {
    throw gqlProblem(body) ?? new MetaError('format-changed', 'Twitch: the channel came without its login.')
  }
  const stream = dig(user, 'stream')
  if (stream === null || stream === undefined) return undefined
  const id = text(dig(stream, 'id'))
  if (!id) throw new MetaError('format-changed', 'Twitch: a live stream came without its id.')
  const started = Date.parse(text(dig(stream, 'createdAt')) ?? '')
  return {
    id,
    login,
    title: text(dig(stream, 'title')),
    startedAt: Number.isFinite(started) ? Math.floor(started / 1000) : undefined,
    type: text(dig(stream, 'type')),
  }
}

/** A `vodStatusQuery` answer: whether the VOD's broadcast is still on the air; `video: null` is `removed`. O(1). */
export function readVodStatus(body: unknown): {readonly recording: boolean; readonly owner: string | undefined} {
  const video = dig(gqlData(body), 'video')
  if (video === null) {
    throw gqlProblem(body) ?? new MetaError('removed', 'This Twitch video was deleted (or never existed).')
  }
  if (!isObject(video))
    throw gqlProblem(body) ?? new MetaError('format-changed', 'Twitch: the video came without data.')
  return {recording: text(dig(video, 'status')) === 'RECORDING', owner: text(dig(video, 'owner', 'login'))}
}
