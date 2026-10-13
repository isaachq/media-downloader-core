// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {pickLanguage, platformOf} from './contract'

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

describe('the mode a link belongs to', () => {
  it('tells TikTok, Instagram and Facebook apart; anything else is the web mode', () => {
    expect(platformOf('https://www.tiktok.com/@someone/video/1')).toBe('tiktok')
    expect(platformOf('https://vm.tiktok.com/ZM1/')).toBe('tiktok')
    expect(platformOf('https://www.instagram.com/reel/abc/')).toBe('instagram')
    expect(platformOf('https://instagr.am/p/abc')).toBe('instagram')
    expect(platformOf('https://m.facebook.com/watch/?v=1')).toBe('facebook')
    expect(platformOf('https://fb.watch/xyz/')).toBe('facebook')
    expect(platformOf('https://www.youtube.com/watch?v=1')).toBe('web')
    expect(platformOf('https://youtu.be/1')).toBe('web')
    expect(platformOf('https://videos.example.org/search/videos/x?type=public')).toBe('web')
  })

  it('a look-alike host is not the site', () => {
    expect(platformOf('https://nottiktok.com/@x')).toBe('web')
    expect(platformOf('https://tiktok.com.evil.test/@x')).toBe('web')
  })

  it('no mode for what is not an http(s) link', () => {
    expect(platformOf('ftp://tiktok.com/x')).toBeUndefined()
    expect(platformOf('not a link')).toBeUndefined()
  })
})
