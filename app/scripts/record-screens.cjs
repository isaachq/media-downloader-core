// Takes the README / website screenshots from the real app (out/, real yt-dlp + FFmpeg),
// YouTube only, in a fresh data folder so nothing else shows up:
//   preview.png       — a YouTube Mix in the preview, a few items picked
//   batch.png         — that batch downloading, with its forecast and time left
//   settings.png      — Settings: the site of this run, processors, integrity
//   signin.png        — Settings → Cookies → How to sign in
//   home-dark-es.png  — the dark theme in Spanish
//
//   npm run build && MDC_BINARIES='{"ytDlp":…,"ffmpeg":…,"ffprobe":…}' node scripts/record-screens.cjs [mix url]
//
// Needs network access. Everything (data, downloads) lives in a temporary folder removed afterwards.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {_electron: electron} = require('@playwright/test')

const APP_DIR = path.resolve(__dirname, '..')
const SHOTS = path.resolve(APP_DIR, '..', 'docs', 'screenshots')
const MIX = process.argv[2] ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'
const SIZE = {width: 1280, height: 800}
const PICK = 4

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-screens-'))
  const dataDir = path.join(work, 'data')
  const outDir = path.join(work, 'Downloads')
  fs.mkdirSync(dataDir)
  fs.mkdirSync(outDir)
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      language: 'en',
      theme: 'light',
      mode: 'web',
      format: 'mp4',
      quality: '720',
      validation: 'full',
      downloadDir: outDir,
      tourDone: true,
      autoUpdate: false,
    }),
  )
  const app = await electron.launch({args: [APP_DIR], env: {...process.env, MDC_DATA_DIR: dataDir}})
  const shot = (page, name) => page.screenshot({path: path.join(SHOTS, name)})
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid="theme-mode"]', {state: 'attached', timeout: 60_000})
    await app.evaluate(({BrowserWindow}, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), SIZE)
    await page.waitForTimeout(800)

    // a YouTube Mix: the preview lists it, a few items are picked
    await page.getByLabel('Video, playlist or profile URL').fill(MIX)
    await page.locator('[data-tour="download"]').click()
    const preview = page.locator('.ant-modal').filter({hasText: 'Choose what to download'})
    await preview.waitFor({timeout: 180_000})
    await preview.getByRole('button', {name: 'Select none'}).click()
    const rows = preview.locator('.ant-table-row')
    for (let i = 0; i < PICK; i++) await rows.nth(i).click()
    await page.waitForTimeout(700)
    await shot(page, 'preview.png')
    await preview.getByRole('button', {name: new RegExp(`Download ${PICK}$`)}).click()

    // the batch downloading: forecast, progress and time left
    const card = page.getByTestId('batch-card').first()
    await card.waitFor()
    await page.waitForFunction(
      () => /\d/.test(document.querySelector('[data-testid="batch-eta"]')?.textContent ?? '') &&
        !/measuring/i.test(document.querySelector('[data-testid="batch-eta"]')?.textContent ?? ''),
      undefined,
      {timeout: 180_000},
    )
    // the counters, the tabs and the whole batch card in view (a notice above scrolls away)
    await page.evaluate(() => {
      document.querySelector('.stats')?.scrollIntoView({block: 'start'})
      window.scrollBy(0, -16)
    })
    await page.mouse.move(SIZE.width - 8, SIZE.height - 8)
    await page.waitForTimeout(700)
    await shot(page, 'batch.png')
    await page.waitForFunction(
      () => ['completed', 'completed-with-errors', 'failed'].includes(document.querySelector('[data-testid="batch-card"]')?.getAttribute('data-status') ?? ''),
      undefined,
      {timeout: 600_000},
    )
    await page.locator('.ant-notification-notice-close').first().click().catch(() => {})
    await page.evaluate(() => window.scrollTo(0, 0))

    // Settings: the site of this run on top, processors and integrity below
    await page.getByRole('button', {name: /settings/i}).click()
    await page.getByTestId('settings-mode').waitFor()
    await page.waitForTimeout(700)
    await shot(page, 'settings.png')
    await page.getByTestId('open-signin-help').click()
    await page.getByTestId('signin-help').waitFor()
    await page.waitForTimeout(700)
    await shot(page, 'signin.png')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)

    // dark theme, in Spanish
    const toggles = page.locator('.header-actions .ant-segmented')
    await toggles.nth(0).locator('.ant-segmented-item').last().click()
    await toggles.nth(1).locator('.ant-segmented-item').last().click()
    // no tooltip left open where the pointer stopped
    await page.mouse.move(SIZE.width / 2, SIZE.height - 8)
    await page.waitForTimeout(1200)
    await shot(page, 'home-dark-es.png')
    console.log('downloaded:', fs.readdirSync(outDir, {recursive: true}).filter(name => name.endsWith('.mp4')).length, 'files')
  } finally {
    await app.close()
    fs.rmSync(work, {recursive: true, force: true})
  }
}

main().catch(failure => {
  process.stderr.write(`record-screens: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}\n`)
  process.exitCode = 1
})
