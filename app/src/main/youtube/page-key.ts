import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * The key YouTube's web client sends with its attestation calls. It is not
 * ours and it is not kept in this code: YouTube serves it to every visitor in
 * its own scripts, and it changes when YouTube wants. The app learns it from
 * YouTube, cheapest way first:
 *
 *  1. memory — O(1);
 *  2. the page's own requests — YouTube's client sends it as `X-Goog-Api-Key`
 *     on its attestation calls; read from the request headers, nothing fetched;
 *  3. the last key that worked, on disk — the next launch fetches nothing;
 *  4. YouTube's scripts, its app code first: the first that names it ends the search.
 *
 * A key YouTube refuses is forgotten (memory and disk) and learned again.
 */

/** Both shapes YouTube's code uses: `setRequestHeader("X-Goog-Api-Key","…")` and `{["X-Goog-Api-Key"]:"…"}`. */
const KEY_IN_CODE = /X-Goog-Api-Key["'\]]*\s*[:,]\s*["'](AIza[0-9A-Za-z_-]{35})["']/
const KEY_SHAPE = /^AIza[0-9A-Za-z_-]{35}$/

export const findAttestationKey = (code: string): string | undefined => KEY_IN_CODE.exec(code)?.[1]

export const isKey = (value: string | undefined): value is string => value !== undefined && KEY_SHAPE.test(value)

/** YouTube's attestation endpoints: where the page's own requests carry the key. */
export const isAttestationCall = (url: string): boolean =>
  /^https:\/\/(?:jnn-pa\.googleapis\.com\/|www\.youtube\.com\/api\/jnn\/)/.test(url)

/**
 * The scripts worth reading, in order: YouTube's app code (where its
 * attestation runs), then the player, then YouTube's other scripts. Anything
 * not served by YouTube is left out. O(n log n) over a few dozen urls.
 */
export function scriptOrder(urls: readonly string[]): string[] {
  const rank = (url: string): number => {
    if (/kevlar_main_module|kevlar_base_module/.test(url)) return 0
    if (/\/s\/player\/[^/]+\/.*base\.js/.test(url)) return 1
    return 2
  }
  return [...new Set(urls)]
    .filter(url => /^https:\/\/(?:www\.youtube\.com|[a-z0-9.-]+\.gstatic\.com)\//.test(url))
    .sort((a, b) => rank(a) - rank(b))
}

/** The key learned last, in memory and in a small file (written atomically). */
export class KeyStore {
  #key: string | undefined
  #loaded = false

  constructor(private readonly file: string | undefined) {}

  async get(): Promise<string | undefined> {
    if (this.#key || this.#loaded || !this.file) return this.#key
    this.#loaded = true
    const saved = (await fs.readFile(this.file, 'utf8').catch(() => '')).trim()
    if (isKey(saved)) this.#key = saved
    return this.#key
  }

  async set(key: string): Promise<void> {
    if (!isKey(key) || key === this.#key) return
    this.#key = key
    this.#loaded = true
    if (!this.file) return
    await fs.mkdir(path.dirname(this.file), {recursive: true})
    const tmp = `${this.file}.${process.pid}.tmp`
    await fs.writeFile(tmp, key)
    await fs.rename(tmp, this.file).catch(() => fs.rm(tmp, {force: true}))
  }

  /** YouTube refused it: learn it again. */
  async forget(): Promise<void> {
    this.#key = undefined
    this.#loaded = true
    if (this.file) await fs.rm(this.file, {force: true})
  }
}
