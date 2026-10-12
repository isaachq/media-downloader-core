// @vitest-environment node
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {findAttestationKey, isAttestationCall, KeyStore, scriptOrder} from './page-key'

// made up, and assembled at run time: no key-shaped literal in this file either
const FAKE = `AIza${'Sy'}${'k'.repeat(33)}`
const OTHER = `AIza${'Sy'}${'q'.repeat(33)}`

describe('the attestation key, learned from YouTube', () => {
  it('finds it in both shapes YouTube’s code sends it, and only next to the header that carries it', () => {
    expect(findAttestationKey(`U.open("POST",Q.url);U.setRequestHeader("X-Goog-Api-Key","${FAKE}");`)).toBe(FAKE)
    expect(findAttestationKey(`WYF=function(d){var t={["X-Goog-Api-Key"]:"${FAKE}"};return t}`)).toBe(FAKE)
    // a key anywhere else (the InnerTube key in a config, a link key) is not the attestation's
    expect(findAttestationKey(`{"INNERTUBE_API_KEY":"${OTHER}","LINK_API_KEY":"${OTHER}"}`)).toBeUndefined()
  })

  it('reads YouTube’s app code first, then the player, and nothing YouTube did not serve', () => {
    const order = scriptOrder([
      'https://www.youtube.com/s/desktop/abc/jsbin/web-animations.js',
      'https://www.youtube.com/s/player/ec429320/player_es6.vflset/es_MX/base.js',
      'https://ads.example.com/tracker.js',
      'https://www.youtube.com/s/_/ytmainappweb/_/js/k=x/m=kevlar_base_module,kevlar_main_module',
      'https://www.youtube.com/s/player/ec429320/player_es6.vflset/es_MX/base.js',
    ])
    expect(order[0]).toMatch(/kevlar_main_module/)
    expect(order[1]).toMatch(/base\.js$/)
    expect(order).toHaveLength(3)
    expect(order.some(url => url.includes('example.com'))).toBe(false)
  })

  it('knows YouTube’s attestation calls (where the page’s own headers carry the key)', () => {
    expect(isAttestationCall('https://www.youtube.com/api/jnn/v1/GenerateIT')).toBe(true)
    expect(isAttestationCall('https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT')).toBe(true)
    expect(isAttestationCall('https://www.youtube.com/youtubei/v1/player')).toBe(false)
  })

  it('keeps the key that worked for the next launch, and forgets one YouTube refused', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-key-'))
    const file = path.join(dir, 'youtube', 'attestation-key')
    try {
      await new KeyStore(file).set(FAKE)
      expect(await new KeyStore(file).get()).toBe(FAKE) // a new launch: from disk, nothing fetched
      const store = new KeyStore(file)
      await store.forget()
      expect(await store.get()).toBeUndefined()
      expect(await new KeyStore(file).get()).toBeUndefined()
      await new KeyStore(file).set('not a key')
      expect(await new KeyStore(file).get()).toBeUndefined()
    } finally {
      await fs.rm(dir, {recursive: true, force: true})
    }
  })
})

describe('the repository', () => {
  it('holds no Google API key: YouTube’s is learned at run time, never written in the code', async () => {
    const root = path.resolve(__dirname, '../../../..')
    const skip = new Set(['node_modules', '.git', 'dist', 'out', '.ci-data'])
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
        if (skip.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (/\.(?:[cm]?[jt]sx?|json|ya?ml|md|html|py)$/.test(entry.name)) {
          const text = await fs.readFile(full, 'utf8')
          if (/AIza[0-9A-Za-z_-]{35}/.test(text)) offenders.push(path.relative(root, full))
        }
      }
    }
    await walk(root)
    expect(offenders).toEqual([])
  })
})
