import {BrowserWindow, type Session, session} from 'electron'
import type {MediaResolver, PlayerMedia} from 'media-downloader-core'

/** How long a page's player may take to be given its media. */
const PAGE_TIMEOUT_MS = 20_000
const POLL_MS = 100
/** Windows are kept for the next page, then released. */
const IDLE_CLOSE_MS = 60_000
/** Pages read at once: each lookup is one short page load. */
const WINDOWS = 2
/** One look into the page: a page that is busy (or stuck) must not stop the lookup's clock. */
const PROBE_MS = 3000

/** `promise`, or `fallback` after `ms` — whichever comes first (the promise is not waited for). */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

/** Media requests and heavy page parts a player lookup never needs. */
const NEVER = new Set(['image', 'media', 'font', 'stylesheet', 'subFrame', 'object', 'ping', 'cspReport'])

/**
 * The first http(s) media url a <video> on the page was given (by its own
 * player script), or what is still missing. Runs in the page; reads only.
 */
const PROBE = `(() => {
  for (const video of document.querySelectorAll('video')) {
    const sources = [video.currentSrc, video.getAttribute('src'), ...[...video.querySelectorAll('source')].map(s => s.getAttribute('src'))]
    for (const src of sources) {
      const url = (src || '').trim()
      if (/^https?:\\/\\//i.test(url)) return {url}
    }
  }
  return {href: location.href, ready: document.readyState === 'complete', video: document.querySelector('video') !== null}
})()`

type Probe = {readonly url?: string; readonly href?: string; readonly ready?: boolean; readonly video?: boolean}

/**
 * Player-page sites through the app's own Chromium: a hidden window opens a
 * video page, the site's player script runs as on any visit, and the link it
 * gives the <video> element is read — nothing is decoded or solved here. The
 * windows are sandboxed, without Node, muted, load no images, video, fonts,
 * styles or frames, accept nothing from other sites but scripts, open no
 * pop-ups, stay on the configured hosts and use an in-memory session.
 */
export function createPlayerBrowser(hosts: readonly string[]): {readonly resolve: MediaResolver; close(): void} {
  const allowed = new Set(
    hosts.flatMap(host => [host.toLowerCase(), `www.${host.toLowerCase().replace(/^www\./, '')}`]),
  )
  const onSite = (url: string) => {
    try {
      return allowed.has(new URL(url).hostname.toLowerCase())
    } catch {
      return false
    }
  }
  let ses: Session | undefined
  const idle: BrowserWindow[] = []
  const all = new Set<BrowserWindow>()
  const waiting: Array<(win: BrowserWindow) => void> = []
  let idleTimer: NodeJS.Timeout | undefined

  const ownSession = (): Session => {
    if (ses) return ses
    ses = session.fromPartition('player-reader', {cache: false})
    // a plain Chrome user agent (no "Electron/…" token), as a regular visit would send
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|media-download-core-app)\/\S+/g, ''))
    ses.webRequest.onBeforeRequest((details, callback) => {
      const heavy = NEVER.has(details.resourceType)
      // from other sites only scripts (the player's libraries on public CDNs)
      const foreign = !onSite(details.url) && details.resourceType !== 'script'
      callback({cancel: heavy || foreign})
    })
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false))
    return ses
  }

  const open = (): BrowserWindow => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ownSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    win.webContents.setAudioMuted(true)
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}))
    win.webContents.on('will-navigate', (event, url) => {
      if (!onSite(url)) event.preventDefault()
    })
    win.on('closed', () => {
      all.delete(win)
      const at = idle.indexOf(win)
      if (at !== -1) idle.splice(at, 1)
    })
    all.add(win)
    return win
  }

  /** A window for one lookup: a free one, a new one, or the next one released — unless the lookup is cancelled first. */
  const acquire = (signal?: AbortSignal): Promise<BrowserWindow> => {
    clearTimeout(idleTimer)
    let free = idle.pop()
    while (free?.isDestroyed()) free = idle.pop()
    if (free) return Promise.resolve(free)
    if (all.size < WINDOWS) return Promise.resolve(open())
    return new Promise((resolve, reject) => {
      const take = (win: BrowserWindow) => {
        signal?.removeEventListener('abort', leave)
        resolve(win)
      }
      // a cancelled lookup leaves the line: it never takes (and holds) a window it no longer needs
      const leave = () => {
        const at = waiting.indexOf(take)
        if (at !== -1) waiting.splice(at, 1)
        reject(signal?.reason ?? new Error('Cancelled.'))
      }
      signal?.addEventListener('abort', leave, {once: true})
      waiting.push(take)
    })
  }

  const release = (win: BrowserWindow) => {
    if (win.isDestroyed()) {
      // a destroyed window frees its slot: the next caller gets a new one
      waiting.shift()?.(open())
    } else {
      // stop the page (ads, timers) while the window waits for the next one
      void win.webContents.loadURL('about:blank').catch(() => {})
      const next = waiting.shift()
      if (next) next(win)
      else idle.push(win)
    }
    if (waiting.length === 0 && idle.length === all.size) {
      idleTimer = setTimeout(close, IDLE_CLOSE_MS)
      idleTimer.unref()
    }
  }

  const close = () => {
    clearTimeout(idleTimer)
    for (const win of [...all]) if (!win.isDestroyed()) win.destroy()
    all.clear()
    idle.length = 0
  }

  const resolve: MediaResolver = async (pageUrl, signal) => {
    if (!onSite(pageUrl)) throw new Error('Not a page of a configured site.')
    signal?.throwIfAborted()
    const win = await acquire(signal)
    const abort = () => {
      if (!win.isDestroyed()) win.destroy()
    }
    signal?.addEventListener('abort', abort, {once: true})
    try {
      // not awaited: the load event waits for every ad; the player is usually ready long before
      void win.loadURL(pageUrl).catch(() => {})
      const deadline = Date.now() + PAGE_TIMEOUT_MS
      while (Date.now() < deadline) {
        signal?.throwIfAborted()
        if (win.isDestroyed()) throw new Error('The page window was closed.')
        const probe: Probe = await within(win.webContents.executeJavaScript(PROBE), PROBE_MS, {})
        if (probe.url) {
          const cookies = await within(ownSession().cookies.get({url: pageUrl}), PROBE_MS, [])
          const media: PlayerMedia = {
            url: probe.url,
            userAgent: win.webContents.getUserAgent(),
            cookies: cookies.map(c => ({name: c.name, value: c.value, domain: c.domain ?? new URL(pageUrl).hostname})),
          }
          return media
        }
        // judged only once the site's page (not the blank one before it) has fully loaded
        if (probe.ready && !probe.video && probe.href && onSite(probe.href)) {
          throw new Error('The page has no video player.')
        }
        await new Promise(done => setTimeout(done, POLL_MS))
      }
      throw new Error(`The page's player gave no video link within ${PAGE_TIMEOUT_MS / 1000} s.`)
    } finally {
      signal?.removeEventListener('abort', abort)
      release(win)
    }
  }

  return {resolve, close}
}
