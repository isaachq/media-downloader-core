import * as path from 'node:path'
import {app, type BrowserWindow} from 'electron'
import type {MediaDownloader} from 'media-downloader-core'
import type {YouTubeState} from '../../shared/contract'
import {ACCOUNT_PARTITION, YouTubeAccount} from './account'
import {createYouTubeAttestation} from './attestation'

/** The guest identity's partition: in memory, gone when the app quits. */
const GUEST_PARTITION = 'youtube-attest'
/** While the account is in use, its cookies.txt is written again this often (YouTube rotates them). */
const REFRESH_JAR_MS = 20 * 60_000

/**
 * YouTube in the app: the attestation the engine climbs to after a bot check,
 * and the account the user may sign in with when that is not enough. The
 * account is used only after the user agreed (a held engine, their click),
 * never by itself.
 */
export class YouTubeController {
  readonly #attestation = createYouTubeAttestation(
    () => (this.#engine?.youtube.level === 'account' ? ACCOUNT_PARTITION : GUEST_PARTITION),
    // the attestation key learned from YouTube, kept for the next launch
    path.join(app.getPath('userData'), 'youtube', 'attestation-key'),
  )
  #engine: MediaDownloader | undefined
  #account: YouTubeAccount | undefined
  #signedIn = false
  #refresh: NodeJS.Timeout | undefined

  constructor(private readonly send: (state: YouTubeState) => void) {}

  /**
   * For the engine's options. Off with the tests' fake tools (MDC_BINARIES): a
   * test never reaches the real YouTube unless it asks (MDC_YOUTUBE_ATTESTATION=on).
   */
  get strategies() {
    const setting = process.env['MDC_YOUTUBE_ATTESTATION']
    const off = setting === 'off' || (setting !== 'on' && Boolean(process.env['MDC_BINARIES']))
    return off ? [] : this.#attestation.strategies
  }

  attach(engine: MediaDownloader): void {
    this.#engine = engine
    this.#account = new YouTubeAccount(engine.dataDir)
    engine.on('youtube', () => this.#push())
    void this.#account.signedIn().then(signedIn => {
      this.#signedIn = signedIn
      this.#push()
    })
  }

  get state(): YouTubeState {
    const access = this.#engine?.youtube
    return {
      level: access?.level ?? 'open',
      pausedUntil: access?.pausedUntil ?? null,
      tokens: access?.tokens ?? false,
      signedIn: this.#signedIn,
    }
  }

  /** Go on as the account: signing in first (a window over `parent`) when there is none yet. */
  async signIn(parent: BrowserWindow | undefined): Promise<{ok: boolean; reason?: 'closed' | 'refused'}> {
    const engine = this.#engine
    const account = this.#account
    if (!engine || !account) return {ok: false, reason: 'refused'}
    if (!(await account.signedIn())) {
      const result = await account.signIn(parent)
      if (!result.ok) return result
    }
    this.#signedIn = true
    engine.setYouTubeAccount(await account.exportJar())
    clearInterval(this.#refresh)
    this.#refresh = setInterval(() => {
      if (engine.youtube.level === 'account') void account.exportJar().catch(() => {})
    }, REFRESH_JAR_MS)
    this.#refresh.unref()
    this.#push()
    return {ok: true}
  }

  async signOut(): Promise<void> {
    clearInterval(this.#refresh)
    this.#engine?.clearYouTubeAccount()
    await this.#account?.signOut()
    this.#signedIn = false
    this.#push()
  }

  waitItOut(): void {
    this.#engine?.waitOutYouTube()
    this.#push()
  }

  close(): void {
    clearInterval(this.#refresh)
    this.#attestation.close()
  }

  #push(): void {
    this.send(this.state)
  }
}
