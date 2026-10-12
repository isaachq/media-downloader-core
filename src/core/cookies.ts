import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {type Executable, invoke} from '../binaries/executable.js'
import {cancelledError, classifyYtDlpError, DownloadError} from './errors.js'
import {writeAtomic} from './files.js'

/**
 * Cookies for yt-dlp as a Netscape cookies.txt, read once and copied per run.
 *
 * Reading a browser's cookies is the expensive, intrusive part: on macOS each
 * read asks the Keychain for the browser's key — one system prompt per yt-dlp
 * process when every run read them itself. A jar is read once (then again only
 * when it is old) and every run gets a private copy of it: yt-dlp writes its
 * jar back to that file when it exits, and runs writing one shared file at the
 * same time could tear it. A copy is O(size) — kilobytes.
 */
export type CookieRecord = {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path?: string | undefined
  readonly secure?: boolean | undefined
  readonly httpOnly?: boolean | undefined
  /** Unix seconds; absent for a session cookie. */
  readonly expirationDate?: number | undefined
  /** Only this exact host (no subdomains). */
  readonly hostOnly?: boolean | undefined
}

const HEADER = '# Netscape HTTP Cookie File\n# Written by media-downloader-core. Private: a signed-in session.\n\n'

/** Cookies → cookies.txt, O(n). Cookies yt-dlp could not read back (tabs, newlines) are left out. */
export function toNetscape(cookies: Iterable<CookieRecord>): string {
  const lines: string[] = []
  for (const c of cookies) {
    if (/[\t\r\n]/.test(c.name + c.value + c.domain + (c.path ?? ''))) continue
    const host = c.domain.replace(/^\./, '')
    const domain = c.hostOnly ? host : `.${host}`
    lines.push(
      [
        `${c.httpOnly ? '#HttpOnly_' : ''}${domain}`,
        c.hostOnly ? 'FALSE' : 'TRUE',
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        String(Math.max(0, Math.floor(c.expirationDate ?? 0))),
        c.name,
        c.value,
      ].join('\t'),
    )
  }
  return `${HEADER}${lines.join('\n')}${lines.length ? '\n' : ''}`
}

/** Only the cookies of these domains (and their subdomains), O(lines). */
export function keepDomains(netscape: string, domains: readonly string[]): string {
  const wanted = domains.map(d => d.replace(/^\./, '').toLowerCase())
  const kept: string[] = []
  for (const line of netscape.split(/\r?\n/)) {
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue
    const host = (line.split('\t', 1)[0] ?? '')
      .replace(/^#HttpOnly_/, '')
      .replace(/^\./, '')
      .toLowerCase()
    if (wanted.some(d => host === d || host.endsWith(`.${d}`))) kept.push(line)
  }
  return `${HEADER}${kept.join('\n')}${kept.length ? '\n' : ''}`
}

/** The cookies a YouTube session needs: youtube.com and the Google account domain. */
export const YOUTUBE_COOKIE_DOMAINS: readonly string[] = ['youtube.com', 'google.com']

/** Write a jar only this user may read. */
export async function writeJar(file: string, netscape: string): Promise<void> {
  await writeAtomic(file, netscape)
  await fs.chmod(file, 0o600).catch(() => {}) // POSIX; on Windows the user's profile folder is already private
}

/**
 * Read a browser's cookies once through yt-dlp (it knows every browser's
 * store and encryption) into `dest`. yt-dlp loads the browser's cookies and
 * saves its jar on exit; the run itself is a no-op on a url that needs no
 * network. Throws `cookies-unreadable` when the browser's cookies can't be read.
 */
export async function exportBrowserCookies(opts: {
  readonly ytDlp: Executable
  readonly env: NodeJS.ProcessEnv
  readonly browser: string
  readonly dest: string
  readonly signal?: AbortSignal | undefined
}): Promise<void> {
  await fs.mkdir(path.dirname(opts.dest), {recursive: true})
  const raw = `${opts.dest}.${process.pid}.export`
  try {
    const result = await invoke(
      opts.ytDlp,
      [
        '--ignore-config',
        '--no-plugin-dirs',
        '--no-warnings',
        '--cookies-from-browser',
        opts.browser,
        '--cookies',
        raw,
        '--simulate',
        '--',
        'mdc:cookies',
      ],
      {env: opts.env, signal: opts.signal},
    )
    if (result.aborted) throw cancelledError()
    const text = await fs.readFile(raw, 'utf8').catch(() => undefined)
    if (text === undefined || !/^# (?:Netscape )?HTTP Cookie File/m.test(text)) {
      const error = classifyYtDlpError(result.stderr, result.code || 1)
      throw error.hint === 'cookies-unreadable'
        ? error
        : new DownloadError(
            'invalid-request',
            `The cookies of ${opts.browser} could not be read: ${error.message}`,
            undefined,
            undefined,
            'cookies-unreadable',
          )
    }
    await writeJar(opts.dest, text)
  } finally {
    await fs.rm(raw, {force: true})
  }
}

/**
 * A browser's cookies, read into `file` once and again only when older than
 * `maxAgeMs` or the browser changes. Concurrent callers share one read (single
 * flight), so a batch of N runs reads the browser once, not N times.
 */
export class BrowserCookies {
  readonly #file: string
  readonly #maxAgeMs: number
  readonly #now: () => number
  #browser: string | undefined
  /** When the jar was read; undefined: not read (for this browser). */
  #readAt: number | undefined
  #reading: Promise<string> | undefined

  constructor(file: string, opts: {readonly maxAgeMs?: number; readonly now?: () => number} = {}) {
    this.#file = file
    this.#maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60_000
    this.#now = opts.now ?? Date.now
  }

  get browser(): string | undefined {
    return this.#browser
  }

  set browser(browser: string | undefined) {
    if (browser === this.#browser) return
    this.#browser = browser
    this.#readAt = undefined
    this.#reading = undefined
  }

  /** The jar, read now if it is missing or old; undefined when no browser is set. */
  async jar(read: (browser: string, dest: string) => Promise<void>): Promise<string | undefined> {
    const browser = this.#browser
    if (!browser) return undefined
    if (this.#readAt !== undefined && this.#now() - this.#readAt < this.#maxAgeMs) return this.#file
    this.#reading ??= read(browser, this.#file).then(
      () => {
        if (this.#browser === browser) this.#readAt = this.#now()
        this.#reading = undefined
        return this.#file
      },
      error => {
        this.#reading = undefined
        throw error
      },
    )
    return this.#reading
  }
}

/** A run's own copy of `jar`, next to its other files (see the module comment). */
export async function jarCopy(jar: string, dir: string): Promise<string> {
  await fs.mkdir(dir, {recursive: true})
  const copy = path.join(dir, 'cookies.txt')
  await fs.copyFile(jar, copy)
  await fs.chmod(copy, 0o600).catch(() => {})
  return copy
}
