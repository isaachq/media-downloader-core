import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {BatchId} from 'media-downloader-core'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {FinishedEntry} from '../../shared/contract'
import {App} from './App'
import {setApi} from './api'
import {extractUrls} from './format'
import {AppStore} from './store'
import {batch, FakeApi, job} from './test/fake-api'

afterEach(() => setApi(undefined))

async function mount(api = new FakeApi()) {
  setApi(api)
  render(<App target={new AppStore()} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000})
  return {api, user: userEvent.setup()}
}

/** Pick an option of the batch filter shown in `scope`. */
async function pickBatch(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, label: RegExp) {
  await user.click(within(scope).getByRole('combobox', {name: 'Batch'}))
  await user.click(await screen.findByText(label, {selector: '.ant-select-item-option-content'}))
}

describe('failures by cause, and retrying them', () => {
  it('a batch tells why items failed and retries them in one click', async () => {
    const closed = batch({
      title: 'Road trip',
      status: 'completed-with-errors',
      jobs: {total: 5, queued: 0, running: 0, succeeded: 3, failed: 2, cancelled: 0},
      problems: {failed: {network: 1, removed: 1}, unavailable: {private: 2}},
    })
    const {api, user} = await mount(new FakeApi({state: {batches: [closed], jobs: []}}))
    const card = screen.getByTestId('batch-card')
    expect(within(card).getByTestId('problems')).toHaveTextContent('Failednetwork 1 · removed 1')
    expect(within(card).getByTestId('problems')).toHaveTextContent('Unavailableprivate 2')
    await user.click(within(card).getByTestId('batch-retry-failed'))
    expect(api.retryBatch).toHaveBeenCalledWith(closed.id)
    expect(await screen.findByText('Retrying 1 item(s)')).toBeInTheDocument()
  })

  it('the report sums causes over the run and retries every batch with failures', async () => {
    const a = batch({
      status: 'completed-with-errors',
      jobs: {total: 2, queued: 0, running: 0, succeeded: 1, failed: 1, cancelled: 0},
      problems: {failed: {network: 1}, unavailable: {}},
    })
    const b = batch({
      status: 'failed',
      jobs: {total: 1, queued: 0, running: 0, succeeded: 0, failed: 1, cancelled: 0},
      problems: {failed: {network: 1}, unavailable: {removed: 3}},
    })
    const {api, user} = await mount(new FakeApi({state: {batches: [a, b], jobs: []}}))
    await user.click(screen.getByTestId('open-report'))
    const report = await screen.findByTestId('report')
    expect(within(report).getAllByTestId('problems')[0]).toHaveTextContent('Failednetwork 2')
    expect(within(report).getAllByTestId('problems')[0]).toHaveTextContent('Unavailableremoved 3')
    await user.click(within(report).getByTestId('report-retry-all'))
    await waitFor(() => expect(api.retryBatch).toHaveBeenCalledTimes(2))
  })

  it('speaks Spanish', async () => {
    const closed = batch({
      status: 'failed',
      jobs: {total: 1, queued: 0, running: 0, succeeded: 0, failed: 1, cancelled: 0},
      problems: {failed: {removed: 1}, unavailable: {}},
    })
    await mount(new FakeApi({settings: {language: 'es'}, state: {batches: [closed], jobs: []}}))
    expect(screen.getByTestId('problems')).toHaveTextContent('Fallaroneliminados 1')
    expect(screen.getByTestId('batch-retry-failed')).toHaveTextContent('Reintentar fallidos (1)')
  })
})

describe('downloads and finished, one batch at a time', () => {
  const entry = (key: string, title: string, batchId?: string, batchTitle?: string): FinishedEntry => ({
    key,
    title,
    filepath: `/Users/me/Downloads/${title}.mp4`,
    sizeBytes: 1000,
    extractor: 'Youtube',
    url: `https://example.com/${key}`,
    completedAt: 1,
    sha256: 'a'.repeat(64),
    validation: 'full',
    file: 'ok',
    ...(batchId && {batchId, batchTitle}),
  })

  it('the Downloads tab filters by batch, and a batch card opens it filtered', async () => {
    const trip = batch({
      id: 'B-trip' as BatchId,
      title: 'Road trip',
      jobs: {total: 1, queued: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0},
    })
    const gym = batch({
      id: 'B-gym' as BatchId,
      title: 'Gym mix',
      jobs: {total: 1, queued: 0, running: 1, succeeded: 0, failed: 0, cancelled: 0},
    })
    const api = new FakeApi({
      state: {
        batches: [trip, gym],
        jobs: [job({batchId: trip.id, title: 'Trip song'}), job({batchId: gym.id, title: 'Gym song'})],
      },
    })
    const {user} = await mount(api)
    await user.click(screen.getByRole('tab', {name: /^Downloads/}))
    expect(screen.getByText('Trip song')).toBeInTheDocument()
    expect(screen.getByText('Gym song')).toBeInTheDocument()
    await pickBatch(user, document.body, /^Gym mix/)
    await waitFor(() => expect(screen.queryByText('Trip song')).not.toBeInTheDocument())
    expect(screen.getByText('Gym song')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', {name: /^Batches/}))
    const tripCard = screen.getAllByTestId('batch-card').find(card => card.textContent?.includes('Road trip'))!
    await user.click(within(tripCard).getByTestId('batch-show-jobs'))
    expect(screen.getByRole('tab', {name: /^Downloads/})).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Trip song')).toBeInTheDocument()
    expect(screen.queryByText('Gym song')).not.toBeInTheDocument()
  })

  it('the Finished tab filters by batch of any session, checks again, exports and forgets', async () => {
    const api = new FakeApi()
    api.finishedEntries = [
      entry('k1', 'Old clip'),
      entry('k2', 'Trip one', 'B-trip', 'Road trip'),
      entry('k3', 'Trip two', 'B-trip', 'Road trip'),
      entry('k4', 'Gym one', 'B-gym', 'Gym mix'),
    ]
    api.verifySummary = {checked: 2, ok: 1, missing: 1, changed: 0, corrupted: 0}
    const {user} = await mount(api)
    await user.click(screen.getByRole('tab', {name: /^Finished/}))
    const list = await screen.findByTestId('finished-list')
    expect(await within(list).findByText('Old clip')).toBeInTheDocument()

    await pickBatch(user, list, /^Road trip · 2/)
    await waitFor(() => expect(within(list).queryByText('Old clip')).not.toBeInTheDocument())
    expect(api.finished).toHaveBeenLastCalledWith(expect.objectContaining({batchId: 'B-trip'}))
    expect(within(list).getByText('Trip one')).toBeInTheDocument()

    // check again: the batch's files; a problem is shown in a dialog
    await user.click(within(list).getByTestId('finished-verify'))
    expect(api.verifyFinished).toHaveBeenLastCalledWith({all: true, search: undefined, batchId: 'B-trip'})
    expect(await screen.findByText('Checked 2: 1 intact · 1 missing · 0 changed size · 0 damaged')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'OK'}))

    await user.click(within(list).getByRole('button', {name: /Export CSV/}))
    expect(api.exportFinished).toHaveBeenLastCalledWith({all: true, search: undefined, batchId: 'B-trip'})
    expect(await screen.findByText('Saved /Users/me/Downloads/finished.csv')).toBeInTheDocument()

    // pick one row, forget it (the file stays)
    const row = within(list)
      .getAllByRole('row')
      .find(r => r.textContent?.includes('Trip two'))!
    await user.click(within(row).getByRole('checkbox'))
    await user.click(within(list).getByTestId('finished-remove'))
    const confirm = (await screen.findByText('The files stay on your disk; only this list forgets them.')).closest(
      '.ant-popover',
    ) as HTMLElement
    await user.click(within(confirm).getByRole('button', {name: 'OK'}))
    await waitFor(() => expect(api.removeFinished).toHaveBeenCalledWith(['k3']))
    await waitFor(() => expect(within(list).queryByText('Trip two')).not.toBeInTheDocument())
  })

  it('a batch card opens Finished filtered to its files', async () => {
    const api = new FakeApi({
      state: {
        batches: [
          batch({
            id: 'B-trip' as BatchId,
            title: 'Road trip',
            status: 'completed',
            jobs: {total: 2, queued: 0, running: 0, succeeded: 2, failed: 0, cancelled: 0},
          }),
        ],
        jobs: [],
      },
    })
    api.finishedEntries = [entry('k1', 'Old clip'), entry('k2', 'Trip one', 'B-trip', 'Road trip')]
    const {user} = await mount(api)
    await user.click(screen.getByTestId('batch-show-finished'))
    const list = await screen.findByTestId('finished-list')
    expect(await within(list).findByText('Trip one')).toBeInTheDocument()
    expect(within(list).queryByText('Old clip')).not.toBeInTheDocument()
  })
})

describe('notifications outside the app', () => {
  it('a batch that finishes while the app is in the background notifies through the system; a click brings it back', async () => {
    const shown: Array<{title: string; body?: string | undefined; onclick: (() => void) | null}> = []
    class SystemNotification {
      onclick: (() => void) | null = null
      constructor(title: string, options?: {body?: string}) {
        shown.push(Object.assign(this, {title, body: options?.body}))
      }
    }
    const original = window.Notification
    Object.defineProperty(window, 'Notification', {value: SystemNotification, configurable: true, writable: true})
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    try {
      const running = batch({status: 'running', title: 'Road trip'})
      const api = new FakeApi()
      await mount(api)
      act(() => api.emit({batches: [running]}))
      act(() => api.emit({batches: [{...running, status: 'completed', jobs: {...running.jobs, succeeded: 3}}]}))
      expect(shown).toHaveLength(1)
      expect(shown[0]).toMatchObject({title: 'Batch finished', body: 'Road trip: 3/3 downloaded and verified'})
      expect(screen.queryByText('Batch finished')).not.toBeInTheDocument()
      shown[0]!.onclick?.()
      expect(api.focusWindow).toHaveBeenCalledTimes(1)
    } finally {
      focus.mockRestore()
      Object.defineProperty(window, 'Notification', {value: original, configurable: true, writable: true})
    }
  })
})

describe('several links at once', () => {
  it('finds each link once in any pasted text', () => {
    expect(
      extractUrls(
        'https://youtu.be/a\nhttps://youtu.be/b, see https://www.tiktok.com/@x (and https://youtu.be/a again).\nnot a link',
      ),
    ).toEqual({urls: ['https://youtu.be/a', 'https://youtu.be/b', 'https://www.tiktok.com/@x'], repeated: 1})
    expect(extractUrls('just one https://youtu.be/a').urls).toEqual(['https://youtu.be/a'])
  })

  it('pasting several links opens their review: drop one, schedule the rest as batches', async () => {
    const {api, user} = await mount()
    const field = screen.getByLabelText('Video, playlist or profile URL')
    await user.click(field)
    await user.paste('https://youtu.be/one\nhttps://youtu.be/two\nhttps://youtu.be/three\nhttps://youtu.be/two')
    const review = (await screen.findByText('3 links')).closest('.ant-modal') as HTMLElement
    expect(field).toHaveValue('')
    expect(within(review).getByText('1 repeated links were left out.')).toBeInTheDocument()
    await user.click(within(review).getAllByRole('button', {name: 'Remove this link'})[1]!)
    await user.click(within(review).getByTestId('many-schedule'))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(2))
    expect(api.schedule.mock.calls.map(([input]) => input.url)).toEqual([
      'https://youtu.be/one',
      'https://youtu.be/three',
    ])
    expect(api.schedule.mock.calls[0]![0]).toMatchObject({format: 'mp4', quality: 'best'})
    expect(await screen.findByText('2 batches scheduled')).toBeInTheDocument()
  })

  it('one pasted link just fills the field', async () => {
    const {user} = await mount()
    const field = screen.getByLabelText('Video, playlist or profile URL')
    await user.click(field)
    await user.paste('https://youtu.be/only')
    expect(field).toHaveValue('https://youtu.be/only')
    expect(screen.queryByText(/links$/)).not.toBeInTheDocument()
  })
})

describe('TikTok slideshows', () => {
  const post = (index: number, slideshow?: {images: number; audio: boolean}) => ({
    id: `p${index}`,
    index,
    url: `https://www.tiktok.com/@a/video/${index}`,
    title: `Post ${index}`,
    extractor: 'TikTok',
    isLive: false,
    ...(slideshow && {slideshow}),
  })

  it('a list with slideshows asks what they become, remembers it, and schedules with it', async () => {
    const api = new FakeApi({info: {mode: 'tiktok'}})
    api.preview = {
      kind: 'playlist',
      title: 'TikTok @a',
      entries: [post(1), post(2, {images: 5, audio: true}), post(3, {images: 2, audio: false})],
      mix: false,
      maxItems: 500,
    }
    const {user} = await mount(api)
    await user.type(screen.getByLabelText('Video, playlist or profile URL'), 'https://www.tiktok.com/@a')
    await user.click(screen.getByRole('button', {name: /download/i}))
    const choice = await screen.findByTestId('slideshow-choice')
    expect(choice).toHaveTextContent('TikTok slideshows: 2 · 1 without sound')
    expect(choice).toHaveTextContent('An MP4: each image shows 3 s over its soundtrack.')
    await user.click(within(choice).getByText('Images + audio'))
    await waitFor(() => expect(api.setSettings).toHaveBeenLastCalledWith({slideshowMode: 'images-audio'}))
    expect(await within(choice).findByText('A folder per post with its images and its soundtrack.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: /Download 3/}))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1))
    expect(api.schedule.mock.calls[0]![0].slideshow).toEqual({mode: 'images-audio', secondsPerImage: 3})
  })

  it('a single slideshow link asks first, with the seconds per image for a video', async () => {
    const api = new FakeApi({info: {mode: 'tiktok'}})
    api.preview = {kind: 'video', title: 'My carousel', slideshow: {images: 4, audio: true}}
    const {user} = await mount(api)
    await user.type(screen.getByLabelText('Video, playlist or profile URL'), 'https://www.tiktok.com/@a/photo/1')
    await user.click(screen.getByRole('button', {name: /download/i}))
    const dialog = (await screen.findByText('This TikTok post is a slideshow')).closest('.ant-modal') as HTMLElement
    expect(api.schedule).not.toHaveBeenCalled()
    const seconds = within(dialog).getByLabelText('Seconds per image')
    await user.clear(seconds)
    await user.type(seconds, '5')
    await waitFor(() => expect(api.setSettings).toHaveBeenLastCalledWith({slideshowSeconds: 5}))
    await user.click(within(dialog).getByRole('button', {name: 'Download'}))
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1))
    expect(api.schedule.mock.calls[0]![0].slideshow).toEqual({mode: 'video', secondsPerImage: 5})
  })

  it('with an audio format there is nothing to choose: only the soundtrack (Spanish)', async () => {
    const api = new FakeApi({info: {mode: 'tiktok'}, settings: {language: 'es', format: 'mp3'}})
    api.preview = {
      kind: 'playlist',
      title: 'TikTok @a',
      entries: [post(1, {images: 3, audio: true})],
      mix: false,
      maxItems: 500,
    }
    const {user} = await mount(api)
    await user.type(screen.getByLabelText(/URL/), 'https://www.tiktok.com/@a')
    await user.click(screen.getByRole('button', {name: /Descargar/}))
    expect(await screen.findByTestId('slideshow-audio')).toHaveTextContent(
      'Con un formato de audio, solo se descarga la música de cada carrusel.',
    )
  })
})

describe('first steps', () => {
  it('the first launch walks three steps; closing marks the guide seen; Guide replays it', async () => {
    const api = new FakeApi({settings: {tourDone: false}})
    const {user} = await mount(api)
    expect(await screen.findByText('1 · Paste a link')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Next'}))
    expect(await screen.findByText('2 · Choose what you get')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Next'}))
    expect(await screen.findByText('3 · Download')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Finish'}))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({tourDone: true}))
    await user.click(screen.getByTestId('open-guide'))
    expect(await screen.findByText('1 · Paste a link')).toBeVisible()
  })

  it('speaks Spanish; closing it at any step counts as seen', async () => {
    const api = new FakeApi({settings: {tourDone: false, language: 'es'}})
    const {user} = await mount(api)
    expect(await screen.findByText('1 · Pega un enlace')).toBeInTheDocument()
    expect(screen.getByText(/También funcionan varios enlaces a la vez/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: /Cerrar|Close/i}))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({tourDone: true}))
  })

  it('once seen, it does not show at start-up', async () => {
    await mount(new FakeApi({settings: {tourDone: true}}))
    expect(screen.queryByText('1 · Paste a link')).not.toBeInTheDocument()
  })
})
