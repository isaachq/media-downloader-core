// Takes the README / website screenshots from the real app (out/, real yt-dlp + FFmpeg),
// real public links, in a fresh data folder so nothing else shows up:
//   preview.png       — a YouTube Mix in the preview, a few items picked
//   batch.png         — that batch downloading, with its forecast and time left
//   mix-list.png      — a mix list: links of five sites added one by one, each with its site
//   mix-preview.png   — the same list checked: grouped by site, one link as MP3, what was left out
//   settings.png      — Settings: YouTube's account, processors, integrity
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
/** A mix list of five sites, and the first link again as another link (a repeat). */
const MIX_LIST = [
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  'https://www.tiktok.com/@complex/video/7626254334065511711',
  'https://www.instagram.com/reel/Dbn-XJhk0_-/',
  'https://vk.com/video-22822305_456242110',
  'https://x.com/elonmusk/status/1585341984679469056',
  'https://youtu.be/jNQXAC9IVRw',
]

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

    // first what asks YouTube nothing (Settings, sign-in), then the mix list (one YouTube check),
    // then the Mix (many): YouTube may pause a busy connection, and its notice shows on every
    // screen after that
    // Settings: YouTube's account, processors and integrity
    await page.getByRole('button', {name: /settings/i}).click()
    await page.getByTestId('youtube-account').waitFor()
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

    // a mix list: links of five sites added one by one, then checked as one
    await page.getByTestId('open-mix').click()
    const mix = page.locator('.mix-modal')
    const field = mix.getByLabel('Paste or type a link')
    for (const link of MIX_LIST.slice(0, 5)) {
      await field.fill(link)
      await field.press('Enter')
    }
    await field.fill(MIX_LIST[5])
    await field.press('Enter')
    await mix.getByTestId('mix-note').waitFor()
    await page.waitForTimeout(700)
    await shot(page, 'mix-list.png')
    await mix.getByTestId('mix-check').click()
    await mix.getByTestId('mix-summary').waitFor({timeout: 300_000})
    // the X post as an MP3, by itself
    const x = mix.locator('.rows-item', {hasText: 'x.com'})
    await x.getByRole('combobox', {name: 'Format'}).click()
    await page.locator('.ant-select-item-option-content', {hasText: 'Audio · MP3 · Best audio'}).first().click()
    await page.mouse.move(SIZE.width - 8, SIZE.height - 8)
    await page.waitForTimeout(700)
    await shot(page, 'mix-preview.png')
    await mix.getByRole('button', {name: 'Cancel'}).click()
    await page.waitForTimeout(600)

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

    // dark theme, in Spanish
    await page.locator('.header-actions .ant-segmented .ant-segmented-item').last().click()
    await page.locator('.header-actions .ant-select').first().click()
    await page.locator('.ant-select-item-option', {hasText: 'Español'}).first().click()
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
