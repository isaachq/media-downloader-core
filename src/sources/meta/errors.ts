import {DownloadError} from '../../core/errors.js'
import type {FailureHint} from '../../types.js'
import {SOURCE_BLOCKED, SOURCE_FORMAT_CHANGED} from '../source.js'

/**
 * Everything that can go wrong talking to Instagram or Facebook, as distinct
 * cases — so a caller can tell "back off and come back later" from "this
 * account is private" from "this needs a signed-in session" from "the site
 * changed its pages, use the other extractor". The same cases TikTok has,
 * plus 'login-required': both sites keep some content (stories, most
 * listings) for signed-in sessions only, and that is a condition to report,
 * not a refusal to wait out.
 */
export type MetaProblem =
  /** A checkpoint / verification page, a captcha or a login wall on a public page: slow down. */
  | 'challenge'
  /** 403 / 429 / "please wait a few minutes" / an empty answer where data was expected: slow down. */
  | 'refused'
  /** The site answers only to a signed-in session (stories, a listing): not retried. */
  | 'login-required'
  | 'private'
  /** Deleted post or account, a short link that leads to the home page, an expired story. */
  | 'removed'
  /** The page no longer has the data where this module expects it. */
  | 'format-changed'
  /** A post with nothing to download for the profile asked (a photo with an audio profile). */
  | 'no-media'

export class MetaError extends Error {
  override readonly name = 'MetaError'

  constructor(
    readonly problem: MetaProblem,
    message: string,
  ) {
    super(message)
  }

  /** Worth retrying later (after backing off). */
  get transient(): boolean {
    return this.problem === 'challenge' || this.problem === 'refused'
  }
}

const HINTS: Readonly<Partial<Record<MetaProblem, FailureHint>>> = {
  private: 'private',
  removed: 'removed',
  'login-required': 'needs-sign-in',
  'no-media': 'format-unavailable',
  challenge: 'retry-later',
  refused: 'retry-later',
}

/** The site's problems in the engine's terms (codes drive retries, hints drive the UI). */
export function toDownloadError(error: unknown, site: string): DownloadError {
  if (error instanceof DownloadError) return error
  if (!(error instanceof MetaError)) {
    const message = error instanceof Error ? error.message : String(error)
    return new DownloadError('network', message)
  }
  switch (error.problem) {
    case 'private':
    case 'removed':
    case 'login-required':
    case 'no-media':
      return new DownloadError('unavailable', error.message, undefined, undefined, HINTS[error.problem])
    case 'challenge':
      // yt-dlp takes over for a while (with the user's cookies it may get further)
      return new DownloadError('network', error.message, SOURCE_BLOCKED, undefined, 'retry-later')
    case 'refused':
      return new DownloadError('network', error.message, undefined, undefined, 'retry-later')
    case 'format-changed':
      // 'unknown' lets the engine fall back to yt-dlp for this url
      return new DownloadError('unknown', `${site}: ${error.message}`, SOURCE_FORMAT_CHANGED)
  }
}
