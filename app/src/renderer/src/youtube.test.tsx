import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterEach, describe, expect, it} from 'vitest'
import {App} from './App'
import {setApi} from './api'
import {AppStore} from './store'
import {batch, FakeApi} from './test/fake-api'

afterEach(() => setApi(undefined))

async function mount(api = new FakeApi()) {
  setApi(api)
  render(<App target={new AppStore()} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000})
  return {api, user: userEvent.setup()}
}

describe("YouTube's bot check", () => {
  it('says what happens and offers to go on with a browser session, at once', async () => {
    const {api, user} = await mount()
    expect(screen.queryByTestId('youtube-pause')).not.toBeInTheDocument()
    act(() => api.emit({youtubePausedUntil: Date.now() + 5 * 60_000}))
    const banner = await screen.findByTestId('youtube-pause')
    expect(banner).toHaveTextContent("YouTube is asking to confirm you're not a bot")
    expect(banner).toHaveTextContent(/try again by themselves at \d{1,2}:\d{2}/)
    // Safari needs a permission the others don't: the banner says so when it is picked
    await user.click(within(banner).getByRole('combobox', {name: 'Cookies from browser'}))
    await user.click(await screen.findByText('safari', {selector: '.ant-select-item-option-content'}))
    expect(banner).toHaveTextContent('Full Disk Access')
    await user.click(within(banner).getByRole('button', {name: 'Use and continue'}))
    expect(api.setSettings).toHaveBeenCalledWith({cookiesFromBrowser: 'safari'})
    expect(await within(banner).findByText(/Using safari's session/)).toBeInTheDocument()
    // the engine resumes: the next bundle says so and the banner goes away
    act(() => api.emit({youtubePausedUntil: null}))
    await waitFor(() => expect(screen.queryByTestId('youtube-pause')).not.toBeInTheDocument())
  })

  it('with the app’s verification tokens, only says it goes on by itself: nothing to choose', async () => {
    const {api} = await mount()
    act(() => api.pushYouTube({level: 'attested', tokens: true, pausedUntil: Date.now() + 90_000}))
    const note = await screen.findByTestId('youtube-pause')
    expect(note).toHaveTextContent('with verification tokens the app makes. Nothing to do.')
    expect(within(note).queryByRole('button')).not.toBeInTheDocument()
    expect(within(note).queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByTestId('youtube-held')).not.toBeInTheDocument()
  })

  it('held: says why, keeps the downloads, and goes on once the user signs in', async () => {
    const {api, user} = await mount()
    act(() => api.pushYouTube({level: 'held', tokens: true, pausedUntil: null}))
    const body = await screen.findByTestId('youtube-held-body')
    expect(body).toHaveTextContent("YouTube keeps asking to confirm you're not a bot")
    expect(body).toHaveTextContent('paused, not lost')
    expect(body).toHaveTextContent('a second account is safer')
    await user.click(screen.getByRole('button', {name: 'Sign in and continue'}))
    expect(api.youtubeSignIn).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByTestId('youtube-held-body')).not.toBeInTheDocument())
  })

  it('held: a refused sign-in says so and stays; waiting closes it; a signed-in account is one click', async () => {
    const api = new FakeApi()
    api.signInResult = {ok: false, reason: 'refused'}
    const {user} = await mount(api)
    act(() => api.pushYouTube({level: 'held', tokens: true}))
    await user.click(await screen.findByRole('button', {name: 'Sign in and continue'}))
    expect(await screen.findByText(/Google didn't allow signing in inside the app/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', {name: 'Wait and try again in 30 min'}))
    expect(api.youtubeWait).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByTestId('youtube-held-body')).not.toBeInTheDocument())
    // later, held again with an account already signed in: no window, one click
    act(() => api.pushYouTube({level: 'held', signedIn: true}))
    expect(await screen.findByRole('button', {name: 'Continue with my YouTube account'})).toBeInTheDocument()
  })

  it('settings show the account signed in inside the app, and sign it out', async () => {
    const {api, user} = await mount()
    act(() => api.pushYouTube({level: 'account', signedIn: true}))
    await user.click(screen.getByRole('button', {name: /settings/i}))
    const row = await screen.findByTestId('youtube-account')
    expect(row).toHaveTextContent('Signed in inside the app')
    await user.click(within(row).getByRole('button', {name: 'Sign out'}))
    expect(api.youtubeSignOut).toHaveBeenCalledOnce()
    await waitFor(() => expect(row).toHaveTextContent('Not signed in'))
  })

  it('names the cause on a batch: a bot check, not "unavailable"', async () => {
    const closed = batch({
      title: 'Mix - Song',
      status: 'completed-with-errors',
      jobs: {total: 3, queued: 0, running: 0, succeeded: 1, failed: 2, cancelled: 0},
      problems: {failed: {'bot-check': 2}, unavailable: {}},
    })
    await mount(new FakeApi({state: {batches: [closed], jobs: []}}))
    expect(screen.getByTestId('problems')).toHaveTextContent('bot check 2')
  })
})

describe('About', () => {
  it('links the repository and asks for a star', async () => {
    const {user} = await mount()
    await user.click(screen.getByRole('button', {name: 'About'}))
    const star = await screen.findByTestId('about-star')
    expect(star).toHaveTextContent('give it a star on GitHub')
    expect(within(star).getByRole('link', {name: /Star it on GitHub/})).toHaveAttribute(
      'href',
      'https://github.com/isaachq/media-downloader-core',
    )
    expect(within(star).getByRole('link', {name: 'github.com/isaachq/media-downloader-core'})).toBeInTheDocument()
  })
})
