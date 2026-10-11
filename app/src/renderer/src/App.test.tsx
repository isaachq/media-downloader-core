import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {BatchId, LogEntry} from 'media-downloader-core'
import {afterEach, describe, expect, it} from 'vitest'
import type {Preview} from '../../shared/contract'
import {App} from './App'
import {setApi} from './api'
import {AppStore} from './store'
import {batch, FakeApi, job, NOT_READY} from './test/fake-api'

afterEach(() => setApi(undefined))

async function mount(api = new FakeApi()) {
  setApi(api)
  const target = new AppStore()
  render(<App target={target} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000}) // rendered once the start-up phases are done
  return {api, target, user: userEvent.setup()}
}

describe('start-up', () => {
  it('walks the phases, retries a failing one and opens the app', async () => {
    const api = new FakeApi()
    const real = api.doctor.getMockImplementation()!
    api.doctor
      .mockRejectedValueOnce(new Error('ffprobe timed out'))
      .mockRejectedValueOnce(new Error('ffprobe timed out'))
    setApi(api)
    render(<App target={new AppStore()} />)
    expect(await screen.findByText('Checking yt-dlp and FFmpeg…')).toBeInTheDocument()
    expect(await screen.findByText('Retrying (2/3)…')).toBeInTheDocument()
    await screen.findByTestId('theme-mode', {}, {timeout: 5000})
    expect(api.doctor).toHaveBeenCalledTimes(3)
    api.doctor.mockImplementation(real)
  })

  it('says which phase failed and why, and Retry resumes from that phase', async () => {
    const api = new FakeApi()
    api.getSettings.mockRejectedValue(
      new Error(
        "Error invoking remote method 'mdc:settings:get': Error: EACCES: permission denied, open 'settings.json'",
      ),
    )
    setApi(api)
    render(<App target={new AppStore()} />)
    const screenEl = await screen.findByTestId('boot-screen', {}, {timeout: 5000})
    await waitFor(() => expect(screenEl).toHaveAttribute('data-status', 'failed'), {timeout: 5000})
    expect(screen.getByText('Failed at: Loading your settings…')).toBeInTheDocument()
    expect(screen.getByTestId('boot-error')).toHaveTextContent("EACCES: permission denied, open 'settings.json'")
    expect(api.getSettings).toHaveBeenCalledTimes(3)

    api.getSettings.mockResolvedValue(api.settings)
    await userEvent.setup().click(screen.getByRole('button', {name: /retry/i}))
    await screen.findByTestId('theme-mode', {}, {timeout: 5000})
    expect(api.info).toHaveBeenCalledTimes(1) // finished phases are not repeated
  })
})

describe('download bar', () => {
  it('rejects an invalid url and schedules a valid one with the chosen format, quality and folder', async () => {
    const {api, user} = await mount()
    const input = screen.getByLabelText('Video, playlist or profile URL')
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
    expect(screen.getByText(/a new link is queued and starts on its own after it/)).toBeInTheDocument()
  })

  it('shows the capacity rule (N/2, and fewer for long videos)', async () => {
    await mount()
    expect(screen.getByText('Up to 6 downloads at once on 12 CPUs · 4 for long videos')).toBeInTheDocument()
  })
})

describe('preview before downloading a list', () => {
  const entry = (index: number, title: string, uploader = 'Some channel') => ({
    id: `v${index}`,
    index,
    url: `https://www.youtube.com/watch?v=v${index}`,
    title,
    uploader,
    duration: 200 + index,
    extractor: 'Youtube',
    isLive: false,
  })
  const list = (patch: Partial<Extract<Preview, {kind: 'playlist'}>> = {}): Preview => ({
    kind: 'playlist',
    title: 'Road trip',
    uploader: 'DJ Test',
    entries: [
      entry(1, 'Alpha song'),
      entry(2, 'Beta song', 'Other artist'),
      entry(3, 'Gamma song'),
      entry(4, 'Delta song'),
    ],
    mix: false,
    maxItems: 5000,
    ...patch,
  })
  const LINK = 'https://www.youtube.com/watch?v=v1&list=PLx'

  async function open(preview: Preview) {
    const api = new FakeApi()
    api.preview = preview
    const ctx = await mount(api)
    await ctx.user.type(screen.getByLabelText('Video, playlist or profile URL'), LINK)
    await ctx.user.click(screen.getByRole('button', {name: /download/i}))
    const dialog = (await screen.findByText('Choose what to download')).closest('.ant-modal') as HTMLElement
    return {...ctx, dialog}
  }

  it('lists everything first, lets you pick some, and schedules exactly those', async () => {
    const {api, user, dialog} = await open(list())
    expect(api.analyze).toHaveBeenCalledWith(LINK)
    expect(api.schedule).not.toHaveBeenCalled()
    expect(within(dialog).getByText('Delta song')).toBeInTheDocument()
    expect(within(dialog).getByTestId('preview-summary')).toHaveTextContent('4 of 4 selected · 13:30')

    // filter, then unselect what is visible: only the match is affected
    await user.type(within(dialog).getByLabelText('Filter by title or channel'), 'other artist')
    expect(within(dialog).queryByText('Alpha song')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', {name: 'Select none'}))
    expect(within(dialog).getByTestId('preview-summary')).toHaveTextContent('3 of 4 selected')
    await user.clear(within(dialog).getByLabelText('Filter by title or channel'))

    // a click on the row toggles it too
    await user.click(within(dialog).getByText('Gamma song'))
    expect(within(dialog).getByTestId('preview-summary')).toHaveTextContent('2 of 4 selected · 6:45')

    await user.click(within(dialog).getByRole('button', {name: /Download 2/}))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1))
    const input = api.schedule.mock.calls[0]![0]
    expect(input.url).toBe(LINK)
    expect(input.selection?.title).toBe('Road trip')
    expect(input.selection?.entries.map(e => e.title)).toEqual(['Alpha song', 'Delta song'])
  })

  it('can download only the video the link points at', async () => {
    const {api, user, dialog} = await open(list({singleVideoUrl: 'https://www.youtube.com/watch?v=v1'}))
    await user.click(within(dialog).getByRole('button', {name: 'Only this video'}))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1))
    expect(api.schedule.mock.calls[0]![0]).toMatchObject({url: 'https://www.youtube.com/watch?v=v1'})
    expect(api.schedule.mock.calls[0]![0].selection).toBeUndefined()
  })

  it('explains a YouTube Mix and reloads it with another size', async () => {
    const {api, user, dialog} = await open(list({mix: true, maxItems: 50}))
    expect(within(dialog).getByText(/YouTube Mix — generated on the fly/)).toBeInTheDocument()
    const size = within(dialog).getByLabelText('Load')
    await user.clear(size)
    await user.type(size, '20')
    await user.click(within(dialog).getByRole('button', {name: /Reload/}))
    await waitFor(() => expect(api.analyze).toHaveBeenLastCalledWith(LINK, 20))
  })

  it('cannot confirm an empty selection', async () => {
    const {user, dialog} = await open(list())
    await user.click(within(dialog).getByRole('button', {name: 'Select none'}))
    expect(within(dialog).getByRole('button', {name: /Download 0/})).toBeDisabled()
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

  it('shows the estimated time left of a running batch, and says when it is still measuring', async () => {
    // same createdAt on purpose: the list order must not matter, each card is found by its title
    const createdAt = Date.now()
    const measured = batch({
      status: 'running',
      title: 'Measured',
      createdAt,
      progress: {fraction: 0.4, etaSeconds: 754},
    })
    const fresh = batch({status: 'running', title: 'Fresh', createdAt, progress: {fraction: 0}})
    await mount(new FakeApi({state: {batches: [measured, fresh], jobs: []}}))
    const eta = (title: string) =>
      within(screen.getByText(title).closest('[data-testid="batch-card"]') as HTMLElement).getByTestId('batch-eta')
    expect(eta('Measured')).toHaveTextContent(/About 13 min left · done around \d{1,2}:\d{2}.*\(estimate/)
    expect(eta('Fresh')).toHaveTextContent('Estimating the time left…')
  })

  it('clears finished batches and keeps the ones still working', async () => {
    const done = batch({status: 'completed', title: 'Done list'})
    const failed = batch({status: 'failed', title: 'Broken list'})
    const running = batch({status: 'running', title: 'Busy list'})
    const finishedJob = job({batchId: done.id, status: 'completed', outcome: 'success', title: 'Old video'})
    const {api, user} = await mount(new FakeApi({state: {batches: [done, failed, running], jobs: [finishedJob]}}))
    expect(screen.getAllByTestId('batch-card')).toHaveLength(3)

    await user.click(screen.getByRole('button', {name: /Clear finished batches \(2\)/}))
    await waitFor(() => expect(api.clearFinished).toHaveBeenCalledTimes(1))
    expect(screen.getAllByTestId('batch-card')).toHaveLength(1)
    expect(screen.getByText('Busy list')).toBeInTheDocument()
    expect(screen.queryByText('Done list')).not.toBeInTheDocument()
    expect(screen.getByRole('button', {name: /Clear finished batches \(0\)/})).toBeDisabled()

    await user.click(screen.getByRole('tab', {name: 'Downloads'}))
    expect(screen.queryByText('Old video')).not.toBeInTheDocument()
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

    // car / USB friendly names are on by default and apply at once
    expect(screen.getByRole('switch', {name: /Car & USB friendly names/})).toBeChecked()
    await user.click(screen.getByText(/Car & USB friendly names/))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({portableNames: false}))
    expect(screen.getByText(/001-Cancion-Nandu-k1gsZ\.mp3/)).toBeInTheDocument()

    // the whole row is the hit target, not just the switch
    await user.click(screen.getByText('Write title / artist tags'))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({embedMetadata: false}))
  })
})

describe('setup', () => {
  it('opens Diagnose from Settings in front of the drawer', async () => {
    const {api, user} = await mount()
    await user.click(screen.getByRole('button', {name: /settings/i}))
    await user.click(await screen.findByRole('button', {name: /run diagnostics/i}))
    await waitFor(() => expect(api.doctor).toHaveBeenCalledTimes(2)) // boot + click
    await screen.findByText('One-time setup')
    const modal = document.querySelector('.ant-modal-wrap') as HTMLElement
    expect(modal).toBeVisible()
    const drawer = document.querySelector('.ant-drawer') as HTMLElement
    // Ant Design layers popups from 1000; an unset z-index means that base
    const layer = (element: HTMLElement) => Number.parseInt(getComputedStyle(element).zIndex, 10) || 1000
    expect(layer(modal)).toBeGreaterThan(layer(drawer))
  })

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

  it('shows the trace ids of every live line, and clicking one traces it', async () => {
    const api = new FakeApi()
    const ids = {
      batchId: `B${'1'.repeat(31)}`,
      jobId: `J${'2'.repeat(31)}`,
      attemptId: `A${'3'.repeat(31)}`,
      stepId: `T${'4'.repeat(31)}`,
    }
    const entry = {level: 'info', message: 'download finished', time: 0, sessionId: 'S'.repeat(32), ...ids} as LogEntry
    api.searchLogs.mockResolvedValue({entries: [entry], total: 1})
    const {user} = await mount(api)
    act(() => api.emit({logs: [entry]}))
    await user.click(screen.getByRole('button', {name: /logs/i}))
    const line = (await screen.findByText('download finished')).closest('.log-line') as HTMLElement
    const shown = within(line).getByTestId('log-ids')
    for (const id of Object.values(ids)) expect(shown).toHaveTextContent(id)
    expect(shown).toHaveTextContent(/batch.*job.*attempt.*step/)

    await user.click(within(line).getByText(ids.jobId))
    await waitFor(() => expect(api.searchLogs).toHaveBeenCalledWith(ids.jobId, 500))
    expect(screen.getByRole('tab', {name: 'Trace an id', selected: true})).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Batch, job, attempt or step id/)).toHaveValue(ids.jobId)
    expect(await screen.findByText('1 of 1 entries')).toBeInTheDocument()
  })
})

describe('updates', () => {
  it('announces a new version; one button downloads, installs and restarts', async () => {
    const api = new FakeApi()
    api.update = {
      status: 'available',
      version: '0.3.0-beta.1',
      notes: 'TikTok',
      page: 'https://example.com/r',
      size: 126e6,
    }
    const {user} = await mount(api)
    const banner = await screen.findByTestId('update-banner')
    expect(banner).toHaveTextContent('Version 0.3.0-beta.1 is available')
    expect(banner).toHaveTextContent('126 MB')
    await user.click(within(banner).getByRole('button', {name: 'Update now'}))
    expect(api.installUpdate).toHaveBeenCalledTimes(1)

    act(() => api.pushUpdate({status: 'downloading', version: '0.3.0-beta.1', page: 'p', received: 63e6, total: 126e6}))
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Downloading version 0.3.0-beta.1')
    expect(screen.getByTestId('update-banner')).toHaveTextContent('50%')
    act(() => api.pushUpdate({status: 'installing', version: '0.3.0-beta.1', page: 'p'}))
    expect(screen.getByTestId('update-banner')).toHaveTextContent('the app restarts in a moment')
  })

  it('stays out of the way when up to date, and explains a failed install', async () => {
    const api = new FakeApi()
    await mount(api)
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument()
    act(() =>
      api.pushUpdate({status: 'error', version: '0.3.0', page: 'p', message: 'The update does not match the checksum'}),
    )
    const banner = screen.getByTestId('update-banner')
    expect(banner).toHaveTextContent('The update could not be installed')
    expect(banner).toHaveTextContent('checksum')
    expect(within(banner).getByRole('button', {name: /Try again/})).toBeInTheDocument()
  })

  it('About checks for updates on demand; Settings can turn the automatic check off', async () => {
    const {api, user} = await mount()
    await user.click(screen.getByRole('button', {name: /about/i}))
    await user.click(await screen.findByRole('button', {name: 'Check for updates'}))
    expect(api.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(screen.getByText('You have the latest version')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', {name: /settings/i}))
    await user.click(await screen.findByText('Check for updates automatically'))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({autoUpdate: false}))
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
