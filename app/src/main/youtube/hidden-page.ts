import {type Session, session, WebContentsView} from 'electron'

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
    hidden.add(contents.id)
    contents.once('destroyed', () => hidden.delete(contents.id))
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
/** The hidden pages' contents: the filters below apply to them only (a sign-in window shares a partition). */
const hidden = new Set<number>()

/** The partition's session, set up once: a plain Chrome user agent, no permissions; hidden pages load nothing heavy. */
function prepare(partition: string): Session {
  const ses = partition.startsWith('persist:')
    ? session.fromPartition(partition)
    : session.fromPartition(partition, {cache: false})
  if (prepared.has(partition)) return ses
  prepared.add(partition)
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|media-download-core-app|Media Download Core)\/\S+/gi, ''))
  ses.webRequest.onBeforeRequest((details, callback) => {
    const mine = details.webContentsId !== undefined && hidden.has(details.webContentsId)
    callback({cancel: mine && ['image', 'media', 'font'].includes(details.resourceType)})
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
