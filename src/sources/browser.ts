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
