// @vitest-environment node
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {defaultSettings, mergeSettings, SettingsStore} from './settings'

const limits = {half: 6, boosted: 7}
const base = defaultSettings('/Users/me/Downloads', 6, ['en-US'])

describe('settings from the renderer', () => {
  it('start checking each file, with half the processors, and no site to pick: every run reads every site', () => {
    expect(base).toMatchObject({validateAfter: false, cpuBoost: false, concurrency: 6})
    expect(base).not.toHaveProperty('mode')
    expect(mergeSettings(base, {mode: 'tiktok'}, limits)).not.toHaveProperty('mode')
  })

  it('load a settings.json of a version with one site per run: its mode is ignored, the rest kept, and never written back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-settings-'))
    try {
      const file = path.join(dir, 'settings.json')
      await fs.writeFile(file, JSON.stringify({mode: 'tiktok', language: 'es', format: 'mp3', syncEnabled: true}))
      const store = new SettingsStore(file, base, limits)
      const loaded = await store.load()
      expect(loaded).toMatchObject({language: 'es', format: 'mp3', syncEnabled: true})
      expect(loaded).not.toHaveProperty('mode')
      await store.update({theme: 'dark'})
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('mode')
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
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
