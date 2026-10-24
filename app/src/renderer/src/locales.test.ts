// @vitest-environment node
// Fourteen interface languages: each one has every key, with the English
// placeholders, and no long dash; Arabic mirrors the window; the language
// select finds a language by any of its names.
import {describe, expect, it} from 'vitest'
import {isRtl, LANGUAGES} from '../../shared/contract'
import {searchText} from './components/LanguageSelect'
import {MESSAGES, type MessageKey} from './i18n'

const keys = Object.keys(MESSAGES.en) as MessageKey[]
const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join()

describe('interface languages', () => {
  it.each(LANGUAGES)('%s has every key, the English placeholders and no long dash', language => {
    const table = MESSAGES[language]
    expect(keys.filter(key => typeof table[key] !== 'string' || table[key].length === 0)).toEqual([])
    expect(keys.filter(key => holes(table[key]) !== holes(MESSAGES.en[key]))).toEqual([])
    expect(keys.filter(key => /[–—]/.test(table[key]))).toEqual([])
  })

  it('only Arabic reads right to left', () => {
    expect(LANGUAGES.filter(isRtl)).toEqual(['ar'])
  })

  it('the select finds a language by its own name, another language’s name for it, or its code', () => {
    expect(searchText('pt')).toContain('portugues')
    expect(searchText('de')).toContain('aleman')
    expect(searchText('ar')).toContain('arabic')
    expect(searchText('zh')).toContain('中文')
    expect(searchText('hi')).toContain('hi')
  })
})
