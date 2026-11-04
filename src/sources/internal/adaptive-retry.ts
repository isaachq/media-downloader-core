/**
 * One analysis, bounded by 8. `n` is one analysis.
 *
 * `profileFor` and `presentationFor` are O(1). Permanent memory is O(1):
 * six outcome buckets plus at most 300 profiles. Nothing is kept on disk.
 *
 * Attempts 1 to 4 stay as they are on main: `variantFor`, the fixed
 * languages, and `rotate` of the source's own routes. They do not call
 * `profileFor` and they do not ask for the host session.
 * Attempts 5, 6 and 7 are the three added tries. Only those call
 * `profileFor`. Each one is a different fictional educational experimental
 * profile. Attempt 8 is the only try that asks for the host session
 * (`sessionOnThisAttempt`).
 *
 * The same url, the same attempt and the same time bucket return the same
 * profile. The same seed and the same family return the same presentation.
 * Another seed, or another salt, returns another presentation. An id already
 * remembered for a different key is derived again, up to three times.
 */

/** Tries an analysis gets: 4 variant, 3 profiles, then the host session. */
export const ANALYZE_ATTEMPTS = 8
/** Attempts 1 to 4. `variantFor` only. */
export const VARIANT_ATTEMPTS = 4
/** First attempt that calls `profileFor`. */
export const PROFILE_ATTEMPT_FIRST = 5
/** Last attempt that calls `profileFor`. */
export const PROFILE_ATTEMPT_LAST = 7
/** The variant tries. Kept so existing callers still name them. */
export const ANONYMOUS_ATTEMPTS = VARIANT_ATTEMPTS
/** How long to tell the caller to wait when the session's one read got a checkpoint, in seconds. */
export const SESSION_EXHAUSTED_SECONDS = 5 * 60

/**
 * Five fixed languages, one per anonymous try. Attempt 1 keeps the language
 * the post page already sent.
 */
const ACCEPT_LANGUAGE = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'es-MX,es;q=0.9,en;q=0.8',
  'pt-BR,pt;q=0.9,en;q=0.8',
  'fr-FR,fr;q=0.9,en;q=0.8',
] as const

/** The pause between two tries of the same post: 300 to 800 ms. Tests pass `random`. */
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

export interface RetryVariant {
  readonly id: string
  readonly attempt: number
  /** Secondary headers only. The source keeps each route's own required headers. */
  readonly headers: Readonly<Record<string, string>>
  /** `routes`, rotated left by `attempt - 1`. Attempt 1 is `routes` as given. */
  readonly routeOrder: readonly string[]
}

/**
 * The variant for this url and this attempt (1-based). `routes` is the
 * source's own list, cheapest first; it is not stored. O(1): the list is a
 * handful of doors and the url is one link.
 */
export function variantFor(url: string, attempt: number, routes: readonly string[]): RetryVariant {
  const index = Math.max(0, attempt - 1)
  return {
    id: fnv1a32(`${url}\n${attempt}`).toString(36),
    attempt,
    headers: {'Accept-Language': ACCEPT_LANGUAGE[index % ACCEPT_LANGUAGE.length] ?? 'en-US,en;q=0.9'},
    routeOrder: rotate(routes, index),
  }
}

/** Milliseconds to wait before the next try. `random` in [0, 1). O(1). */
export function betweenAttemptsMs(random: () => number = Math.random): number {
  const roll = random()
  const unit = roll < 0 ? 0 : roll > 1 ? 1 : roll
  return PAUSE_MIN_MS + Math.floor(unit * (PAUSE_SPAN_MS + 1))
}

/** One fictional educational experimental profile for a single analysis try. Not exported from the package. */
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
/** Recent profiles, oldest first. Capped at RECENT_LIMIT. */
const byKey = new Map<string, ExperimentalProfile>()
const keyById = new Map<string, string>()

/** True only on attempt 8, the try that asks for the host session. O(1). */
export function sessionOnThisAttempt(attempt: number): boolean {
  return attempt === ANALYZE_ATTEMPTS
}

export type AttemptUse =
  | {readonly kind: 'variant'; readonly attempt: number; readonly variant: RetryVariant}
  | {readonly kind: 'profile'; readonly attempt: number; readonly profile: ExperimentalProfile}
  | {readonly kind: 'session'; readonly attempt: number}

/**
 * What this attempt is allowed to do. Attempts 1 to 4 call `variantFor` and
 * nothing else. Attempts 5, 6 and 7 call `profileFor`. Attempt 8 asks for the
 * host session and does not build a profile. O(1).
 */
export function describeAttempt(
  url: string,
  attempt: number,
  routes: readonly string[] = [],
  now?: number,
): AttemptUse {
  const attemptNo = Math.floor(attempt)
  if (attemptNo >= 1 && attemptNo <= VARIANT_ATTEMPTS) {
    return {kind: 'variant', attempt: attemptNo, variant: variantFor(url, attemptNo, routes)}
  }
  if (attemptNo >= PROFILE_ATTEMPT_FIRST && attemptNo <= PROFILE_ATTEMPT_LAST) {
    return {kind: 'profile', attempt: attemptNo, profile: profileFor(url, attemptNo, now)}
  }
  if (attemptNo === ANALYZE_ATTEMPTS) return {kind: 'session', attempt: attemptNo}
  throw new Error(`attempt ${attempt} is outside 1..${ANALYZE_ATTEMPTS}`)
}

/**
 * The profile for attempts 5, 6 and 7 only. `now` is the clock; when the
 * caller passes it, this does not read `Date.now`. O(1).
 */
export function profileFor(url: string, attempt: number, now?: number): ExperimentalProfile {
  const attemptNo = Math.floor(attempt)
  if (attemptNo < PROFILE_ATTEMPT_FIRST || attemptNo > PROFILE_ATTEMPT_LAST) {
    throw new Error('a fictional educational experimental profile is only for attempts 5, 6 and 7')
  }
  const clock = now ?? Date.now()
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

function compose(key: string, attempt: number, salt: number): ExperimentalProfile {
  const seed = fnv1a32(key + salt)
  const rng = mulberry32(seed)
  const roll = Math.floor(rng() * 0x1000000)
  const index = familyIndex(attempt, salt)
  const routeBias = salt === 0 ? (attempt - 1) % ANONYMOUS_ATTEMPTS : Math.floor(rng() * ANONYMOUS_ATTEMPTS)
  return {
    id: fnv1a32(`${key}\n${index}\n${routeBias}\n${roll}`).toString(36),
    attempt,
    presentation: presentationFor(seed, index),
    locale: localeFor(index),
    acceptLanguage: acceptLanguageFor(index),
    routeBias,
  }
}

/**
 * Pieces for one fictional educational experimental profile.
 * No entry is a finished presentation.
 */
const platforms = [
  'Windows NT 10.0; Win64; x64',
  'Windows NT 6.1; Win64; x64',
  'Macintosh; Intel Mac OS X 10_15_7',
  'Macintosh; Intel Mac OS X 11_6',
  'X11; Linux x86_64',
  'X11; Ubuntu; Linux x86_64',
] as const
const engines = ['AppleWebKit', 'Gecko', 'Blink'] as const
const versionNumbers = [120, 121, 122, 128, 130, 131] as const
const locales = [
  {language: 'en', region: 'US'},
  {language: 'en', region: 'GB'},
  {language: 'es', region: 'MX'},
  {language: 'pt', region: 'BR'},
  {language: 'fr', region: 'FR'},
  {language: 'de', region: 'DE'},
] as const
const languages = {en: 'en', es: 'es', pt: 'pt', fr: 'fr', de: 'de'} as const

type FamilyParts = {readonly locale: string; readonly language: string}

/** Locale and language for this family index, joined from the language dictionary. O(1). */
function familyParts(index: number): FamilyParts {
  const slot = familySlot(index)
  const locale = locales[slot] ?? locales[0]
  const language = languages[locale.language]
  return {locale: `${language}-${locale.region}`, language}
}

/**
 * Builds the presentation of one fictional educational experimental profile.
 * The seed picks the platform, the engine and the version. The same seed and
 * the same family return the same string. Another seed returns another. O(1).
 */
function presentationFor(seed: number, family: number): string {
  const n = seed >>> 0
  const platform = platforms[(n + family) % platforms.length] ?? platforms[0]
  const engine = engines[((n >>> 4) + family) % engines.length] ?? engines[0]
  const major = versionNumbers[n % versionNumbers.length] ?? versionNumbers[0]
  const minor = versionNumbers[(n >>> 8) % versionNumbers.length] ?? versionNumbers[0]
  return `${platform} ${engine}/${major}.${minor}.${n}`
}

function localeFor(family: number): string {
  return familyParts(family).locale
}

/** The language header of the same family `localeFor` uses. */
function acceptLanguageFor(family: number): string {
  const {locale, language} = familyParts(family)
  if (language === languages.en) return `${locale},${language};q=0.9`
  return `${locale},${language};q=0.9,${languages.en};q=0.8`
}

function familySlot(family: number): number {
  return ((family % FAMILY_COUNT) + FAMILY_COUNT) % FAMILY_COUNT
}

/** Attempt 1 is family 0, attempt 2 is the next, and a salt shifts the whole run. */
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

/** Left rotate by `by` places. `routes` has a fixed handful of entries: O(1). */
function rotate(routes: readonly string[], by: number): readonly string[] {
  const count = routes.length
  if (count === 0) return []
  const shift = by % count
  if (shift === 0) return routes.slice()
  const order = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    const route = routes[(i + shift) % count]
    if (route !== undefined) order[i] = route
  }
  return order
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
