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
    expect(pickLanguage(['ja-JP', 'es-ES'])).toBe('es')
    expect(pickLanguage(['ko-KR', 'en-GB'])).toBe('en')
    expect(pickLanguage(['fr-FR', 'es-ES'])).toBe('fr')
    expect(pickLanguage(['pt-BR'])).toBe('pt')
    expect(pickLanguage(['ar-EG'])).toBe('ar')
    expect(pickLanguage(['zh-TW'])).toBe('zh')
  })

  it('English when the app speaks none of the preferred languages', () => {
    expect(pickLanguage(['ja-JP', 'ko-KR'])).toBe('en')
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

describe('format profiles & 26-profile contract', () => {
  it('defines the expected format lists and qualities', async () => {
    const {AUDIO_FORMATS, QUALITIES, VIDEO_FORMATS} = await import('./contract')
    expect(VIDEO_FORMATS).toEqual(['mp4', 'webm', 'mkv'])
    expect(AUDIO_FORMATS).toEqual(['m4a', 'mp3', 'opus', 'flac', 'wav'])
    expect(QUALITIES).toEqual(['best', '2160', '1440', '1080', '720', '480', '360'])
  })

  it('correctly discriminates audio vs video formats with isAudioFormat', async () => {
    const {isAudioFormat} = await import('./contract')
    expect(isAudioFormat('mp4')).toBe(false)
    expect(isAudioFormat('webm')).toBe(false)
    expect(isAudioFormat('mkv')).toBe(false)
    expect(isAudioFormat('m4a')).toBe(true)
    expect(isAudioFormat('mp3')).toBe(true)
    expect(isAudioFormat('opus')).toBe(true)
    expect(isAudioFormat('flac')).toBe(true)
    expect(isAudioFormat('wav')).toBe(true)
  })

  it('generates all 21 video profiles and 5 audio profiles (26 total) via toProfile', async () => {
    const {AUDIO_FORMATS, QUALITIES, toProfile, VIDEO_FORMATS} = await import('./contract')

    // 21 video profiles
    for (const container of VIDEO_FORMATS) {
      for (const quality of QUALITIES) {
        const profile = toProfile({format: container, quality})
        expect(profile.kind).toBe('video')
        if (profile.kind === 'video') {
          expect(profile.container).toBe(container)
          if (quality === 'best') {
            expect(profile.maxHeight).toBeUndefined()
          } else {
            expect(profile.maxHeight).toBe(Number(quality))
          }
        }
      }
    }

    // 5 audio profiles
    for (const container of AUDIO_FORMATS) {
      for (const quality of QUALITIES) {
        // audio format must ignore quality
        const profile = toProfile({format: container, quality})
        expect(profile.kind).toBe('audio')
        if (profile.kind === 'audio') {
          expect(profile.container).toBe(container)
        }
      }
    }
  })
})
