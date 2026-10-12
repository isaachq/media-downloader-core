import type {AttestationStrategy, MintSession} from 'media-downloader-core'
import {HiddenPage} from './hidden-page'
import {findAttestationKey, KeyStore, scriptOrder} from './page-key'

/**
 * YouTube's attestation in the app's own Chromium — for learning how a site
 * proves the client that streams from it is its own web page (see the README,
 * "YouTube: attestation"). Only used after YouTube has refused a request.
 *
 * In a real youtube.com page, never shown: the page's attestation challenge
 * (BotGuard) runs, its answer is exchanged for an integrity token (valid for
 * hours), and the minter it unlocks makes a PO token per content binding in
 * well under a millisecond. Running in YouTube's own page keeps everything it
 * binds the challenge to (its config, its visitor) exactly as YouTube made it.
 *
 * Two ways, so one change at YouTube rarely breaks both:
 *  - `youtube`: the challenge the page carries, or InnerTube's (att/get); the
 *    integrity token from youtube.com — in the page the app keeps loaded.
 *  - `waa`: a page loaded afresh, and the integrity token from Google's WAA
 *    service (jnn-pa.googleapis.com) instead.
 * `PoTokenService` (the library) picks between them, remembers which works and
 * reports which broke.
 */

/** The attestation request key YouTube's web client sends (public, part of its page). */
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo'
// The API key that goes with it is not in this code: it is learned from YouTube (see page-key.ts).
const GENERATE_IT = {
  youtube: 'https://www.youtube.com/api/jnn/v1/GenerateIT',
  waa: 'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT',
} as const
const HOME = 'https://www.youtube.com/'
/** The kept page is reloaded after this long (a fresh config and visitor), when next needed. */
const PAGE_MAX_AGE_MS = 30 * 60_000
/** Interpreters kept by hash: a new one appears when YouTube changes it (rarely). */
const INTERPRETERS_KEPT = 4

/**
 * What runs inside the page: fetches a challenge, runs the attestation
 * program, exchanges its answer, keeps the minters by id. Original code; the
 * calls into the program follow its own calling convention.
 */
const PAGE_SCRIPT = `(() => {
  if (globalThis.__mdcAttest) return
  const minters = new Map()
  const bytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  const websafe = data => {
    let text = ''
    for (let i = 0; i < data.length; i++) text += String.fromCharCode(data[i])
    // websafe, padding kept: yt-dlp decodes a token strictly and refuses one without it
    return btoa(text).replace(/\\+/g, '-').replace(/\\//g, '_')
  }
  const within = (promise, ms, what) =>
    Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error(what + ' took over ' + ms / 1000 + ' s')), ms))])
  globalThis.__mdcAttest = {
    async challenge() {
      // the challenge this page came with, when YouTube put one in it
      const carried = await within(Promise.resolve(window.ytAtP), 50, 'the page challenge').catch(() => undefined)
      if (carried && carried.R) {
        const parsed = typeof carried.R === 'string' ? JSON.parse(carried.R) : carried.R
        if (parsed && parsed.bgChallenge) return {challenge: parsed.bgChallenge, from: 'page'}
      }
      const config = window.ytcfg && window.ytcfg.data_
      if (!config || !config.INNERTUBE_CONTEXT) throw new Error('the page has no InnerTube configuration')
      const answer = await fetch('/youtubei/v1/att/get?prettyPrint=false', {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type': 'application/json', 'X-Goog-Visitor-Id': config.VISITOR_DATA || '',
          'X-Youtube-Client-Name': String(config.INNERTUBE_CONTEXT_CLIENT_NAME || 1), 'X-Youtube-Client-Version': config.INNERTUBE_CLIENT_VERSION || ''},
        body: JSON.stringify({context: config.INNERTUBE_CONTEXT, engagementType: 'ENGAGEMENT_TYPE_UNBOUND'}),
      })
      if (!answer.ok) throw new Error('att/get answered HTTP ' + answer.status)
      const data = await answer.json()
      if (!data.bgChallenge) throw new Error('att/get gave no challenge')
      return {challenge: data.bgChallenge, from: 'innertube'}
    },
    async open(challenge, requestKey, generateIt, apiKey) {
      const program = globalThis[challenge.globalName]
      if (!program || typeof program.a !== 'function') throw new Error('the attestation program did not load (' + challenge.globalName + ')')
      const snapshot = await within(new Promise(ready => {
        program.a(challenge.program, take => ready(take), true, undefined, () => {}, [[], []])
      }), 10000, 'starting the attestation program')
      const outputs = []
      const answer = await within(new Promise(done => snapshot(done, [undefined, undefined, outputs, undefined])), 10000, 'the attestation')
      const getMinter = outputs[0]
      if (typeof getMinter !== 'function') throw new Error('the attestation gave no minter')
      const exchange = await fetch(generateIt, {
        method: 'POST',
        headers: {'content-type': 'application/json+protobuf', 'x-goog-api-key': apiKey, 'x-user-agent': 'grpc-web-javascript/0.1'},
        body: JSON.stringify([requestKey, answer]),
      })
      if (!exchange.ok) throw new Error('GenerateIT answered HTTP ' + exchange.status)
      const [integrityToken, ttlSeconds, mintLimit] = await exchange.json()
      if (typeof integrityToken !== 'string' || !integrityToken) throw new Error('the attestation was refused (no integrity token)')
      const minter = await within(getMinter(bytes(integrityToken)), 10000, 'unlocking the minter')
      if (typeof minter !== 'function') throw new Error('the integrity token unlocked no minter')
      const id = crypto.randomUUID()
      minters.set(id, minter)
      return {id, ttlSeconds: Number(ttlSeconds) || 0, mintLimit: Number(mintLimit) || 0}
    },
    async mint(id, binding) {
      const minter = minters.get(id)
      if (!minter) throw new Error('the session is gone (the page reloaded)')
      const token = await minter(new TextEncoder().encode(binding))
      if (!token || !token.length) throw new Error('the minter made an empty token')
      return websafe(token)
    },
    close(id) {
      minters.delete(id)
    },
  }
})()`

export type KeySource = 'page' | 'kept' | 'scripts'

type Challenge = {
  readonly globalName: string
  readonly program: string
  readonly interpreterHash?: string
  readonly interpreterUrl?: string | {readonly privateDoNotAccessOrElseTrustedResourceUrlWrappedValue?: string}
}

export type YouTubeAttestation = {
  readonly strategies: readonly AttestationStrategy[]
  /** Where the attestation key came from the last time (for a report): the page's own calls, memory or disk, its scripts. */
  readonly keySource: () => KeySource | undefined
  close(): void
}

/**
 * The app's two ways to pass YouTube's attestation. `partition` says whose
 * identity: the guest's (in memory) or the signed-in account's — tokens are
 * made in the session they will be used with.
 */
export function createYouTubeAttestation(
  partition: () => string,
  /** Where the attestation key learned last is kept between launches. */
  keyFile?: string,
): YouTubeAttestation {
  const keys = new KeyStore(keyFile)
  let keySource: KeySource | undefined
  /** The page `youtube` keeps loaded, per partition (one at a time in practice). */
  let kept: {page: HiddenPage; partition: string; loadedAt: number} | undefined
  let loading: Promise<HiddenPage> | undefined
  /** Pages `waa` opened for its live sessions: closed with them. */
  const fresh = new Set<HiddenPage>()
  /** interpreterHash → source, oldest first. */
  const interpreters = new Map<string, string>()

  /** The key, cheapest way first (page-key.ts): memory, the page's own calls, disk, YouTube's scripts. */
  const attestationKey = async (page: HiddenPage, signal: AbortSignal): Promise<string> => {
    const seen = page.seenKey
    if (seen) {
      await keys.set(seen)
      keySource = 'page'
      return seen
    }
    const known = await keys.get()
    if (known) {
      keySource = 'kept'
      return known
    }
    for (const url of scriptOrder(page.scripts)) {
      const response = await page.session.fetch(url, {signal}).catch(() => undefined)
      const found = response?.ok ? findAttestationKey(await response.text()) : undefined
      if (found) {
        await keys.set(found)
        keySource = 'scripts'
        return found
      }
    }
    throw new Error('the page names no attestation key (YouTube changed how it sends it)')
  }

  const keptPage = (signal: AbortSignal): Promise<HiddenPage> => {
    const wanted = partition()
    const usable =
      kept && !kept.page.closed && kept.partition === wanted && Date.now() - kept.loadedAt < PAGE_MAX_AGE_MS
    if (usable) return Promise.resolve(kept!.page)
    loading ??= (async () => {
      kept?.page.close()
      kept = undefined
      const page = await HiddenPage.open(wanted, HOME, signal)
      kept = {page, partition: wanted, loadedAt: Date.now()}
      return page
    })().finally(() => {
      loading = undefined
    })
    return loading
  }

  const interpreter = async (page: HiddenPage, challenge: Challenge, signal: AbortSignal): Promise<string> => {
    const key = challenge.interpreterHash ?? ''
    const known = key ? interpreters.get(key) : undefined
    if (known !== undefined) return known
    const raw =
      typeof challenge.interpreterUrl === 'string'
        ? challenge.interpreterUrl
        : challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue
    if (!raw) throw new Error('the challenge names no attestation program')
    const url = raw.startsWith('//') ? `https:${raw}` : raw
    // fetched by the app (no page CORS), with the page's own session
    const response = await page.session.fetch(url, {signal})
    if (!response.ok) throw new Error(`the attestation program answered HTTP ${response.status}`)
    const source = await response.text()
    if (key) {
      interpreters.set(key, source)
      if (interpreters.size > INTERPRETERS_KEPT) interpreters.delete(interpreters.keys().next().value!)
    }
    return source
  }

  /** Attest in `page`: its challenge, the program, the integrity token from `generateIt`. */
  const attest = async (
    page: HiddenPage,
    generateIt: string,
    signal: AbortSignal,
    release: () => void,
  ): Promise<MintSession> => {
    await page.run(PAGE_SCRIPT, signal)
    const {challenge} = await page.run<{challenge: Challenge}>('globalThis.__mdcAttest.challenge()', signal)
    await page.run(`${await interpreter(page, challenge, signal)}\n;0`, signal)
    const key = await attestationKey(page, signal)
    let opened: {id: string; ttlSeconds: number; mintLimit: number}
    try {
      // our own call: the key it carries must not be "learned" back from it
      opened = await page.asOurs(() =>
        page.run(
          `globalThis.__mdcAttest.open(${JSON.stringify(challenge)}, ${JSON.stringify(REQUEST_KEY)}, ${JSON.stringify(generateIt)}, ${JSON.stringify(key)})`,
          signal,
        ),
      )
    } catch (error) {
      // the key refused (YouTube changed it): learned again next time
      if (/GenerateIT answered HTTP 4\d\d/.test(String(error))) await keys.forget()
      throw error
    }
    const expiresAt = Date.now() + Math.max(60, opened.ttlSeconds || 6 * 3600) * 1000
    return {
      expiresAt,
      ...(opened.mintLimit > 0 && {maxMints: opened.mintLimit}),
      mint: (binding, mintSignal) =>
        page.run<string>(
          `globalThis.__mdcAttest.mint(${JSON.stringify(opened.id)}, ${JSON.stringify(binding)})`,
          mintSignal,
        ),
      close: () => {
        if (!page.closed) void page.run(`globalThis.__mdcAttest.close(${JSON.stringify(opened.id)})`).catch(() => {})
        release()
      },
    }
  }

  const strategies: AttestationStrategy[] = [
    {
      name: 'youtube',
      open: async signal => attest(await keptPage(signal), GENERATE_IT.youtube, signal, () => {}),
    },
    {
      name: 'waa',
      open: async signal => {
        const page = await HiddenPage.open(partition(), HOME, signal)
        fresh.add(page)
        const release = () => {
          fresh.delete(page)
          page.close()
        }
        try {
          return await attest(page, GENERATE_IT.waa, signal, release)
        } catch (error) {
          release()
          throw error
        }
      },
    },
  ]

  return {
    strategies,
    keySource: () => keySource,
    close: () => {
      kept?.page.close()
      kept = undefined
      for (const page of fresh) page.close()
      fresh.clear()
    },
  }
}
