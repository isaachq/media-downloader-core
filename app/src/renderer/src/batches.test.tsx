import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {BatchId} from 'media-downloader-core'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {FinishedEntry} from '../../shared/contract'
import {App} from './App'
import {setApi} from './api'
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
    site: 'web',
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

describe('a mix list: several links at once, one batch', () => {
  const checked = (api: FakeApi) => {
    api.mixPreview = {
      id: 'mix-7',
      valid: [
        {line: 1, url: 'https://youtu.be/one', site: 'youtube', title: 'One', duration: 65},
        {line: 2, url: 'https://www.tiktok.com/@a/video/2', site: 'tiktok', title: 'Two', archived: true},
        {line: 3, url: 'https://x.com/a/status/3', site: 'x', title: 'Three', unchecked: true},
      ],
      skipped: [
        {line: 4, input: 'https://youtu.be/one', site: 'youtube', reason: 'duplicate', duplicateOf: 1},
        {line: 5, input: 'https://www.youtube.com/@nasa', site: 'youtube', reason: 'listing'},
        {
          line: 6,
          input: 'https://vk.com/video-1_9',
          site: 'vk',
          reason: 'private',
          error: {code: 'unavailable', hint: 'private', message: 'Private'},
        },
      ],
      summary: {
        total: 6,
        valid: 3,
        skipped: 3,
        bySite: {youtube: 1, tiktok: 1, x: 1},
        byReason: {duplicate: 1, listing: 1, private: 1},
      },
    }
    return api
  }

  it('pasting several links checks them at once; what downloads and what was left out, then one batch', async () => {
    const {api, user} = await mount(checked(new FakeApi()))
    const field = screen.getByLabelText('Video, playlist or profile URL')
    await user.click(field)
    const text = 'https://youtu.be/one\nhttps://www.tiktok.com/@a/video/2\nhttps://x.com/a/status/3'
    await user.paste(text)
    expect(field).toHaveValue('')
    const dialog = await screen.findByRole('dialog')
    expect(api.analyzeMix).toHaveBeenCalledWith(text, 'mp4', 'best')
    const summary = await within(dialog).findByTestId('mix-summary')
    expect(summary).toHaveTextContent('3 ready')
    expect(summary).toHaveTextContent('3 left out')
    expect(within(dialog).getByText('Already downloaded')).toBeInTheDocument()
    expect(within(dialog).getByText('Checked when it downloads')).toBeInTheDocument()
    await user.click(within(dialog).getByText('Left out (3)'))
    expect(await within(dialog).findByText('Same as line 1')).toBeInTheDocument()
    expect(within(dialog).getByText('A list or profile: download it on its own')).toBeInTheDocument()
    expect(within(dialog).getByText('Private')).toBeInTheDocument()
    // one removed: the batch takes the other two
    await user.click(within(dialog).getAllByRole('button', {name: 'Remove this link'})[1]!)
    await user.click(within(dialog).getByTestId('mix-schedule'))
    await waitFor(() => expect(api.scheduleMix).toHaveBeenCalledTimes(1))
    expect(api.scheduleMix.mock.calls[0]![0]).toMatchObject({
      id: 'mix-7',
      urls: ['https://youtu.be/one', 'https://x.com/a/status/3'],
      format: 'mp4',
      quality: 'best',
    })
    expect(api.schedule).not.toHaveBeenCalled()
    expect(await screen.findByText('Mix list scheduled: 2 links in one batch')).toBeInTheDocument()
    expect(await screen.findByTestId('batch-mix')).toHaveTextContent('Mix list')
  })

  it('the Mix list button opens an empty form: links go in one by one or as a list, each a numbered card with its site', async () => {
    const {api, user} = await mount(checked(new FakeApi()))
    await user.click(screen.getByTestId('open-mix'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('mix-check')).toBeDisabled()
    expect(within(dialog).getByText(/Add a link, or paste a whole list/)).toBeInTheDocument()
    const field = within(dialog).getByLabelText('Paste or type a link')
    // one by one: type, Enter
    await user.click(field)
    await user.type(field, 'https://youtu.be/a{Enter}')
    expect(within(dialog).getByTestId('mix-note')).toHaveTextContent('Added: 1')
    expect(field).toHaveValue('')
    // the same link again; then text that is not a link
    await user.type(field, 'https://www.youtube.com/watch?v=a&si=x{Enter}')
    await user.type(field, 'https://youtu.be/a/{Enter}')
    expect(within(dialog).getByTestId('mix-note')).toHaveTextContent('Already in the list')
    await user.type(field, 'hello{Enter}')
    expect(within(dialog).getByTestId('mix-note')).toHaveTextContent('That is not a link')
    // a list pasted at once: every new link of it
    await user.clear(field)
    await user.paste('https://vk.com/video-1_2\nhttps://youtu.be/a\nhttps://x.com/a/status/3')
    expect(within(dialog).getByTestId('mix-note')).toHaveTextContent('Added: 2')
    const sites = within(dialog).getByTestId('mix-sites')
    expect(sites).toHaveTextContent('4 links')
    expect(
      within(sites)
        .getAllByTestId('site-tag')
        .map(tag => tag.getAttribute('data-site')),
    ).toEqual(['youtube', 'vk', 'x'])
    expect(api.analyzeMix).not.toHaveBeenCalled()
    await user.click(within(dialog).getByTestId('mix-check'))
    await waitFor(() => expect(api.analyzeMix).toHaveBeenCalledTimes(1))
    expect(api.analyzeMix.mock.calls[0]![0]).toBe(
      'https://youtu.be/a\nhttps://www.youtube.com/watch?v=a&si=x\nhttps://vk.com/video-1_2\nhttps://x.com/a/status/3',
    )
    expect(await within(dialog).findByTestId('mix-summary')).toBeInTheDocument()
    // back to the cards, as they were
    await user.click(within(dialog).getByTestId('mix-edit'))
    expect(within(dialog).getByTestId('mix-sites')).toHaveTextContent('4 links')
  })

  it('says little on the form: what a mix list is opens behind the info button, Close shuts it', async () => {
    const {user} = await mount()
    await user.click(screen.getByTestId('open-mix'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText(/They are checked together/)).not.toBeInTheDocument()
    await user.click(within(dialog).getByTestId('mix-info'))
    expect(await screen.findByText(/They are checked together and download as one batch/)).toBeInTheDocument()
    // the dialog's own Close (its corner cross is called Close too)
    const close = screen.getAllByRole('button', {name: 'Close'}).find(button => button.textContent === 'Close')!
    await user.click(close)
    await waitFor(() => expect(screen.queryByText(/They are checked together/)).not.toBeInTheDocument())
  })

  it('the format is said and chosen here: for all links, and a link of the preview in a format of its own', async () => {
    const {api, user} = await mount(checked(new FakeApi()))
    await user.click(screen.getByLabelText('Video, playlist or profile URL'))
    await user.paste('https://youtu.be/one\nhttps://www.tiktok.com/@a/video/2\nhttps://x.com/a/status/3')
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('mix-summary')
    expect(within(dialog).getByTestId('mix-format')).toHaveTextContent('Format for all links')
    // grouped by site
    expect(within(dialog).getByTestId('mix-group-youtube')).toBeInTheDocument()
    expect(within(dialog).getByTestId('mix-group-tiktok')).toBeInTheDocument()
    // the first link as MP3: its own select
    const own = within(within(dialog).getByTestId('mix-group-youtube')).getByRole('combobox', {name: 'Format'})
    await user.click(own)
    await user.click(await screen.findByText('Audio · MP3 · Best audio', {selector: '.ant-select-item-option-content'}))
    await user.click(within(dialog).getByTestId('mix-schedule'))
    await waitFor(() => expect(api.scheduleMix).toHaveBeenCalledTimes(1))
    expect(api.scheduleMix.mock.calls[0]![0]).toMatchObject({
      format: 'mp4',
      quality: 'best',
      formats: {'https://youtu.be/one': {format: 'mp3', quality: 'best'}},
    })
  })

  it('a song in a list of videos shows as M4A on its card and is asked as M4A', async () => {
    const api = new FakeApi()
    api.mixPreview = {
      id: 'mix-8',
      valid: [
        {line: 1, url: 'https://youtu.be/one', site: 'youtube', title: 'One'},
        {
          line: 2,
          url: 'https://soundcloud.com/forss/flickermood',
          site: 'soundcloud',
          title: 'Flickermood',
          song: true,
        },
      ],
      skipped: [],
      summary: {total: 2, valid: 2, skipped: 0, bySite: {youtube: 1, soundcloud: 1}, byReason: {}},
    }
    const {user} = await mount(api)
    await user.click(screen.getByLabelText('Video, playlist or profile URL'))
    await user.paste('https://youtu.be/one\nhttps://soundcloud.com/forss/flickermood')
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('mix-summary')
    const song = within(within(dialog).getByTestId('mix-group-soundcloud')).getByRole('combobox', {name: 'Format'})
    expect(song.closest('.ant-select')).toHaveTextContent('Audio · M4A')
    await user.click(within(dialog).getByTestId('mix-schedule'))
    await waitFor(() => expect(api.scheduleMix).toHaveBeenCalledTimes(1))
    expect(api.scheduleMix.mock.calls[0]![0]).toMatchObject({
      format: 'mp4',
      formats: {'https://soundcloud.com/forss/flickermood': {format: 'm4a', quality: 'best'}},
    })
  })

  it('shows the check going, and stops it on Cancel', async () => {
    const api = new FakeApi()
    let finish: (() => void) | undefined
    api.analyzeMix.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          finish = () => reject(new Error('Cancelled.'))
        }),
    )
    const {user} = await mount(api)
    await user.click(screen.getByLabelText('Video, playlist or profile URL'))
    await user.paste('https://youtu.be/a\nhttps://youtu.be/b')
    const dialog = await screen.findByRole('dialog')
    act(() => api.pushMixProgress({total: 2, checked: 1}))
    expect(await within(dialog).findByText('Checked 1 of 2')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', {name: 'Cancel'}))
    expect(api.cancelMix).toHaveBeenCalled()
    act(() => finish?.())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByText('Cancelled.')).not.toBeInTheDocument()
  })

  it('one pasted link just fills the field', async () => {
    const {user} = await mount()
    const field = screen.getByLabelText('Video, playlist or profile URL')
    await user.click(field)
    await user.paste('https://youtu.be/only')
    expect(field).toHaveValue('https://youtu.be/only')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    const api = new FakeApi()
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
    const api = new FakeApi()
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
    const api = new FakeApi({settings: {language: 'es', format: 'mp3'}})
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
  it('the first launch walks four steps; closing marks the guide seen; Guide replays it', async () => {
    const api = new FakeApi({settings: {tourDone: false}})
    const {user} = await mount(api)
    expect(await screen.findByText('1 · Paste a link')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Next'}))
    expect(await screen.findByText('2 · Choose what you get')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Next'}))
    expect(await screen.findByText('3 · Download')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Next'}))
    expect(await screen.findByText('4 · Lists and the mix list')).toBeInTheDocument()
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
