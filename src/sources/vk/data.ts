import {decodeEntities} from '../player-page/parse.js'
import type {Rendition} from '../renditions.js'

/**
 * VK's answers as its web client gets them, reduced to what the source needs.
 * Everything comes from `al_video.php` (the endpoint the site's own video
 * layer calls), which answers anonymously in the "al" format:
 * `{"payload": [code, data], …}` — code 0 with the data, or an error code
 * (seen: "8") with the message as a JSON-encoded string in data[0].
 *  - act=show: data[4] (or any object of data) holds `player.params[0]`:
 *    `md_title`, `md_author`, `duration`, `date`, `jpg`, and the progressive
 *    MP4s `url144`…`url2160` (named by the short side), plus `hls`.
 *    The media links are signed for this IP (`srcIp`) and user agent
 *    (`srcAg`) and live for days.
 *  - act=load_videos_silent: data[0] is {<section>: {list, count, total}},
 *    each entry an array: [oid, id, thumb, title, flags, "m:ss", …,
 *    8: owner html, 9: date, …, 19: seconds, 20: path]; with need_albums=1
 *    data[1] lists the owner's albums ([name, count, thumb, path, …]).
 * The body is windows-1251 (the charset VK has always served), decoded here
 * without ICU (nodejs-mobile may lack it). No HTML is parsed anywhere.
 */

export const PUBLIC_ORIGIN = 'https://vk.com'

/** Why VK said no, in the source's terms. */
export type VkProblem =
  | 'removed'
  | 'private'
  | 'login-required'
  | 'geo-blocked'
  | 'blocked'
  | 'refused'
  | 'live'
  /** Only an HLS stream, or played from another site: no file this extractor fetches (yt-dlp may). */
  | 'stream-only'
  | 'format-changed'
  | 'no-media'

export class VkError extends Error {
  override readonly name = 'VkError'

  constructor(
    readonly problem: VkProblem,
    message: string,
  ) {
    super(message)
  }
}

// ─── windows-1251 ───────────────────────────────────────────────────────────

/** Code points of bytes 0x80…0xFF in windows-1251 (0x98 is unassigned: kept as U+0098, as WHATWG does). */
const CP1251_HIGH: readonly number[] = [
  0x0402,
  0x0403,
  0x201a,
  0x0453,
  0x201e,
  0x2026,
  0x2020,
  0x2021,
  0x20ac,
  0x2030,
  0x0409,
  0x2039,
  0x040a,
  0x040c,
  0x040b,
  0x040f,
  0x0452,
  0x2018,
  0x2019,
  0x201c,
  0x201d,
  0x2022,
  0x2013,
  0x2014,
  0x0098,
  0x2122,
  0x0459,
  0x203a,
  0x045a,
  0x045c,
  0x045b,
  0x045f,
  0x00a0,
  0x040e,
  0x045e,
  0x0408,
  0x00a4,
  0x0490,
  0x00a6,
  0x00a7,
  0x0401,
  0x00a9,
  0x0404,
  0x00ab,
  0x00ac,
  0x00ad,
  0x00ae,
  0x0407,
  0x00b0,
  0x00b1,
  0x0406,
  0x0456,
  0x0491,
  0x00b5,
  0x00b6,
  0x00b7,
  0x0451,
  0x2116,
  0x0454,
  0x00bb,
  0x0458,
  0x0405,
  0x0455,
  0x0457,
  // 0xC0…0xFF: А…я
  ...Array.from({length: 64}, (_, i) => 0x0410 + i),
]

/** windows-1251 bytes as text: one table lookup per byte, O(n). */
export function decodeWindows1251(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!
    units[i] = byte < 0x80 ? byte : CP1251_HIGH[byte - 0x80]!
  }
  // UTF-16 needs no ICU, unlike the legacy encodings
  return new TextDecoder('utf-16le').decode(units)
}

/** An answer's body as text, by the charset its Content-Type names (VK's own default: windows-1251). O(n). */
export function decodeBody(bytes: Uint8Array, contentType: string | null | undefined): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase()
  if (charset === 'utf-8' || charset === 'utf8') return new TextDecoder('utf-8').decode(bytes)
  return decodeWindows1251(bytes)
}

// ─── answers ────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
/** Text as shown: entities decoded (titles come as `&#237;`, `&amp;`, emoji as `&#128077;`), tags dropped. */
const plain = (value: unknown): string | undefined => {
  const raw = text(value)
  if (!raw) return undefined
  const stripped = decodeEntities(raw.replace(/<[^<>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
  return stripped || undefined
}

/**
 * The data of an "al" answer, or the problem it reports. Both shapes are
 * read: plain JSON, and the older `<!--`-prefixed one. O(n).
 */
export function readAnswer(body: string): unknown[] {
  const start = body.indexOf('{')
  const head = body.slice(0, start).trim()
  if (start < 0 || (head !== '' && head !== '<!--')) {
    throw new VkError('format-changed', 'VK answered something other than its data (the endpoint changed?).')
  }
  let answer: unknown
  try {
    answer = JSON.parse(body.slice(start))
  } catch {
    throw new VkError('format-changed', 'VK answered data this extractor cannot read.')
  }
  const payload = isObject(answer) ? answer['payload'] : undefined
  if (!Array.isArray(payload) || payload.length < 2 || !Array.isArray(payload[1])) {
    throw new VkError('format-changed', 'VK answered without the data where it used to be.')
  }
  const [code, data] = payload as [unknown, unknown[]]
  if (code === 0 || code === '0') return data
  throw problemOf(code, data)
}

/** An error answer as a problem: VK words it (in the visitor's language: English is asked for). */
export function problemOf(code: unknown, data: readonly unknown[]): VkError {
  let message = text(data[0]) ?? ''
  try {
    const decoded: unknown = JSON.parse(message)
    if (typeof decoded === 'string') message = decoded
  } catch {}
  message = plain(message) ?? `error ${String(code)}`
  const says = (pattern: RegExp) => pattern.test(message)
  // transient wordings first: "access temporarily restricted, try later" is a wait, not a private video
  if (says(/captcha|robot|бот|подтверд/i)) return new VkError('blocked', `VK asks to confirm this is not a bot.`)
  if (says(/temporar|try again|later|too many|временно|позже|слишком много/i))
    return new VkError('refused', `VK: ${message}`)
  if (says(/deleted|removed|no longer available|not found|удал[её]н|изъят|не найден/i))
    return new VkError('removed', 'This VK video has been deleted or is no longer available.')
  if (says(/region|country|стран|регион/i)) return new VkError('geo-blocked', 'This VK video is not available here.')
  if (says(/log ?in|sign ?in|войдите|авториз|18\+|age[- ]restrict|возраст/i))
    return new VkError('login-required', 'This VK video can only be watched signed in (age-restricted?).')
  if (says(/restricted|denied|private|access|доступ|ограничен|приват/i))
    return new VkError('private', 'This VK video is private (access restricted by its owner).')
  // a wording this extractor doesn't know: not a verdict (yt-dlp, where there is one, reads it again)
  return new VkError('format-changed', `VK refused this video: ${message}`)
}

// ─── a video ────────────────────────────────────────────────────────────────

export type VkVideo = {
  readonly oid: string
  readonly id: string
  readonly title?: string | undefined
  readonly author?: string | undefined
  /** Seconds. */
  readonly duration?: number | undefined
  /** Upload time, unix seconds. */
  readonly date?: number | undefined
  readonly thumbnail?: string | undefined
  /** The progressive MP4s, one per size. */
  readonly renditions: readonly Rendition[]
  /** The HLS master playlist (not downloaded: no HLS in the core; only reported). */
  readonly hls?: string | undefined
  /**
   * A live stream on air (`live` 2, a live-only playlist) or one waiting to
   * start (flagged, no file yet). A finished stream's recording (`live` 3,
   * with its files) is a video like any other.
   */
  readonly live: boolean
  /** Played from another site (YouTube, Rutube…): VK has no file of it. */
  readonly external: boolean
}

const QUALITY_KEY = /^url(\d{3,4})$/

/**
 * The video of an act=show answer. The data's top level is scanned for the
 * object holding `player` (it has sat at index 4): O(d) for d items, then
 * O(k) over the player's k params.
 */
export function readVideo(data: readonly unknown[], oid: string, id: string): VkVideo {
  const holder = data.find(item => isObject(item) && isObject(item['player'])) as Json | undefined
  const player = holder?.['player'] as Json | undefined
  const params = Array.isArray(player?.['params']) ? (player!['params'] as unknown[])[0] : undefined
  if (!holder || !isObject(params)) {
    if (holder?.['player_unavailable']) throw new VkError('removed', 'VK has no player for this video.')
    throw new VkError('format-changed', 'VK video answer without its player data.')
  }
  const renditions: Rendition[] = []
  for (const [key, value] of Object.entries(params)) {
    const quality = QUALITY_KEY.exec(key)
    const href = text(value)
    if (!quality || !href || !/^https?:\/\//.test(href)) continue
    const resolution = Number(quality[1])
    renditions.push({codec: 'h264', width: 0, height: 0, resolution, bitrate: resolution, urls: [href]})
  }
  renditions.sort((a, b) => b.resolution - a.resolution)
  const live = num(params['live']) ?? 0
  const hls = text(params['hls']) ?? text(params['hls_fmp4'])
  return {
    oid: String(num(params['oid']) ?? oid),
    id: String(num(params['vid']) ?? id),
    title: plain(params['md_title']) ?? plain(data[0]),
    author: plain(params['md_author']),
    duration: num(params['duration']) || undefined,
    date: num(params['date']) || undefined,
    thumbnail: text(params['jpg']) ?? text(params['first_frame_800']),
    renditions,
    hls,
    live:
      live === 2 ||
      text(params['hls_live']) !== undefined ||
      text(params['live_mp4']) !== undefined ||
      (live > 0 && renditions.length === 0),
    external: typeof player?.['type'] === 'string' && player['type'] !== 'vk' && renditions.length === 0,
  }
}

// ─── the embedded player ────────────────────────────────────────────────────

const PREFETCH = '"apiPrefetchCache":'
const EMBED_QUALITY = /^mp4_(\d{3,4})$/

/**
 * The JSON value that starts at `from` in `text` (an array or an object),
 * found by matching brackets outside strings: one pass, O(n) for the n
 * characters scanned. Undefined when it doesn't close.
 */
export function jsonAt(text: string, from: number): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
      if (depth < 0) return undefined
    }
  }
  return undefined
}

/**
 * The video of the embed page (`video_ext.php?oid=&id=&hash=`), which an
 * embed of a hidden video opens with its hash. The page prefetches the API's
 * `video.get` for its player (`window.cur.apiPrefetchCache`): `files.mp4_144`…
 * `mp4_1080`, `hls`, the title, duration and date (no author). O(n) in the
 * page's length.
 */
export function readEmbed(html: string, oid: string, id: string): VkVideo {
  const at = html.indexOf(PREFETCH)
  const raw = at >= 0 ? jsonAt(html, at + PREFETCH.length) : undefined
  let cache: unknown
  try {
    cache = raw ? JSON.parse(raw) : undefined
  } catch {}
  if (!Array.isArray(cache)) {
    if (/video_ext_msg|This video is (?:private|unavailable)|has been deleted|was deleted/i.test(html)) {
      throw new VkError('removed', 'This embedded VK video is not available (removed, or the link is no longer valid).')
    }
    throw new VkError('format-changed', 'VK embed page without the player data where it used to be.')
  }
  const get = cache.find(entry => isObject(entry) && entry['method'] === 'video.get') as Json | undefined
  const response = get?.['response']
  const items = isObject(response) && Array.isArray(response['items']) ? response['items'] : undefined
  const item = items?.find(isObject)
  if (!item) {
    if (get && (items?.length === 0 || isObject(get['error'])))
      throw new VkError('removed', 'This embedded VK video is not available (removed, or the link is no longer valid).')
    throw new VkError('format-changed', 'VK embed page without the video where it used to be.')
  }
  const files = isObject(item['files']) ? item['files'] : {}
  const renditions: Rendition[] = []
  for (const [key, value] of Object.entries(files)) {
    const quality = EMBED_QUALITY.exec(key)
    const href = text(value)
    if (!quality || !href || !/^https?:\/\//.test(href)) continue
    const resolution = Number(quality[1])
    renditions.push({codec: 'h264', width: 0, height: 0, resolution, bitrate: resolution, urls: [href]})
  }
  renditions.sort((a, b) => b.resolution - a.resolution)
  const images = Array.isArray(item['image']) ? item['image'].filter(isObject) : []
  const status = text(item['live_status'])
  return {
    oid: String(num(item['owner_id']) ?? oid),
    id: String(num(item['id']) ?? id),
    title: plain(item['title']),
    duration: num(item['duration']) || undefined,
    date: num(item['date']) || undefined,
    thumbnail: text(images.at(-1)?.['url']),
    renditions,
    hls: text(files['hls']),
    live:
      status === 'started' ||
      status === 'upcoming' ||
      text(files['hls_live']) !== undefined ||
      text(files['live_mp4']) !== undefined ||
      (num(item['live']) === 1 && renditions.length === 0),
    external: text(files['external']) !== undefined && renditions.length === 0,
  }
}

// ─── listings ───────────────────────────────────────────────────────────────

export type ListedVideo = {
  readonly oid: string
  readonly id: string
  readonly title?: string | undefined
  readonly author?: string | undefined
  readonly duration?: number | undefined
  readonly date?: number | undefined
  readonly thumbnail?: string | undefined
  readonly clip: boolean
  /** The access key the entry's own link carries (a hidden video in an album). */
  readonly list?: string | undefined
}

export type ListingPage = {
  readonly videos: readonly ListedVideo[]
  /** Entries this page took up (the next offset is the current one plus this). */
  readonly count: number
  /** Videos in the whole section, as VK counts them. */
  readonly total?: number | undefined
  /** The album's name, when the answer lists the owner's albums. */
  readonly albumName?: string | undefined
}

/** The access key in an entry's path: `/video-1_2?list=<key>` or `/video-1_2_<key>`. */
const ENTRY_KEY =
  /^\/(?:video|clip)-?\d+_\d+(?:_([0-9a-f]{4,40})|\?(?:[^#]*&)?list=([0-9a-f]{4,40}|ln-[\da-zA-Z]{1,40}))/

const keyOf = (path: string): string | undefined => {
  const match = ENTRY_KEY.exec(path)
  return match?.[1] ?? match?.[2]
}

/**
 * One page of act=load_videos_silent for `section` (`all`, `album_<n>`).
 * Malformed entries are skipped; a page without the section is a changed
 * format. O(e) for e entries (plus O(a) over a albums when listed).
 */
export function readListing(data: readonly unknown[], section: string, oid: string, album: string): ListingPage {
  const sections = data[0]
  const block = isObject(sections) ? sections[section] : undefined
  if (!isObject(block) || !Array.isArray(block['list'])) {
    throw new VkError('format-changed', 'VK video listing without the list where it used to be.')
  }
  const list = block['list'] as unknown[]
  const videos: ListedVideo[] = []
  for (const entry of list) {
    if (!Array.isArray(entry)) continue
    const owner = num(entry[0])
    const vid = num(entry[1])
    if (owner === undefined || vid === undefined) continue
    const path = text(entry[20]) ?? ''
    videos.push({
      oid: String(owner),
      id: String(vid),
      title: plain(entry[3]),
      author: plain(entry[8]),
      date: num(entry[9]) || undefined,
      duration: num(entry[19]) || undefined,
      thumbnail: text(entry[2]),
      clip: path.startsWith('/clip'),
      list: keyOf(path),
    })
  }
  return {
    videos,
    count: num(block['count']) ?? list.length,
    total: num(block['total']),
    albumName: albumName(data[1], oid, album),
  }
}

/** An album's name from the albums an answer lists ([name, count, thumb, path, …]). O(a). */
function albumName(albums: unknown, oid: string, album: string): string | undefined {
  if (!Array.isArray(albums) || album === 'all') return undefined
  const path = `/video/playlist/${oid}_${album}`
  for (const entry of albums) {
    if (Array.isArray(entry) && (entry[3] === path || String(entry[6]) === album)) return plain(entry[0])
  }
  return undefined
}
