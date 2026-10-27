import {SOURCE_FORMAT_CHANGED} from '../../sources/source.js'
import type {ErrorCode, FailureHint, MessageParams} from '../../types.js'
import {DownloadError} from '../errors.js'

/** Why an HLS download stopped; `HlsError` turns it into the engine's code and hint. */
export type HlsFailure =
  /** Not a playlist (an HTML page, a JSON error). */
  | 'not-hls'
  /** No segments, or no usable variant. */
  | 'empty'
  /** No EXT-X-ENDLIST (or an EVENT playlist without an end): a live stream, never downloaded here. */
  | 'live'
  /** FairPlay / Widevine / PlayReady, SoundCloud's ctr- / cbc-encrypted-hls. */
  | 'drm'
  /** SAMPLE-AES, EXT-X-DEFINE IMPORT / QUERYPARAM, an https → http downgrade, a hostile segment count. */
  | 'unsupported'
  /** 401 / 403 after the refresh budget, or with no refresh. */
  | 'refused'
  /** The refreshed playlist is another one (count or paths differ). */
  | 'changed'
  /** A segment still 404 / 410 after its retries. */
  | 'missing'
  /** A body that is not media (an HTML 200, a short body, a bad AES length) after its retries. */
  | 'corrupt'
  /** ffmpeg -c copy failed. */
  | 'assemble'

const CODES: Readonly<Record<HlsFailure, readonly [ErrorCode, FailureHint | undefined, string | undefined]>> = {
  'not-hls': ['unknown', undefined, SOURCE_FORMAT_CHANGED],
  empty: ['unknown', undefined, SOURCE_FORMAT_CHANGED],
  unsupported: ['unknown', 'stream-only', SOURCE_FORMAT_CHANGED],
  live: ['unavailable', 'live-now', undefined],
  // decision 6: no public `drm-protected` hint yet; the message says DRM
  drm: ['unavailable', 'format-unavailable', undefined],
  refused: ['expired', undefined, undefined],
  changed: ['expired', undefined, undefined],
  // `network` on purpose: the engine keeps the work folder after a network failure, so the next attempt
  // resumes instead of throwing away an hour of segments over one transient CDN 404
  missing: ['network', undefined, undefined],
  corrupt: ['network', undefined, undefined],
  assemble: ['conversion', undefined, undefined],
}

/**
 * A `DownloadError` whose code, hint and details follow from `reason` (design §3.5); `params.reason`
 * carries the reason too, for hosts that log it.
 */
export class HlsError extends DownloadError {
  constructor(
    readonly reason: HlsFailure,
    message: string,
    details?: string,
  ) {
    const [code, hint, fallbackDetails] = CODES[reason]
    super(code, message, details ?? fallbackDetails, {reason} satisfies MessageParams, hint)
  }
}

export const isHlsError = (error: unknown, reason?: HlsFailure): error is HlsError =>
  error instanceof HlsError && (reason === undefined || error.reason === reason)
