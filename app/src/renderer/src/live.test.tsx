import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {JobId} from 'media-downloader-core'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {App} from './App'
import {setApi} from './api'
import {AppStore} from './store'
import {FakeApi, job} from './test/fake-api'

// jsdom has no MediaSource: hls.js stands in, recording what the player asked of it
const hls = vi.hoisted(() => ({sources: [] as string[], destroyed: 0}))
vi.mock('hls.js', () => {
  class Hls {
    static isSupported = () => true
    static Events = {ERROR: 'hlsError'}
    on() {}
    loadSource(src: string) {
      hls.sources.push(src)
    }
    attachMedia() {}
    destroy() {
      hls.destroyed++
    }
  }
  return {default: Hls}
})

// unmount first: a closing player lets its session go through the bridge
afterEach(() => {
  cleanup()
  setApi(undefined)
})

async function mount(api = new FakeApi()) {
  setApi(api)
  const target = new AppStore()
  render(<App target={target} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000})
  return {api, target, user: userEvent.setup()}
}

const FIELD = 'Video, playlist or profile URL'
const CHANNEL = 'https://www.twitch.tv/liveonair'

function liveApi() {
  const api = new FakeApi()
  api.preview = {
    kind: 'video',
    title: 'Speedrun night',
    live: {channel: 'LiveOnAir', startedAt: Date.UTC(2026, 9, 27, 18, 0)},
  }
  const recording = job({
    id: 'Jrec' as JobId,
    url: CHANNEL,
    title: 'LiveOnAir Speedrun night',
    status: 'downloading',
    progress: {live: true, elapsedSec: 0, bytes: 0},
  })
  api.recorded = recording
  return {api, recording}
}

async function startRecording() {
  const {api, recording} = liveApi()
  const mounted = await mount(api)
  await mounted.user.type(screen.getByLabelText(FIELD), CHANNEL)
  await mounted.user.click(screen.getByRole('button', {name: /download/i}))
  const modal = await screen.findByTestId('live-modal')
  await mounted.user.click(within(modal).getByRole('button', {name: /record/i}))
  return {...mounted, recording}
}

describe('a live Twitch channel', () => {
  it('opens the live choice, not a download; Record starts a recording of its own', async () => {
    const {api, recording} = await startRecording()
    expect(api.schedule).not.toHaveBeenCalled()
    expect(api.record).toHaveBeenCalledWith(expect.objectContaining({url: CHANNEL}))
    const card = await screen.findByTestId('recordings')
    expect(card).toHaveTextContent('LiveOnAir Speedrun night')
    expect(within(card).getByText(/REC/)).toBeInTheDocument()
    expect(screen.queryByTestId('live-modal')).not.toBeInTheDocument()

    // the engine reports how far it got: a clock, never a percent
    act(() =>
      api.emit({jobs: [{...recording, progress: {live: true, elapsedSec: 125, bytes: 48_000_000, speed: 800_000}}]}),
    )
    expect(await within(card).findByTestId('recording-elapsed')).toHaveTextContent('2:05 recorded')
    expect(card).not.toHaveTextContent('%')
  })

  it('Stop and save stops it; Discard asks first, then cancels it', async () => {
    const {api, user, recording} = await startRecording()
    const card = await screen.findByTestId('recordings')
    await user.click(within(card).getByTestId('recording-stop'))
    expect(api.stopJob).toHaveBeenCalledWith(recording.id)

    await user.click(within(card).getByTestId('recording-discard'))
    expect(api.cancelJob).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', {name: 'Discard', hidden: false}))
    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith(recording.id))
  })

  it('after Stop it says it is saving; once completed it leaves the card', async () => {
    const {api, recording} = await startRecording()
    const card = await screen.findByTestId('recordings')
    act(() => api.emit({jobs: [{...recording, status: 'validating', progress: {live: true, elapsedSec: 180}}]}))
    expect(await within(card).findByText('Saving the recording…')).toBeInTheDocument()
    expect(within(card).queryByTestId('recording-stop')).not.toBeInTheDocument()
    act(() =>
      api.emit({
        jobs: [
          {
            ...recording,
            status: 'completed',
            outcome: 'success',
            recording: {
              ended: 'stopped',
              seconds: 202,
              segments: 101,
              gaps: 0,
              lostSegments: 0,
              skippedSeconds: 30,
              refreshes: 0,
            },
          },
        ],
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('recordings')).not.toBeInTheDocument())
  })

  it('Watch opens the player on the main process proxy, and closing it lets the session go', async () => {
    hls.sources.length = 0
    const {api, user} = await mount(liveApi().api)
    await user.type(screen.getByLabelText(FIELD), CHANNEL)
    await user.click(screen.getByRole('button', {name: /download/i}))
    const modal = await screen.findByTestId('live-modal')
    await user.click(within(modal).getByRole('button', {name: /watch/i}))
    await waitFor(() => expect(hls.sources).toEqual(['mdc-live://sid1/master.m3u8']))
    expect(api.liveOpen).toHaveBeenCalledWith(CHANNEL)
    const player = await screen.findByTestId('live-player')
    fireEvent.click(within(player).getByRole('button', {name: /close/i}))
    await waitFor(() => expect(api.liveClose).toHaveBeenCalledWith('sid1'))
    expect(api.record).not.toHaveBeenCalled()
  })

  it('a channel off the air: the player says so and offers Try again', async () => {
    const {api, user} = await mount(liveApi().api)
    api.liveOpen.mockResolvedValueOnce(undefined as never)
    await user.type(screen.getByLabelText(FIELD), CHANNEL)
    await user.click(screen.getByRole('button', {name: /download/i}))
    await user.click(within(await screen.findByTestId('live-modal')).getByRole('button', {name: /watch/i}))
    expect(await screen.findByTestId('live-player-error')).toHaveTextContent('The live player stopped')
    await user.click(screen.getByRole('button', {name: 'Try again'}))
    await waitFor(() => expect(api.liveOpen).toHaveBeenCalledTimes(2))
  })
})

describe('quitting with a recording running', () => {
  it('asks: keep recording closes the question; stop, save and quit answers save', async () => {
    const {api, user} = await mount()
    act(() => api.requestQuit(1))
    const ask = await screen.findByText('A recording is running')
    expect(ask).toBeInTheDocument()
    expect(
      screen.getByText('1 recording(s) still running. Save what was recorded before quitting?'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Keep recording'}))
    expect(api.quitWith).toHaveBeenCalledWith('keep')
    await waitFor(() => expect(screen.queryByText('A recording is running')).not.toBeInTheDocument())

    act(() => api.requestQuit(2))
    await user.click(await screen.findByRole('button', {name: 'Stop, save and quit'}))
    expect(api.quitWith).toHaveBeenLastCalledWith('save')
  })
})
