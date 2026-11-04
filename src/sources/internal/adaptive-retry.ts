/**
 * One experimental profile per analysis try, and nothing else.
 *
 * `n` is the tries of one analysis. It is bounded by 5. `profileFor` runs
 * once per try: O(1) time (one pass over a fixed family list and the url's
 * characters) and O(1) memory. `note` is O(1). The permanent memory is six
 * outcome buckets plus at most 300 recent ids. Nothing here is kept on disk.
 * The same url, the same attempt and the same time bucket return the same
 * profile. A post's five tries step through the families in order, so a try
 * does not repeat the previous try's language. The host session is only for
 * attempt 5 (`sessionOnThisAttempt`).
 */

/** Anonymous doors of one public post before the host session is asked for. */
export const ANONYMOUS_ATTEMPTS = 5
/** How long to tell the caller to wait once the session try is spent, in seconds. */
export const SESSION_EXHAUSTED_SECONDS = 5 * 60

/** The pause between two doors of the same post, after one refused: 300 to 800 ms. */
const PAUSE_MIN_MS = 300
const PAUSE_SPAN_MS = 500

const FAMILY_COUNT = 6
const RECENT_LIMIT = 300
const DERIVE_LIMIT = 3
/** Short bucket: profiles of one moment stay put, and a later moment may differ. */
const BUCKET_MS = 5 * 60 * 1000
const HALF_LIFE_MS = 45 * 60 * 1000
const PRIOR = 0.5
const ALPHA = 0.3

/** A fixed family: one locale, the language it sends, and a matching presentation. */
const FAMILIES = [
  {
    locale: 'en-US',
    acceptLanguage: 'en-US,en;q=0.9',
    presentation:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  {
    locale: 'en-GB',
    acceptLanguage: 'en-GB,en;q=0.9',
    presentation:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
  {
    locale: 'es-MX',
    acceptLanguage: 'es-MX,es;q=0.9,en;q=0.8',
    presentation: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  },
  {
    locale: 'pt-BR',
    acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.8',
    presentation:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  {
    locale: 'fr-FR',
    acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8',
    presentation:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  },
  {
    locale: 'de-DE',
    acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8',
    presentation:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
] as const

/** One experimental profile for a single analysis try. Not exported from the package. */
export interface ExperimentalProfile {
  readonly id: string
  readonly attempt: number
  readonly presentation: string
  readonly locale: string
  readonly acceptLanguage: string
  readonly routeBias: number
}

type Outcome = 'ok' | 'wall' | 'rate' | 'timeout'
type Bucket = {score: number; at: number}

/** Six buckets, one per family. Not one entry per url. */
const outcomes = new Map<number, Bucket>()
/** Recent ids, oldest first. Capped at RECENT_LIMIT. */
const byKey = new Map<string, ExperimentalProfile>()
const keyById = new Map<string, string>()

/** The host session is only on the fifth try. O(1). */
export function sessionOnThisAttempt(attempt: number): boolean {
  return attempt >= ANONYMOUS_ATTEMPTS
}

/**
 * The profile for this url and this attempt (1-based). `now` is the clock;
 * when the caller passes it, this does not read `Date.now`. O(1).
 */
export function profileFor(url: string, attempt: number, now?: number): ExperimentalProfile {
  const clock = now ?? Date.now()
  const attemptNo = attempt >= 1 ? Math.floor(attempt) : 1
  const key = `${canonical(url)}\n${attemptNo}\n${Math.floor(clock / BUCKET_MS)}`
  const cached = byKey.get(key)
  if (cached) {
    byKey.delete(key)
    byKey.set(key, cached)
    return cached
  }
  let profile = compose(key, attemptNo, 0)
  for (let salt = 1; salt <= DERIVE_LIMIT && takenBySomeoneElse(profile.id, key); salt++) {
    profile = compose(key, attemptNo, salt)
  }
  remember(key, profile)
  return profile
}

/** Record one outcome. Six buckets, updated in place: O(1), and the map cannot grow past them. */
export function note(profile: ExperimentalProfile, outcome: Outcome, now?: number): void {
  const clock = now ?? Date.now()
  const index = familyIndex(profile.attempt, 0)
  const current = outcomes.get(index)
  const decayed = current ? decay(current.score, current.at, clock) : PRIOR
  const hit = outcome === 'ok' ? 1 : 0
  outcomes.set(index, {score: decayed * (1 - ALPHA) + hit * ALPHA, at: clock})
}

/** How many recent profiles are remembered. At most RECENT_LIMIT. O(1). */
export function profileMemorySize(): number {
  return byKey.size
}

/** How many outcome buckets exist. At most the six families. O(1). */
export function outcomeBucketCount(): number {
  return outcomes.size
}

/** Milliseconds to wait before the next door, after one refused. `random` in [0, 1). O(1). */
export function betweenAttemptsMs(random: () => number = Math.random): number {
  const roll = random()
  const unit = roll < 0 ? 0 : roll > 1 ? 1 : roll
  return PAUSE_MIN_MS + Math.floor(unit * (PAUSE_SPAN_MS + 1))
}

function compose(key: string, attempt: number, salt: number): ExperimentalProfile {
  const rng = mulberry32(fnv1a32(`${key}\n${salt}`))
  const roll = Math.floor(rng() * 0x1000000)
  const index = familyIndex(attempt, salt)
  const family = FAMILIES[index] ?? FAMILIES[0]
  const routeBias = salt === 0 ? (attempt - 1) % ANONYMOUS_ATTEMPTS : Math.floor(rng() * ANONYMOUS_ATTEMPTS)
  return {
    id: fnv1a32(`${key}\n${index}\n${routeBias}\n${roll}`).toString(36),
    attempt,
    presentation: family.presentation,
    locale: family.locale,
    acceptLanguage: family.acceptLanguage,
    routeBias,
  }
}

/** Attempt 1 is family 0, attempt 2 is the next, and a url only shifts the whole run. */
function familyIndex(attempt: number, salt: number): number {
  return (attempt - 1 + salt) % FAMILY_COUNT
}

function takenBySomeoneElse(id: string, key: string): boolean {
  const owner = keyById.get(id)
  return owner !== undefined && owner !== key
}

function remember(key: string, profile: ExperimentalProfile): void {
  if (byKey.size >= RECENT_LIMIT && !byKey.has(key)) {
    const oldest = byKey.keys().next().value
    if (oldest !== undefined) {
      const previous = byKey.get(oldest)
      byKey.delete(oldest)
      if (previous) keyById.delete(previous.id)
    }
  }
  byKey.set(key, profile)
  keyById.set(profile.id, key)
}

function decay(score: number, at: number, now: number): number {
  const elapsed = Math.max(0, now - at)
  const factor = 2 ** (-elapsed / HALF_LIFE_MS)
  return PRIOR + (score - PRIOR) * factor
}

function canonical(url: string): string {
  const hash = url.indexOf('#')
  const bare = hash === -1 ? url : url.slice(0, hash)
  try {
    const parsed = new URL(bare)
    parsed.hash = ''
    return parsed.href
  } catch {
    return bare
  }
}

/** FNV-1a, 32 bits. One pass over the string: O(length), and a url's length is bounded. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** mulberry32. One seed, one roll: O(1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
