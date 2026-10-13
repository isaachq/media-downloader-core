import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {JobSnapshot} from 'media-downloader-core'
import {afterEach, describe, expect, it, vi} from 'vitest'
import type {FinishedEntry, Preview} from '../../shared/contract'
import {App} from './App'
import {setApi} from './api'
import {translator} from './i18n'
import {buildReport, reportText} from './report'
import {AppStore} from './store'
import {batch, FakeApi, INFO, job} from './test/fake-api'

afterEach(() => {
  setApi(undefined)
  vi.useRealTimers()
})

async function mount(api = new FakeApi()) {
  setApi(api)
  const target = new AppStore()
  render(<App target={target} />)
  await screen.findByTestId('theme-mode', {}, {timeout: 5000})
  return {api, target, user: userEvent.setup()}
}

const bundle = (jobs: JobSnapshot[]) => ({jobs, batches: [], items: [], logs: []})

describe('store counts', () => {
  it('follows every status change in O(1), keeps trimmed finished jobs counted until cleared', () => {
    const store = new AppStore()
    const running = job({status: 'downloading', weight: 1})
    store.apply(bundle([running, job({status: 'queued'}), job({status: 'validating', weight: 2})]))
    expect(store.counts.downloading).toBe(1)
    expect(store.counts.queued).toBe(1)
    expect(store.counts.used).toBe(3)

    // a job moves on: counted once, in its new status
    store.apply(
      bundle([
        {
          ...running,
          status: 'completed',
          outcome: 'success',
          validation: {sizeBytes: 5000} as JobSnapshot['validation'],
        },
      ]),
    )
    expect(store.counts.downloading).toBe(0)
    expect(store.counts.completed).toBe(1)
    expect(store.counts.used).toBe(2)
    expect(store.counts.finishedBytes).toBe(5000)

    // 2,000 finished jobs: the store keeps 1,500 rows, the counts keep all of them
    const many = Array.from({length: 2000}, () => job({status: 'completed', outcome: 'success'}))
    store.apply(bundle(many))
    expect(store.jobs.size).toBeLessThanOrEqual(1500)
    expect(store.counts.completed).toBe(2001)

    // a failed job retried is no longer failed
    const failed = job({status: 'failed', outcome: 'failed'})
    store.apply(bundle([failed]))
    expect(store.counts.failed).toBe(1)
    store.apply(bundle([{...failed, status: 'queued', outcome: 'in-progress'}]))
    expect(store.counts.failed).toBe(0)

    store.clearFinished()
    expect(store.counts.completed).toBe(0)
    expect(store.counts.validating).toBe(1)
    expect(store.counts.finishedBytes).toBe(5000)
  })

  it('hands out the same counts object until a job changes status (progress alone re-renders nothing)', () => {
    const store = new AppStore()
    const running = job({status: 'downloading'})
    store.apply(bundle([running]))
    const first = store.counts
    expect(store.counts).toBe(first)
    store.apply(bundle([{...running, progress: {fraction: 0.5, speed: 1e6}}]))
    expect(store.counts).toBe(first)
    store.apply(bundle([{...running, status: 'validating'}]))
    expect(store.counts).not.toBe(first)
    expect(store.counts.validating).toBe(1)
  })
})

describe('run report', () => {
  const store = () => {
    const target = new AppStore()
    const running = batch({
      id: 'B-run' as never,
      title: 'Running list',
      status: 'running',
      progress: {fraction: 0.5, etaSeconds: 120},
      jobs: {total: 10, queued: 3, running: 2, succeeded: 4, failed: 1, cancelled: 0},
    })
    const waiting = batch({
      id: 'B-wait' as never,
      title: 'Next list',
      status: 'scheduled',
      jobs: {total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0},
      preflight: {total: 0, checked: 0, ok: 0, unavailable: 0},
    })
    const downloads = Array.from({length: 12}, (_, i) =>
      job({title: `Clip ${i}`, status: 'downloading', progress: {fraction: i / 12, speed: 1000}}),
    )
    target.apply({
      jobs: [
        ...downloads,
        job({title: 'Checking me', status: 'validating', progress: {fraction: 0.4}}),
        job({title: 'Waiting', status: 'queued'}),
        job({title: 'Done A', status: 'completed', outcome: 'success', finishedAt: 10}),
        job({title: 'Done B', status: 'completed', outcome: 'success', finishedAt: 20}),
        job({
          title: 'Broken',
          status: 'failed',
          outcome: 'failed',
          finishedAt: 5,
          error: {code: 'unavailable', message: 'Video unavailable'},
        }),
      ],
      batches: [waiting, running],
      items: [],
      logs: [],
    })
    return target
  }

  it('sums up the run: totals, stages, what is in each stage, batches and recent results', () => {
    const target = store()
    const report = buildReport({
      runId: 'RUN1',
      startedAt: 1,
      counts: target.counts,
      batches: target.batches.values(), // single-pass iterators are fine
      jobs: target.jobs.values(),
      now: 99,
    })
    expect(report).toMatchObject({
      runId: 'RUN1',
      at: 99,
      pending: 1,
      inProgress: 13,
      finished: 2,
      failed: 1,
      cancelled: 0,
    })
    expect(report.stages).toEqual({downloading: 12, processing: 0, converting: 0, validating: 1, finalizing: 0})
    expect(report.now.downloading).toHaveLength(8)
    expect(report.now.downloading[0]?.title).toBe('Clip 11') // most advanced first
    expect(report.now.validating.map(j => j.title)).toEqual(['Checking me'])
    expect(report.speed).toBe(12_000)
    expect(report.batches.map(b => b.title)).toEqual(['Running list', 'Next list'])
    expect(report.batchesWaiting).toBe(1)
    expect(report.etaSeconds).toBe(120)
    expect(report.fraction).toBe(0.5)
    expect(report.recentDone.map(j => j.title)).toEqual(['Done B', 'Done A'])
    expect(report.recentFailed[0]).toMatchObject({title: 'Broken', error: 'Video unavailable'})
  })

  it('reads as plain text in both languages', () => {
    const target = store()
    const report = buildReport({
      runId: 'RUN1',
      startedAt: 1,
      counts: target.counts,
      batches: target.batches.values(),
      jobs: target.jobs.values(),
    })
    const format = {bytes: String, rate: String, time: String, left: String, cause: String}
    const en = reportText(report, {...format, label: translator('en') as never})
    expect(en).toContain('Run ID: RUN1')
    expect(en).toContain('Pending: 1 · In progress: 13 · Finished: 2 · Failed: 1')
    expect(en).toContain('Verifying: 1')
    const es = reportText(report, {...format, label: translator('es') as never})
    expect(es).toContain('ID de ejecución: RUN1')
    expect(es).toContain('Pendientes: 1 · En progreso: 13 · Terminados: 2 · Fallidos: 1')
  })
})

describe('finished tab', () => {
  const entry = (i: number, patch: Partial<FinishedEntry> = {}): FinishedEntry => ({
    key: `k${i}`,
    title: `Finished clip ${i}`,
    filepath: `/Users/me/Downloads/Finished-clip-${i}.mp4`,
    sizeBytes: 1_000_000 * i,
    duration: 60 * i,
    extractor: 'Youtube',
    url: `https://example.com/${i}`,
    completedAt: Date.UTC(2026, 9, 11, 12, i),
    sha256: 'a'.repeat(64),
    validation: 'full',
    file: 'ok',
    ...patch,
  })

  it('lists finished files of every session; plays, shows and searches them', async () => {
    const api = new FakeApi()
    api.finishedEntries = [entry(2), entry(1, {file: 'missing'})]
    const {user} = await mount(api)
    await user.click(screen.getByRole('tab', {name: /^Finished/}))
    const list = await screen.findByTestId('finished-list')
    expect(await within(list).findByText('Finished clip 2')).toBeInTheDocument()
    expect(within(list).getByTestId('finished-summary')).toHaveTextContent('2 files · 3 MB')
    expect(within(list).getByText('Verified')).toBeInTheDocument()
    expect(within(list).getByText('File not found')).toBeInTheDocument()

    const rows = within(list).getAllByRole('row')
    const row2 = rows.find(row => row.textContent?.includes('Finished clip 2'))!
    await user.click(within(row2).getByRole('button', {name: 'Play / open'}))
    expect(api.openFinished).toHaveBeenLastCalledWith('k2', 'file')
    await user.click(within(row2).getByRole('button', {name: 'Show in folder'}))
    expect(api.openFinished).toHaveBeenLastCalledWith('k2', 'folder')
    const row1 = rows.find(row => row.textContent?.includes('Finished clip 1'))!
    expect(within(row1).getByRole('button', {name: 'Play / open'})).toBeDisabled()

    await user.click(within(list).getByRole('button', {name: /Open downloads folder/}))
    expect(api.openFolder).toHaveBeenCalledWith('downloads')

    await user.type(within(list).getByLabelText('Search finished files by title or name'), 'clip 2')
    await waitFor(() =>
      expect(api.finished).toHaveBeenLastCalledWith({offset: 0, limit: 50, search: 'clip 2', sort: 'newest'}),
    )
    expect(await within(list).findByTestId('finished-summary')).toHaveTextContent('1 file · 2 MB')
    await waitFor(() => expect(within(list).queryByText('Finished clip 1')).not.toBeInTheDocument())
  })

  it('says "verified" only when a check ran: checksum-only and older records say so', async () => {
    const api = new FakeApi()
    api.finishedEntries = [
      entry(3, {title: 'Checked', validation: 'quick'}),
      entry(2, {title: 'Check off', validation: 'none'}),
      entry(1, {title: 'Older record', validation: undefined}),
    ]
    const {user} = await mount(api)
    await user.click(screen.getByRole('tab', {name: /^Finished/}))
    const list = await screen.findByTestId('finished-list')
    const row = async (title: string) =>
      (await within(list).findAllByRole('row')).find(r => r.textContent?.includes(title))!
    expect(within(await row('Checked')).getByText('Verified')).toBeInTheDocument()
    expect(within(await row('Check off')).getByText('Not checked')).toBeInTheDocument()
    expect(within(await row('Older record')).getByText('Checksum')).toBeInTheDocument()
  })

  it('warns when a file is gone, and follows new completions without reloading on every event', async () => {
    const api = new FakeApi()
    api.finishedEntries = [entry(1)]
    api.openFinished.mockResolvedValueOnce(false)
    const {user} = await mount(api)
    await user.click(screen.getByRole('tab', {name: /^Finished/}))
    const list = await screen.findByTestId('finished-list')
    await user.click(await within(list).findByRole('button', {name: 'Play / open'}))
    expect(await screen.findByText('That file is no longer where it was downloaded.')).toBeInTheDocument()

    await waitFor(() => expect(api.finished).toHaveBeenCalledTimes(2)) // the warning reloads the page
    const before = api.finished.mock.calls.length
    api.finishedEntries = [entry(3), entry(1)]
    const running = job({status: 'downloading'})
    act(() => api.emit({jobs: [running]}))
    act(() => api.emit({jobs: [{...running, progress: {fraction: 0.5}}]})) // progress alone: no reload
    act(() => api.emit({jobs: [{...running, status: 'completed', outcome: 'success'}]}))
    expect(await within(list).findByText('Finished clip 3', {}, {timeout: 4000})).toBeInTheDocument()
    expect(api.finished.mock.calls.length).toBe(before + 1)
  })
})

describe('tabs, stats and batches', () => {
  it('shows live counts on the tabs, and a stat card opens its tab', async () => {
    const api = new FakeApi()
    const {user} = await mount(api)
    act(() =>
      api.emit({
        batches: [batch({status: 'running'})],
        jobs: [job({status: 'downloading'}), job({status: 'queued'}), job({status: 'completed', outcome: 'success'})],
      }),
    )
    expect(screen.getByRole('tab', {name: /^Batches/})).toHaveTextContent('Batches1')
    expect(screen.getByRole('tab', {name: /^Downloads/})).toHaveTextContent('Downloads2')
    expect(screen.getByRole('tab', {name: /^Finished/})).toHaveTextContent('Finished1')

    await user.click(screen.getByRole('button', {name: 'Completed'}))
    expect(await screen.findByTestId('finished-list')).toBeInTheDocument()
    expect(screen.getByRole('tab', {name: /^Finished/})).toHaveAttribute('aria-selected', 'true')
  })

  it("opens a batch's folder once it has finished files", async () => {
    const done = batch({
      status: 'completed',
      jobs: {total: 2, queued: 0, running: 0, succeeded: 2, failed: 0, cancelled: 0},
    })
    const {api, user} = await mount(new FakeApi({state: {batches: [done], jobs: []}}))
    await user.click(screen.getByTestId('batch-open-folder'))
    expect(api.openFolder).toHaveBeenCalledWith({batchId: done.id})
  })
})

describe('report modal', () => {
  it('shows the run id and everything in flight, refreshes every 15 s, and copies as text', async () => {
    const api = new FakeApi()
    const {user} = await mount(api)
    const running = batch({title: 'Road trip', status: 'running', progress: {fraction: 0.25, etaSeconds: 600}})
    act(() =>
      api.emit({
        batches: [running],
        jobs: [
          job({title: 'Song one', status: 'downloading', progress: {fraction: 0.3, speed: 2_000_000}}),
          job({title: 'Song two', status: 'validating'}),
          job({title: 'Song three', status: 'queued'}),
        ],
      }),
    )
    await user.click(screen.getByTestId('open-report'))
    const report = await screen.findByTestId('report')
    expect(within(report).getByTestId('report-run-id')).toHaveTextContent(INFO.sessionId)
    expect(within(report).getByTestId('report-pending')).toHaveTextContent('1')
    expect(within(report).getByTestId('report-inProgress')).toHaveTextContent('2')
    expect(within(report).getByTestId('report-stage-validating')).toHaveTextContent('Verifying · 1')
    expect(within(report).getByText('Song one')).toBeInTheDocument()
    expect(within(report).getByText('Road trip')).toBeInTheDocument()
    expect(within(report).getByTestId('report-next')).toHaveTextContent(/next update in 1[45] s/)

    // new work does not change the open report until its next reading…
    act(() => api.emit({jobs: [job({title: 'Song four', status: 'downloading'})]}))
    expect(within(report).queryByText('Song four')).not.toBeInTheDocument()
    // …which "Refresh now" brings forward
    await user.click(within(report).getByRole('button', {name: /Refresh now/}))
    expect(await within(report).findByText('Song four')).toBeInTheDocument()

    await user.click(within(report).getByRole('button', {name: /Copy report/}))
    const text = await navigator.clipboard.readText()
    expect(text).toContain(`Run ID: ${INFO.sessionId}`)
    expect(text).toContain('Song one')
  })

  it('reads the store again on its own after 15 s', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true})
    const api = new FakeApi()
    setApi(api)
    render(<App target={new AppStore()} />)
    await screen.findByTestId('theme-mode', {}, {timeout: 5000})
    const user = userEvent.setup({advanceTimers: vi.advanceTimersByTime})
    await user.click(screen.getByTestId('open-report'))
    const report = await screen.findByTestId('report')
    act(() => api.emit({jobs: [job({title: 'Late song', status: 'downloading'})]}))
    expect(within(report).queryByText('Late song')).not.toBeInTheDocument()
    await act(async () => {
      vi.advanceTimersByTime(15_000)
    })
    expect(await within(report).findByText('Late song')).toBeInTheDocument()
  })

  it('speaks Spanish', async () => {
    const api = new FakeApi({settings: {language: 'es'}})
    const {user} = await mount(api)
    await user.click(screen.getByRole('button', {name: /Reporte/}))
    expect(await screen.findByText('Reporte de la ejecución')).toBeInTheDocument()
    expect(screen.getByText('ID de ejecución:')).toBeInTheDocument()
    expect(screen.getByText('Aún no se ha programado nada en esta ejecución.')).toBeInTheDocument()
  })
})

describe('preview of a profile whose count includes posts it does not list', () => {
  const entry = (index: number) => ({
    id: `v${index}`,
    index,
    url: `https://www.tiktok.com/@a/video/${index}`,
    title: `Post ${index}`,
    duration: 15,
    extractor: 'TikTok',
    isLive: false,
  })

  it('explains it instead of offering a load that brings nothing (Spanish)', async () => {
    const api = new FakeApi({info: {mode: 'tiktok'}, settings: {language: 'es'}})
    api.preview = {
      kind: 'playlist',
      title: 'TikTok @a',
      entries: [entry(1), entry(2)],
      mix: false,
      maxItems: 1022,
      total: 1022,
      complete: true,
    } satisfies Preview
    const {user} = await mount(api)
    await user.type(screen.getByLabelText(/URL/), 'https://www.tiktok.com/@a')
    await user.click(screen.getByRole('button', {name: /Descargar/}))
    const notice = await screen.findByTestId('preview-unlisted')
    expect(notice).toHaveTextContent('Aquí están las 2 publicaciones públicas. TikTok cuenta 1022')
    expect(notice).toHaveTextContent('las otras 1020 no aparecen en su lista pública')
    expect(screen.queryByTestId('preview-load-all')).not.toBeInTheDocument()
  })

  it('a listing that stopped short offers to continue', async () => {
    const api = new FakeApi({info: {mode: 'tiktok'}})
    api.preview = {
      kind: 'playlist',
      title: 'TikTok @a',
      entries: [entry(1), entry(2)],
      mix: false,
      maxItems: 1022,
      total: 1022,
      complete: false,
    } satisfies Preview
    const {user} = await mount(api)
    await user.type(screen.getByLabelText('Video, playlist or profile URL'), 'https://www.tiktok.com/@a')
    await user.click(screen.getByRole('button', {name: /download/i}))
    expect(await screen.findByText(/TikTok’s listing stopped at 2 of 1022/)).toBeInTheDocument()
    expect(screen.getByTestId('preview-load-all')).toBeInTheDocument()
  })
})
