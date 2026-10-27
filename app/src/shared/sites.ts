// The supported sites, once: what each one is, how it is read, whether it needs the user's
// session and whether the Android app has it. The app's panel and the line under a pasted
// link, the README's table and the website's (scripts/build-site.mjs) all come from here;
// their words, in every language, from site-words.ts.
import type {LinkSite} from 'media-downloader-core/detect'

/** What a tag names: a site, or a link straight to a media file of any other site. */
export type SiteLabel = LinkSite | 'file'

/** The sites where some content needs the user's own session. */
export type SignInSite = 'youtube' | 'instagram' | 'facebook' | 'vk' | 'threads' | 'twitch' | 'web'

export interface SupportedSite {
  readonly site: SiteLabel
  /** The brand as written everywhere; `web` and `file` have translated names instead. */
  readonly brand?: string
  /** `native`: the library reads it itself; `yt-dlp`: handed to yt-dlp (desktop only). */
  readonly engine: 'native' | 'yt-dlp'
  /** Whether some of its content needs the user's session (what, in site-words.ts). */
  readonly signIn: boolean
  /** Whether the Android app reads it (no yt-dlp on the phone). */
  readonly phone: boolean
}

/** In the order the panel and the tables show them: the busiest first, the catch-alls last. */
export const SITES: readonly SupportedSite[] = [
  {site: 'youtube', brand: 'YouTube', engine: 'yt-dlp', signIn: true, phone: false},
  {site: 'tiktok', brand: 'TikTok', engine: 'native', signIn: false, phone: true},
  {site: 'instagram', brand: 'Instagram', engine: 'native', signIn: true, phone: true},
  {site: 'facebook', brand: 'Facebook', engine: 'native', signIn: true, phone: true},
  {site: 'twitch', brand: 'Twitch', engine: 'native', signIn: true, phone: true},
  {site: 'soundcloud', brand: 'SoundCloud', engine: 'native', signIn: false, phone: true},
  {site: 'x', brand: 'X', engine: 'native', signIn: false, phone: true},
  {site: 'threads', brand: 'Threads', engine: 'native', signIn: true, phone: true},
  {site: 'bluesky', brand: 'Bluesky', engine: 'native', signIn: false, phone: true},
  {site: 'snapchat', brand: 'Snapchat', engine: 'native', signIn: false, phone: true},
  {site: 'vk', brand: 'VK', engine: 'native', signIn: true, phone: true},
  {site: 'web', engine: 'yt-dlp', signIn: true, phone: false},
  {site: 'file', engine: 'native', signIn: false, phone: true},
]

/** One site's facts: O(1), the table is built once. */
export const SITE_BY_LABEL: Readonly<Record<SiteLabel, SupportedSite>> = Object.fromEntries(
  SITES.map(entry => [entry.site, entry]),
) as Record<SiteLabel, SupportedSite>
