import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {type ElectronApplication, _electron as electron, expect, type Page, test} from '@playwright/test'
import {startFakeTikTok} from '../../test/helpers/fake-tiktok'
import {writeFakes} from '../../test/helpers/fakes'
import {listenLocal} from '../../test/helpers/listen'

// The real Electron app (built by `electron-vite build`), driven end to end.
// yt-dlp / ffmpeg are the engine's test fakes, injected through MDC_BINARIES,
// so the run is fast, offline and deterministic.

const APP_DIR = path.resolve(__dirname, '..')
// MDC_E2E_EXECUTABLE runs the suite against a packaged build instead of out/
const PACKAGED = process.env.MDC_E2E_EXECUTABLE
const target = PACKAGED ? {executablePath: PACKAGED, args: []} : {args: [APP_DIR]}
let root = ''

test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-e2e-'))
})
test.afterAll(async () => {
  await fs.rm(root, {recursive: true, force: true})
})

/** What every app launched by the running test printed (main process stdout / stderr), oldest first. */
let output: string[] = []
test.beforeEach(() => {
  output = []
})
// a failure carries what the app itself said: a hang or a crash in the main process is not blind
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires its fixtures argument destructured
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && output.length > 0) {
    await testInfo.attach('app-output', {body: output.join(''), contentType: 'text/plain'})
  }
})

/** Launch the built app, its output kept for the report (see `output`). */
async function start(env: Record<string, string>): Promise<ElectronApplication> {
  const app = await electron.launch({...target, env: {...(process.env as Record<string, string>), ...env}})
  const launched = output.length
  const stamp = (stream: string) => (chunk: Buffer) => {
    output.push(`[app ${launched} ${stream} ${new Date().toISOString()}] ${chunk.toString()}`)
  }
  app.process().stdout?.on('data', stamp('out'))
  app.process().stderr?.on('data', stamp('err'))
  return app
}

async function launch(name: string, settings: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const dataDir = path.join(root, name, 'data')
  const outDir = path.join(root, name, 'out')
  await fs.mkdir(dataDir, {recursive: true})
  // fakes can't decode media, so the integrity check is turned off for these runs
  await fs.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      validation: 'none',
      format: 'm4a',
      language: 'en',
      theme: 'light',
      downloadDir: outDir,
      // past the first-steps guide (its own test turns it back on)
      tourDone: true,
      ...settings,
    }),
  )
  const fakes = await writeFakes(path.join(root, name, 'fakes'))
  const app = await start({
    MDC_DATA_DIR: dataDir,
    MDC_DOWNLOAD_DIR: outDir,
    MDC_BINARIES: JSON.stringify(fakes),
    ...env,
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="theme-mode"]', {state: 'attached'}) // start-up finished
  return {app, page, dataDir, outDir}
}

/** The app's own quit gives up on a stuck shutdown after 10 s (forced exit): past that it is a bug. */
const QUIT_MS = 20_000

/**
 * Quit the app; one that doesn't quit in time is killed and the test fails
 * right here, saying so — not two minutes later on the test's timeout, with
 * the worker's teardown stuck on the same process for two more.
 */
async function close(app: ElectronApplication) {
  const child = app.process()
  let timer: NodeJS.Timeout | undefined
  const quit = await Promise.race([
    app.close().then(() => true),
    new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), QUIT_MS)
    }),
  ])
  clearTimeout(timer)
  if (!quit) {
    child.kill('SIGKILL')
    throw new Error(`the app (pid ${child.pid}) did not quit within ${QUIT_MS / 1000} s`)
  }
}

/** Paste a link and start it; a list opens the preview, confirmed with everything selected. */
async function download(page: Page, url: string) {
  await page.getByLabel('Video, playlist or profile URL').fill(url)
  await page
    .getByRole('button', {name: /download|schedule/i})
    .first()
    .click()
  if (url.includes('list')) {
    await page
      .locator('.ant-modal')
      .getByRole('button', {name: /Download \d+$/})
      .click()
  }
}

test('downloads a playlist batch end to end: preflight, jobs, files on disk', async () => {
  const {app, page, outDir} = await launch('batch')
  await expect(page.getByText('One-time setup')).toHaveCount(0) // tools are ready
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'home-light.png')})

  await download(page, 'https://fake.test/list?n=4')
  const card = page.getByTestId('batch-card').first()
  await expect(card).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
  await expect(card).toContainText('4/4 done')
  await expect(page.getByText('Batch finished')).toBeVisible()

  await card.getByRole('button', {name: /items/i}).click()
  // clean screenshot: dismiss the notification and let the toast expire
  await page.locator('.ant-notification-notice-close').click()
  await expect(page.locator('.ant-message-notice, .ant-notification-notice')).toHaveCount(0, {timeout: 8_000})
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'batch.png'), fullPage: true})

  await page.getByRole('tab', {name: /^Downloads/}).click()
  await expect(page.locator('[data-testid="job-status"][data-status="completed"]')).toHaveCount(4)
  await page.waitForTimeout(400)
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'downloads.png')})

  await page.getByRole('button', {name: /settings/i}).click()
  await page.waitForTimeout(500)
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'settings.png')})

  // Diagnose from Settings: the setup modal must be the topmost element, in front of the drawer
  await page.getByRole('button', {name: /run diagnostics/i}).click()
  const modal = page.locator('.ant-modal').filter({hasText: 'One-time setup'})
  await expect(modal).toBeVisible()
  const box = (await modal.boundingBox())!
  const onTop = await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.closest('.ant-modal') !== null, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })
  expect(onTop).toBe(true)

  const files = await fs.readdir(path.join(outDir, 'Fake-List'))
  expect(files.sort()).toEqual([
    '001-Title-b1-b1.m4a',
    '002-Title-b2-b2.m4a',
    '003-Title-b3-b3.m4a',
    '004-Title-b4-b4.m4a',
  ])
  await close(app)
})

test('finished files of every session, their folders, and the run report', async () => {
  const openLog = path.join(root, 'finished-open.log')
  const {app, page, outDir} = await launch('finished', {}, {MDC_OPEN_LOG: openLog})
  await page.getByLabel('Video, playlist or profile URL').fill('https://fake.test/list?n=3')
  await page
    .getByRole('button', {name: /download/i})
    .first()
    .click()
  await page
    .locator('.ant-modal')
    .getByRole('button', {name: /Download 3$/})
    .click()
  const card = page.getByTestId('batch-card').first()
  await expect(card).toHaveAttribute('data-status', 'completed', {timeout: 60_000})

  // the batch's folder, from its card
  await card.getByTestId('batch-open-folder').click()
  // the Finished tab: the three files, newest first, verified, with live count on the tab
  await expect(page.getByRole('tab', {name: /^Finished/})).toContainText('3')
  await page.getByRole('button', {name: 'Completed'}).click()
  const list = page.getByTestId('finished-list')
  await expect(list.locator('.finished-row')).toHaveCount(3)
  await expect(list.getByTestId('finished-summary')).toContainText('3 files')
  // these runs turn the integrity check off: the files have their checksum, not a "verified"
  await expect(list.getByText('Not checked')).toHaveCount(3)
  const first = list.locator('.finished-row').first()
  await first.getByRole('button', {name: 'Play / open'}).click()
  await first.getByRole('button', {name: 'Show in folder'}).click()
  await list.getByRole('button', {name: /Open downloads folder/}).click()
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'finished.png')})

  // the run report sums the three tabs up
  await page.locator('.ant-notification-notice-close').click()
  await page.getByTestId('open-report').click()
  const report = page.getByTestId('report')
  await expect(report.getByTestId('report-finished')).toContainText('3')
  await expect(report.getByTestId('report-run-id')).toHaveText(/^[A-Za-z0-9]{6,32}$/)
  await expect(report).toContainText('Fake List')
  await page.waitForTimeout(500) // the modal's opening animation
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'report.png')})

  // what the system was asked to open: the batch folder, then the newest file (whichever of the three
  // parallel downloads ended last) with its app and in its folder, then the downloads folder
  const folder = path.join(outDir, 'Fake-List')
  await expect.poll(async () => (await fs.readFile(openLog, 'utf8').catch(() => '')).trim().split('\n').length).toBe(4)
  const [batchFolder, played, revealed, downloads] = (await fs.readFile(openLog, 'utf8')).trim().split('\n')
  expect(batchFolder).toBe(`open ${folder}`)
  expect(played!.startsWith(`open ${folder}${path.sep}`)).toBe(true)
  expect(path.basename(played!)).toMatch(/^00[1-3]-Title-b[1-3]-b[1-3]\.m4a$/)
  expect(revealed).toBe(played!.replace(/^open /, 'reveal '))
  expect(downloads).toBe(`open ${outDir}`)
  await close(app)
})

test('the first launch shows the three first steps once; Guide replays them', async () => {
  const {app, page, dataDir} = await launch('guide', {tourDone: false})
  const tour = page.locator('.ant-tour')
  await expect(tour).toContainText('1 · Paste a link')
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'guide.png')})
  await tour.getByRole('button', {name: 'Next'}).click()
  await expect(tour).toContainText('2 · Choose what you get')
  await tour.getByRole('button', {name: 'Next'}).click()
  await expect(tour).toContainText('3 · Download')
  await tour.getByRole('button', {name: 'Finish'}).click()
  await expect(tour).toBeHidden()
  await expect
    .poll(async () => JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).tourDone)
    .toBe(true)
  await page.getByTestId('open-guide').click()
  await expect(page.locator('.ant-tour')).toContainText('1 · Paste a link')
  await close(app)

  // a second launch doesn't show it again
  const again = await start({MDC_DATA_DIR: dataDir})
  const second = await again.firstWindow()
  await second.waitForSelector('[data-testid="theme-mode"]', {state: 'attached'})
  await second.waitForTimeout(800)
  await expect(second.locator('.ant-tour:visible')).toHaveCount(0)
  await close(again)
})

test('previews a list and downloads only the picked items', async () => {
  const {app, page, outDir} = await launch('pick')
  await page.getByLabel('Video, playlist or profile URL').fill('https://fake.test/list?n=5')
  await page
    .getByRole('button', {name: /download/i})
    .first()
    .click()
  const preview = page.locator('.ant-modal').filter({hasText: 'Choose what to download'})
  await expect(preview).toContainText('5 of 5 selected')
  await preview.getByRole('button', {name: 'Select none'}).click()
  await preview.getByText('Entry b2').click()
  await preview.getByText('Entry b5').click()
  await expect(preview).toContainText('2 of 5 selected')
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'preview.png')})
  await preview.getByRole('button', {name: 'Download 2'}).click()

  const card = page.getByTestId('batch-card').first()
  await expect(card).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
  await expect(card).toContainText('2/2 done')
  const files = await fs.readdir(path.join(outDir, 'Fake-List'))
  expect(files.sort()).toEqual(['002-Title-b2-b2.m4a', '005-Title-b5-b5.m4a'])
  await close(app)
})

test('backs up picked posts of a TikTok profile as MP3 (built-in extractor)', async () => {
  const site = await startFakeTikTok({posts: 6, pinned: true})
  try {
    const {app, page, outDir} = await launch(
      'tiktok',
      {format: 'mp3', mode: 'tiktok'},
      {MDC_TIKTOK_ORIGIN: site.origin},
    )
    await page.getByLabel('Video, playlist or profile URL').fill(`${site.origin}/@${site.user}`)
    await page
      .getByRole('button', {name: /download/i})
      .first()
      .click()
    const preview = page.locator('.ant-modal').filter({hasText: 'Choose what to download'})
    await expect(preview).toContainText('TikTok @fakeuser')
    await expect(preview).toContainText('6 of 6 selected')
    await preview.getByRole('button', {name: 'Select none'}).click()
    await preview.locator('.ant-table-row').nth(0).click()
    await preview.locator('.ant-table-row').nth(1).click()
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'tiktok-preview.png')})
    await preview.getByRole('button', {name: /Download 2$/}).click()

    const card = page.getByTestId('batch-card').first()
    await expect(card).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
    const files = await fs.readdir(path.join(outDir, 'TikTok-fakeuser'))
    expect(files).toHaveLength(2)
    for (const file of files) expect(file).toMatch(/^\d{3}-Post-numero-\d-con-acentos-\d+\.mp3$/)
    await close(app)
  } finally {
    await site.close()
  }
})

test('Sync Up keeps a TikTok account in step with its folder, in the format of the folder', async () => {
  const site = await startFakeTikTok({posts: 5})
  try {
    // downloaded earlier as MP3 (the app's format is M4A now): recognized by the post number in the name
    const folder = path.join(root, 'sync', 'out', 'TikTok-fakeuser')
    await fs.mkdir(folder, {recursive: true})
    for (const id of site.ids.slice(2)) await fs.writeFile(path.join(folder, `old-${id}.mp3`), 'audio')
    const {app, page} = await launch(
      'sync',
      {format: 'm4a', syncEnabled: true, mode: 'tiktok'},
      {MDC_TIKTOK_ORIGIN: site.origin},
    )
    await page.getByRole('tab', {name: 'Sync Up'}).click()
    await page.getByTestId('sync-add').click()
    const dialog = page.locator('.ant-modal').filter({hasText: 'TikTok account'})
    await dialog.getByLabel('TikTok account').fill('@fakeuser')
    // the folder follows the account, and its files decide the format
    await expect(dialog.getByRole('textbox', {name: 'Folder'})).toHaveValue(folder)
    await expect(dialog.getByTestId('sync-folder-info')).toContainText('This folder has 3 MP3 files')
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'sync-add.png')})
    await dialog.getByRole('button', {name: 'Add', exact: true}).click()
    const card = page.getByTestId('sync-card')
    await expect(card).toContainText('@fakeuser')
    await expect(card).toContainText('MP3')

    // a check downloads nothing
    await card.getByTestId('sync-more').click()
    await page.getByRole('menuitem', {name: /Check$/}).click()
    const result = page.getByTestId('sync-check-result')
    await expect(result).toContainText('New: 2', {timeout: 60_000})
    await expect(result).toContainText('in the folder: 3')
    expect(await fs.readdir(folder)).toHaveLength(3)
    await page.getByRole('button', {name: 'Download 2'}).click()

    await expect(card).toContainText('downloaded: 2', {timeout: 60_000})
    const files = (await fs.readdir(folder)).sort()
    expect(files).toHaveLength(5)
    // one format in the folder; new files go straight into it, no index prefix
    expect(files.every(file => file.endsWith('.mp3'))).toBe(true)
    for (const id of site.ids.slice(0, 2)) {
      expect(files.some(file => file.endsWith(`-${id}.mp3`) && !/^\d{3}-/.test(file))).toBe(true)
    }
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'sync-up.png')})

    // the sync is an ordinary batch, below
    await expect(page.getByTestId('batch-card').first()).toContainText('Sync @fakeuser')

    // nothing new the second time
    await card.getByTestId('sync-run').click()
    await expect(page.getByText('Up to date: nothing new')).toBeVisible({timeout: 60_000})
    await close(app)
  } finally {
    await site.close()
  }
})

test('a TikTok profile behind a verification page opens through the built-in browser', async () => {
  // plain requests get a "please wait" page whose script sets a cookie and reloads: only a browser passes
  const site = await startFakeTikTok({posts: 6, jsChallenge: true})
  try {
    const {app, page, outDir} = await launch(
      'tiktok-browser',
      {format: 'mp3', mode: 'tiktok'},
      {MDC_TIKTOK_ORIGIN: site.origin},
    )
    await page.getByLabel('Video, playlist or profile URL').fill(`${site.origin}/@${site.user}`)
    await page
      .getByRole('button', {name: /download/i})
      .first()
      .click()
    await expect(page.getByTestId('analyze-loader')).toBeVisible()
    const preview = page.locator('.ant-modal').filter({hasText: 'Choose what to download'})
    await expect(preview).toContainText('6 of 6 selected', {timeout: 60_000})
    await preview.getByRole('button', {name: 'Select none'}).click()
    await preview.locator('.ant-table-row').nth(0).click()
    await preview.locator('.ant-table-row').nth(1).click()
    await preview.getByRole('button', {name: /Download 2$/}).click()
    await expect(page.getByTestId('batch-card').first()).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
    expect(await fs.readdir(path.join(outDir, 'TikTok-fakeuser'))).toHaveLength(2)
    expect(site.hits.challenge).toBeGreaterThanOrEqual(1)
    await close(app)
  } finally {
    await site.close()
  }
})

test('finds a new version, downloads it and verifies its checksum (dry run)', async () => {
  const payload = Buffer.from('new app '.repeat(20_000))
  const digest = createHash('sha256').update(payload).digest('hex')
  let origin = ''
  const feed = http.createServer((req, res) => {
    if (req.url === '/releases') {
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(
        JSON.stringify([
          {
            tag_name: 'app-v99.0.0',
            draft: false,
            body: 'Everything is new',
            html_url: `${origin}/page`,
            assets: [
              {
                name: `Media-Download-Core-99.0.0-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`,
                size: payload.length,
                digest: `sha256:${digest}`,
                browser_download_url: `${origin}/download/app.zip`,
              },
            ],
          },
        ]),
      )
      return
    }
    res.writeHead(200, {'Content-Length': String(payload.length)})
    res.end(payload)
  })
  origin = `http://127.0.0.1:${await listenLocal(feed)}`
  try {
    const {app, page, dataDir} = await launch(
      'update',
      {},
      {
        MDC_UPDATE_FEED: `${origin}/releases`,
        MDC_UPDATE_TRUSTED: `${origin}/download/`,
        MDC_UPDATE_KIND: 'mac-app',
        MDC_UPDATE_DRY_RUN: '1',
      },
    )
    await page.getByRole('button', {name: /about/i}).click()
    await page.getByRole('button', {name: 'Check for updates'}).click()
    const banner = page.getByTestId('update-banner')
    await expect(banner).toContainText('Version 99.0.0 is available')
    await page.keyboard.press('Escape')
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'update-available.png')})
    await banner.getByRole('button', {name: 'Update now'}).click()
    await expect(banner).toHaveAttribute('data-status', 'ready', {timeout: 30_000})
    await expect(banner).toContainText('Version 99.0.0 downloaded and verified')
    const saved = await fs.readFile(
      path.join(dataDir, 'updates', `Media-Download-Core-99.0.0-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`),
    )
    expect(createHash('sha256').update(saved).digest('hex')).toBe(digest)
    await close(app)
  } finally {
    await new Promise(resolve => feed.close(resolve))
  }
})

test('reports unavailable items with a reason and finishes with errors', async () => {
  const {app, page} = await launch('mixed')
  await download(page, 'https://fake.test/list-mixed')
  const card = page.getByTestId('batch-card').first()
  await expect(card).toHaveAttribute('data-status', 'completed-with-errors', {timeout: 60_000})
  await card.getByRole('button', {name: /items/i}).click()
  await expect(card.getByText('Removed or unavailable')).toBeVisible()
  await close(app)
})

test('remembers language and theme across restarts', async () => {
  const first = await launch('prefs')
  await first.page.getByText('ES', {exact: true}).click()
  await expect(first.page.getByText('Nueva descarga')).toBeVisible()
  await first.page.getByLabel('Oscuro').click()
  await expect(first.page.getByTestId('theme-mode')).toHaveText('dark')
  await first.page.waitForTimeout(600) // let Ant Design's theme transition finish
  await first.page.screenshot({path: path.join(APP_DIR, 'test-results', 'home-dark-es.png')})
  await close(first.app)

  // relaunch on the same data folder (settings.json is not rewritten this time)
  const fakes = await writeFakes(path.join(root, 'prefs', 'fakes'))
  const app = await start({MDC_DATA_DIR: first.dataDir, MDC_BINARIES: JSON.stringify(fakes)})
  const page = await app.firstWindow()
  await expect(page.getByText('Nueva descarga')).toBeVisible()
  await expect(page.getByTestId('theme-mode')).toHaveText('dark')
  await close(app)
})

// ─── beta 10 ────────────────────────────────────────────────────────────────

test('one site per run: TikTok mode has Sync Up and refuses other links; web mode has no Sync Up', async () => {
  const site = await startFakeTikTok({posts: 2})
  try {
    const tiktok = await launch('mode-tiktok', {mode: 'tiktok', syncEnabled: true}, {MDC_TIKTOK_ORIGIN: site.origin})
    await expect(tiktok.page.getByTestId('mode-tag')).toHaveText('Mode: TikTok')
    await expect(tiktok.page.getByRole('tab', {name: 'Sync Up'})).toBeVisible()
    await tiktok.page.getByLabel('Video, playlist or profile URL').fill('https://www.youtube.com/watch?v=x')
    await expect(
      tiktok.page.getByText(/This is a YouTube and websites link — this run is in TikTok mode/),
    ).toBeVisible()
    await tiktok.page.screenshot({path: path.join(APP_DIR, 'test-results', 'mode-tiktok.png')})
    await close(tiktok.app)

    // a scheduled sync never runs outside TikTok mode, and its controls are not there
    const web = await launch('mode-web', {mode: 'web', syncEnabled: true}, {MDC_TIKTOK_ORIGIN: site.origin})
    await expect(web.page.getByTestId('mode-tag')).toHaveText('Mode: YouTube and websites')
    await expect(web.page.getByRole('tab', {name: 'Sync Up'})).toHaveCount(0)
    await web.page.getByLabel('Video, playlist or profile URL').fill(`${site.origin}/@${site.user}`)
    await expect(web.page.getByText(/This is a TikTok link — this run is in YouTube and websites mode/)).toBeVisible()
    await web.page.getByRole('button', {name: /settings/i}).click()
    await expect(web.page.getByTestId('settings-mode')).toBeVisible()
    await expect(web.page.getByRole('switch', {name: 'Run scheduled syncs (Sync Up)'})).toHaveCount(0)
    await web.page.waitForTimeout(500)
    await web.page.screenshot({path: path.join(APP_DIR, 'test-results', 'settings-mode.png')})
    expect(site.hits.list + site.hits.profile).toBe(0)
    await close(web.app)
  } finally {
    await site.close()
  }
})

test('cancelling one download leaves the rest of its batch running, and the batch completes', async () => {
  const {app, page} = await launch('cancel-one', {concurrency: 1})
  await download(page, 'https://fake.test/list?n=4&p=slowest-')
  const card = page.getByTestId('batch-card').first()
  await expect(card).toHaveAttribute('data-status', 'running', {timeout: 60_000})
  await page.getByRole('tab', {name: /^Downloads/}).click()
  // the running one (first row): only it is cancelled
  await page
    .locator('.job-row')
    .first()
    .getByRole('button', {name: 'Cancel only this download (the batch goes on)'})
    .click()
  await page.getByRole('tab', {name: /^Batches/}).click()
  await expect(card).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
  await expect(card).toContainText('3/4 done')
  await expect(card).toContainText('1 cancelled')
  await expect(card.getByTestId('batch-retry-failed')).toHaveCount(0)
  await close(app)
})

test('failed downloads of several batches go into one new batch from the Failed card', async () => {
  const {app, page} = await launch('failed-list')
  await download(page, 'https://fake.test/list-gone?g=a')
  await download(page, 'https://fake.test/list-gone?g=b')
  const cards = page.getByTestId('batch-card')
  await expect(cards.nth(1)).toHaveAttribute('data-status', 'completed-with-errors', {timeout: 60_000})
  await expect(cards.nth(0)).toHaveAttribute('data-status', 'completed-with-errors', {timeout: 60_000})
  await page.locator('.ant-notification-notice-close').first().click()

  await page.getByRole('button', {name: 'Failed — see the list and retry'}).click()
  const modal = page.getByTestId('failed-modal')
  await expect(modal.locator('.ant-table-row')).toHaveCount(2)
  await page.waitForTimeout(400)
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'failed-list.png')})
  await modal.getByRole('button', {name: 'Select all (2)'}).click()
  await page.getByTestId('failed-retry').click()
  await expect(modal).toHaveCount(0)
  // one new batch with both, from both batches
  await expect(cards).toHaveCount(3)
  const retried = cards.filter({hasText: 'Failed, retried'})
  await expect(retried).toHaveAttribute('data-status', 'failed', {timeout: 60_000})
  await expect(retried).toContainText('0/2 done')
  await close(app)
})

test('download first, check after: a damaged file is marked, kept, and never downloaded again', async () => {
  const {app, page, outDir} = await launch('check-after', {validation: 'quick', validateAfter: true, format: 'mp4'})
  await download(page, 'https://fake.test/list-broken?g=x')
  const card = page.getByTestId('batch-card').first()
  await expect(card).toHaveAttribute('data-status', 'completed-with-errors', {timeout: 60_000})
  await expect(card.getByTestId('problems')).toContainText('damaged at the source 1')

  await page.getByRole('tab', {name: /^Finished/}).click()
  const list = page.getByTestId('finished-list')
  await expect(list.locator('.finished-row')).toHaveCount(3)
  await expect(list.getByTestId('finished-damaged')).toHaveCount(1)
  await expect(list.getByText('Verified')).toHaveCount(2)
  await list.getByTestId('finished-damaged').hover()
  await expect(page.getByText(/can’t be downloaded/)).toBeVisible()
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'finished-damaged.png')})
  const files = await fs.readdir(path.join(outDir, 'Fake-List'))
  expect(files.some(file => file.includes('broken-x'))).toBe(true)

  // asked again: the check says so, nothing downloads
  await page.getByRole('tab', {name: /^Batches/}).click()
  await download(page, 'https://fake.test/list-broken?g=x')
  const again = page.getByTestId('batch-card').first()
  await expect(again).toHaveAttribute('data-status', 'completed-with-errors', {timeout: 60_000})
  await expect(again.getByTestId('problems')).toContainText('damaged at the source 1')
  await again.getByRole('button', {name: /items/i}).click()
  await expect(again.getByTestId('item-damaged')).toHaveCount(1)
  await close(app)
})

test('Finished: filters by integrity and size, and forgets the records of deleted files', async () => {
  const {app, page, outDir} = await launch('prune')
  await download(page, 'https://fake.test/list?n=3')
  await expect(page.getByTestId('batch-card').first()).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
  await fs.rm(path.join(outDir, 'Fake-List', '002-Title-b2-b2.m4a'))
  await page.getByRole('tab', {name: /^Finished/}).click()
  const list = page.getByTestId('finished-list')
  await expect(list.locator('.finished-row')).toHaveCount(3)

  const integrity = list.locator('.ant-table-thead th').filter({hasText: 'Integrity'})
  await integrity.locator('.ant-table-filter-trigger').click()
  const menu = page.locator('.ant-table-filter-dropdown').last()
  await menu.getByText('Missing (deleted or moved)').click()
  await menu.getByRole('button', {name: 'OK'}).click()
  await expect(list.locator('.ant-table-row')).toHaveCount(1)
  await expect(list.locator('.ant-table-row')).toContainText('Title b2')
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'finished-filter.png')})

  await list.getByTestId('finished-prune').click()
  await page.getByRole('button', {name: 'Remove', exact: true}).click()
  await expect(page.getByText('1 record(s) of missing files removed')).toBeVisible()
  await expect(list.locator('.ant-table-row')).toHaveCount(0)
  await integrity.locator('.ant-table-filter-trigger').click()
  await page.locator('.ant-table-filter-dropdown').last().getByRole('button', {name: 'Reset'}).click()
  await page.locator('.ant-table-filter-dropdown').last().getByRole('button', {name: 'OK'}).click()
  await expect(list.locator('.finished-row')).toHaveCount(2)
  await close(app)
})

test('Finished: a deleted file is not checked again, and downloads again into its folder from its link', async () => {
  const {app, page, outDir} = await launch('redownload')
  await download(page, 'https://fake.test/list?n=3')
  await expect(page.getByTestId('batch-card').first()).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
  const gone = path.join(outDir, 'Fake-List', '002-Title-b2-b2.m4a')
  await fs.rm(gone)
  await page.getByRole('tab', {name: /^Finished/}).click()
  const list = page.getByTestId('finished-list')
  await expect(list.getByText('File not found')).toHaveCount(1)

  // only the missing file picked: there is nothing to check
  await list.locator('.ant-table-row').filter({hasText: 'Title b2'}).getByRole('checkbox').check()
  await expect(list.getByTestId('finished-verify')).toBeDisabled()

  await list.getByTestId('finished-redownload').click()
  await page.getByRole('button', {name: 'Download', exact: true}).click()
  await expect(page.getByText('1 file(s) queued to download again')).toBeVisible()
  await expect
    .poll(
      () =>
        fs.stat(gone).then(
          () => true,
          () => false,
        ),
      {timeout: 60_000},
    )
    .toBe(true)
  await expect(list.getByText('File not found')).toHaveCount(0, {timeout: 10_000})
  await close(app)
})
