import type {ErrorCode, JobError, MessageParams} from '../types.js'

export class DownloadError extends Error {
  override readonly name = 'DownloadError'

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: string,
    readonly params?: MessageParams,
  ) {
    super(message)
  }

  toJSON(): JobError {
    return {code: this.code, message: this.message, details: this.details, params: this.params}
  }
}

export const cancelledError = (): DownloadError => new DownloadError('cancelled', 'Cancelled.')

/** Errors where the same request can succeed a moment later. */
export function isRetryable(code: ErrorCode): boolean {
  return code === 'network' || code === 'expired' || code === 'validation' || code === 'unknown'
}

const UNAVAILABLE: readonly RegExp[] = [
  /private video/i,
  /video unavailable/i,
  /this video is unavailable/i,
  /has been removed/i,
  /account .* terminated/i,
  /not available in your country/i,
  /geo.?restrict/i,
  /members.only/i,
  /join this channel/i,
  /sign in to confirm your age/i,
  /age.restricted/i,
  /requires? (?:a )?(?:login|authentication|payment|subscription)/i,
  /premieres in/i,
  /this live event will begin/i,
  /unsupported url/i,
  /is not a valid url/i,
  /no video formats found/i,
  /requested format is not available/i,
  /HTTP Error 404/i,
  /HTTP Error 410/i,
  /copyright/i,
]

const EXPIRED: readonly RegExp[] = [/HTTP Error 403/i, /forbidden/i, /expired/i, /signature/i]

const NETWORK: readonly RegExp[] = [
  /timed? ?out/i,
  /connection (?:reset|refused|aborted)/i,
  /network is unreachable/i,
  /temporary failure in name resolution/i,
  /getaddrinfo/i,
  /nodename nor servname/i,
  /unable to download (?:webpage|json|video data)/i,
  /HTTP Error 5\d\d/i,
  /HTTP Error 429/i,
  /too many requests/i,
  /IncompleteRead/i,
  /did not get any data blocks/i,
  /SSL/,
  /EOF occurred/i,
  /giving up after \d+ retries/i,
]

const DISK_FULL: readonly RegExp[] = [/no space left on device/i, /disk full/i, /errno 28/i, /ENOSPC/]

const ERROR_TAG = 'ERROR:'

/**
 * The human part of yt-dlp's last error line. yt-dlp writes
 * "ERROR: [extractor] <media id>: <message>"; the extractor tag and the
 * media id are noise for a user, so both are dropped when present.
 */
export function ytDlpErrorMessage(stderr: string): string {
  const at = stderr.lastIndexOf(ERROR_TAG)
  if (at === -1) return ''
  const end = stderr.indexOf('\n', at)
  let message = stderr.slice(at + ERROR_TAG.length, end === -1 ? undefined : end).trim()
  if (message.startsWith('[')) {
    const close = message.indexOf(']')
    if (close !== -1) message = message.slice(close + 1).trimStart()
  }
  const colon = message.indexOf(': ')
  // a media id is a single token (no spaces), e.g. "dQw4w9WgXcQ: Video unavailable"
  if (colon > 0 && !message.slice(0, colon).includes(' ')) message = message.slice(colon + 2)
  return message.trim()
}

export function classifyYtDlpError(stderr: string, exitCode: number | null): DownloadError {
  const message = ytDlpErrorMessage(stderr) || `yt-dlp exited with code ${exitCode}.`
  const context = `${message}\n${stderr.slice(-4000)}`
  const details = stderr.trim().split('\n').slice(-10).join('\n')

  // order matters: disk errors trump everything, a 403 page may also say "unavailable"
  if (DISK_FULL.some(re => re.test(context))) return new DownloadError('disk-full', 'No space left on device.', details)
  if (UNAVAILABLE.some(re => re.test(message))) return new DownloadError('unavailable', message, details)
  if (EXPIRED.some(re => re.test(message))) return new DownloadError('expired', message, details)
  if (NETWORK.some(re => re.test(context))) return new DownloadError('network', message, details)
  return new DownloadError('unknown', message, details)
}

export function toJobError(error: unknown): JobError {
  if (error instanceof DownloadError) return error.toJSON()
  if (error instanceof Error) {
    if (error.name === 'BinaryError') return {code: 'binary-missing', message: error.message}
    if (error.name === 'AbortError') return {code: 'cancelled', message: 'Cancelled.'}
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') return {code: 'disk-full', message: error.message}
    return {code: 'unknown', message: error.message}
  }
  return {code: 'unknown', message: String(error)}
}
