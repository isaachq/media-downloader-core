// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {defaultSettings, mergeSettings} from './settings'

const limits = {half: 6, boosted: 7}
const base = defaultSettings('/Users/me/Downloads', 6, ['en-US'])

describe('settings from the renderer', () => {
  it('start in the web mode, checking each file, with half the processors', () => {
    expect(base).toMatchObject({mode: 'web', validateAfter: false, cpuBoost: false, concurrency: 6})
  })

  it('take one of the four modes, nothing else', () => {
    expect(mergeSettings(base, {mode: 'tiktok'}, limits).mode).toBe('tiktok')
    expect(mergeSettings(base, {mode: 'instagram'}, limits).mode).toBe('instagram')
    expect(mergeSettings(base, {mode: 'myspace'}, limits).mode).toBe('web')
    expect(mergeSettings(base, {mode: 3}, limits).mode).toBe('web')
  })

  it('allow more downloads at once only with the 60% boost, and bring them back without it', () => {
    expect(mergeSettings(base, {concurrency: 7}, limits).concurrency).toBe(6)
    const boosted = mergeSettings(base, {cpuBoost: true, concurrency: 7}, limits)
    expect(boosted).toMatchObject({cpuBoost: true, concurrency: 7})
    expect(mergeSettings(boosted, {cpuBoost: false}, limits)).toMatchObject({cpuBoost: false, concurrency: 6})
    expect(mergeSettings(base, {cpuBoost: 'yes'}, limits).cpuBoost).toBe(false)
  })

  it('take the check-after-the-batch switch as a boolean only', () => {
    expect(mergeSettings(base, {validateAfter: true}, limits).validateAfter).toBe(true)
    expect(mergeSettings(base, {validateAfter: 1}, limits).validateAfter).toBe(false)
  })
})
