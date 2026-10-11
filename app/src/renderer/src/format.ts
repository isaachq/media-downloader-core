// Locale-aware formatting for the UI (the engine's helpers live in Node).
const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

// Intl formatters are costly to build and called on every render: one per (locale, unit, digits)
const formatters = new Map<string, Intl.NumberFormat>()

function unitFormatter(locale: string, unit: (typeof UNITS)[number], digits: number): Intl.NumberFormat {
  const key = `${locale}|${unit}|${digits}`
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: digits,
    })
    formatters.set(key, formatter)
  }
  return formatter
}

export function bytes(value: number | undefined, locale: string): string {
  if (value === undefined || !(value > 0)) return '—'
  const exponent = Math.min(UNITS.length - 1, Math.max(0, Math.floor(Math.log10(value) / 3)))
  const scaled = value / 1000 ** exponent
  return unitFormatter(locale, UNITS[exponent]!, scaled < 10 && exponent > 0 ? 1 : 0).format(scaled)
}

export const rate = (bytesPerSecond: number | undefined, locale: string): string =>
  bytesPerSecond ? `${bytes(bytesPerSecond, locale)}/s` : ''

export function clock(seconds: number | undefined): string {
  if (seconds === undefined || !(seconds > 0)) return ''
  const total = Math.round(seconds)
  const parts = [Math.trunc(total / 3600), Math.trunc((total % 3600) / 60), total % 60]
  if (parts[0] === 0) parts.shift()
  return parts.map((part, i) => (i === 0 ? String(part) : String(part).padStart(2, '0'))).join(':')
}

export const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Seconds left → "< 1 min", "12 min", "1 h 05 min" (same units in English and Spanish). */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return '< 1 min'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** Wall-clock time `seconds` from now, e.g. "14:32". */
export function finishesAt(seconds: number, locale: string, now = Date.now()): string {
  return new Date(now + seconds * 1000).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'})
}
