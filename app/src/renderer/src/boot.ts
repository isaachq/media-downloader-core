/** Start-up phases, in order. Each is one call to the main process. */
export const BOOT_PHASES = ['connect', 'settings', 'restore', 'tools'] as const
export type BootPhase = (typeof BOOT_PHASES)[number]

export type BootProgress =
  | {readonly status: 'running'; readonly phase: BootPhase; readonly attempt: number}
  | {readonly status: 'failed'; readonly phase: BootPhase; readonly error: string}

export const BOOT_ATTEMPTS = 3
const BASE_DELAY_MS = 400

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Run `task` up to `attempts` times with exponential backoff (400 ms, 800 ms…),
 * reporting each attempt before it starts. Throws the last error.
 */
export async function retrying<T>(
  task: () => Promise<T>,
  onAttempt: (attempt: number) => void,
  {attempts = BOOT_ATTEMPTS, baseDelayMs = BASE_DELAY_MS}: {attempts?: number; baseDelayMs?: number} = {},
): Promise<T> {
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    onAttempt(attempt)
    try {
      return await task()
    } catch (error) {
      last = error
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1))
    }
  }
  throw last
}

/** Errors crossing IPC arrive as "Error invoking remote method '…': Error: <message>". */
export function bootErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
