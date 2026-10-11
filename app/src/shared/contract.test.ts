// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {pickLanguage} from './contract'

describe('default language', () => {
  it('Spanish when Spanish is preferred', () => {
    expect(pickLanguage(['es-MX'])).toBe('es')
    expect(pickLanguage(['es_ES'])).toBe('es')
  })

  it('the first language the app speaks wins, in the user’s order', () => {
    expect(pickLanguage(['en-US', 'es-MX'])).toBe('en')
    expect(pickLanguage(['es-419', 'en-US'])).toBe('es')
    expect(pickLanguage(['fr-FR', 'es-ES'])).toBe('es')
    expect(pickLanguage(['de-DE', 'en-GB'])).toBe('en')
  })

  it('English when neither Spanish nor English is preferred', () => {
    expect(pickLanguage(['fr-FR', 'ja-JP'])).toBe('en')
    expect(pickLanguage([])).toBe('en')
  })
})
