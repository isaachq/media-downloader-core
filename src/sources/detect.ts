/**
 * Which site a pasted or shared link belongs to: the one box of every app
 * (desktop, Android) asks this before anything else, so the answer lives here
 * once instead of in each app. Plain regular expressions over the text, no
 * URL class: the Android renderer (Hermes) has none that parses. O(n) in the
 * length of the text, O(1) besides.
 */

/** The sites the engine reads natively or through yt-dlp; "web" is any other site. */
export type LinkSite =
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'facebook'
  | 'vk'
  | 'x'
  | 'snapchat'
  | 'threads'
  | 'bluesky'
  | 'web'
export const LINK_SITES: readonly LinkSite[] = [
  'youtube',
  'tiktok',
  'instagram',
  'facebook',
  'vk',
  'x',
  'snapchat',
  'threads',
  'bluesky',
  'web',
]

export type DetectedLink = {
  readonly site: LinkSite
  /** The link itself: out of the text it came in ("Look at this! https://…"), unwrapped from a tracker. */
  readonly url: string
  /** Its host, lower case, without "www.". */
  readonly host: string
  /** Its path ends in a video or audio file's extension: a link straight to the file. */
  readonly file: boolean
}

/** Each site's domains (a subdomain counts: m.vk.com, vm.tiktok.com). */
const DOMAINS: ReadonlyArray<readonly [Exclude<LinkSite, 'web'>, readonly string[]]> = [
  ['youtube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']],
  ['tiktok', ['tiktok.com']],
  ['instagram', ['instagram.com', 'instagr.am']],
  ['facebook', ['facebook.com', 'fb.watch', 'fb.com', 'fb.me', 'fb.gg']],
  ['vk', ['vk.com', 'vk.ru', 'vkvideo.ru', 'vk.cc', 'vkontakte.ru']],
  // the "fixer" hosts people share X posts through read as X too (XSource takes them)
  ['x', ['x.com', 'twitter.com', 't.co', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com']],
  // t.snapchat.com (short links) and story.snapchat.com are subdomains
  ['snapchat', ['snapchat.com']],
  // threads.net is the old host (a 301 to threads.com)
  ['threads', ['threads.com', 'threads.net']],
  // the web app (bsky.app); the AT Protocol API hosts are never pasted
  ['bluesky', ['bsky.app']],
]

/** The first http(s) link in a text; its end is the first space or quote. */
const LINK = /https?:\/\/[^\s"'<>]+/i
/** scheme, host (after an optional user@), :port, the rest. */
const PARTS = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)(:\d+)?(.*)$/i
const MEDIA_FILE = /^[^?#]*\.(mp4|m4v|mov|webm|mkv|m4a|mp3|opus|ogg|oga|flac|wav|aac)(?:[?#]|$)/i
/** Outbound wrappers that carry the real link in a parameter: l.instagram.com/?u=, l.facebook.com/l.php?u=. */
const WRAPPER = /^https?:\/\/(?:l|lm)\.(?:instagram|facebook)\.com\/(?:l\.php)?\?(?:[^#]*&)?u=([^&#]+)/i

const inDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/**
 * The link without the sentence's punctuation after it: "(see https://a/b_(c))"
 * keeps "b_(c)" and drops the last ")". One count, then the trailing marks
 * walked back once: O(n).
 */
function trimEnd(link: string): string {
  let open = 0
  let close = 0
  for (const char of link) {
    if (char === '(') open++
    else if (char === ')') close++
  }
  let end = link.length
  while (end > 0) {
    const char = link[end - 1]!
    if (char === ')' && close > open) close--
    else if (!'.,;:!?]'.includes(char)) break
    end--
  }
  return link.slice(0, end)
}

/** The real link inside an outbound wrapper, when it carries an http(s) one. */
function unwrap(link: string): string {
  const wrapped = WRAPPER.exec(link)?.[1]
  if (!wrapped) return link
  try {
    const target = decodeURIComponent(wrapped)
    return LINK.test(target) ? target : link
  } catch {
    return link
  }
}

/**
 * The link in `text` and its site; undefined when the text holds no http(s)
 * link. `aliases` maps more hosts ("host" or "host:port") to a site: the local fakes of tests.
 */
export function detectLink(text: string, aliases?: Readonly<Record<string, LinkSite>>): DetectedLink | undefined {
  const found = LINK.exec(text)?.[0]
  if (!found) return undefined
  const url = unwrap(trimEnd(found))
  const parts = PARTS.exec(url)
  if (!parts) return undefined
  const host = parts[1]!.toLowerCase().replace(/^www\./, '')
  const file = MEDIA_FILE.test(parts[3] ?? '')
  const alias = aliases?.[`${host}${parts[2] ?? ''}`] ?? aliases?.[host]
  if (alias) return {site: alias, url, host, file}
  for (const [site, domains] of DOMAINS) {
    if (domains.some(domain => inDomain(host, domain))) return {site, url, host, file}
  }
  return {site: 'web', url, host, file}
}
