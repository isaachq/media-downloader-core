// Records docs/demo.gif: the real app (out/, real yt-dlp + FFmpeg) pastes a link,
// downloads it as MP4, verifies it, shows the integrity report, finds the file in
// the Finished tab and opens the run report — and saves those two screens as
// docs/screenshots/finished.png and report.png (real files, really verified).
//
//   npm run build && MDC_DATA_DIR=<folder with tools from `mdc setup`> node scripts/record-demo.cjs [url]
//   npm run build && MDC_BINARIES='{"ytDlp":…,"ffmpeg":…,"ffprobe":…}' node scripts/record-demo.cjs [url]
//
// Needs network access. The download goes to a temporary folder that is removed afterwards; with
// MDC_BINARIES the data folder is a fresh temporary one too, so no other file shows up in Finished.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {_electron: electron} = require('@playwright/test')

const APP_DIR = path.resolve(__dirname, '..')
const DOCS = path.resolve(APP_DIR, '..', 'docs')
const OUTPUT = path.join(DOCS, 'demo.gif')
const URL = process.argv[2] ?? 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const SIZE = {width: 1280, height: 800}

/** The FFmpeg `mdc setup` installed in the data folder, else the one on the PATH (setup keeps a working system copy). */
function ffmpegPath(dataDir) {
  const root = path.join(dataDir, 'bin', 'ffmpeg')
  const versions = fs.existsSync(root)
    ? fs.readdirSync(root).filter(name => fs.statSync(path.join(root, name)).isDirectory())
    : []
  const version = versions.sort().at(-1)
  return version ? path.join(root, version, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg'
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdc-demo-'))
  const dataDir = process.env.MDC_BINARIES ? path.join(work, 'data') : process.env.MDC_DATA_DIR
  if (!dataDir) throw new Error('Set MDC_DATA_DIR to a data folder with the tools installed (mdc setup --data-dir …), or MDC_BINARIES')
  fs.mkdirSync(dataDir, {recursive: true})
  const outDir = path.join(work, 'Downloads')
  fs.mkdirSync(outDir)
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      language: 'en',
      theme: 'light',
      mode: 'web',
      format: 'mp4',
      quality: 'best',
      validation: 'full',
      downloadDir: outDir,
      tourDone: true,
      autoUpdate: false,
    }),
  )

  // frames come from Chromium's screencast (Playwright's recordVideo stalls Electron's first window)
  const framesDir = path.join(work, 'frames')
  fs.mkdirSync(framesDir)
  const frames = []
  const app = await electron.launch({args: [APP_DIR], env: {...process.env, MDC_DATA_DIR: dataDir}})
  const binaries = process.env.MDC_BINARIES ? JSON.parse(process.env.MDC_BINARIES) : undefined
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid="theme-mode"]', {state: 'attached', timeout: 60_000})
    await app.evaluate(({BrowserWindow}, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), SIZE)
    const cdp = await page.context().newCDPSession(page)
    cdp.on('Page.screencastFrame', ({data, metadata, sessionId}) => {
      const file = path.join(framesDir, `${String(frames.length).padStart(5, '0')}.png`)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      frames.push({file, time: metadata.timestamp})
      void cdp.send('Page.screencastFrameAck', {sessionId}).catch(() => {})
    })
    // lossless frames: a JPEG's noise differs on every frame, so the GIF could reuse nothing (a 45 MB file)
    await cdp.send('Page.startScreencast', {format: 'png', maxWidth: SIZE.width, maxHeight: SIZE.height})
    await page.waitForTimeout(1200)

    const input = page.getByLabel('Video, playlist or profile URL')
    await input.click()
    await input.pressSequentially(URL, {delay: 35})
    await page.waitForTimeout(500)
    await page.locator('[data-tour="download"]').click()

    const card = page.getByTestId('batch-card').first()
    await card.waitFor()
    await page.waitForFunction(
      () => ['completed', 'completed-with-errors', 'failed'].includes(document.querySelector('[data-testid="batch-card"]')?.getAttribute('data-status') ?? ''),
      undefined,
      {timeout: 180_000},
    )
    await page.waitForTimeout(1500)

    await page.getByRole('tab', {name: /^Downloads/}).click()
    await page.waitForTimeout(1200)
    await page.locator('[data-testid="integrity-tag"]').first().click()
    await page.waitForTimeout(3500)
    await page.keyboard.press('Escape')
    await page.mouse.click(SIZE.width - 40, SIZE.height - 40) // close the report popover

    // every finished file, ready to play or show in its folder
    await page.getByRole('tab', {name: /^Finished/}).click()
    const row = page.locator('.finished-row').first()
    await row.waitFor()
    await page.waitForTimeout(900)
    await page.screenshot({path: path.join(DOCS, 'screenshots', 'finished.png')})
    await row.getByRole('button', {name: 'Play / open'}).hover()
    await page.waitForTimeout(1600)
    await row.getByRole('button', {name: 'Show in folder'}).hover()
    await page.waitForTimeout(1400)

    // the whole run, summed up
    await page.getByTestId('open-report').click()
    await page.getByTestId('report').waitFor()
    await page.waitForTimeout(1200)
    await page.screenshot({path: path.join(DOCS, 'screenshots', 'report.png')})
    await page.waitForTimeout(2800)
    await cdp.send('Page.stopScreencast')
  } finally {
    await app.close()
  }

  if (frames.length < 2) throw new Error('No frames were recorded')
  // the screencast only sends a frame when something changes: keep each one on screen until the next
  const list = frames.map((frame, i) => {
    const next = frames[i + 1]?.time ?? frame.time + 1
    return `file '${frame.file}'\nduration ${Math.max(0.02, next - frame.time).toFixed(3)}`
  })
  const concat = path.join(work, 'frames.txt')
  fs.writeFileSync(concat, `${list.join('\n')}\nfile '${frames.at(-1).file}'\n`)
  const files = fs.readdirSync(outDir, {recursive: true})
  console.log('downloaded:', files)
  // the screencast's frame size can change while the window settles (1280×714 among 1280×800):
  // every frame goes onto one canvas, or the picture would shift and nothing could be reused
  const sizes = new Map()
  for (const {file} of frames) {
    const head = fs.readFileSync(file).subarray(16, 24)
    const size = `${head.readUInt32BE(0)}×${head.readUInt32BE(4)}`
    sizes.set(size, (sizes.get(size) ?? 0) + 1)
  }
  console.log('frame sizes:', Object.fromEntries(sizes))
  // two-pass palette: small file, clean colors. The colors are rounded first (the sky's gradient
  // jitters by a step between frames) and repeated frames dropped: what stays still costs nothing
  execFileSync(binaries?.ffmpeg ?? ffmpegPath(dataDir), [
    '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
    '-vf', `fps=12,scale=${SIZE.width}:${SIZE.height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${SIZE.width}:${SIZE.height}:0:0:color=white,scale=960:-2:flags=lanczos,format=rgb24,lutrgb=r='bitand(val,248)':g='bitand(val,248)':b='bitand(val,248)',mpdecimate,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', OUTPUT,
  ])
  console.log(`${path.relative(process.cwd(), OUTPUT)}: ${(fs.statSync(OUTPUT).size / 1048576).toFixed(1)} MB`)
  fs.rmSync(work, {recursive: true, force: true})
}

main().catch(failure => {
  process.stderr.write(`record-demo: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}\n`)
  process.exitCode = 1
})
