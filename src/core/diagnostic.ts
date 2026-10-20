import type {AnalysisResult, ErrorCode, FailureHint, JobError} from '../types.js'

/**
 * A failed link, described so it can be read without the device it failed on:
 * which site, what kind of media, at which stage, why (a stable code) and how
 * long it took. Built in O(1) from the error the engine already has — no
 * extra requests — so a host can keep the last few and let the user copy one
 * into a bug report. Nothing here is sent anywhere.
 */
export type FailureDiagnostic = {
  readonly target_url: string
  /** Where the short link led, when it was followed (reveals login walls and dead links). */
  readonly resolved_url?: string | undefined
  readonly platform: Platform
  readonly detected_media_type: DetectedMediaType
  readonly failure_stage: FailureStage
  readonly error_code: FailureCode
  readonly http_status?: number | undefined
  readonly execution_time_ms: number
  /** The engine's own code and hint, for whoever reads the report next to the source. */
  readonly engine: {readonly code: ErrorCode; readonly hint?: FailureHint | undefined}
  readonly message: string
  /** The error's last lines, without query strings (signed media urls) and capped. */
  readonly stack_snippet?: string | undefined
}

export type Platform = 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'unknown'
export type DetectedMediaType =
  | 'video'
  | 'reel'
  | 'photo_with_audio'
  | 'carousel'
  | 'profile'
  | 'short_link'
  | 'unknown'
export type FailureStage =
  | 'URL_VALIDATION'
  | 'REDIRECT_RESOLUTION'
  | 'METADATA_PARSE'
  | 'STREAM_EXTRACTION'
  | 'MUXING'
  | 'NETWORK_IO'
export type FailureCode =
  | 'UNSUPPORTED_URL'
  | 'REDIRECT_LOOP'
  | 'REDIRECT_DEAD_END'
  | 'LOGIN_WALL_DETECTED'
  | 'BOT_CHECK'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PRIVATE'
  | 'REMOVED'
  | 'GEO_BLOCKED'
  | 'NO_MEDIA'
  | 'FORMAT_CHANGED'
  | 'DASH_AUDIO_MISSING'
  | 'PHOTO_AUDIO_PARSE_ERROR'
  | 'MUXING_FAILED'
  | 'VALIDATION_FAILED'
  | 'DISK_FULL'
  | 'BINARY_MISSING'
  | 'CANCELLED'
  | 'UNKNOWN'

/** Host → platform, exact names: one hash lookup per suffix of the host (a handful at most). */
const HOSTS: ReadonlyMap<string, Platform> = new Map([
  ['facebook.com', 'facebook'],
  ['fb.com', 'facebook'],
  ['fb.watch', 'facebook'],
  ['fb.gg', 'facebook'],
  ['instagram.com', 'instagram'],
  ['instagr.am', 'instagram'],
  ['tiktok.com', 'tiktok'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
])

/** The site a url belongs to: www., m., web., vm., vt. … all reduce to their registered name. */
export function platformOf(url: string): Platform {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'unknown'
  }
  // walk the suffixes: m.facebook.com → facebook.com → com
  for (let at = 0; ; ) {
    const platform = HOSTS.get(host.slice(at))
    if (platform) return platform
    const dot = host.indexOf('.', at)
    if (dot === -1) return 'unknown'
    at = dot + 1
  }
}

/** What the url's shape says it points at, before anything is read. */
export function mediaTypeOf(url: string, analysis?: AnalysisResult): DetectedMediaType {
  if (analysis?.kind === 'playlist') return 'profile'
  const slideshow = analysis?.kind === 'video' ? analysis.media.slideshow : undefined
  if (slideshow) return slideshow.audio && slideshow.images > 0 && !slideshow.videos ? 'photo_with_audio' : 'carousel'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'unknown'
  }
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname
  if (SHORT_HOSTS.has(host) || SHORT_PATH.test(path)) return 'short_link'
  if (REEL_PATH.test(path)) return 'reel'
  if (PHOTO_PATH.test(path)) return 'photo_with_audio'
  if (VIDEO_PATH.test(path)) return 'video'
  return 'unknown'
}

const SHORT_HOSTS: ReadonlySet<string> = new Set(['fb.watch', 'vm.tiktok.com', 'vt.tiktok.com'])
const SHORT_PATH = /^\/(?:share|t|s)\//
const REEL_PATH = /^\/(?:[^/]+\/)?reels?\//
const PHOTO_PATH = /\/photo\//
const VIDEO_PATH = /\/(?:video|videos|watch|tv|p)\b|video\.php|story\.php|permalink\.php|\/posts\//

const HTTP_STATUS = /\bHTTP(?: Error)? ?\(?(\d{3})\b/i
const SECRETS = /([?&][^=\s]*=)[^\s&"']+/g

/**
 * The engine's error in the plan's terms. `stage` is where the caller was
 * (analyzing or downloading); the error refines it (a conversion is muxing,
 * a dead short link is redirect resolution).
 */
export function diagnoseFailure(input: {
  readonly url: string
  readonly error: JobError
  readonly stage: 'analyze' | 'download'
  readonly elapsedMs: number
  readonly resolvedUrl?: string | undefined
  readonly analysis?: AnalysisResult | undefined
}): FailureDiagnostic {
  const {error} = input
  const text = `${error.message}\n${error.details ?? ''}`
  const status = HTTP_STATUS.exec(text)?.[1]
  const code = failureCode(error, text)
  return {
    target_url: input.url,
    ...(input.resolvedUrl && {resolved_url: input.resolvedUrl}),
    platform: platformOf(input.url),
    detected_media_type: mediaTypeOf(input.url, input.analysis),
    failure_stage: stageOf(code, input.stage),
    error_code: code,
    ...(status && {http_status: Number(status)}),
    execution_time_ms: Math.round(input.elapsedMs),
    engine: {code: error.code, ...(error.hint && {hint: error.hint})},
    message: error.message,
    ...(error.details && {stack_snippet: snippet(error.details)}),
  }
}

/** What the message says, when neither the code nor the hint did; first match wins. Compiled once. */
const BY_MESSAGE: ReadonlyArray<readonly [RegExp, FailureCode]> = [
  [/verification page|captcha|checkpoint|not a (?:ro)?bot/i, 'BOT_CHECK'],
  [/\b429\b|too many requests|rate.?limit|please wait/i, 'RATE_LIMITED'],
  [/timed? ?out|ETIMEDOUT|aborted due to timeout/i, 'TIMEOUT'],
  [/sign(?:ed)?[ -]in|log ?in|login/i, 'LOGIN_WALL_DETECTED'],
  [/unsupported url/i, 'UNSUPPORTED_URL'],
  [/format.?changed|no longer has the data/i, 'FORMAT_CHANGED'],
]
const REDIRECT_LOOP = /redirect loop|too many redirects/i
const REDIRECT_DEAD_END = /short link leads nowhere/i
const SILENT = /no audio|audio stream|silent/i
const PICTURES = /photo|image|slideshow/i

function failureCode(error: JobError, text: string): FailureCode {
  switch (error.code) {
    case 'cancelled':
      return 'CANCELLED'
    case 'disk-full':
      return 'DISK_FULL'
    case 'binary-missing':
      return 'BINARY_MISSING'
    case 'conversion':
      return 'MUXING_FAILED'
    case 'validation':
      return SILENT.test(text) ? 'DASH_AUDIO_MISSING' : 'VALIDATION_FAILED'
    case 'blocked':
      return 'BOT_CHECK'
    default:
  }
  if (REDIRECT_LOOP.test(text)) return 'REDIRECT_LOOP'
  if (REDIRECT_DEAD_END.test(text)) return 'REDIRECT_DEAD_END'
  switch (error.hint) {
    case 'needs-sign-in':
      return 'LOGIN_WALL_DETECTED'
    case 'private':
    case 'members-only':
      return 'PRIVATE'
    case 'removed':
      return 'REMOVED'
    case 'geo-blocked':
      return 'GEO_BLOCKED'
    case 'unsupported-url':
      return 'UNSUPPORTED_URL'
    case 'format-unavailable':
      return PICTURES.test(text) ? 'PHOTO_AUDIO_PARSE_ERROR' : 'NO_MEDIA'
    case 'bot-check':
      return 'BOT_CHECK'
    default:
  }
  for (const [pattern, code] of BY_MESSAGE) if (pattern.test(text)) return code
  if (error.details === 'source:format-changed') return 'FORMAT_CHANGED'
  if (error.code === 'network' || error.code === 'expired') return 'NETWORK_ERROR'
  if (error.code === 'unavailable') return 'REMOVED'
  if (error.code === 'invalid-request') return 'UNSUPPORTED_URL'
  return 'UNKNOWN'
}

function stageOf(code: FailureCode, stage: 'analyze' | 'download'): FailureStage {
  switch (code) {
    case 'UNSUPPORTED_URL':
      return 'URL_VALIDATION'
    case 'REDIRECT_LOOP':
    case 'REDIRECT_DEAD_END':
      return 'REDIRECT_RESOLUTION'
    case 'MUXING_FAILED':
    case 'DASH_AUDIO_MISSING':
      return 'MUXING'
    case 'RATE_LIMITED':
    case 'TIMEOUT':
    case 'NETWORK_ERROR':
    case 'DISK_FULL':
      return 'NETWORK_IO'
    default:
      return stage === 'analyze' ? 'METADATA_PARSE' : 'STREAM_EXTRACTION'
  }
}

/** The last lines of a stack or stderr, query strings dropped (signed urls, tokens), at most 1 KB. */
function snippet(details: string): string {
  const lines = details.trim().split('\n')
  return lines.slice(-8).join('\n').replace(SECRETS, '$1…').slice(-1024)
}
