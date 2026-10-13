import {BrowserWindow, type Session, session} from 'electron'
import type {BrowserAssist, BrowserPage} from 'media-downloader-core'
import {within} from './player-browser'

/** How long a page may take to load and run its own checks. */
const PAGE_TIMEOUT_MS = 25_000
const POLL_MS = 250
/** Once loaded, a moment for the page's scripts to settle (a check may reload it). */
const SETTLE_MS = 1500
/** The hidden window is kept for the next page, then released. */
const IDLE_CLOSE_MS = 60_000

/**
 * Instagram / Facebook pages through the app's own Chromium, for when the
 * site answers plain requests with a page its own script must run first: in
 * a real browser it runs by itself, as when you open the site. The window is
 * hidden, sandboxed, without Node, muted, loads no images, video or fonts,
 * stays on the site's hosts and uses an in-memory session of its own. Nothing
 * here solves a captcha or signs in: a login or verification page is returned
 * as it is and the library steps aside (yt-dlp takes over for a while).
 */
export function createMetaBrowser(
  partition: string,
  hosts: readonly string[],
): {readonly render: BrowserAssist; close(): void} {
  const onSite = (url: string) => {
    try {
      const host = new URL(url).hostname.toLowerCase()
      return hosts.some(domain => host === domain || host.endsWith(`.${domain}`))
    } catch {
      return false
    }
  }
  let ses: Session | undefined
  let win: BrowserWindow | undefined
  let idle: NodeJS.Timeout | undefined

  const prepare = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win
    ses ??= (() => {
      const own = session.fromPartition(partition, {cache: false})
      // a plain Chrome user agent (no "Electron/…" token), as a regular visit would send
      own.setUserAgent(own.getUserAgent().replace(/\s(?:Electron|media-download-core-app)\/\S+/g, ''))
      own.webRequest.onBeforeRequest((details, callback) => {
        callback({cancel: ['image', 'media', 'font'].includes(details.resourceType)})
      })
      own.setPermissionRequestHandler((_wc, _permission, done) => done(false))
      return own
    })()
    win = new BrowserWindow({
      show: false,
      webPreferences: {session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false},
    })
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
    win.webContents.on('will-navigate', (event, url) => {
      if (!onSite(url)) event.preventDefault()
    })
    return win
  }

  const close = () => {
    clearTimeout(idle)
    if (win && !win.isDestroyed()) win.destroy()
    win = undefined
  }

  const render: BrowserAssist = async (url, signal) => {
    if (!onSite(url)) throw new Error(`Not a page of ${hosts[0]}: ${url}`)
    clearTimeout(idle)
    const page = prepare()
    // a cancel stops this page only; the window stays for the next one
    const abort = () => {
      if (!page.isDestroyed()) page.webContents.stop()
    }
    signal?.addEventListener('abort', abort, {once: true})
    try {
      await within(page.loadURL(url), PAGE_TIMEOUT_MS, undefined)
      const deadline = Date.now() + PAGE_TIMEOUT_MS
      while (Date.now() < deadline && !signal?.aborted && !page.isDestroyed()) {
        const ready = await within(
          page.webContents.executeJavaScript('document.readyState === "complete"'),
          3000,
          false,
        )
        if (ready) break
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
      }
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
      signal?.throwIfAborted()
      if (page.isDestroyed()) throw new Error('The page window was closed.')
      const html: string = await within(
        page.webContents.executeJavaScript('document.documentElement.outerHTML'),
        10_000,
        '',
      )
      if (!html) throw new Error('The page did not answer.')
      const cookies = await ses!.cookies.get({url: `https://${hosts[0]}`})
      const result: BrowserPage = {
        html,
        userAgent: page.webContents.getUserAgent(),
        cookies: cookies.map(c => ({name: c.name, value: c.value, domain: c.domain ?? hosts[0]!})),
      }
      return result
    } finally {
      signal?.removeEventListener('abort', abort)
      idle = setTimeout(close, IDLE_CLOSE_MS)
      idle.unref()
    }
  }

  return {render, close}
}
