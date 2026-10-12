import * as path from 'node:path'
import {BrowserWindow, type Session, session} from 'electron'
import {type CookieRecord, keepDomains, toNetscape, writeJar, YOUTUBE_COOKIE_DOMAINS} from 'media-downloader-core'

/** The signed-in YouTube session lives here, inside the app — never in a browser's store or the Keychain. */
export const ACCOUNT_PARTITION = 'persist:youtube-account'
const SIGN_IN_URL =
  'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3D%252F'
/** A Google account signed in to YouTube carries these on youtube.com. */
const SIGNED_IN_COOKIES = new Set(['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'])

export type SignInResult = {readonly ok: true} | {readonly ok: false; readonly reason: 'closed' | 'refused'}

/**
 * The YouTube account the user may choose to sign in with, when YouTube keeps
 * refusing this connection. Only on the user's say-so: nothing here runs
 * until they ask. The session stays in the app's own partition; the engine
 * gets a cookies.txt with YouTube's and Google's cookies only.
 */
export class YouTubeAccount {
  readonly #jar: string

  constructor(dataDir: string) {
    this.#jar = path.join(dataDir, 'cookies', 'youtube-account.txt')
  }

  get #session(): Session {
    return session.fromPartition(ACCOUNT_PARTITION)
  }

  /** Signed in already (from an earlier sign-in): no window needed. */
  async signedIn(): Promise<boolean> {
    return isSignedIn(await this.#session.cookies.get({domain: 'youtube.com'}))
  }

  /**
   * Google's own sign-in page in a window the user sees, over `parent`. Ends
   * when YouTube's session cookies appear (signed in), or when the user closes
   * the window. Google may refuse to sign in inside an app; the page says so.
   */
  signIn(parent: BrowserWindow | undefined): Promise<SignInResult> {
    const ses = this.#session
    ses.setUserAgent(
      ses.getUserAgent().replace(/\s(?:Electron|media-download-core-app|Media Download Core)\/\S+/gi, ''),
    )
    const window = new BrowserWindow({
      width: 480,
      height: 680,
      show: false,
      ...(parent && {parent, modal: true}),
      title: 'YouTube',
      autoHideMenuBar: true,
      webPreferences: {session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false},
    })
    window.webContents.setWindowOpenHandler(({url}) => {
      // Google's own links (help, privacy) stay in this window
      void window.loadURL(url)
      return {action: 'deny'}
    })
    return new Promise<SignInResult>(resolve => {
      let settled = false
      const finish = (result: SignInResult) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        ses.cookies.off('changed', onCookie)
        if (!window.isDestroyed()) window.close()
        resolve(result)
      }
      const check = async () => {
        if (await this.signedIn()) finish({ok: true})
      }
      const onCookie = (_event: unknown, cookie: Electron.Cookie) => {
        if (SIGNED_IN_COOKIES.has(cookie.name) && /youtube\.com$/.test(cookie.domain ?? '')) void check()
      }
      ses.cookies.on('changed', onCookie)
      // the cookies event can be missed while the page redirects: check now and then too
      const poll = setInterval(() => void check(), 1500)
      window.on('closed', () => finish({ok: false, reason: 'closed'}))
      window.once('ready-to-show', () => window.show())
      void window.loadURL(SIGN_IN_URL).catch(() => finish({ok: false, reason: 'refused'}))
    })
  }

  /** The session as a cookies.txt (YouTube and Google only, this user only); its path. */
  async exportJar(): Promise<string> {
    const cookies = await this.#session.cookies.get({})
    await writeJar(this.#jar, keepDomains(toNetscape(cookies.map(toRecord)), YOUTUBE_COOKIE_DOMAINS))
    return this.#jar
  }

  /** Forget the account: its cookies, storage and the exported file. */
  async signOut(): Promise<void> {
    await this.#session.clearStorageData()
    await writeJar(this.#jar, toNetscape([]))
  }
}

export function isSignedIn(cookies: ReadonlyArray<{readonly name: string; readonly domain?: string}>): boolean {
  return cookies.some(c => SIGNED_IN_COOKIES.has(c.name) && /(^|\.)youtube\.com$/.test(c.domain ?? ''))
}

function toRecord(cookie: Electron.Cookie): CookieRecord {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? '',
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly,
    ...(cookie.expirationDate !== undefined && {expirationDate: cookie.expirationDate}),
  }
}
