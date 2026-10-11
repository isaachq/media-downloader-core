// Locale-aware formatting of sizes, rates and durations, built on Intl so a
// UI gets "1,5 GB" in Spanish and "1.5 GB" in English from the same call.
// Sizes use decimal units (1 kB = 1000 B), as Finder and most UIs do.

const SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

const formatters = new Map<string, Intl.NumberFormat>()

/** Intl.NumberFormat instances are costly to build; reuse one per locale + unit. */
function formatter(locale: string, unit: string, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${locale}|${unit}|${maximumFractionDigits}`
  let cached = formatters.get(key)
  if (!cached) {
    cached = new Intl.NumberFormat(locale, {style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits})
    formatters.set(key, cached)
  }
  return cached
}

/** Pick the unit in O(1) from the number's order of magnitude (3 decimal digits per step). */
function scale(bytes: number): {value: number; unit: (typeof SIZE_UNITS)[number]} {
  const exponent = Math.min(SIZE_UNITS.length - 1, Math.max(0, Math.floor(Math.log10(bytes) / 3)))
  return {value: bytes / 1000 ** exponent, unit: SIZE_UNITS[exponent]!}
}

/** 1536000 → "1.5 MB". Empty string for non-positive or non-finite input. */
export function formatBytes(bytes: number, locale = 'en'): string {
  if (!(bytes > 0) || !Number.isFinite(bytes)) return ''
  const {value, unit} = scale(bytes)
  // one decimal below 10 ("4.2 MB"), none above ("420 MB")
  return formatter(locale, unit, value < 10 && unit !== 'byte' ? 1 : 0).format(value)
}

/** Bytes per second → "2.4 MB/s". */
export function formatRate(bytesPerSecond: number, locale = 'en'): string {
  if (!(bytesPerSecond > 0) || !Number.isFinite(bytesPerSecond)) return ''
  const {value, unit} = scale(bytesPerSecond)
  return formatter(locale, `${unit}-per-second`, value < 10 && unit !== 'byte' ? 1 : 0).format(value)
}

/** Seconds → "4:05" or "1:02:03". Empty string for non-positive input. */
export function formatClock(totalSeconds: number): string {
  if (!(totalSeconds > 0) || !Number.isFinite(totalSeconds)) return ''
  const rounded = Math.round(totalSeconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor(rounded / 60) % 60
  const seconds = String(rounded % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
