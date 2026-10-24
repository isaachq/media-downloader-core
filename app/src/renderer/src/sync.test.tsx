import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {SubscriptionView} from 'media-downloader-core'
import {afterEach, describe, expect, it} from 'vitest'
import {App} from './App'
import {setApi} from './api'
import {suggestedFolder, tiktokAccount} from './components/SyncPanel'
import {AppStore} from './store'
import {FakeApi} from './test/fake-api'

afterEach(() => setApi(undefined))

async function mount(api: FakeApi) {
  setApi(api)
  render(<App target={new AppStore()} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000})
  return {api, user: userEvent.setup()}
}

/** Open Sync Up, next to New download. */
async function openSync(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', {name: 'Sync Up'}))
  return screen.findByTestId('sync-panel')
}

/** Pick an entry of an account's "More" menu. */
async function more(user: ReturnType<typeof userEvent.setup>, card: HTMLElement, entry: string) {
  await user.click(within(card).getByTestId('sync-more'))
  await user.click(await screen.findByRole('menuitem', {name: new RegExp(`${entry}$`)}))
}

const account = (patch: Partial<SubscriptionView> = {}): SubscriptionView => ({
  id: 'S'.padEnd(32, '1'),
  site: 'tiktok',
  user: 'someone',
  url: 'https://www.tiktok.com/@someone',
  folder: '/Videos/TikTok-someone',
  profile: {kind: 'video', container: 'mp4'},
  schedule: {every: 'day', at: '08:00'},
  createdAt: Date.now() - 86_400_000,
  runs: [],
  state: 'idle',
  nextRunAt: Date.now() + 3_600_000,
  ...patch,
})

describe('account names and folders', () => {
  it('reads @name, name and profile links; nothing else', () => {
    expect(tiktokAccount('@some.one_1')).toBe('some.one_1')
    expect(tiktokAccount('someone')).toBe('someone')
    expect(tiktokAccount(' https://www.tiktok.com/@someone?lang=es ')).toBe('someone')
    expect(tiktokAccount('tiktok.com/@someone/')).toBe('someone')
    expect(tiktokAccount('https://www.tiktok.com/@someone/video/7500000000000000001')).toBeUndefined()
    expect(tiktokAccount('https://www.youtube.com/@someone')).toBeUndefined()
    expect(tiktokAccount('two words')).toBeUndefined()
  })

  it('suggests the folder a profile download uses', () => {
    expect(suggestedFolder('/Users/me/Downloads/', 'someone')).toBe('/Users/me/Downloads/TikTok-someone')
    expect(suggestedFolder('C:\\Users\\me\\Downloads', 'someone')).toBe('C:\\Users\\me\\Downloads\\TikTok-someone')
  })
})

describe('Sync Up', () => {
  it('is always a section next to New download, its schedule switch in Settings', async () => {
    const {api, user} = await mount(new FakeApi())
    expect(await screen.findByRole('tab', {name: 'New download'})).toHaveAttribute('aria-selected', 'true')
    await openSync(user)
    expect(screen.queryByLabelText('Video, playlist or profile URL')).not.toBeInTheDocument()
    expect(screen.getByText(/No accounts yet/)).toBeInTheDocument()
    // the batches below stay where they are
    expect(screen.getByRole('tab', {name: /^Batches/})).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: /settings/i}))
    await user.click(await screen.findByRole('switch', {name: 'Run scheduled syncs (Sync Up)'}))
    expect(api.setSettings).toHaveBeenCalledWith({syncEnabled: true})
  })

  it('is there in every run, its schedule switch showing whether it is on', async () => {
    const {user} = await mount(new FakeApi({settings: {syncEnabled: true}}))
    expect(screen.getByRole('tab', {name: 'Sync Up'})).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: /settings/i}))
    expect(await screen.findByRole('switch', {name: 'Run scheduled syncs (Sync Up)'})).toBeChecked()
    expect(screen.queryByTestId('settings-mode')).not.toBeInTheDocument()
  })

  it('adds an account into the folder that already has its videos, keeping their format, and syncs it', async () => {
    const api = new FakeApi({settings: {syncEnabled: true, format: 'mp3'}})
    api.syncFolderResult = {files: 835, formats: ['mp4'], format: 'mp4'}
    const {user} = await mount(api)
    await openSync(user)
    await user.click(screen.getByTestId('sync-add'))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox', {name: 'TikTok account'}), '@someone')
    // the folder follows the account
    expect(within(dialog).getByRole('textbox', {name: 'Folder'})).toHaveValue('/Users/me/Downloads/TikTok-someone')
    const info = await within(dialog).findByTestId('sync-folder-info')
    expect(api.syncFolder).toHaveBeenLastCalledWith('/Users/me/Downloads/TikTok-someone')
    expect(info).toHaveTextContent('This folder has 835 MP4 files')
    // MP3 is the usual format, but this folder holds MP4: the format is the folder's
    const format = within(dialog).getByRole('combobox', {name: 'Format'})
    expect(format.closest('.ant-select')).toHaveClass('ant-select-disabled')
    expect(within(dialog).getByText(/MP4 · H.264/)).toBeInTheDocument()
    await user.click(within(dialog).getByTestId('sync-save'))
    expect(api.syncAdd).toHaveBeenCalledWith({
      url: 'https://www.tiktok.com/@someone',
      folder: '/Users/me/Downloads/TikTok-someone',
      schedule: {every: 'day', at: '08:00'},
    })
    await waitFor(() => expect(api.syncRun).toHaveBeenCalledWith(api.syncs[0]!.id, false))
    const card = await screen.findByTestId('sync-card')
    expect(card).toHaveTextContent('@someone')
    expect(card).toHaveTextContent('MP4')
    expect(card).toHaveTextContent('Daily at 08:00')
  })

  it('an empty folder takes the format chosen; a folder mixing formats cannot be synced', async () => {
    const api = new FakeApi({settings: {syncEnabled: true}})
    const {user} = await mount(api)
    await openSync(user)
    await user.click(screen.getByTestId('sync-add'))
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByRole('textbox', {name: 'TikTok account'})
    await user.type(name, 'https://www.youtube.com/@someone')
    expect(within(dialog).getByText(/Write a TikTok account/)).toBeInTheDocument()
    expect(within(dialog).getByTestId('sync-save')).toBeDisabled()

    await user.clear(name)
    await user.type(name, 'someone')
    expect(await within(dialog).findByTestId('sync-folder-info')).toHaveTextContent('Empty or new folder')
    await user.click(within(dialog).getByRole('combobox', {name: 'Format'}))
    await user.click(await screen.findByText('MP3', {selector: '.ant-select-item-option-content'}))
    await user.click(within(dialog).getByText('On demand'))
    await user.click(within(dialog).getByRole('button', {name: 'Add'}))
    expect(api.syncAdd).toHaveBeenCalledWith({
      url: 'https://www.tiktok.com/@someone',
      folder: '/Users/me/Downloads/TikTok-someone',
      format: 'mp3',
      schedule: {every: 'manual'},
    })
    expect(api.syncRun).not.toHaveBeenCalled()

    api.syncFolderResult = {files: 3, formats: ['mp4', 'mp3'], problem: 'mixed'}
    await user.click(screen.getByTestId('sync-add'))
    const again = await screen.findByRole('dialog')
    await user.type(within(again).getByRole('textbox', {name: 'TikTok account'}), 'other')
    expect(await within(again).findByTestId('sync-folder-info')).toHaveTextContent('This folder mixes MP4, MP3 files')
    expect(within(again).getByTestId('sync-save')).toBeDisabled()
    expect(within(again).getByRole('button', {name: 'Add'})).toBeDisabled()
  })

  it('checks what is new without downloading, then downloads it', async () => {
    const api = new FakeApi({settings: {syncEnabled: true}})
    api.syncs = [account()]
    api.syncCheckResult = {
      listed: 20,
      total: 860,
      inFolder: 835,
      new: 2,
      sample: [
        {id: '7500000000000000002', title: 'Newest post'},
        {id: '7500000000000000001', title: 'Another post'},
      ],
      gone: 0,
      caughtUp: true,
    }
    const {user} = await mount(api)
    await openSync(user)
    await more(user, await screen.findByTestId('sync-card'), 'Check')
    const result = await screen.findByTestId('sync-check-result')
    expect(api.syncCheck).toHaveBeenCalledWith(api.syncs[0]!.id, false)
    expect(result).toHaveTextContent('New: 2')
    expect(result).toHaveTextContent('Read from TikTok: 20 · in the folder: 835')
    expect(result).toHaveTextContent('Newest post')
    expect(api.syncRun).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', {name: 'Download 2'}))
    expect(api.syncRun).toHaveBeenCalledWith(api.syncs[0]!.id, false)
  })

  it('follows a run live and opens its batch in Downloads and Finished', async () => {
    const api = new FakeApi({settings: {syncEnabled: true}})
    const item = account()
    api.syncs = [item]
    const {user} = await mount(api)
    await openSync(user)
    await user.click(await screen.findByTestId('sync-run'))
    expect(api.syncRun).toHaveBeenCalledWith(item.id, false)
    act(() => api.pushSync({view: {...item, state: 'listing', progress: {listed: 45, expected: 860}}}))
    expect(await screen.findByTestId('sync-state')).toHaveTextContent('Reading TikTok')
    expect(screen.getByTestId('sync-card')).toHaveTextContent('45 posts read')
    expect(screen.getByTestId('sync-run')).toBeDisabled()
    const run = {
      id: 'R1',
      trigger: 'manual' as const,
      deep: true,
      status: 'done' as const,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      listed: 839,
      inFolder: 835,
      new: 4,
      downloaded: 4,
      failed: 0,
      gone: 0,
      batchId: 'B-sync',
    }
    act(() => api.pushSync({view: {...item, runs: [run]}}))
    const card = screen.getByTestId('sync-card')
    await waitFor(() => expect(card).toHaveTextContent('new: 4 · downloaded: 4 · in the folder: 835'))
    expect(within(card).getByTestId('sync-run')).toBeEnabled()
    await user.click(within(card).getByRole('button', {name: 'Finished'}))
    expect(await screen.findByRole('tab', {name: /^Finished/, selected: true})).toBeInTheDocument()
  })

  it('changes the schedule, opens the folder, and removes an account keeping its files', async () => {
    const api = new FakeApi({settings: {syncEnabled: true}})
    const item = account()
    api.syncs = [item]
    const {user} = await mount(api)
    await openSync(user)
    const card = await screen.findByTestId('sync-card')

    await more(user, card, 'Change schedule')
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByText('Every N hours'))
    await user.click(within(dialog).getByRole('button', {name: 'Save'}))
    expect(api.syncUpdate).toHaveBeenCalledWith(item.id, {schedule: {every: 'hours', hours: 6}})
    expect(await within(card).findByText('Every 6 h')).toBeInTheDocument()

    await more(user, card, 'Open folder')
    expect(api.openFolder).toHaveBeenCalledWith({syncId: item.id})

    await more(user, card, 'Remove account')
    expect(await screen.findByText('Its folder and files stay as they are.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Remove account'}))
    expect(api.syncRemove).toHaveBeenCalledWith(item.id)
    await waitFor(() => expect(screen.queryByTestId('sync-card')).not.toBeInTheDocument())
  })
})
