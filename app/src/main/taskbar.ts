import type {BatchSnapshot} from 'media-downloader-core'

const ACTIVE = new Set<BatchSnapshot['status']>(['checking', 'running'])

/**
 * What the Dock / taskbar icon shows for the batches at work: overall
 * progress (0…1, weighted by each batch's size; -1 when nothing runs, which
 * removes the bar) and how many items are left (the macOS badge).
 */
export function taskbarState(batches: Iterable<BatchSnapshot>): {readonly progress: number; readonly left: number} {
  let weighted = 0
  let items = 0
  let left = 0
  let active = 0
  for (const batch of batches) {
    if (!ACTIVE.has(batch.status)) continue
    active++
    const total = batch.jobs.total || batch.preflight.total
    const settled = batch.jobs.succeeded + batch.jobs.failed
    const fraction = batch.status === 'checking' ? 0 : (batch.progress?.fraction ?? (total ? settled / total : 0))
    weighted += fraction * total
    items += total
    left += Math.max(0, total - settled)
  }
  if (active === 0) return {progress: -1, left: 0}
  // a batch still being checked has no size yet: an indeterminate bar (2 in Electron) until it has
  return {progress: items ? Math.min(1, weighted / items) : 2, left}
}
