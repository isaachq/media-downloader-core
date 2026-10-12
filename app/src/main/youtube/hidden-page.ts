import {type Session, session, WebContentsView} from 'electron'
import {isAttestationCall, isKey} from './page-key'

/**
 * A page the user never sees: an offscreen WebContentsView attached to no
 * window — nothing appears on screen, in the Dock or the taskbar, ever (a
 * hidden BrowserWindow is still a native window). Sandboxed, no Node, muted,
 * no pop-ups, no permissions, and no pictures, video or fonts: the scripts and
 * the document are all a check needs.
 */
export class HiddenPage {
  readonly #view: WebContentsView
  #closed = false

  private constructor(view: WebContentsView) {
    this.#view = view
  }

  /** Open `url` in a hidden page of `partition` (prepared once per partition). */
  static async open(partition: string, url: string, signal?: AbortSignal): Promise<HiddenPage> {
    const view = new WebContentsView({
      webPreferences: {
        session: prepare(partition),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false,
      },
    })
    const contents = view.webContents
    hidden.set(contents.id, [])
    contents.once('destroyed', () => {
      hidden.delete(contents.id)
      seenKeys.delete(contents.id)
      ours.delete(contents.id)
    })
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({action: 'deny'}))
    // a page asking to stay ("leave site?") never gets a dialog: it just goes
    contents.on('will-prevent-unload', event => event.preventDefault())
    const page = new HiddenPage(view)
    try {
      await abortable(contents.loadURL(url), signal)
    } catch (error) {
      page.close()
      throw error
    }
    return page
  }

  /** The scripts the page loaded, in order (at most MAX_SCRIPTS): where its own code can be read. */
  get scripts(): readonly string[] {
    return hidden.get(this.#view.webContents.id) ?? []
  }

  /** The attestation key the page's own code sent (read from its request headers), if it sent one yet. */
  get seenKey(): string | undefined {
    return seenKeys.get(this.#view.webContents.id)
  }

  /** Run `task` as this app's own calls: their headers are not the page's, so none is learned from them. */
  async asOurs<T>(task: () => Promise<T>): Promise<T> {
    const id = this.#view.webContents.id
    ours.add(id)
    try {
      return await task()
    } finally {
      ours.delete(id)
    }
  }

  get session(): Session {
    return this.#view.webContents.session
  }

  get closed(): boolean {
    return this.#closed || this.#view.webContents.isDestroyed()
  }

  /** Run `code` in the page's own world (where its scripts and globals live). */
  run<T>(code: string, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The page is closed.'))
    return abortable(this.#view.webContents.executeJavaScript(code, true) as Promise<T>, signal)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (!this.#view.webContents.isDestroyed()) this.#view.webContents.close()
  }
}

const prepared = new Set<string>()
/**
 * The hidden pages' contents → the scripts each loaded. The filters below apply
 * to them only (a sign-in window shares a partition).
 */
const hidden = new Map<number, string[]>()
const MAX_SCRIPTS = 200
/** The key each page's own attestation calls carried. */
const seenKeys = new Map<number, string>()
/** Pages running this app's calls right now (see asOurs). */
const ours = new Set<number>()

/** The partition's session, set up once: a plain Chrome user agent, no permissions; hidden pages load nothing heavy. */
function prepare(partition: string): Session {
  const ses = partition.startsWith('persist:')
    ? session.fromPartition(partition)
    : session.fromPartition(partition, {cache: false})
  if (prepared.has(partition)) return ses
  prepared.add(partition)
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|media-download-core-app|Media Download Core)\/\S+/gi, ''))
  ses.webRequest.onBeforeRequest((details, callback) => {
    const scripts = details.webContentsId === undefined ? undefined : hidden.get(details.webContentsId)
    if (scripts && details.resourceType === 'script' && scripts.length < MAX_SCRIPTS) scripts.push(details.url)
    callback({cancel: scripts !== undefined && ['image', 'media', 'font'].includes(details.resourceType)})
  })
  // what YouTube's own client sends its attestation calls with: learned for free, nothing fetched
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const id = details.webContentsId
    if (id !== undefined && hidden.has(id) && !ours.has(id) && isAttestationCall(details.url)) {
      const header = Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === 'x-goog-api-key')
      if (isKey(header?.[1])) seenKeys.set(id, header[1])
    }
    callback({requestHeaders: details.requestHeaders})
  })
  // camera, notifications, location…: nothing a check or a sign-in needs
  ses.setPermissionRequestHandler((_contents, _permission, done) => done(false))
  return ses
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, {once: true})
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
