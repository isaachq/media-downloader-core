import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {type ElectronApplication, _electron as electron, expect, type Page, test} from '@playwright/test'
import {HANDLES as BLUESKY_HANDLES, RKEYS as BLUESKY_RKEYS, startFakeBluesky} from '../../test/helpers/fake-bluesky'
import {startFakeHls, startFakeLive} from '../../test/helpers/fake-hls'
import {startFakeSnapchat} from '../../test/helpers/fake-snapchat'
import {
  HYDRATION_ID as SOUNDCLOUD_HYDRATION_ID,
  trackUrl as soundcloudTrackUrl,
  startFakeSoundcloud,
} from '../../test/helpers/fake-soundcloud'
import {startFakeThreads} from '../../test/helpers/fake-threads'
import {startFakeTikTok} from '../../test/helpers/fake-tiktok'
import {LIVE, LIVE_TRACKS, SLUGS, startFakeTwitch, VOD_TRACKS, VODS, WEB_ID} from '../../test/helpers/fake-twitch'
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
    // a file in test-results (kept whole by CI's artifact), not only the report's shortened copy
    const file = testInfo.outputPath('app-output.txt')
    await fs.writeFile(file, output.join(''))
    await testInfo.attach('app-output', {path: file, contentType: 'text/plain'})
  }
})

/** Launch the built app, its output kept for the report (see `output`). */
async function start(env: Record<string, string>): Promise<ElectronApplication> {
  const app = await electron.launch({
    ...target,
    // the main process prints its start-up and quit steps (see phase() in src/main/index.ts)
    env: {...(process.env as Record<string, string>), MDC_E2E_TRACE: '1', ...env},
  })
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
    // before the kill: is the main process busy (no answer) or idle and waiting on something (what)?
    const state = await Promise.race([
      app
        .evaluate(() => JSON.stringify({resources: process.getActiveResourcesInfo(), uptime: process.uptime()}))
        .catch((error: unknown) => `evaluate failed: ${String(error)}`),
      new Promise<string>(resolve => setTimeout(() => resolve('no answer in 3 s: the main thread is blocked'), 3000)),
    ])
    output.push(`[e2e ${new Date().toISOString()}] stuck quit, main process: ${state}\n`)
    child.kill('SIGKILL')
    throw new Error(`the app (pid ${child.pid}) did not quit within ${QUIT_MS / 1000} s — main process: ${state}`)
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

test('downloads a playlist batch end to end: preflight, jobs, files on disk', {tag: '@smoke'}, async () => {
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

test('finished files of every session, their folders, and the run report', {tag: '@full'}, async () => {
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

test('the first launch shows the four first steps once; Guide replays them', {tag: '@smoke'}, async () => {
  const {app, page, dataDir} = await launch('guide', {tourDone: false})
  const tour = page.locator('.ant-tour')
  await expect(tour).toContainText('1 · Paste a link')
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'guide.png')})
  await tour.getByRole('button', {name: 'Next'}).click()
  await expect(tour).toContainText('2 · Choose what you get')
  await tour.getByRole('button', {name: 'Next'}).click()
  await expect(tour).toContainText('3 · Download')
  await tour.getByRole('button', {name: 'Next'}).click()
  await expect(tour).toContainText('4 · Lists and the mix list')
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

test('previews a list and downloads only the picked items', {tag: '@full'}, async () => {
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

test('backs up picked posts of a TikTok profile as MP3 (built-in extractor)', {tag: '@full'}, async () => {
  const site = await startFakeTikTok({posts: 6, pinned: true})
  try {
    const {app, page, outDir} = await launch('tiktok', {format: 'mp3'}, {MDC_TIKTOK_ORIGIN: site.origin})
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

test('Sync Up keeps a TikTok account in step with its folder, in the format of the folder', {
  tag: '@full',
}, async () => {
  const site = await startFakeTikTok({posts: 5})
  try {
    // downloaded earlier as MP3 (the app's format is M4A now): recognized by the post number in the name
    const folder = path.join(root, 'sync', 'out', 'TikTok-fakeuser')
    await fs.mkdir(folder, {recursive: true})
    for (const id of site.ids.slice(2)) await fs.writeFile(path.join(folder, `old-${id}.mp3`), 'audio')
    const {app, page} = await launch('sync', {format: 'm4a', syncEnabled: true}, {MDC_TIKTOK_ORIGIN: site.origin})
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

test('a TikTok profile behind a verification page opens through the built-in browser', {tag: '@full'}, async () => {
  // plain requests get a "please wait" page whose script sets a cookie and reloads: only a browser passes
  const site = await startFakeTikTok({posts: 6, jsChallenge: true})
  try {
    const {app, page, outDir} = await launch('tiktok-browser', {format: 'mp3'}, {MDC_TIKTOK_ORIGIN: site.origin})
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

test('finds a new version, downloads it and verifies its checksum (dry run)', {tag: '@full'}, async () => {
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

test('reports unavailable items with a reason and finishes with errors', {tag: '@full'}, async () => {
  const {app, page} = await launch('mixed')
  await download(page, 'https://fake.test/list-mixed')
  const card = page.getByTestId('batch-card').first()
  await expect(card).toHaveAttribute('data-status', 'completed-with-errors', {timeout: 60_000})
  await card.getByRole('button', {name: /items/i}).click()
  await expect(card.getByText('Removed or unavailable')).toBeVisible()
  await close(app)
})

test('remembers language and theme across restarts', {tag: '@full'}, async () => {
  const first = await launch('prefs')
  // the language select (fourteen languages, with search): Español by its own name
  await first.page.getByTestId('language-select').first().click()
  await first.page.keyboard.type('espa')
  await first.page.keyboard.press('Enter')
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

test('one link box for every site: an old settings.json with a mode loads, Sync Up is there, links are tagged', {
  tag: '@smoke',
}, async () => {
  const site = await startFakeTikTok({posts: 2})
  try {
    // settings of a version with one site per run: its mode is ignored
    const {app, page} = await launch('every-site', {mode: 'web', syncEnabled: true}, {MDC_TIKTOK_ORIGIN: site.origin})
    await expect(page.getByTestId('mode-tag')).toHaveCount(0)
    await expect(page.getByRole('tab', {name: 'New download'})).toBeVisible()
    await expect(page.getByRole('tab', {name: 'Sync Up'})).toBeVisible()
    const field = page.getByLabel('Video, playlist or profile URL')
    await field.fill(`${site.origin}/@${site.user}`)
    await expect(page.getByTestId('site-tag')).toHaveAttribute('data-site', 'tiktok')
    await field.fill('https://www.youtube.com/watch?v=x')
    await expect(page.getByTestId('site-tag')).toHaveAttribute('data-site', 'youtube')
    await field.fill('https://vk.com/video-1_2')
    await expect(page.getByTestId('site-tag')).toHaveText('VK')
    // the beta 11 sites: each tagged with its name and an icon that draws
    for (const [link, site, name] of [
      ['https://www.threads.com/@zuck/post/C1', 'threads', 'Threads'],
      ['https://bsky.app/profile/bsky.app', 'bluesky', 'Bluesky'],
      ['https://www.twitch.tv/videos/1', 'twitch', 'Twitch'],
      ['https://soundcloud.com/a/b', 'soundcloud', 'SoundCloud'],
      ['https://www.snapchat.com/spotlight/W7_1', 'snapchat', 'Snapchat'],
    ] as const) {
      await field.fill(link)
      const tag = page.getByTestId('site-tag')
      await expect(tag).toHaveAttribute('data-site', site)
      await expect(tag).toHaveText(name)
      await expect(tag.locator('svg')).toBeVisible()
    }
    // the tag eases from one site's colour to the next: the picture waits for it
    await page.waitForTimeout(400)
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'every-site.png')})
    // under the tag: what the link downloads, whether it asks for a sign-in, whether yt-dlp reads it
    const line = page.getByTestId('site-line')
    await expect(line).toHaveText('Spotlights, stories, highlights and public profiles')
    await field.fill('https://www.youtube.com/watch?v=x')
    await expect(line).toHaveText(
      'Videos, Shorts, playlists, channels and Mixes · Sign-in needed for private, members-only and age-restricted videos · Read by yt-dlp',
    )
    // the label counts the sites and opens their list
    await expect(page.getByText('or any of the 13 supported sites')).toBeVisible()
    await page.getByTestId('open-sites').click()
    const sites = page.getByTestId('supported-sites')
    await expect(sites.locator('.ant-table-row')).toHaveCount(13)
    await expect(sites.locator('.ant-table-row').filter({hasText: 'Twitch'})).toContainText(
      'For subscriber-only videos and streams',
    )
    await expect(sites.locator('.ant-table-row').filter({hasText: 'YouTube'})).toContainText('Desktop only')
    await page.waitForTimeout(400)
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'supported-sites.png')})
    await page.keyboard.press('Escape')
    await expect(sites).toHaveCount(0)
    await page.getByRole('button', {name: /settings/i}).click()
    await expect(page.getByRole('switch', {name: 'Run scheduled syncs (Sync Up)'})).toBeChecked()
    await expect(page.getByTestId('settings-mode')).toHaveCount(0)
    await expect(page.getByTestId('youtube-account')).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'settings-no-site.png')})
    await close(app)
  } finally {
    await site.close()
  }
})

test('cancelling one download leaves the rest of its batch running, and the batch completes', {
  tag: '@full',
}, async () => {
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

test('failed downloads of several batches go into one new batch from the Failed card', {tag: '@full'}, async () => {
  const {app, page} = await launch('failed-list')
  await download(page, 'https://fake.test/list-gone?g=a')
  await download(page, 'https://fake.test/list-gone?g=b')
  const cards = page.getByTestId('batch-card')
  await expect(cards.nth(1)).toHaveAttribute('data-status', 'completed-with-errors', {timeout: 60_000})
  await expect(cards.nth(0)).toHaveAttribute('data-status', 'completed-with-errors', {timeout: 60_000})
  await page.locator('.ant-notification-notice-close').first().click()

  await page.getByRole('button', {name: 'Failed: see the list and retry'}).click()
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

test('download first, check after: a damaged file is marked, kept, and never downloaded again', {
  tag: '@full',
}, async () => {
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

test('Finished: filters by integrity and size, and forgets the records of deleted files', {tag: '@full'}, async () => {
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

test('Finished: a deleted file is not checked again, and downloads again into its folder from its link', {
  tag: '@full',
}, async () => {
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

test('a mix list: links added one by one, checked at once, one in a format of its own, one batch', {
  tag: '@full',
}, async () => {
  // the form is set to M4A: every link becomes M4A unless it has its own format
  const {app, page, outDir} = await launch('mix-list')
  await page.getByTestId('open-mix').click()
  const dialog = page.getByRole('dialog')
  const field = dialog.getByLabel('Paste or type a link')
  for (const link of [
    'https://fake.test/mx1',
    'https://fake.test/mx2',
    'https://fake.test/unavailable-mx3',
    'https://www.youtube.com/playlist?list=PL1',
  ]) {
    await field.fill(link)
    await field.press('Enter')
  }
  await field.fill('https://fake.test/mx1/')
  await field.press('Enter')
  await expect(dialog.getByTestId('mix-note')).toHaveText('Already in the list')
  await expect(dialog.getByTestId('mix-sites')).toContainText('4 links')
  await expect(dialog.getByTestId('mix-format')).toContainText('Format for all links')
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'mix-list-form.png')})
  await dialog.getByTestId('mix-check').click()
  const summary = dialog.getByTestId('mix-summary')
  await expect(summary).toContainText('2 ready', {timeout: 60_000})
  await expect(summary).toContainText('2 left out')
  await dialog.getByText('Left out (2)').click()
  await expect(dialog).toContainText('A list or profile: download it on its own')
  // mx2 as an MP4 video, by itself
  const second = dialog.locator('.rows-item', {hasText: 'fake.test/mx2'})
  await second.getByRole('combobox', {name: 'Format'}).click()
  await page.locator('.ant-select-item-option-content', {hasText: 'Video · MP4 · Best available'}).first().click()
  await page.screenshot({path: path.join(APP_DIR, 'test-results', 'mix-list.png')})
  await dialog.getByTestId('mix-schedule').click()
  const cards = page.getByTestId('batch-card')
  await expect(cards).toHaveCount(1)
  await expect(cards.first().getByTestId('batch-mix')).toHaveText('Mix list')
  await expect(cards.first()).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
  await expect(cards.first()).toContainText('2/2 done')
  // one batch, one folder: mx1 as M4A (the list's format), mx2 as MP4 (its own)
  const files = (await fs.readdir(outDir)).sort()
  expect(files.map(name => path.extname(name))).toEqual(['.m4a', '.mp4'])
  await close(app)
})

test('a subscriber-only Twitch VOD downloads once a browser session is chosen', {tag: '@full'}, async () => {
  const hls = await startFakeHls({tracks: VOD_TRACKS})
  const site = await startFakeTwitch({hls})
  try {
    const {app, page, outDir} = await launch('twitch-signin', {}, {MDC_TWITCH_ORIGIN: site.origin})
    const link = `https://www.twitch.tv/videos/${VODS.subsOnly}`
    // signed out: the app says to sign in, and nothing is downloaded
    await download(page, link)
    await expect(page.getByText(/Sign-in required/).first()).toBeVisible({timeout: 30_000})
    expect(site.requests.every(request => request.auth === undefined)).toBe(true)

    // the sign-in modal names what a Twitch session opens
    await page.getByRole('button', {name: /settings/i}).click()
    await page.getByRole('button', {name: /how to sign in/i}).click()
    const help = page.getByTestId('signin-sites')
    await expect(help.locator('[data-site="twitch"]')).toContainText('Twitch: subscriber-only videos and streams')
    await expect(help.locator('[data-site="threads"]')).toContainText('Threads: private accounts')
    await page.keyboard.press('Escape')

    // a browser's session: the fake jar carries a subscriber's .twitch.tv auth-token
    await page.getByLabel('Cookies from browser').click()
    await page.locator('.ant-select-item-option[title="firefox"]').click()
    await page.locator('.ant-drawer-close').click()
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0)
    await download(page, link)
    const card = page.getByTestId('batch-card').first()
    await expect(card).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
    expect((await fs.readdir(outDir)).length).toBe(1)
    // the session went only on the reads that mint a playback token, with the web player's id
    const signed = site.requests.filter(request => request.auth !== undefined)
    expect(signed.length).toBeGreaterThan(0)
    expect(signed.every(request => request.auth === 'OAuth fake-ok' && request.clientId === WEB_ID)).toBe(true)
    await close(app)
  } finally {
    await site.close()
    await hls.close()
  }
})

test('records a live Twitch channel, stops and keeps the file; a discarded one leaves nothing', {
  tag: '@full',
}, async () => {
  const live = await startFakeLive({tracks: LIVE_TRACKS})
  const site = await startFakeTwitch({live})
  // the fake channel's clock: 2 s of stream every 200 ms (the recorder's own waits are real)
  const tick = setInterval(() => live.clock.advance(2000), 200)
  try {
    const {app, page, outDir, dataDir} = await launch('twitch-live', {format: 'mp4'}, {MDC_TWITCH_ORIGIN: site.origin})
    const link = `https://www.twitch.tv/${LIVE.onAir}`
    const record = async () => {
      await page.getByLabel('Video, playlist or profile URL').fill(link)
      await page
        .getByRole('button', {name: /download|schedule/i})
        .first()
        .click()
      // a channel on the air is recorded or watched, never scheduled as a download
      const modal = page.getByTestId('live-modal')
      await expect(modal).toContainText('Recording starts from the last half minute')
      await modal.getByRole('button', {name: /record/i}).click()
      await expect(modal).toHaveCount(0)
      await expect(page.getByTestId('recording')).toHaveAttribute('data-status', 'downloading')
      // it records: a clock, REC, and no batch
      await expect(page.getByTestId('recording-elapsed')).toBeVisible({timeout: 30_000})
      await expect(page.getByTestId('recording-elapsed')).not.toHaveText('0:00 recorded', {timeout: 30_000})
      await expect(page.getByTestId('batch-card')).toHaveCount(0)
    }

    await record()
    await page.waitForTimeout(400)
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'live-recording.png')})
    await page.getByTestId('recording-stop').click()
    // saved like any download (converted, finalized), then it leaves the card
    await expect(page.getByTestId('recordings')).toHaveCount(0, {timeout: 60_000})
    const saved = (await fs.readdir(outDir)).filter(name => name.endsWith('.mp4'))
    expect(saved).toHaveLength(1)
    expect((await fs.stat(path.join(outDir, saved[0]!))).size).toBeGreaterThan(0)
    await page.getByRole('tab', {name: /^Finished/}).click()
    await expect(page.getByTestId('finished-live')).toBeVisible()
    await page.getByRole('tab', {name: /^Batches/}).click()

    // the same channel again, discarded: nothing new on disk, no work folder left
    await record()
    await page.getByTestId('recording-discard').click()
    await page.locator('.ant-popconfirm').getByRole('button', {name: 'Discard'}).click()
    await expect(page.getByTestId('recordings')).toHaveCount(0, {timeout: 30_000})
    expect((await fs.readdir(outDir)).filter(name => name.endsWith('.mp4'))).toEqual(saved)
    const work = await fs.readdir(path.join(dataDir, 'work')).catch(() => [])
    expect(work).toEqual([])

    // quitting while it records: the window asks; Stop, save and quit keeps the file, then quits
    await record()
    const exited = new Promise<void>(resolve => app.process().once('exit', () => resolve()))
    await app.evaluate(({app: electronApp}) => electronApp.quit())
    const ask = page.getByTestId('quit-recording')
    await expect(ask).toContainText('1 recording(s) still running')
    await ask.getByRole('button', {name: 'Stop, save and quit'}).click()
    await exited
    expect((await fs.readdir(outDir)).filter(name => name.endsWith('.mp4'))).toHaveLength(2)
  } finally {
    clearInterval(tick)
    await site.close()
    await live.close()
  }
})

test('beta 23: a SoundCloud track with MP4 chosen downloads as M4A, alone and in a mix list of videos', {
  tag: '@full',
}, async () => {
  const threads = await startFakeThreads()
  const soundcloud = await startFakeSoundcloud({hydrationId: SOUNDCLOUD_HYDRATION_ID})
  try {
    const {app, page, outDir} = await launch(
      'beta23-song',
      {format: 'mp4', quality: 'best'},
      {MDC_THREADS_ORIGIN: threads.origin, MDC_SOUNDCLOUD_ORIGIN: soundcloud.origin},
    )
    const song = soundcloudTrackUrl('clear-track')
    const m4a = async () =>
      (await fs.readdir(outDir, {recursive: true})).map(String).filter(name => name.endsWith('.m4a'))

    // alone: no picture, so the batch keeps it as M4A instead of failing
    await download(page, song)
    const single = page.getByTestId('batch-card').first()
    await expect(single).toHaveAttribute('data-status', 'completed', {timeout: 60_000})
    expect(await m4a()).toHaveLength(1)

    // in a mix list of videos: kept (not left out as unavailable), its card says M4A
    await page.getByTestId('open-mix').click()
    const dialog = page.getByRole('dialog')
    const field = dialog.getByLabel('Paste or type a link')
    for (const link of [
      `https://www.threads.com/@zuck/post/${threads.codes.video}`,
      soundcloudTrackUrl('old-upload'),
    ]) {
      await field.fill(link)
      await field.press('Enter')
    }
    await dialog.getByTestId('mix-check').click()
    await expect(dialog.getByTestId('mix-summary')).toContainText('2 ready', {timeout: 60_000})
    await expect(dialog.locator('.rows-item', {hasText: 'soundcloud.com'})).toContainText('Audio · M4A')
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'beta23-song-mix.png')})
    await dialog.getByTestId('mix-schedule').click()
    const mix = page.getByTestId('batch-card').first()
    await expect(mix).toHaveAttribute('data-status', 'completed', {timeout: 90_000})
    await expect(mix).toContainText('2/2 done')
    const files = (await fs.readdir(outDir, {recursive: true})).map(String)
    expect(files.filter(name => name.endsWith('.mp4'))).toHaveLength(1)
    expect(await m4a()).toHaveLength(2)
    await close(app)
  } finally {
    await threads.close()
    await soundcloud.close()
  }
})

test('beta 11: a mix list of the five new sites is checked at once and downloads as one batch', {
  tag: '@full',
}, async () => {
  // every site from its local fake: no network
  const hls = await startFakeHls({tracks: VOD_TRACKS})
  const twitch = await startFakeTwitch({hls})
  const threads = await startFakeThreads()
  const bluesky = await startFakeBluesky()
  const snapchat = await startFakeSnapchat()
  const soundcloud = await startFakeSoundcloud({hydrationId: SOUNDCLOUD_HYDRATION_ID})
  try {
    // the list as M4A (SoundCloud is sound only), the Twitch clip as a video of its own
    const {app, page, outDir} = await launch(
      'beta11-mix',
      {},
      {
        MDC_TWITCH_ORIGIN: twitch.origin,
        MDC_THREADS_ORIGIN: threads.origin,
        MDC_BLUESKY_ORIGIN: bluesky.origin,
        MDC_SNAPCHAT_ORIGIN: snapchat.origin,
        MDC_SOUNDCLOUD_ORIGIN: soundcloud.origin,
      },
    )
    const links = {
      threads: `https://www.threads.com/@zuck/post/${threads.codes.video}`,
      bluesky: `https://bsky.app/profile/${BLUESKY_HANDLES.alice}/post/${BLUESKY_RKEYS.video}`,
      twitch: `https://clips.twitch.tv/${SLUGS.good}`,
      snapchat: `https://www.snapchat.com/spotlight/${snapchat.ids.spotlight}`,
      soundcloud: soundcloudTrackUrl('clear-track'),
    }
    await page.getByTestId('open-mix').click()
    const dialog = page.getByRole('dialog')
    const field = dialog.getByLabel('Paste or type a link')
    for (const link of Object.values(links)) {
      await field.fill(link)
      await field.press('Enter')
    }
    await expect(dialog.getByTestId('mix-sites')).toContainText('5 links')
    // each link tagged with its own site
    for (const site of Object.keys(links)) await expect(dialog.locator(`[data-site="${site}"]`).first()).toBeVisible()
    await dialog.getByTestId('mix-check').click()
    await expect(dialog.getByTestId('mix-summary')).toContainText('5 ready', {timeout: 60_000})
    const clip = dialog.locator('.rows-item', {hasText: 'twitch.tv'})
    await clip.getByRole('combobox', {name: 'Format'}).click()
    await page.locator('.ant-select-item-option-content', {hasText: 'Video · MP4 · Best available'}).first().click()
    await page.screenshot({path: path.join(APP_DIR, 'test-results', 'beta11-mix.png')})
    await dialog.getByTestId('mix-schedule').click()
    const card = page.getByTestId('batch-card').first()
    await expect(card).toHaveAttribute('data-status', 'completed', {timeout: 90_000})
    await expect(card).toContainText('5/5 done')
    const files = (await fs.readdir(outDir, {recursive: true})).map(String).filter(name => /\.(mp4|m4a)$/.test(name))
    expect(files.filter(name => name.endsWith('.m4a'))).toHaveLength(4)
    expect(files.filter(name => name.endsWith('.mp4'))).toHaveLength(1)
    // the Finished tab names every site
    await page.getByRole('tab', {name: /^Finished/}).click()
    for (const site of Object.keys(links))
      await expect(page.locator(`.finished-site[data-site="${site}"]`).first()).toBeVisible()
    await close(app)
  } finally {
    for (const fake of [twitch, threads, bluesky, snapchat, soundcloud, hls]) await fake.close()
  }
})
