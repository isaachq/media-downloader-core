import type {Style} from './term.js'

// A 5-row block font drawn for this project ('#' = lit cell).
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: [' ## ', '#  #', '####', '#  #', '#  #'],
  C: [' ###', '#   ', '#   ', '#   ', ' ###'],
  D: ['### ', '#  #', '#  #', '#  #', '### '],
  E: ['####', '#   ', '### ', '#   ', '####'],
  I: ['###', ' # ', ' # ', ' # ', '###'],
  L: ['#   ', '#   ', '#   ', '#   ', '####'],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
  O: [' ## ', '#  #', '#  #', '#  #', ' ## '],
  R: ['### ', '#  #', '### ', '# # ', '#  #'],
  W: ['#   #', '#   #', '# # #', '## ##', '#   #'],
  ' ': ['  ', '  ', '  ', '  ', '  '],
}

const ROWS = 5

/**
 * Render text in the block font. Lit cells become █ and cast a ░ shadow one
 * cell down-right, so the grid grows by one row and one column.
 */
export function blockText(text: string): string[] {
  const rows = Array.from({length: ROWS}, () => '')
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char] ?? GLYPHS[' ']!
    for (let r = 0; r < ROWS; r++) rows[r] += `${glyph[r]} `
  }
  const lit = (r: number, c: number) => rows[r]?.[c] === '#'
  const width = rows[0]!.length + 1
  return Array.from({length: ROWS + 1}, (_, r) => {
    let out = ''
    for (let c = 0; c < width; c++) out += lit(r, c) ? '█' : lit(r - 1, c - 1) ? '░' : ' '
    return out.trimEnd()
  })
}

export const TITLE = 'MEDIA DOWNLOAD CORE'

/**
 * The big banner when the terminal is wide enough, otherwise a one-line
 * title. Rows fade from bright to dark green like a CRT phosphor trail.
 */
export function banner(style: Style, columns: number, version: string): string {
  const shades = [style.lime, style.lime, style.green, style.green, style.dim, style.dark]
  const tagline = style.dim(`  ── yt-dlp + ffmpeg engine ── v${version} ── integrity first ──`)
  const lines = [blockText('MEDIA DOWNLOAD'), blockText('CORE')]
  const width = Math.max(...lines.flat().map(row => row.length))
  if (columns < width + 4)
    return `\n ${style.lime('▓▒░')} ${style.bold(style.green(TITLE))} ${style.lime('░▒▓')}\n${tagline}\n`

  // lit cells take the row's shade; shadow cells stay dark so they read as depth
  const paintRow = (row: string, r: number) =>
    row.replace(/█+/g, run => shades[r]!(run)).replace(/░+/g, run => style.dark(run))
  const block = lines.flatMap((rows, index) => [
    ...rows.map((row, r) => `  ${paintRow(row, r)}`),
    ...(index === 0 ? [''] : []),
  ])
  return `\n${block.join('\n')}\n\n${tagline}\n`
}

export type BootLine = {readonly label: string; readonly value: string; readonly state?: 'ok' | 'warn' | 'fail'}

/** "[ 0x01 ] label     value   [ OK ]" — the boot sequence printed under the banner. */
export function bootSequence(style: Style, lines: readonly BootLine[]): string {
  const width = Math.max(...lines.map(line => line.label.length))
  const valueWidth = Math.max(...lines.map(line => line.value.length))
  return lines
    .map((line, index) => {
      const tag = style.dark(`[ 0x${(index + 1).toString(16).padStart(2, '0')} ]`)
      const state =
        line.state === 'fail'
          ? style.red(' FAIL ')
          : line.state === 'warn'
            ? style.yellow(' WARN ')
            : style.green('  OK  ')
      return `  ${tag} ${style.dim(line.label.padEnd(width))}  ${style.green(line.value.padEnd(valueWidth))}  ${style.dark('[')}${state}${style.dark(']')}`
    })
    .join('\n')
}
