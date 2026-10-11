/**
 * Semantic versions with pre-releases, as this app is tagged:
 * 0.2.0-beta.2 < 0.2.0-beta.10 < 0.2.0 < 0.2.1. O(parts).
 */
export type Version = {
  readonly core: readonly [number, number, number]
  /** "beta.10" → ["beta", 10]; empty for a release. */
  readonly pre: ReadonlyArray<string | number>
  readonly text: string
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(text: string): Version | undefined {
  const match = PATTERN.exec(text.trim())
  if (!match) return undefined
  const pre = match[4] ? match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part)) : []
  return {core: [Number(match[1]), Number(match[2]), Number(match[3])], pre, text: text.trim().replace(/^v/, '')}
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = a.core[i]! - b.core[i]!
    if (diff !== 0) return diff
  }
  // a release ranks above any of its pre-releases
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    // numbers rank below words; numbers compare numerically
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}
