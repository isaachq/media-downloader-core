import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {BatchId, JobId, PreflightItem} from 'media-downloader-core'
import {afterEach, describe, expect, it} from 'vitest'
import type {FinishedEntry} from '../../shared/contract'
import {App} from './App'
import {setApi} from './api'
import {AppStore} from './store'
import {batch, FakeApi, job} from './test/fake-api'

afterEach(() => setApi(undefined))

async function mount(api = new FakeApi()) {
  setApi(api)
  const target = new AppStore()
  render(<App target={target} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000})
  return {api, target, user: userEvent.setup()}
}

const failedJob = (patch: Parameters<typeof job>[0] = {}) =>
  job({status: 'failed', outcome: 'failed', progress: {}, error: {code: 'network', message: 'timed out'}, ...patch})

describe('one site per run', () => {
  it('says so in the header, and refuses a link of another site before asking anything', async () => {
    const {api, user} = await mount(new FakeApi())
    expect(screen.getByTestId('mode-tag')).toHaveTextContent('Mode: YouTube and websites')
    expect(screen.getByText('New download · YouTube and websites')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Video, playlist or profile URL'), 'https://www.tiktok.com/@someone')
    expect(
      await screen.findByText(/This is a TikTok link — this run is in YouTube and websites mode/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: /download/i}))
    expect(api.analyze).not.toHaveBeenCalled()
    // a link of this mode goes through
    await user.clear(screen.getByLabelText('Video, playlist or profile URL'))
    await user.type(screen.getByLabelText('Video, playlist or profile URL'), 'https://www.youtube.com/watch?v=x')
    await user.click(screen.getByRole('button', {name: /download/i}))
    await waitFor(() => expect(api.analyze).toHaveBeenCalledWith('https://www.youtube.com/watch?v=x'))
  })

  it('in TikTok mode a YouTube link is the one refused, and the main process’s refusal reads the same', async () => {
    const api = new FakeApi({info: {mode: 'tiktok'}})
    const {user} = await mount(api)
    expect(screen.getByTestId('mode-tag')).toHaveAttribute('data-mode', 'tiktok')
    await user.type(screen.getByLabelText('Video, playlist or profile URL'), 'https://youtu.be/x')
    expect(
      await screen.findByText(/This is a YouTube and websites link — this run is in TikTok mode/),
    ).toBeInTheDocument()
    expect(api.analyze).not.toHaveBeenCalled()
  })

  it('an error from the main process reads as words, with how to sign in when the site asks', async () => {
    const api = new FakeApi({info: {mode: 'instagram'}})
    api.analyze.mockRejectedValue(
      new Error("Error invoking remote method 'mdc:analyze': DownloadError: Instagram asks to sign in for this."),
    )
    const {user} = await mount(api)
    await user.type(screen.getByLabelText('Video, playlist or profile URL'), 'https://www.instagram.com/nasa/')
    await user.click(screen.getByRole('button', {name: /download/i}))
    expect(await screen.findByText(/^Instagram asks to sign in for this\. Sign-in required/)).toBeInTheDocument()
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument()
  })

  it('several links pasted at once: only this site’s are offered, the rest are counted', async () => {
    const {user} = await mount(new FakeApi({info: {mode: 'instagram'}}))
    const input = screen.getByLabelText('Video, playlist or profile URL')
    await user.click(input)
    await user.paste(
      'https://www.instagram.com/reel/a/\nhttps://www.instagram.com/p/b/\nhttps://www.tiktok.com/@c\nhttps://youtu.be/d',
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Schedule 2')).toBeInTheDocument()
    expect(within(dialog).getByTestId('many-other-mode')).toHaveTextContent(
      '2 link(s) of other sites left out: this run is in Instagram mode.',
    )
  })

  it('changing the site waits for open batches, then asks for a restart', async () => {
    const running = batch({status: 'running'})
    const {api, user} = await mount(new FakeApi({state: {batches: [running], jobs: []}}))
    await user.click(screen.getByRole('button', {name: /settings/i}))
    const modes = await screen.findByTestId('settings-mode')
    expect(within(modes).getByRole('radio', {name: /^TikTok/})).toBeDisabled()
    expect(screen.getByText(/1 batch\(es\) still open/)).toBeInTheDocument()
    cleanup()

    const free = await mount(new FakeApi())
    await free.user.click(screen.getByRole('button', {name: /settings/i}))
    await free.user.click(within(await screen.findByTestId('settings-mode')).getByRole('radio', {name: /^Facebook/}))
    await waitFor(() => expect(free.api.setSettings).toHaveBeenCalledWith({mode: 'facebook'}))
    const notice = await screen.findByTestId('mode-restart')
    expect(notice).toHaveTextContent('Restart to switch to Facebook.')
    await free.user.click(within(notice).getByRole('button', {name: /Restart now/}))
    expect(free.api.relaunch).toHaveBeenCalled()
    expect(api.relaunch).not.toHaveBeenCalled()
  })

  it('YouTube’s sign-in row exists only in the web mode', async () => {
    const {user} = await mount(new FakeApi({info: {mode: 'facebook'}}))
    await user.click(screen.getByRole('button', {name: /settings/i}))
    await screen.findByTestId('settings-mode')
    expect(screen.queryByTestId('youtube-account')).not.toBeInTheDocument()
  })
})

describe('signing in', () => {
  it('Settings explains step by step how to use the browser’s session, with this system’s permission', async () => {
    const {user} = await mount(new FakeApi({info: {platform: 'darwin-arm64'}}))
    await user.click(screen.getByRole('button', {name: /settings/i}))
    await user.click(await screen.findByTestId('open-signin-help'))
    const help = await screen.findByTestId('signin-help')
    expect(help).toHaveTextContent('sign in there as always: to Google / YouTube, Instagram or Facebook')
    expect(help).toHaveTextContent('choose that same browser')
    expect(within(help).getByTestId('signin-system')).toHaveTextContent('Always Allow')
    expect(help).toHaveTextContent('never sent anywhere else')
  })

  it('on Windows it says to close the browser, and Firefox when Chrome can’t be read', async () => {
    const {user} = await mount(new FakeApi({info: {platform: 'win32-x64'}}))
    await user.click(screen.getByRole('button', {name: /settings/i}))
    await user.click(await screen.findByTestId('open-signin-help'))
    expect(await screen.findByTestId('signin-system')).toHaveTextContent('use Firefox')
  })
})

describe('failed downloads', () => {
  it('the Failed card lists them from every batch; picked ones go into one new batch', async () => {
    const a = batch({title: 'List A', status: 'completed-with-errors'})
    const b = batch({title: 'List B', status: 'completed-with-errors'})
    const one = failedJob({batchId: a.id, title: 'Clip one', url: 'https://youtu.be/1'})
    const two = failedJob({batchId: b.id, title: 'Clip two', url: 'https://youtu.be/2'})
    const broken = failedJob({
      batchId: b.id,
      title: 'Broken clip',
      error: {code: 'unavailable', hint: 'damaged-source', message: 'Damaged at the source — not downloaded again'},
    })
    const ok = job({status: 'completed', outcome: 'success', batchId: a.id})
    const {api, user} = await mount(new FakeApi({state: {batches: [a, b], jobs: [one, two, broken, ok]}}))
    await user.click(screen.getByRole('button', {name: 'Failed — see the list and retry'}))
    const modal = await screen.findByTestId('failed-modal')
    expect(screen.getByText('Failed downloads (3)')).toBeInTheDocument()
    expect(within(modal).getByText('Clip one')).toBeInTheDocument()
    expect(within(modal).getByText('Clip two')).toBeInTheDocument()
    // damaged at the source: listed, never offered again
    const brokenRow = within(modal).getByText('Broken clip').closest('tr')!
    expect(within(brokenRow).getByRole('checkbox')).toBeDisabled()
    expect(within(brokenRow).getByTestId('failed-damaged')).toHaveTextContent('Damaged at the source')

    await user.click(within(modal).getByRole('button', {name: 'Select all (2)'}))
    await user.click(screen.getByTestId('failed-retry'))
    await waitFor(() => expect(api.retryFailed).toHaveBeenCalled())
    const items = api.retryFailed.mock.calls[0]![0]
    expect(items.map(item => item.jobId).sort()).toEqual([one.id, two.id].sort())
    expect(items[0]).toMatchObject({profile: {kind: 'video', container: 'mp4'}})
    // the new batch shows in Batches; the list stops offering what was sent
    expect(await screen.findByText(/New batch scheduled with 2 failed download/)).toBeInTheDocument()
    expect(screen.queryByTestId('failed-modal')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', {name: /^Batches/})).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Failed, retried (2)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Failed — see the list and retry'}))
    expect(await screen.findByText('Failed downloads (1)')).toBeInTheDocument()
  })

  it('can narrow the list to some batches', async () => {
    const a = batch({title: 'List A', status: 'completed-with-errors'})
    const b = batch({title: 'List B', status: 'completed-with-errors'})
    const {user} = await mount(
      new FakeApi({
        state: {
          batches: [a, b],
          jobs: [failedJob({batchId: a.id, title: 'From A'}), failedJob({batchId: b.id, title: 'From B'})],
        },
      }),
    )
    await user.click(screen.getByRole('button', {name: 'Failed — see the list and retry'}))
    const modal = await screen.findByTestId('failed-modal')
    await user.click(within(modal).getByRole('combobox', {name: 'Batches'}))
    await user.click(await screen.findByTitle('List B · 1'))
    await waitFor(() => expect(within(modal).queryByText('From A')).not.toBeInTheDocument())
    expect(within(modal).getByText('From B')).toBeInTheDocument()
    expect(within(modal).getByRole('button', {name: 'Select all (1)'})).toBeInTheDocument()
  })
})

describe('batch cards', () => {
  it('a batch checking its files says how far it got; cancelled items are counted, not failures', async () => {
    const checking = batch({
      status: 'validating',
      title: 'Checking now',
      jobs: {total: 5, queued: 0, running: 0, succeeded: 4, failed: 0, cancelled: 1},
      validation: {done: 2, total: 4},
    })
    await mount(new FakeApi({state: {batches: [checking], jobs: []}}))
    const card = await screen.findByTestId('batch-card')
    expect(within(card).getByTestId('batch-status')).toHaveTextContent('Checking files')
    expect(within(card).getByTestId('batch-validating')).toHaveTextContent('Downloads done — checking files: 2/4')
    expect(card).toHaveTextContent('1 cancelled')
    expect(within(card).queryByTestId('batch-retry-failed')).not.toBeInTheDocument()
  })

  it('a batch whose only failure is damaged at the source offers no retry', async () => {
    const closed = batch({
      status: 'completed-with-errors',
      jobs: {total: 3, queued: 0, running: 0, succeeded: 2, failed: 1, cancelled: 0},
      problems: {failed: {'damaged-source': 1}, unavailable: {}},
    })
    await mount(new FakeApi({state: {batches: [closed], jobs: []}}))
    const card = await screen.findByTestId('batch-card')
    expect(within(card).getByTestId('problems')).toHaveTextContent('damaged at the source 1')
    expect(within(card).queryByTestId('batch-retry-failed')).not.toBeInTheDocument()
  })

  it('Cancel on an item drops only that download; Cancel batch says it stops everything', async () => {
    const running = batch({status: 'running', preflight: {total: 2, checked: 2, ok: 2, unavailable: 0}})
    const first = job({id: 'J'.padEnd(32, '1') as JobId, batchId: running.id, status: 'downloading'})
    const api = new FakeApi({state: {batches: [running], jobs: [first]}})
    api.itemsPage = [
      {index: 1, url: 'https://youtu.be/1', title: 'First', state: 'ok', jobId: first.id},
      {
        index: 2,
        url: 'https://youtu.be/2',
        title: 'Second',
        state: 'unavailable',
        error: {code: 'unavailable', hint: 'damaged-source', message: 'Damaged at the source — not downloaded again'},
      },
    ] satisfies PreflightItem[]
    const {user} = await mount(api)
    const card = await screen.findByTestId('batch-card')
    await user.click(within(card).getByRole('button', {name: /Items/}))
    await user.click(await within(card).findByTestId('item-cancel'))
    expect(api.cancelJob).toHaveBeenCalledWith(first.id)
    expect(api.cancelBatch).not.toHaveBeenCalled()
    const damaged = within(card).getByTestId('item-damaged')
    expect(damaged).toHaveTextContent('Damaged at the source')
    await user.hover(damaged)
    expect(await screen.findByText(/won’t be downloaded again/)).toBeInTheDocument()

    await user.click(within(card).getByRole('button', {name: /Cancel batch/}))
    expect(await screen.findByText(/Stops the whole batch\. To drop one download only/)).toBeInTheDocument()
  })

  it('Downloads shows a file waiting for the check after its batch, and one damaged at the source', async () => {
    const waiting = job({
      status: 'completed',
      outcome: 'success',
      title: 'Waits',
      validationPending: true,
      batchId: 'B'.padEnd(32, '9') as BatchId,
    })
    const damaged = failedJob({
      title: 'Broken',
      error: {code: 'unavailable', hint: 'damaged-source', message: 'Damaged at the source — not downloaded again'},
    })
    const {user} = await mount(new FakeApi({state: {batches: [], jobs: [waiting, damaged]}}))
    await user.click(screen.getByRole('tab', {name: /^Downloads/}))
    expect(await screen.findByTestId('integrity-later')).toHaveTextContent('Check at the end')
    expect(screen.getByTestId('integrity-damaged')).toHaveTextContent('Damaged at the source')
  })
})

describe('finished: header filters and missing records', () => {
  const entry = (i: number, patch: Partial<FinishedEntry> = {}): FinishedEntry => ({
    key: `k${i}`,
    title: `Clip ${i}`,
    filepath: `/Users/me/Downloads/Clip-${i}.mp4`,
    sizeBytes: 1_000_000 * 10 ** i,
    extractor: 'Youtube',
    url: `https://example.com/${i}`,
    completedAt: Date.UTC(2026, 9, 11, 12, i),
    sha256: 'a'.repeat(64),
    validation: 'full',
    file: 'ok',
    ...patch,
  })

  async function openFinished(api: FakeApi) {
    const mounted = await mount(api)
    await mounted.user.click(screen.getByRole('tab', {name: /^Finished/}))
    const list = await screen.findByTestId('finished-list')
    await within(list).findByText('Clip 1')
    return {...mounted, list}
  }

  /** Tick values in a column's filter menu and confirm. */
  async function filterBy(
    user: ReturnType<typeof userEvent.setup>,
    list: HTMLElement,
    column: string,
    values: string[],
  ) {
    const header = within(list)
      .getAllByRole('columnheader')
      .find(cell => cell.textContent?.includes(column))!
    await user.click(header.querySelector('.ant-table-filter-trigger')!)
    const menu = await waitFor(() => {
      const open = [...document.querySelectorAll<HTMLElement>('.ant-dropdown:not(.ant-dropdown-hidden)')].at(-1)
      if (!open?.querySelector('.ant-table-filter-dropdown')) throw new Error('no filter menu yet')
      return open
    })
    for (const value of values) await user.click(within(menu).getByText(value))
    await user.click(within(menu).getByRole('button', {name: 'OK'}))
  }

  it('filters by Integrity and Size, sorts by Size, and the damaged ones say why on hover', async () => {
    const api = new FakeApi()
    api.finishedEntries = [
      entry(3, {damaged: 'Decoding failed: Invalid NAL unit size'}),
      entry(2, {validation: 'none'}),
      entry(1),
    ]
    const {user, list} = await openFinished(api)
    const tag = within(list).getByTestId('finished-damaged')
    await user.hover(tag)
    expect(await screen.findByText(/Invalid NAL unit size/)).toBeInTheDocument()

    await filterBy(user, list, 'Integrity', ['Damaged at the source'])
    await waitFor(() =>
      expect(api.finished).toHaveBeenLastCalledWith(expect.objectContaining({integrity: ['damaged']})),
    )
    await waitFor(() => expect(within(list).queryByText('Clip 1')).not.toBeInTheDocument())
    expect(within(list).getByText('Clip 3')).toBeInTheDocument()

    await filterBy(user, list, 'Integrity', ['Damaged at the source'])
    await filterBy(user, list, 'Size', ['Under 10 MB'])
    await waitFor(() => expect(api.finished).toHaveBeenLastCalledWith(expect.objectContaining({size: ['lt10m']})))
    await waitFor(() => expect(within(list).queryByText('Clip 2')).not.toBeInTheDocument())
    await filterBy(user, list, 'Size', ['Under 10 MB'])

    const sizeHeader = within(list)
      .getAllByRole('columnheader')
      .find(cell => cell.textContent?.includes('Size'))!
    fireEvent.click(sizeHeader)
    await waitFor(() => expect(api.finished).toHaveBeenLastCalledWith(expect.objectContaining({sort: 'largest'})))
    const titles = () =>
      within(list)
        .getAllByText(/^Clip \d$/)
        .map(node => node.textContent)
    await waitFor(() => expect(titles()).toEqual(['Clip 3', 'Clip 2', 'Clip 1']))
    fireEvent.click(sizeHeader)
    await waitFor(() => expect(titles()).toEqual(['Clip 1', 'Clip 2', 'Clip 3']))
  })

  it('removes the records of files that were deleted or moved, after asking', async () => {
    const api = new FakeApi()
    api.finishedEntries = [entry(2, {file: 'missing'}), entry(1)]
    const {user, list} = await openFinished(api)
    await user.click(within(list).getByTestId('finished-prune'))
    expect(await screen.findByText(/no longer where they were downloaded/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Remove'}))
    await waitFor(() => expect(api.pruneFinished).toHaveBeenCalledWith(expect.objectContaining({all: true})))
    expect(await screen.findByText('1 record(s) of missing files removed')).toBeInTheDocument()
    await waitFor(() => expect(within(list).queryByText('Clip 2')).not.toBeInTheDocument())
    expect(within(list).getByText('Clip 1')).toBeInTheDocument()
  })

  /** The row checkbox of a title. */
  const pick = (list: HTMLElement, title: string) =>
    within(within(list).getByText(title).closest('tr')!).getByRole('checkbox')

  it('a file already gone is not checked again: only the selected files still on disk are', async () => {
    const api = new FakeApi()
    api.finishedEntries = [entry(3, {file: 'missing'}), entry(2, {file: 'missing'}), entry(1)]
    const {user, list} = await openFinished(api)
    await user.click(pick(list, 'Clip 3'))
    await user.click(pick(list, 'Clip 2'))
    const verify = within(list).getByTestId('finished-verify')
    // only missing files picked: nothing to check
    expect(verify).toBeDisabled()
    expect(verify).toHaveTextContent('Check selected (0)')
    await user.click(pick(list, 'Clip 1'))
    expect(verify).toBeEnabled()
    await user.click(verify)
    await waitFor(() => expect(api.verifyFinished).toHaveBeenCalledWith({keys: ['k1']}))
    // the missing rows keep their tag, never a "Checking" spinner
    expect(within(list).getAllByText('File not found')).toHaveLength(2)
  })

  it('the progress ends with the check: a late progress event does not bring it back', async () => {
    const api = new FakeApi()
    api.finishedEntries = [entry(2), entry(1)]
    api.verifySummary = {checked: 2, ok: 2, missing: 0, changed: 0, corrupted: 0}
    const {user, list} = await openFinished(api)
    await user.click(within(list).getByTestId('finished-verify'))
    expect(await screen.findByText(/Checked 2: 2 intact/)).toBeInTheDocument()
    await waitFor(() => expect(within(list).queryByTestId('finished-checking')).not.toBeInTheDocument())
    act(() => api.emitVerifyProgress({done: 2, total: 2}))
    expect(within(list).queryByTestId('finished-checking')).not.toBeInTheDocument()
    expect(within(list).getByTestId('finished-verify')).toBeEnabled()
    // no "Checking files…" toast left behind
    expect(screen.queryByText(/Checking files…/)).not.toBeInTheDocument()
  })

  it('the actions wait for a running check: no second check, no prune meanwhile', async () => {
    const api = new FakeApi()
    api.finishedEntries = [entry(2, {file: 'missing'}), entry(1)]
    let finish: (summary: typeof api.verifySummary) => void = () => {}
    api.verifyFinished.mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
    const {user, list} = await openFinished(api)
    await user.click(within(list).getByTestId('finished-verify'))
    expect(await within(list).findByTestId('finished-checking')).toBeInTheDocument()
    expect(within(list).getByTestId('finished-prune')).toBeDisabled()
    expect(within(list).getByTestId('finished-redownload')).toBeDisabled()
    await user.click(within(list).getByTestId('finished-verify'))
    expect(api.verifyFinished).toHaveBeenCalledTimes(1)
    act(() => finish({checked: 2, ok: 1, missing: 1, changed: 0, corrupted: 0}))
    await waitFor(() => expect(within(list).queryByTestId('finished-checking')).not.toBeInTheDocument())
    expect(within(list).getByTestId('finished-prune')).toBeEnabled()
  })

  it('downloads the missing files again from their links, after asking', async () => {
    const api = new FakeApi()
    api.finishedEntries = [entry(2, {file: 'missing'}), entry(1)]
    const {user, list} = await openFinished(api)
    await user.click(within(list).getByTestId('finished-redownload'))
    expect(await screen.findByText(/from the link each one kept/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Download'}))
    await waitFor(() => expect(api.redownloadFinished).toHaveBeenCalledWith(expect.objectContaining({all: true})))
    expect(await screen.findByText('1 file(s) queued to download again')).toBeInTheDocument()
  })

  it('with only files still on disk picked, the missing-file actions are off', async () => {
    const api = new FakeApi()
    api.finishedEntries = [entry(2, {file: 'missing'}), entry(1)]
    const {user, list} = await openFinished(api)
    await user.click(pick(list, 'Clip 1'))
    expect(within(list).getByTestId('finished-redownload')).toBeDisabled()
    expect(within(list).getByTestId('finished-prune')).toBeDisabled()
    await user.click(pick(list, 'Clip 2'))
    expect(within(list).getByTestId('finished-redownload')).toHaveTextContent('Download missing again (1)')
    expect(within(list).getByTestId('finished-prune')).toHaveTextContent('Remove missing among selected (1)')
  })
})

describe('settings', () => {
  it('60% of the processors raises the most downloads at once; off brings it back to half', async () => {
    const {api, user} = await mount(new FakeApi())
    await user.click(screen.getByRole('button', {name: /settings/i}))
    expect(await screen.findByTestId('cpu-boost-help')).toHaveTextContent(
      'Half (6 of 12) by default. On: up to 7 downloads at once',
    )
    expect(screen.getByText(/Capped at half your CPUs \(6 of 12\)/)).toBeInTheDocument()
    await user.click(screen.getByRole('switch', {name: 'Allow up to 60% of the processors'}))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({cpuBoost: true}))
    expect(await screen.findByText('Up to 7 at once (60% of 12 processors).')).toBeInTheDocument()
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuemax', '7')
  })

  it('on a computer where 60% is still half, it says so', async () => {
    const {user} = await mount(new FakeApi({info: {cpus: 8, maxConcurrency: 4, boostedConcurrency: 4}}))
    await user.click(screen.getByRole('button', {name: /settings/i}))
    expect(await screen.findByTestId('cpu-boost-help')).toHaveTextContent('60% of 8 processors is still 4')
  })

  it('download first, check after: a switch (off without checks); the damaged list lets one try again', async () => {
    const api = new FakeApi()
    api.damaged = [
      {
        key: 'fake:x1',
        url: 'https://example.com/x1',
        title: 'Broken one',
        reason: 'Decoding failed',
        issues: ['decode-failed'],
        at: Date.now(),
      },
    ]
    const {user} = await mount(api)
    await user.click(screen.getByRole('button', {name: /settings/i}))
    await user.click(await screen.findByRole('switch', {name: 'Download first, check after'}))
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({validateAfter: true}))
    await user.click(screen.getByTestId('open-damaged'))
    const modal = await screen.findByTestId('damaged-modal')
    expect(await within(modal).findByText('Broken one')).toBeInTheDocument()
    await user.click(within(modal).getByRole('button', {name: 'Allow again'}))
    expect(api.damagedForget).toHaveBeenCalledWith('fake:x1')
    expect(await within(modal).findByText('No video damaged at the source')).toBeInTheDocument()
  })
})
