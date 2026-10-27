import {CLIP_PERIODS, type ClipPeriod, DEFAULT_CLIP_PERIOD, TWITCH_ORIGIN} from './endpoints.js'

/**
 * Twitch urls in all their shapes, reduced to what they point at:
 *   clips.twitch.tv/<slug>, clips.twitch.tv/embed?clip=<slug>,
 *   (www|m|go.)twitch.tv/<u>/clip/<slug>, twitch.tv/clip/<slug>        → clip
 *   twitch.tv/<u>/clips (?range=24hr|7d|30d|all, ?filter=clips&range=…)  → a channel's clips
 *   twitch.tv/videos/<id>, /<u>/v/<id>, /<u>/video/<id>,
 *   player.twitch.tv/?video=v<id>, /<u>/schedule?vodID=<id> (?t=1h2m3s)  → vod
 *   twitch.tv/<u>/videos (?filter=all|archives|highlights|uploads|past_premieres&sort=time|views) → videos
 *   twitch.tv/<u>                                                        → channel (its live stream)
 * Clips, VODs and both listings are read natively (VODs are HLS, through
 * core/hls); a channel is checked for a live stream, which is never
 * downloaded. No request: everything is in the link. O(L) for its length.
 */
export type TwitchLink =
  | {readonly kind: 'clip'; readonly slug: string}
  | {readonly kind: 'clips'; readonly channel: string; readonly period: ClipPeriod}
  | {readonly kind: 'vod'; readonly id: string; readonly start?: number | undefined}
  | {
      readonly kind: 'videos'
      readonly channel: string
      readonly filter: VideoFilter
      readonly sort: 'time' | 'views'
    }
  | {readonly kind: 'channel'; readonly channel: string}

export type VideoFilter = 'all' | 'archives' | 'highlights' | 'uploads' | 'past_premieres'

/** A login: letters, digits and underscores, 1 to 25 (lower case once read). */
const LOGIN = /^[a-z0-9_]{1,25}$/
/** A clip slug: the old CamelCase words, or the new words-plus-suffix with - and _. */
const SLUG = /^[A-Za-z0-9_-]{3,100}$/
const VOD_ID = /^\d{1,15}$/
/** `?t=` of a VOD: 1h2m3s, 2m, 95s, or plain seconds. */
const TIMESTAMP = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/
const HOSTS: ReadonlySet<string> = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv'])
const CLIPS_HOST = 'clips.twitch.tv'
const PLAYER_HOST = 'player.twitch.tv'
/** First path segments of twitch.tv that are pages, never a channel. */
const RESERVED: ReadonlySet<string> = new Set([
  'clip',
  'collections',
  'directory',
  'downloads',
  'drops',
  'embed',
  'friends',
  'inventory',
  'jobs',
  'login',
  'logout',
  'messages',
  'moderator',
  'p',
  'payments',
  'popout',
  'prime',
  'search',
  'settings',
  'signup',
  'store',
  'subscriptions',
  'team',
  'turbo',
  'videos',
  'wallet',
])
const VIDEO_FILTERS: ReadonlySet<string> = new Set(['all', 'archives', 'highlights', 'uploads', 'past_premieres'])

export function isTwitchHost(host: string): boolean {
  return HOSTS.has(host) || host === CLIPS_HOST || host === PLAYER_HOST
}

const slugOf = (raw: string | null | undefined): string | undefined => (raw && SLUG.test(raw) ? raw : undefined)

function channelOf(raw: string | null | undefined): string | undefined {
  const login = raw?.toLowerCase()
  return login && LOGIN.test(login) && !RESERVED.has(login) ? login : undefined
}

function periodOf(raw: string | null): ClipPeriod {
  return raw !== null && Object.hasOwn(CLIP_PERIODS, raw) ? (raw as ClipPeriod) : DEFAULT_CLIP_PERIOD
}

/** `?t=1h2m3s` in seconds; undefined when absent or not a time. O(L). */
function startOf(raw: string | null): number | undefined {
  if (!raw) return undefined
  const match = TIMESTAMP.exec(raw)
  if (!match) return undefined
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
  return seconds > 0 ? seconds : undefined
}

function vod(id: string | null | undefined, url: URL): TwitchLink | undefined {
  const value = id?.replace(/^v/, '')
  if (!value || !VOD_ID.test(value)) return undefined
  const start = startOf(url.searchParams.get('t'))
  return start === undefined ? {kind: 'vod', id: value} : {kind: 'vod', id: value, start}
}

/** What a url points at, or undefined when it isn't a Twitch url this module understands. */
export function parseTwitchLink(raw: string, extraHost?: string): TwitchLink | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  const [first, second, third, ...rest] = parts

  if (host === CLIPS_HOST) {
    if (first === 'embed' && !second) {
      const slug = slugOf(url.searchParams.get('clip'))
      return slug ? {kind: 'clip', slug} : undefined
    }
    const slug = slugOf(first)
    return slug && !second ? {kind: 'clip', slug} : undefined
  }
  if (host === PLAYER_HOST) {
    if (first) return undefined
    const clip = slugOf(url.searchParams.get('clip'))
    if (clip) return {kind: 'clip', slug: clip}
    const video = url.searchParams.get('video')
    if (video) return vod(video, url)
    const channel = channelOf(url.searchParams.get('channel'))
    return channel ? {kind: 'channel', channel} : undefined
  }
  if (!HOSTS.has(host) && host !== extraHost) return undefined
  if (!first || rest.length > 0) return undefined

  if (first === 'clip') {
    const slug = slugOf(second)
    return slug && !third ? {kind: 'clip', slug} : undefined
  }
  if (first === 'videos') return !third ? vod(second, url) : undefined
  const channel = channelOf(first)
  if (!channel) return undefined
  if (!second) return {kind: 'channel', channel}
  switch (second) {
    case 'clip': {
      const slug = slugOf(third)
      return slug ? {kind: 'clip', slug} : undefined
    }
    case 'clips':
      return third ? undefined : {kind: 'clips', channel, period: periodOf(url.searchParams.get('range'))}
    case 'v':
    case 'video':
      return vod(third, url)
    case 'schedule':
      return third ? undefined : vod(url.searchParams.get('vodID'), url)
    case 'videos': {
      if (third) return undefined
      const filter = url.searchParams.get('filter') ?? 'all'
      return {
        kind: 'videos',
        channel,
        filter: VIDEO_FILTERS.has(filter) ? (filter as VideoFilter) : 'all',
        sort: url.searchParams.get('sort') === 'views' ? 'views' : 'time',
      }
    }
    default:
      return undefined
  }
}

/** A clip's page on the web site. */
export function clipUrl(channel: string | undefined, slug: string): string {
  return channel ? `${TWITCH_ORIGIN}/${channel}/clip/${slug}` : `https://${CLIPS_HOST}/${slug}`
}

/** A channel's clips page, with its period. */
export function clipsUrl(channel: string, period: ClipPeriod): string {
  return `${TWITCH_ORIGIN}/${channel}/clips?range=${period}`
}

/** A listing url (a channel's clips or videos): batches cap these unless told otherwise. */
export function isTwitchListing(url: string): boolean {
  const kind = parseTwitchLink(url)?.kind
  return kind === 'clips' || kind === 'videos'
}

/** A VOD's page on the web site. */
export function vodUrl(id: string): string {
  return `${TWITCH_ORIGIN}/videos/${id}`
}

/** A channel's videos page, with its filter and sort. */
export function videosUrl(channel: string, filter: VideoFilter, sort: 'time' | 'views'): string {
  return `${TWITCH_ORIGIN}/${channel}/videos?filter=${filter}&sort=${sort}`
}

/**
 * What the source takes: every link this module understands. Clips, VODs
 * and both listings are read natively; a channel (and a VOD) on the air is
 * `live-now`, never handed to yt-dlp, which would record the stream.
 */
export function isNativeTwitchLink(link: TwitchLink | undefined): boolean {
  return link !== undefined
}
