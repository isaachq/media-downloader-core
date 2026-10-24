// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {detectLink, pickLanguage} from './contract'

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

describe('the site a link belongs to (the core’s detection, as the app uses it)', () => {
  const site = (text: string, aliases?: Parameters<typeof detectLink>[1]) => detectLink(text, aliases)?.site

  it('tells YouTube, TikTok, Instagram, Facebook, VK and X apart; anything else is a website', () => {
    expect(site('https://www.youtube.com/watch?v=1')).toBe('youtube')
    expect(site('https://youtu.be/1')).toBe('youtube')
    expect(site('https://www.tiktok.com/@someone/video/1')).toBe('tiktok')
    expect(site('https://vm.tiktok.com/ZM1/')).toBe('tiktok')
    expect(site('https://www.instagram.com/reel/abc/')).toBe('instagram')
    expect(site('https://instagr.am/p/abc')).toBe('instagram')
    expect(site('https://m.facebook.com/watch/?v=1')).toBe('facebook')
    expect(site('https://fb.watch/xyz/')).toBe('facebook')
    expect(site('https://vk.com/video-1_2')).toBe('vk')
    expect(site('https://x.com/someone/status/1')).toBe('x')
    expect(site('https://twitter.com/someone/status/1')).toBe('x')
    expect(site('https://www.trannyvideosx.com/video/81455/ts-havenna-sofia-solo-1')).toBe('web')
  })

  it('finds the link in shared text, a look-alike host is not the site, a fake counts by its alias', () => {
    expect(detectLink('Look at this! https://www.tiktok.com/@a/video/1 :)')?.url).toBe(
      'https://www.tiktok.com/@a/video/1',
    )
    expect(site('https://nottiktok.com/@x')).toBe('web')
    expect(site('https://tiktok.com.evil.test/@x')).toBe('web')
    expect(site('http://127.0.0.1:4100/@a', {'127.0.0.1:4100': 'tiktok'})).toBe('tiktok')
    expect(detectLink('https://cdn.example.org/clip.mp4')?.file).toBe(true)
  })

  it('no site for what is not an http(s) link', () => {
    expect(site('ftp://tiktok.com/x')).toBeUndefined()
    expect(site('not a link')).toBeUndefined()
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
