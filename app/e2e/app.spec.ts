import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import type {AddressInfo} from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import {type ElectronApplication, _electron as electron, expect, type Page, test} from '@playwright/test'
import {startFakeTikTok} from '../../test/helpers/fake-tiktok'
import {writeFakes} from '../../test/helpers/fakes'

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
      ...settings,
    }),
  )
  const fakes = await writeFakes(path.join(root, name, 'fakes'))
  const app = await electron.launch({
    ...target,
    env: {...process.env, MDC_DATA_DIR: dataDir, MDC_DOWNLOAD_DIR: outDir, MDC_BINARIES: JSON.stringify(fakes), ...env},
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="theme-mode"]', {state: 'attached'}) // start-up finished
  return {app, page, dataDir, outDir}
}

async function close(app: ElectronApplication) {
  await app.close()
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

  await page.getByRole('tab', {name: 'Downloads'}).click()
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

test('a TikTok profile behind a verification page opens through the built-in browser', async () => {
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
  await new Promise<void>(resolve => feed.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`
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
  const app = await electron.launch({
    ...target,
    env: {...process.env, MDC_DATA_DIR: first.dataDir, MDC_BINARIES: JSON.stringify(fakes)},
  })
  const page = await app.firstWindow()
  await expect(page.getByText('Nueva descarga')).toBeVisible()
  await expect(page.getByTestId('theme-mode')).toHaveText('dark')
  await close(app)
})
