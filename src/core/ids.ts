import {randomBytes} from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const ID_LENGTH = 32
export const ID_PATTERN = /^[A-Za-z0-9]{32}$/

/**
 * 32-character base62 identifier (~190 random bits): unique without
 * coordination, safe in file names and urls, and easy to grep in logs.
 *
 * Bytes are masked to 6 bits (0–63) and values ≥ 62 are rejected, so every
 * character is uniformly distributed — a plain `% 62` would favour 'A'–'H'.
 * One 48-byte batch covers a whole id ~97% of the time.
 */
export function newId(): string {
  let id = ''
  while (id.length < ID_LENGTH) {
    for (const byte of randomBytes(48)) {
      const value = byte & 63
      if (value < 62) id += ALPHABET[value]
      if (id.length === ID_LENGTH) break
    }
  }
  return id
}
