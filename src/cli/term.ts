// Terminal output: colors, width and capability detection. Rendering code
// receives a `Style` and never touches process.stdout directly, so every
// screen can be unit-tested as plain strings.

const ESC = '\x1b['

export type Style = {
  readonly color: boolean
  /** Hacker palette: bright → dim green, plus alert colors. */
  readonly green: (text: string) => string
  readonly lime: (text: string) => string
  readonly dim: (text: string) => string
  readonly dark: (text: string) => string
  readonly bold: (text: string) => string
  readonly red: (text: string) => string
  readonly yellow: (text: string) => string
  readonly cyan: (text: string) => string
}

const paint = (code: string) => (text: string) => `${ESC}${code}m${text}${ESC}0m`
const plain = (text: string) => text

export function createStyle(color: boolean): Style {
  if (!color) {
    return {
      color,
      green: plain,
      lime: plain,
      dim: plain,
      dark: plain,
      bold: plain,
      red: plain,
      yellow: plain,
      cyan: plain,
    }
  }
  return {
    color,
    green: paint('38;5;46'),
    lime: paint('1;38;5;118'),
    dim: paint('38;5;34'),
    dark: paint('38;5;22'),
    bold: paint('1'),
    red: paint('1;38;5;196'),
    yellow: paint('38;5;220'),
    cyan: paint('38;5;51'),
  }
}

/** https://no-color.org + FORCE_COLOR, falling back to "is it a TTY". */
export function wantsColor(isTTY: boolean, env: NodeJS.ProcessEnv, flag?: boolean): boolean {
  if (flag === false) return false
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return true
  return isTTY && env['TERM'] !== 'dumb'
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** Visible width (ANSI-free; every code point counts 1 — good enough for our glyphs). */
export const visibleLength = (text: string): number => [...stripAnsi(text)].length

/** Cut a plain string to `width` columns, ending with "…" when shortened. */
export function fit(text: string, width: number): string {
  const chars = [...text]
  if (chars.length <= width) return text
  return width <= 1 ? chars.slice(0, width).join('') : `${chars.slice(0, width - 1).join('')}…`
}

export const cursor = {
  up: (lines: number) => (lines > 0 ? `${ESC}${lines}A` : ''),
  clearLine: `${ESC}2K`,
  clearDown: `${ESC}0J`,
  hide: `${ESC}?25l`,
  show: `${ESC}?25h`,
  column0: '\r',
}

export type Output = {
  readonly write: (text: string) => void
  readonly isTTY: boolean
  readonly columns: number
}

export function processOutput(stream: NodeJS.WriteStream = process.stdout): Output {
  return {
    write: text => {
      stream.write(text)
    },
    isTTY: Boolean(stream.isTTY),
    get columns() {
      return stream.columns && stream.columns > 0 ? stream.columns : 80
    },
  }
}
