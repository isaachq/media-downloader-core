import type {BatchSnapshot} from 'media-downloader-core'
import {describe, expect, it} from 'vitest'
import {taskbarState} from './taskbar'

const batch = (patch: Partial<BatchSnapshot>): BatchSnapshot =>
  ({
    id: 'B',
    url: 'u',
    profile: {kind: 'video', container: 'mp4'},
    outDir: '/out',
    status: 'running',
    preflight: {total: 0, checked: 0, ok: 0, unavailable: 0},
    jobs: {total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0},
    createdAt: 0,
    ...patch,
  }) as BatchSnapshot

describe('taskbar progress', () => {
  it('weights batches by size and counts what is left; nothing running removes the bar', () => {
    expect(taskbarState([])).toEqual({progress: -1, left: 0})
    expect(
      taskbarState([
        batch({status: 'completed', jobs: {total: 9, queued: 0, running: 0, succeeded: 9, failed: 0, cancelled: 0}}),
      ]),
    ).toEqual({
      progress: -1,
      left: 0,
    })
    const big = batch({
      progress: {fraction: 0.5},
      jobs: {total: 30, queued: 10, running: 5, succeeded: 14, failed: 1, cancelled: 0},
    })
    const small = batch({
      progress: {fraction: 1},
      jobs: {total: 10, queued: 0, running: 1, succeeded: 9, failed: 0, cancelled: 0},
    })
    expect(taskbarState([big, small])).toEqual({progress: (0.5 * 30 + 1 * 10) / 40, left: 15 + 1})
  })

  it('a batch still being checked shows an indeterminate bar', () => {
    expect(taskbarState([batch({status: 'checking'})])).toEqual({progress: 2, left: 0})
  })
})
