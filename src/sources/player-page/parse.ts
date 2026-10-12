/**
 * Reading "player page" sites: listing pages (search results, categories,
 * channels) link to one page per video, and each video page embeds a player.
 * Plain string scanning, no DOM: one pass over a ~100 KB page takes well
 * under a millisecond, and nothing here depends on how the page is styled
 * beyond the few landmarks named below.
 */

/** Default path of a video page: `/video/<numeric id>/<slug>`. */
export const DEFAULT_VIDEO_PATH = '^/video/(\\d+)(?:/|$)'

export type ListedVideo = {
  readonly id: string
  readonly url: string
  readonly title?: string | undefined
  /** Seconds. */
  readonly duration?: number | undefined
  readonly thumbnail?: string | undefined
}

export type ListingPage = {
  /** In page order, each video once. */
  readonly videos: readonly ListedVideo[]
  /** Other pages of the same listing linked from this one: page number → url. */
  readonly pages: ReadonlyMap<number, string>
  readonly title?: string | undefined
}

export type VideoPage = {
  readonly title?: string | undefined
  /** Seconds. */
  readonly duration?: number | undefined
  readonly thumbnail?: string | undefined
  /** Heights the player offers (1080, 720…), best first; empty when the page doesn't say. */
  readonly heights: readonly number[]
  /** The page embeds a video player (a page without one has nothing to download). */
  readonly player: boolean
}

export type VideoPathMatcher = (url: URL) => string | undefined

/** `pattern`'s first group is the id; the url must be on one of `hosts`. */
export function videoMatcher(hosts: ReadonlySet<string>, pattern = DEFAULT_VIDEO_PATH): VideoPathMatcher {
  const path = new RegExp(pattern)
  return url => (hosts.has(url.hostname.toLowerCase()) ? path.exec(url.pathname)?.[1] : undefined)
}

const ANCHOR = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi
const CLOCK = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/

/**
 * Videos of one listing page and the links to its other pages.
 *
 * The results sit between the page heading (the first <h1>) and the
 * pagination; everything before the heading is the site's menu (it shows
 * featured videos on every page) and is skipped. Each result is usually two
 * links to the same video — the thumbnail (with its length) and the title —
 * merged by id.
 */
export function readListing(html: string, pageUrl: string, isVideo: VideoPathMatcher): ListingPage {
  const heading = html.indexOf('<h1')
  const start = heading === -1 ? Math.max(0, html.lastIndexOf('</nav>')) : heading
  const pagination = html.indexOf('class="pagination', start)
  const end = pagination === -1 ? html.length : pagination

  const byId = new Map<string, {-readonly [K in keyof ListedVideo]: ListedVideo[K]}>()
  ANCHOR.lastIndex = start
  for (let match = ANCHOR.exec(html); match && match.index < end; match = ANCHOR.exec(html)) {
    const url = absolute(match[1]!, pageUrl)
    const id = url && isVideo(url)
    if (!id) continue
    const close = html.indexOf('</a>', ANCHOR.lastIndex)
    const inner = html.slice(ANCHOR.lastIndex, close === -1 ? Math.min(end, ANCHOR.lastIndex + 4000) : close)
    const entry = byId.get(id) ?? {id, url: `${url.origin}${url.pathname}`}
    entry.title ??= titleIn(inner)
    entry.duration ??= durationIn(inner)
    const thumbnail = attribute(inner, 'img', 'src')
    entry.thumbnail ??= thumbnail && absolute(thumbnail, pageUrl)?.href
    byId.set(id, entry)
  }

  return {
    // only the fields the page gave (no undefined keys in what crosses IPC)
    videos: [...byId.values()].map(
      video => Object.fromEntries(Object.entries(video).filter(([, v]) => v !== undefined)) as ListedVideo,
    ),
    pages: pagesIn(html, end, pageUrl),
    title:
      textOf(between(html, '<h1', '</h1>')) ??
      metaContent(html, 'og:title') ??
      textOf(between(html, '<title', '</title>')),
  }
}

/** A video page: title, length, poster and the player's offered heights. */
export function readVideoPage(html: string): VideoPage {
  const duration =
    Number(metaContent(html, 'video:duration')) ||
    Number(/\bvideo_duration\s*=\s*["']?([\d.]+)/.exec(html)?.[1]) ||
    undefined
  const heights = new Set<number>()
  for (const match of html.matchAll(/["']res["']\s*:\s*["']?(\d{3,4})\b/g)) heights.add(Number(match[1]))
  return {
    title: metaContent(html, 'og:title') ?? textOf(between(html, '<title', '</title>')),
    duration: duration && duration > 0 ? duration : undefined,
    thumbnail: metaContent(html, 'og:image'),
    heights: [...heights].sort((a, b) => b - a),
    player: /<video[\s>]/i.test(html),
  }
}

/** The page number of a listing url (`?page=N`); 1 when absent. */
export function pageNumber(url: URL): number {
  const page = Number(url.searchParams.get('page'))
  return Number.isInteger(page) && page > 0 ? page : 1
}

/** The first page of the listing `url` belongs to (its `page` parameter dropped). */
export function firstPage(url: string): string {
  const first = new URL(url)
  first.searchParams.delete('page')
  first.hash = ''
  return first.href
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Links to other pages of the same listing (same path, a `page` number) after `from`. */
function pagesIn(html: string, from: number, pageUrl: string): Map<number, string> {
  const pages = new Map<number, string>()
  if (from >= html.length) return pages
  const base = new URL(pageUrl)
  ANCHOR.lastIndex = from
  // both pagination blocks (narrow and wide screens) sit within a few KB
  const limit = Math.min(html.length, from + 12_000)
  for (let match = ANCHOR.exec(html); match && match.index < limit; match = ANCHOR.exec(html)) {
    const url = absolute(match[1]!, pageUrl)
    if (!url || url.hostname !== base.hostname || url.pathname !== base.pathname || !url.searchParams.has('page'))
      continue
    pages.set(pageNumber(url), url.href)
  }
  return pages
}

function absolute(href: string, base: string): URL | undefined {
  const clean = decodeEntities(href.trim())
  if (!clean || clean.startsWith('#') || /^(javascript|mailto|data):/i.test(clean)) return undefined
  try {
    const url = new URL(clean, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** A result's title: its title element, else the thumbnail's title / alt text. */
function titleIn(inner: string): string | undefined {
  const marked = /class=["'][^"']*\b(?:content-)?title\b[^"']*["'][^>]*>([^<]+)</i.exec(inner)?.[1]
  return clean(marked) ?? clean(attribute(inner, 'img', 'title')) ?? clean(attribute(inner, 'img', 'alt'))
}

/** "49:22" / "1:02:03" in the result's duration element → seconds. */
function durationIn(inner: string): number | undefined {
  const at = inner.search(/class=["'][^"']*\bduration\b/i)
  if (at === -1) return undefined
  const clock = CLOCK.exec(inner.slice(at, at + 400).replace(/<[^>]*>/g, ' '))
  if (!clock) return undefined
  const seconds = Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
  return seconds > 0 ? seconds : undefined
}

function attribute(html: string, tag: string, name: string): string | undefined {
  const element = new RegExp(`<${tag}\\s[^>]*>`, 'i').exec(html)?.[0]
  const value = element && new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(element)?.[1]
  return value ? decodeEntities(value) : undefined
}

function metaContent(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tag = new RegExp(`<meta\\s[^>]*(?:property|name|itemprop)=["']${escaped}["'][^>]*>`, 'i').exec(html)?.[0]
  const value = tag && /\scontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
  return clean(value && decodeEntities(value))
}

function between(html: string, open: string, close: string): string | undefined {
  const start = html.indexOf(open)
  if (start === -1) return undefined
  const body = html.indexOf('>', start) + 1
  const end = html.indexOf(close, body)
  return end === -1 ? undefined : html.slice(body, end)
}

function textOf(fragment: string | undefined): string | undefined {
  return clean(fragment && decodeEntities(fragment.replace(/<[^>]*>/g, ' ')))
}

function clean(text: string | undefined): string | undefined {
  const value = text?.replace(/\s+/g, ' ').trim()
  return value || undefined
}

const NAMED: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? entity
    const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}
