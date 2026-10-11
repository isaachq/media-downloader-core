/** One command-line option: a flag alone, or a flag paired with its value. */
export type Option = readonly [flag: string] | readonly [flag: string, value: string]

/** Options in order; `false` / `undefined` entries are skipped, so conditionals stay inline. */
export type OptionList = ReadonlyArray<Option | false | undefined>

/**
 * Flatten options into argv in O(n). Keeping every value next to its flag
 * makes command lines readable and impossible to misalign.
 */
export function toArgv(options: OptionList): string[] {
  const argv: string[] = []
  for (const option of options) if (option) argv.push(...option)
  return argv
}
