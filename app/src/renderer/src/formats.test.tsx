import {render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterEach, describe, expect, it} from 'vitest'
import {AUDIO_FORMATS, QUALITIES, toProfile, VIDEO_FORMATS} from '../../shared/contract'
import {App} from './App'
import {setApi} from './api'
import {AppStore} from './store'
import {FakeApi} from './test/fake-api'

afterEach(() => setApi(undefined))

async function mount(api = new FakeApi()) {
  setApi(api)
  const target = new AppStore()
  render(<App target={target} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000})
  return {api, target, user: userEvent.setup()}
}

describe('UI Format & Quality Matrix (All 26 Profiles)', () => {
  const VIDEO_URL = 'https://www.youtube.com/watch?v=formatTest123'

  describe('Video formats (MP4, WebM, MKV) with all quality levels', () => {
    // 3 video containers * 7 qualities = 21 profiles
    for (const format of VIDEO_FORMATS) {
      for (const quality of QUALITIES) {
        it(`schedules video format ${format} at quality ${quality} producing expected profile`, async () => {
          const api = new FakeApi({
            settings: {format, quality},
          })
          const {user} = await mount(api)

          // Verify quality dropdown is enabled for video
          const qualitySelect = screen.getByLabelText('Quality').closest('.ant-select')
          expect(qualitySelect).not.toHaveClass('ant-select-disabled')

          // Input URL and submit
          const input = screen.getByLabelText('Video, playlist or profile URL')
          await user.type(input, VIDEO_URL)
          await user.click(screen.getByRole('button', {name: /download/i}))

          await waitFor(() =>
            expect(api.schedule).toHaveBeenCalledWith(
              expect.objectContaining({
                url: VIDEO_URL,
                format,
                quality,
              }),
            ),
          )

          // Verify backend profile mapping
          const expectedProfile = toProfile({format, quality})
          expect(expectedProfile.kind).toBe('video')
          if (expectedProfile.kind === 'video') {
            expect(expectedProfile.container).toBe(format)
            if (quality === 'best') {
              expect(expectedProfile.maxHeight).toBeUndefined()
            } else {
              expect(expectedProfile.maxHeight).toBe(Number(quality))
            }
          }
        })
      }
    }
  })

  describe('Audio formats (M4A, MP3, Opus, FLAC, WAV)', () => {
    // 5 audio containers = 5 profiles
    for (const format of AUDIO_FORMATS) {
      it(`disables quality dropdown and schedules audio format ${format} with "best" audio`, async () => {
        const api = new FakeApi({
          settings: {format, quality: '1080'}, // 1080 should be ignored by audio
        })
        const {user} = await mount(api)

        // Quality select must be disabled for audio
        const qualitySelect = screen.getByLabelText('Quality').closest('.ant-select')
        expect(qualitySelect).toHaveClass('ant-select-disabled')
        expect(screen.getByText('Best audio')).toBeInTheDocument()

        // Submit download
        const input = screen.getByLabelText('Video, playlist or profile URL')
        await user.type(input, VIDEO_URL)
        await user.click(screen.getByRole('button', {name: /download/i}))

        await waitFor(() =>
          expect(api.schedule).toHaveBeenCalledWith(
            expect.objectContaining({
              url: VIDEO_URL,
              format,
            }),
          ),
        )

        // Verify backend profile mapping produces audio kind with no video height
        const expectedProfile = toProfile({format, quality: 'best'})
        expect(expectedProfile.kind).toBe('audio')
        expect(expectedProfile.container).toBe(format)
      })
    }
  })

  describe('Preset buttons in DownloadBar', () => {
    it('Quick preset "Solo audio (MP3)" switches format to mp3 and disables quality', async () => {
      const api = new FakeApi({
        settings: {format: 'mp4', quality: '1080'},
      })
      const {user} = await mount(api)

      // Click "Solo audio (MP3)" button
      const mp3Button = screen.getByRole('button', {name: /Audio only \(MP3\)|Solo audio \(MP3\)/i})
      await user.click(mp3Button)

      await waitFor(() => {
        expect(api.setSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            format: 'mp3',
          }),
        )
      })
    })

    it('Quick preset "Equilibrado (720p)" switches format to mp4 720p', async () => {
      const api = new FakeApi({
        settings: {format: 'webm', quality: '2160'},
      })
      const {user} = await mount(api)

      const balancedButton = screen.getByRole('button', {name: /Balanced \(720p\)|Equilibrado \(720p\)/i})
      await user.click(balancedButton)

      await waitFor(() => {
        expect(api.setSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            format: 'mp4',
            quality: '720',
          }),
        )
      })
    })
  })

  describe('Playlist preview selection across formats', () => {
    const listPreview = {
      kind: 'playlist' as const,
      title: 'Sample Album',
      uploader: 'Artist',
      entries: [
        {
          id: 'track1',
          index: 1,
          url: 'https://www.youtube.com/watch?v=track1',
          title: 'Track 1',
          uploader: 'Artist',
          duration: 180,
          extractor: 'Youtube',
          isLive: false,
        },
        {
          id: 'track2',
          index: 2,
          url: 'https://www.youtube.com/watch?v=track2',
          title: 'Track 2',
          uploader: 'Artist',
          duration: 210,
          extractor: 'Youtube',
          isLive: false,
        },
      ],
      mix: false,
      maxItems: 50,
    }

    it('schedules playlist preview selections using the configured format (FLAC)', async () => {
      const api = new FakeApi({
        settings: {format: 'flac', quality: 'best'},
      })
      api.preview = listPreview
      const {user} = await mount(api)

      const input = screen.getByLabelText('Video, playlist or profile URL')
      await user.type(input, 'https://www.youtube.com/playlist?list=sample')
      await user.click(screen.getByRole('button', {name: /download/i}))

      const dialog = (await screen.findByText('Choose what to download')).closest('.ant-modal') as HTMLElement
      expect(within(dialog).getByText('Track 1')).toBeInTheDocument()

      // Confirm download
      await user.click(within(dialog).getByRole('button', {name: /download/i}))

      await waitFor(() =>
        expect(api.schedule).toHaveBeenCalledWith(
          expect.objectContaining({
            format: 'flac',
            selection: expect.objectContaining({
              title: 'Sample Album',
            }),
          }),
        ),
      )
    })

    it('schedules playlist preview selections using MKV 1080p', async () => {
      const api = new FakeApi({
        settings: {format: 'mkv', quality: '1080'},
      })
      api.preview = listPreview
      const {user} = await mount(api)

      const input = screen.getByLabelText('Video, playlist or profile URL')
      await user.type(input, 'https://www.youtube.com/playlist?list=sample')
      await user.click(screen.getByRole('button', {name: /download/i}))

      const dialog = (await screen.findByText('Choose what to download')).closest('.ant-modal') as HTMLElement
      await user.click(within(dialog).getByRole('button', {name: /download/i}))

      await waitFor(() =>
        expect(api.schedule).toHaveBeenCalledWith(
          expect.objectContaining({
            format: 'mkv',
            quality: '1080',
          }),
        ),
      )
    })
  })

  describe('TikTok slideshow format handling in UI', () => {
    it('passes video slideshow settings with video format (WebM)', async () => {
      const api = new FakeApi({
        settings: {
          format: 'webm',
          quality: '720',
          slideshowMode: 'video',
          slideshowSeconds: 5,
        },
      })
      const {user} = await mount(api)

      const input = screen.getByLabelText('Video, playlist or profile URL')
      await user.type(input, VIDEO_URL)
      await user.click(screen.getByRole('button', {name: /download/i}))

      await waitFor(() =>
        expect(api.schedule).toHaveBeenCalledWith(
          expect.objectContaining({
            format: 'webm',
            quality: '720',
            slideshow: {mode: 'video', secondsPerImage: 5},
          }),
        ),
      )
    })

    it('passes audio format without requiring slideshow video configuration', async () => {
      const api = new FakeApi({
        settings: {
          format: 'opus',
          slideshowMode: 'images-audio',
          slideshowSeconds: 3,
        },
      })
      const {user} = await mount(api)

      const input = screen.getByLabelText('Video, playlist or profile URL')
      await user.type(input, VIDEO_URL)
      await user.click(screen.getByRole('button', {name: /download/i}))

      await waitFor(() =>
        expect(api.schedule).toHaveBeenCalledWith(
          expect.objectContaining({
            format: 'opus',
          }),
        ),
      )
    })
  })
})
