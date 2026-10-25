/**
 * The links a pasted text holds, as a mix list: every link once, in the order
 * pasted, each with its site — and what was left out (a line with no link, a
 * repeat). Pure and local, like `detectLink` (regular expressions, no URL
 * class, no Node built-ins), so a renderer — Electron's or Hermes on Android —
 * shows the list the moment it is pasted, before the engine checks anything.
 * O(n) in the length of the text: one pass per line, one Set lookup per link.
 */
import {detectLink, type LinkSite} from './detect.js'

/**
 * Links one mix list takes; the rest are left out ('too-many'). The same
 * ceiling as a list's entries (MAX_LISTED_ITEMS): one mix list is one batch.
 */
export const MIX_MAX_LINKS = 5000

/** Characters of a line kept to say what it was ('not-a-link'): a pasted paragraph is not echoed whole. */
const ECHO_CHARS = 200

export type MixLink = {
  /** 1-based line of the text the link was on. */
  readonly line: number
  /** The link, out of the text around it and unwrapped from a tracker (see `detectLink`). */
  readonly url: string
  readonly site: LinkSite
  readonly host: string
  /** A link straight to a video or audio file. */
  readonly file: boolean
  /** What makes two links the same link (see `linkKey`). */
  readonly key: string
}

/** Why the text left something out, before anything is checked on the network. */
export type MixPlanSkip = 'not-a-link' | 'duplicate' | 'too-many'

export type MixPlanSkipped = {
  readonly line: number
  /** The link, or the line's text (its first 200 characters) when it holds none. */
  readonly input: string
  readonly site?: LinkSite | undefined
  readonly reason: MixPlanSkip
  /** 'duplicate': the line of the link it repeats. */
  readonly duplicateOf?: number | undefined
}

export type MixPlan = {
  readonly links: readonly MixLink[]
  readonly skipped: readonly MixPlanSkipped[]
}

export type MixPlanOptions = {
  /** More hosts for a site ("host" or "host:port"): the local fakes of tests (see `detectLink`). */
  readonly aliases?: Readonly<Record<string, LinkSite>> | undefined
  /** Links taken at most (1–5000). Default MIX_MAX_LINKS. */
  readonly maxLinks?: number | undefined
}

/** Every http(s) run in a line; "a,https://b" is two links (a comma-separated paste). */
const LINKS = /https?:\/\/[^\s"'<>]+/gi
const BEFORE_NEXT_LINK = /,(?=https?:\/\/)/i
const PARTS = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)(:\d+)?([^?#]*)(\?[^#]*)?/i

/**
 * Query parameters that only say who shared a link or how: a link with them is
 * the same link without them. utm_* goes by its prefix.
 */
const TRACKING: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'igsh',
  'igshid',
  'mibextid',
  'si',
  'feature',
  'ref_src',
  'ref_url',
  'rdid',
  'share_url',
])

/** Sites whose links carry the post in the path: their query is only tracking (?s=20, ?igsh=, ?_r=1&_t=…). */
const PATH_IDENTIFIED: ReadonlySet<LinkSite> = new Set(['tiktok', 'instagram', 'x'])

/**
 * What makes two links the same link, without asking the site: scheme, a
 * "www." / mobile host prefix, a trailing slash, the fragment and tracking
 * parameters don't count; the remaining parameters count in any order.
 * Links that differ more (a short link and the link it opens, youtu.be and
 * youtube.com) are found the same once checked — by the media they name
 * (`MediaDownloader.analyzeMix`). O(length).
 */
export function linkKey(url: string, site?: LinkSite): string {
  const parts = PARTS.exec(url)
  if (!parts) return url
  let host = parts[1]!.toLowerCase().replace(/^www\./, '')
  // m.facebook.com, mobile.twitter.com: the same post as on the desktop host (only for the sites the engine reads)
  if (site !== undefined && site !== 'web') host = host.replace(/^(?:m|mobile)\./, '')
  const port = parts[2] ?? ''
  const path = (parts[3] ?? '').replace(/\/+$/, '')
  if (site !== undefined && PATH_IDENTIFIED.has(site)) return `${host}${port}${path}`
  const params = (parts[4] ?? '')
    .slice(1)
    .split('&')
    .filter(param => {
      if (!param) return false
      const name = param.split('=', 1)[0]!.toLowerCase()
      return !TRACKING.has(name) && !name.startsWith('utm_')
    })
    .sort()
  return `${host}${port}${path}${params.length ? `?${params.join('&')}` : ''}`
}

/** The link-looking runs of one line, split where a comma runs into the next link. */
function* runsOf(line: string): Generator<string> {
  for (const match of line.matchAll(LINKS)) yield* match[0].split(BEFORE_NEXT_LINK)
}

/**
 * The links of a pasted text (or of a list of texts, one per line), each
 * once, in order, with their site; and what was left out — a line with no
 * link, a link already in the list, links past `maxLinks`. A line may hold
 * several links ("a b", "a,b") or a link inside a sentence. O(n) in the text.
 */
export function planMix(input: string | readonly string[], options: MixPlanOptions = {}): MixPlan {
  const max = Math.max(1, Math.min(MIX_MAX_LINKS, Math.floor(options.maxLinks ?? MIX_MAX_LINKS)))
  const lines = typeof input === 'string' ? input.split(/\r\n|\r|\n/) : input
  const links: MixLink[] = []
  const skipped: MixPlanSkipped[] = []
  /** key → line of its first link: O(1) per link. */
  const seen = new Map<string, number>()
  lines.forEach((text, offset) => {
    const line = offset + 1
    let found = false
    for (const run of runsOf(text)) {
      const link = detectLink(run, options.aliases)
      if (!link) continue
      found = true
      const key = linkKey(link.url, link.site)
      const first = seen.get(key)
      if (first !== undefined) {
        skipped.push({line, input: link.url, site: link.site, reason: 'duplicate', duplicateOf: first})
        continue
      }
      seen.set(key, line)
      if (links.length >= max) {
        skipped.push({line, input: link.url, site: link.site, reason: 'too-many'})
        continue
      }
      links.push({line, url: link.url, site: link.site, host: link.host, file: link.file, key})
    }
    const rest = text.trim()
    if (!found && rest) skipped.push({line, input: rest.slice(0, ECHO_CHARS), reason: 'not-a-link'})
  })
  return {links, skipped}
}
