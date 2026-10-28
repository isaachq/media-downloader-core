// Beta 24: "show in folder" for a file of a batch still running says so and
// opens once the batch ends, in Finished, in Downloads and on the batch's card.
import {render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterEach, describe, expect, it} from 'vitest'
import type {FinishedEntry} from '../../shared/contract'
import {App} from './App'
import {setApi} from './api'
import {AppStore} from './store'
import {batch, FakeApi, job} from './test/fake-api'

afterEach(() => setApi(undefined))

async function mount(api: FakeApi) {
  setApi(api)
  render(<App target={new AppStore()} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000})
  return {api, user: userEvent.setup()}
}

const LATER = 'Available when the batch finishes.'

describe('beta 24: show in folder waits for the batch', () => {
  const running = () =>
    batch({
      title: 'Carousel',
      status: 'running',
      jobs: {total: 3, queued: 0, running: 2, succeeded: 1, failed: 0, cancelled: 0},
    })
  const entry = (batchId: string): FinishedEntry => ({
    key: 'k1',
    title: 'Photo 1',
    filepath: '/Users/me/Downloads/Carousel/001-Photo-1.jpg',
    sizeBytes: 1_000_000,
    extractor: 'Instagram',
    url: 'https://www.instagram.com/p/abc/',
    site: 'instagram',
    completedAt: Date.UTC(2026, 9, 27, 10, 0),
    sha256: 'a'.repeat(64),
    validation: 'none',
    file: 'ok',
    batchId,
    batchTitle: 'Carousel',
  })

  it('Finished: the button stays, the tap says so and opens nothing; the batch ends and the folder opens', async () => {
    const live = running()
    const api = new FakeApi({state: {batches: [live], jobs: []}})
    api.finishedEntries = [entry(live.id)]
    const {user} = await mount(api)
    await user.click(screen.getByRole('tab', {name: /^Finished/}))
    const list = await screen.findByTestId('finished-list')
    await within(list).findByText('Photo 1')
    const reveal = within(list).getByRole('button', {name: 'Show in folder'})
    expect(reveal).toBeEnabled()
    await user.click(reveal)
    expect(await screen.findByText(LATER)).toBeInTheDocument()
    expect(api.openFinished).not.toHaveBeenCalled()
    // a second tap keeps one open for the batch, not two
    await user.click(reveal)
    api.emit({batches: [{...live, status: 'completed'}]})
    await waitFor(() => expect(api.openFinished).toHaveBeenCalledWith('k1', 'folder'))
    expect(api.openFinished).toHaveBeenCalledTimes(1)
    // the batch is over: the next tap opens at once
    await user.click(reveal)
    await waitFor(() => expect(api.openFinished).toHaveBeenCalledTimes(2))
  })

  it('Finished: a file of a finished batch, or of no batch this session knows, opens at once', async () => {
    const done = batch({status: 'completed'})
    const api = new FakeApi({state: {batches: [done], jobs: []}})
    api.finishedEntries = [entry(done.id), {...entry('B'.repeat(32)), key: 'k2', title: 'Photo 2'}]
    const {user} = await mount(api)
    await user.click(screen.getByRole('tab', {name: /^Finished/}))
    const list = await screen.findByTestId('finished-list')
    await within(list).findByText('Photo 1')
    const buttons = within(list).getAllByRole('button', {name: 'Show in folder'})
    await user.click(buttons[0]!)
    await user.click(buttons[1]!)
    await waitFor(() => expect(api.openFinished).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(LATER)).not.toBeInTheDocument()
  })

  it('Downloads: a finished file of a running batch shows in its folder once the batch ends', async () => {
    const live = running()
    const finished = job({
      batchId: live.id,
      status: 'completed',
      outcome: 'success',
      filepath: '/Users/me/Downloads/Carousel/001.jpg',
    })
    const api = new FakeApi({state: {batches: [live], jobs: [finished]}})
    const {user} = await mount(api)
    await user.click(screen.getByRole('tab', {name: /^Downloads/}))
    const reveal = await screen.findByRole('button', {name: 'Show file'})
    await user.click(reveal)
    expect(await screen.findByText(LATER)).toBeInTheDocument()
    expect(api.reveal).not.toHaveBeenCalled()
    api.emit({batches: [{...live, status: 'completed-with-errors'}]})
    await waitFor(() => expect(api.reveal).toHaveBeenCalledWith('/Users/me/Downloads/Carousel/001.jpg'))
  })

  it("the batch card's Open folder waits for the batch too", async () => {
    const live = running()
    const api = new FakeApi({state: {batches: [live], jobs: []}})
    const {user} = await mount(api)
    const card = screen.getByTestId('batch-card')
    await user.click(within(card).getByTestId('batch-open-folder'))
    expect(await screen.findByText(LATER)).toBeInTheDocument()
    expect(api.openFolder).not.toHaveBeenCalled()
    api.emit({batches: [{...live, status: 'cancelled'}]})
    await waitFor(() => expect(api.openFolder).toHaveBeenCalledWith({batchId: live.id}))
  })
})
