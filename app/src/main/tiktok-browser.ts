import {BrowserWindow, type Session, session} from 'electron'
import type {BrowserAssist, BrowserPage} from 'media-downloader-core'
import {within} from './player-browser'

/** How long a page may take to pass TikTok's check and show its data. */
const PAGE_TIMEOUT_MS = 25_000
const POLL_MS = 250
/** The hidden window is kept for the next page, then released. */
const IDLE_CLOSE_MS = 60_000
const DATA_SCRIPT = '__UNIVERSAL_DATA_FOR_REHYDRATION__'

/**
 * TikTok pages through the app's own Chromium, for when TikTok answers plain
 * requests with its "please wait" check: in a real browser TikTok's script
 * runs and passes by itself, like when you open the site. The window is
 * hidden, sandboxed, without Node, muted, loads no images or video, stays on
 * tiktok.com, and uses an in-memory session of its own. Nothing here solves a
 * captcha: if the data never shows up, the page is returned as is and the
 * library treats it as a challenge.
 */
export function createTikTokBrowser(origin = 'https://www.tiktok.com'): {
  readonly render: BrowserAssist
  close(): void
} {
  const allowed = new URL(origin).hostname
  const onTikTok = (url: string) => {
    try {
      const host = new URL(url).hostname
      return host === allowed || host.endsWith('.tiktok.com') || host === 'tiktok.com'
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
      const own = session.fromPartition('tiktok-reader', {cache: false})
      // a plain Chrome user agent (no "Electron/…" token), as a regular visit would send
      own.setUserAgent(own.getUserAgent().replace(/\s(?:Electron|media-download-core-app)\/\S+/g, ''))
      // the check only needs scripts and the document: no pictures, video or fonts
      own.webRequest.onBeforeRequest((details, callback) => {
        callback({cancel: ['image', 'media', 'font'].includes(details.resourceType)})
      })
      own.setPermissionRequestHandler((_wc, _permission, done) => done(false))
      return own
    })()
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
    win.webContents.on('will-navigate', (event, url) => {
      if (!onTikTok(url)) event.preventDefault()
    })
    return win
  }

  const close = () => {
    clearTimeout(idle)
    if (win && !win.isDestroyed()) win.destroy()
    win = undefined
  }

  const render: BrowserAssist = async (url, signal) => {
    if (!onTikTok(url)) throw new Error(`Not a TikTok page: ${url}`)
    clearTimeout(idle)
    const page = prepare()
    // a cancel stops this page only: the window (and its session) stays for the next one
    const abort = () => {
      if (!page.isDestroyed()) page.webContents.stop()
    }
    signal?.addEventListener('abort', abort, {once: true})
    try {
      await within(page.loadURL(url), PAGE_TIMEOUT_MS, undefined) // the check reloads the page: the first load may be superseded
      const deadline = Date.now() + PAGE_TIMEOUT_MS
      let ready = false
      while (!ready && Date.now() < deadline && !signal?.aborted && !page.isDestroyed()) {
        ready = await within(
          page.webContents.executeJavaScript(`Boolean(document.getElementById(${JSON.stringify(DATA_SCRIPT)}))`),
          3000,
          false,
        )
        if (!ready) await new Promise(resolve => setTimeout(resolve, POLL_MS))
      }
      signal?.throwIfAborted()
      const html: string = await within(
        page.webContents.executeJavaScript('document.documentElement.outerHTML'),
        10_000,
        '',
      )
      if (!html) throw new Error('The page did not answer.')
      const cookies = await ses!.cookies.get({url: origin})
      const result: BrowserPage = {
        html,
        userAgent: page.webContents.getUserAgent(),
        cookies: cookies.map(c => ({name: c.name, value: c.value, domain: c.domain ?? allowed})),
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
