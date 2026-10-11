import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {BatchId, LogEntry} from 'media-downloader-core'
import {afterEach, describe, expect, it} from 'vitest'
import {App} from './App'
import {setApi} from './api'
import {AppStore} from './store'
import {batch, FakeApi, job, NOT_READY} from './test/fake-api'

afterEach(() => setApi(undefined))

async function mount(api = new FakeApi()) {
  setApi(api)
  const target = new AppStore()
  render(<App target={target} />)
  await screen.findByText('Media Download Core')
  return {api, target, user: userEvent.setup()}
}

describe('download bar', () => {
  it('rejects an invalid url and schedules a valid one with the chosen format, quality and folder', async () => {
    const {api, user} = await mount()
    const input = screen.getByLabelText('Video or playlist URL')
    await user.type(input, 'not a url')
    await user.click(screen.getByRole('button', {name: /download/i}))
    expect(await screen.findByText('Enter a valid http(s) link')).toBeInTheDocument()
    expect(api.schedule).not.toHaveBeenCalled()

    await user.clear(input)
    await user.type(input, 'https://www.youtube.com/watch?v=abc')
    await user.click(screen.getByRole('button', {name: /download/i}))
    await waitFor(() =>
      expect(api.schedule).toHaveBeenCalledWith({
        url: 'https://www.youtube.com/watch?v=abc',
        format: 'mp4',
        quality: 'best',
        outDir: '/Users/me/Downloads',
      }),
    )
  })

  it('disables quality for audio formats', async () => {
    await mount(new FakeApi({settings: {format: 'mp3', quality: '1080'}}))
    const quality = screen.getByLabelText('Quality').closest('.ant-select')
    expect(quality).toHaveClass('ant-select-disabled')
    expect(screen.getByText('Best audio')).toBeInTheDocument()
  })

  it('changes the download folder through the system picker', async () => {
    const {api, user} = await mount()
    await user.click(screen.getByRole('button', {name: /change/i}))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({downloadDir: '/Volumes/Backup/Videos'}))
    expect(await screen.findByDisplayValue('/Volumes/Backup/Videos')).toBeInTheDocument()
  })

  it('says a new link will be scheduled while a batch is running', async () => {
    await mount(new FakeApi({state: {batches: [batch({status: 'running'})], jobs: []}}))
    expect(screen.getByRole('button', {name: /schedule/i})).toBeInTheDocument()
    expect(screen.getByText(/this one will start when it finishes/)).toBeInTheDocument()
  })

  it('shows the capacity rule (N/2, and fewer for long videos)', async () => {
    await mount()
    expect(screen.getByText('Up to 6 downloads at once on 12 CPUs · 4 for long videos')).toBeInTheDocument()
  })
})

describe('language and theme', () => {
  it('switches the whole interface to Spanish', async () => {
    const {api, user} = await mount()
    await user.click(screen.getByText('ES'))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({language: 'es'}))
    expect(await screen.findByText('Nueva descarga')).toBeInTheDocument()
    expect(screen.getByRole('button', {name: /descargar/i})).toBeInTheDocument()
  })

  it('switches to the dark theme', async () => {
    const {api, user} = await mount()
    expect(screen.getByTestId('theme-mode')).toHaveTextContent('light')
    await user.click(screen.getByLabelText('Dark'))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({theme: 'dark'}))
    await waitFor(() => expect(screen.getByTestId('theme-mode')).toHaveTextContent('dark'))
  })
})

describe('batches', () => {
  it('shows preflight, forecast and progress, and cancels a batch', async () => {
    const running = batch({
      status: 'running',
      estimate: {bytes: 3e9, requiredBytes: 5e9, freeBytes: 100e9, unknown: 0, archived: 1, long: 2, heavy: 0},
    })
    const {api, user} = await mount(new FakeApi({state: {batches: [running], jobs: []}}))
    const card = screen.getByTestId('batch-card')
    expect(within(card).getByText('Checked 3/3 · 2 available · 1 unavailable')).toBeInTheDocument()
    expect(within(card).getByTestId('batch-forecast')).toHaveTextContent('3 GB of new files')
    expect(within(card).getByTestId('batch-forecast')).toHaveTextContent('2 long · 0 heavy videos')
    expect(within(card).getByTestId('batch-forecast')).toHaveTextContent('1 already downloaded')
    await user.click(within(card).getByRole('button', {name: /cancel batch/i}))
    await user.click(await screen.findByRole('button', {name: /^ok$/i}))
    await waitFor(() => expect(api.cancelBatch).toHaveBeenCalledWith(running.id))
  })

  it('pages the items of a batch and patches them live', async () => {
    const running = batch()
    const api = new FakeApi({state: {batches: [running], jobs: []}})
    api.itemsPage = [
      {index: 1, url: 'https://x/1', title: 'First', state: 'ok'},
      {
        index: 2,
        url: 'https://x/2',
        title: 'Second',
        state: 'unavailable',
        error: {code: 'unavailable', hint: 'private', message: 'Private video'},
      },
    ]
    const {user} = await mount(api)
    await user.click(screen.getByRole('button', {name: /items/i}))
    expect(await screen.findByText('First')).toBeInTheDocument()
    expect(api.items).toHaveBeenCalledWith(running.id, 0, 50)
    expect(screen.getByText('Private video')).toBeInTheDocument()
    act(() =>
      api.emit({
        items: [
          {
            batchId: running.id as BatchId,
            item: {index: 1, url: 'https://x/1', title: 'First', state: 'ok', archived: true},
          },
        ],
      }),
    )
    expect(await screen.findByText('Already downloaded')).toBeInTheDocument()
  })

  it('notifies when a batch finishes', async () => {
    const running = batch({status: 'running', title: 'Road trip'})
    const api = new FakeApi()
    await mount(api)
    act(() => api.emit({batches: [running]}))
    act(() => api.emit({batches: [{...running, status: 'completed', jobs: {...running.jobs, succeeded: 3}}]}))
    expect(await screen.findByText('Batch finished')).toBeInTheDocument()
    expect(screen.getByText('Road trip: 3/3 downloaded and verified')).toBeInTheDocument()
  })

  it('does not claim files were verified when the integrity check is off', async () => {
    const running = batch({status: 'running', title: 'Road trip'})
    const api = new FakeApi({settings: {validation: 'none'}})
    await mount(api)
    act(() => api.emit({batches: [running]}))
    act(() => api.emit({batches: [{...running, status: 'completed', jobs: {...running.jobs, succeeded: 3}}]}))
    expect(await screen.findByText('Road trip: 3/3 downloaded (integrity check off)')).toBeInTheDocument()
  })

  it('stays quiet when notifications are turned off', async () => {
    const running = batch({status: 'running', title: 'Road trip'})
    const api = new FakeApi({settings: {notifications: false}})
    await mount(api)
    act(() => api.emit({batches: [running]}))
    act(() => api.emit({batches: [{...running, status: 'failed'}]}))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByText('Batch failed')).not.toBeInTheDocument()
  })
})

describe('downloads (one row per thread)', () => {
  it('lists running jobs with progress, speed, steps and tier', async () => {
    const running = job({tier: 'long', weight: 1.5, attempt: 2, title: 'Two hour concert'})
    const {user} = await mount(new FakeApi({state: {batches: [], jobs: [running]}}))
    await user.click(screen.getByRole('tab', {name: 'Downloads'}))
    expect(await screen.findByText('Two hour concert')).toBeInTheDocument()
    expect(screen.getByText('Long')).toBeInTheDocument()
    expect(screen.getByText('Attempt 2/4')).toBeInTheDocument()
    expect(screen.getByText(/2.5 MB\/s/)).toBeInTheDocument()
    expect(screen.getByTestId('step-download')).toHaveAttribute('data-state', 'in-progress')
    expect(screen.getByTestId('step-convert')).toHaveAttribute('data-state', 'pending')
  })

  it('shows the integrity report of a verified file', async () => {
    const done = job({
      status: 'completed',
      outcome: 'success',
      filepath: '/Users/me/Downloads/a.mp4',
      validation: {
        level: 'full',
        ok: true,
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        sizeBytes: 12e6,
        duration: 600,
        decodedDuration: 600,
        expectedDuration: 600,
        video: {codec: 'h264', width: 1920, height: 1080, fps: 30},
        audio: {codec: 'aac', channels: 2, sampleRate: 48000},
        sha256: 'ab'.repeat(32),
        issues: [],
      },
    })
    const {api, user} = await mount(new FakeApi({state: {batches: [], jobs: [done]}}))
    await user.click(screen.getByRole('tab', {name: 'Downloads'}))
    await user.click(await screen.findByTestId('integrity-tag'))
    const report = await screen.findByTestId('integrity-report')
    expect(report).toHaveTextContent('Full decode of every frame')
    expect(report).toHaveTextContent('h264 · 1920×1080 · 30 fps')
    expect(report).toHaveTextContent('decoded 10:00 of 10:00')
    expect(report).toHaveTextContent('abababababababab')
    await user.click(screen.getByRole('button', {name: 'Show file'}))
    expect(api.reveal).toHaveBeenCalledWith('/Users/me/Downloads/a.mp4')
  })

  it('retries a failed job and explains why it failed', async () => {
    const failed = job({
      status: 'failed',
      outcome: 'failed',
      error: {code: 'unavailable', hint: 'needs-sign-in', message: 'Sign in to confirm your age'},
    })
    const {api, user} = await mount(new FakeApi({state: {batches: [], jobs: [failed]}}))
    await user.click(screen.getByRole('tab', {name: 'Downloads'}))
    expect(await screen.findByText(/Sign-in required/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Retry'}))
    expect(api.retryJob).toHaveBeenCalledWith(failed.id)
  })

  it('pauses and resumes the queue', async () => {
    const {api, user} = await mount()
    await user.click(screen.getByRole('tab', {name: 'Downloads'}))
    await user.click(await screen.findByRole('button', {name: /pause queue/i}))
    expect(api.pause).toHaveBeenCalled()
    await user.click(await screen.findByRole('button', {name: /resume queue/i}))
    expect(api.resume).toHaveBeenCalled()
  })
})

describe('settings', () => {
  it('caps threads at N/2, changes validation and flags restart-only options', async () => {
    const {api, user} = await mount()
    await user.click(screen.getByRole('button', {name: /settings/i}))
    expect(await screen.findByText('Simultaneous downloads: 6')).toBeInTheDocument()
    expect(screen.getByText(/Capped at half your CPUs \(6 of 12\)/)).toBeInTheDocument()
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuemax', '6')

    await user.click(screen.getByLabelText('Quick — read every packet'))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({validation: 'quick'}))

    await user.click(screen.getByLabelText('Embed thumbnail as cover'))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({embedThumbnail: true}))
    expect(screen.getByText('Applies the next time the app starts.')).toBeInTheDocument()

    // the whole row is the hit target, not just the switch
    await user.click(screen.getByText('Write title / artist tags'))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({embedMetadata: false}))
  })
})

describe('setup', () => {
  it('opens on first run, installs with progress and finishes ready', async () => {
    const api = new FakeApi({diagnosis: NOT_READY})
    const {user} = await mount(api)
    expect(await screen.findByText('One-time setup')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
    await user.click(screen.getByTestId('setup-install'))
    await waitFor(() => expect(api.setup).toHaveBeenCalledWith(false))
    expect(await screen.findByText('All set — tools installed and verified.')).toBeInTheDocument()
  })
})

describe('logs', () => {
  it('shows live logs and traces an id', async () => {
    const api = new FakeApi()
    const entry: LogEntry = {
      level: 'warn',
      message: 'attempt 1/4 failed — retrying in 2.0s',
      time: 0,
      sessionId: 'S'.repeat(32),
    }
    api.searchLogs.mockResolvedValue({entries: [{...entry, message: 'batch scheduled: https://x'}], total: 1})
    const {user} = await mount(api)
    act(() => api.emit({logs: [entry]}))
    await user.click(screen.getByRole('button', {name: /logs/i}))
    expect(await screen.findByText('attempt 1/4 failed — retrying in 2.0s')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', {name: 'Trace an id'}))
    await user.type(screen.getByPlaceholderText(/Batch, job, attempt or step id/), 'AbCdEf123456{Enter}')
    await waitFor(() => expect(api.searchLogs).toHaveBeenCalledWith('AbCdEf123456', 500))
    expect(await screen.findByText('batch scheduled: https://x')).toBeInTheDocument()
  })
})

describe('about', () => {
  it('thanks Ant Design and lists the open-source credits', async () => {
    const {user} = await mount()
    await user.click(screen.getByRole('button', {name: 'About'}))
    expect(await screen.findByText(/Ant Design — the UI components of this app \(MIT\)/)).toBeInTheDocument()
    expect(screen.getByRole('link', {name: 'yt-dlp'})).toHaveAttribute('href', 'https://github.com/yt-dlp/yt-dlp')
  })
})
