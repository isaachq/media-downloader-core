/**
 * A real browser, supplied by the host app (Electron has one built in), for
 * pages a site only serves after its own JavaScript has run — e.g. TikTok's
 * "please wait" check, which any browser passes by itself. The library never
 * runs or solves that code; it asks the browser for the finished page and
 * adopts the browser's session (cookies + user agent) for its own requests.
 */
export type BrowserPage = {
  /** The page as the browser ended up with it. */
  readonly html: string
  readonly cookies: ReadonlyArray<{readonly name: string; readonly value: string; readonly domain: string}>
  readonly userAgent: string
}

export type BrowserAssist = (url: string, signal?: AbortSignal) => Promise<BrowserPage>

/**
 * The media link a page's own player ends up with, read by a real browser:
 * for sites that only reveal it to their player's script. The library never
 * runs or reimplements that script; it asks the browser what the <video>
 * element was given, and continues with the browser's session over HTTP.
 */
export type PlayerMedia = {
  readonly url: string
  readonly cookies: BrowserPage['cookies']
  readonly userAgent: string
}

export type MediaResolver = (pageUrl: string, signal?: AbortSignal) => Promise<PlayerMedia>
