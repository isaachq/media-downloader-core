// Locale-aware formatting for the UI (the engine's helpers live in Node).
const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

export function bytes(value: number | undefined, locale: string): string {
  if (value === undefined || !(value > 0)) return '—'
  const exponent = Math.min(UNITS.length - 1, Math.max(0, Math.floor(Math.log10(value) / 3)))
  const scaled = value / 1000 ** exponent
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: UNITS[exponent],
    unitDisplay: 'short',
    maximumFractionDigits: scaled < 10 && exponent > 0 ? 1 : 0,
  }).format(scaled)
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
