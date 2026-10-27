// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {LANGUAGES, LINK_SITES} from './contract'
import {SITE_WORDS, siteMessages} from './site-words'
import {SITE_BY_LABEL, SITES} from './sites'

describe('supported sites', () => {
  it('lists every site the engine detects, and a file link, once each', () => {
    const listed = SITES.map(entry => entry.site)
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual([...LINK_SITES, 'file'].sort())
    for (const site of listed) expect(SITE_BY_LABEL[site].site).toBe(site)
  })

  it('YouTube and other websites go through yt-dlp, so the phone has neither', () => {
    for (const entry of SITES) {
      expect(entry.engine === 'yt-dlp').toBe(entry.site === 'youtube' || entry.site === 'web')
      expect(entry.phone).toBe(entry.engine === 'native')
    }
  })

  it('every language says what each site downloads, and what needs a sign-in exactly where one helps', () => {
    for (const language of LANGUAGES) {
      const words = SITE_WORDS[language]
      for (const entry of SITES) {
        expect(words.what[entry.site], `${language} ${entry.site}`).toBeTruthy()
        expect(entry.site in words.needs, `${language} ${entry.site}`).toBe(entry.signIn)
      }
      for (const text of Object.values(siteMessages(language))) expect(text.trim()).toBe(text)
      expect(words.signInFor).toContain('{what}')
      expect(words.inlineSignIn).toContain('{what}')
    }
  })
})
