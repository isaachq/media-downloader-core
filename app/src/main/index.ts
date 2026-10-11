import * as path from 'node:path'
import {app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell} from 'electron'
import {
  type BatchId,
  BatchScheduler,
  type BinaryPaths,
  type Diagnosis,
  type FormatProfile,
  isTikTokProfile,
  isYouTubeMix,
  type JobId,
  MAX_LISTED_ITEMS,
  MediaDownloader,
  MIX_DEFAULT_ITEMS,
  searchTrace,
  TIKTOK_PROFILE_DEFAULT_ITEMS,
  type VideoAnalysis,
} from 'media-downloader-core'
import {
  type AppInfo,
  type AppSettings,
  CHANNEL,
  isAudioFormat,
  type Preview,
  RESTART_SETTINGS,
  type ScheduleInput,
  type SetupOutcome,
} from '../shared/contract'
import {EventCoalescer} from './events'
import {defaultSettings, SettingsStore} from './settings'
import {MIN_SIZE, readWindowState, restoreBounds, writeWindowState} from './window-state'

// Test hooks: e2e runs point the app at a temp data folder and fake tools.
if (process.env['MDC_DATA_DIR']) app.setPath('userData', path.resolve(process.env['MDC_DATA_DIR']))

function binariesFromEnv(): BinaryPaths | undefined {
  const raw = process.env['MDC_BINARIES']
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as BinaryPaths
  } catch {
    return undefined
  }
}

let window: BrowserWindow | undefined
let engine: MediaDownloader
let scheduler: BatchScheduler
let settings: SettingsStore
/** Settles once the batches pending at last shutdown are back; the renderer's restore phase waits for it. */
let restoring: Promise<void> = Promise.resolve()
/** Tool check started with the process: ready (or nearly) when the window asks for it. */
let warmDiagnosis: Promise<Diagnosis> | undefined

/**
 * Videos analyzed for a preview, reused when the same link is scheduled right
 * after (skips a second yt-dlp run, ~2 s). Small and short-lived: the links
 * inside expire, and the jobs refresh old metadata anyway.
 */
const PREVIEW_TTL_MS = 10 * 60_000
const PREVIEW_SLOTS = 16
const previews = new Map<string, {readonly analysis: VideoAnalysis; readonly at: number}>()

function rememberPreview(url: string, analysis: VideoAnalysis): void {
  previews.delete(url)
  previews.set(url, {analysis, at: Date.now()})
  // Map iterates in insertion order: the first key is the oldest — O(1) eviction
  if (previews.size > PREVIEW_SLOTS) previews.delete(previews.keys().next().value!)
}

function takePreview(url: string): VideoAnalysis | undefined {
  const hit = previews.get(url)
  previews.delete(url)
  return hit && Date.now() - hit.at < PREVIEW_TTL_MS ? hit.analysis : undefined
}
let coalescer: EventCoalescer

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

function toProfile(input: ScheduleInput): FormatProfile {
  if (isAudioFormat(input.format)) return {kind: 'audio', container: input.format}
  return {kind: 'video', container: input.format, ...(input.quality !== 'best' && {maxHeight: Number(input.quality)})}
}

function createEngine(current: AppSettings): void {
  const dataDir = app.getPath('userData')
  const binaries = binariesFromEnv()
  engine = new MediaDownloader({
    dataDir,
    concurrency: current.concurrency,
    validation: current.validation,
    embedMetadata: current.embedMetadata,
    embedThumbnail: current.embedThumbnail,
    fileNames: current.portableNames ? 'portable' : 'original',
    // test hook: e2e runs point TikTok at a local fake site, without pacing delays
    ...(process.env['MDC_TIKTOK_ORIGIN'] && {
      tiktok: {origin: process.env['MDC_TIKTOK_ORIGIN'], pacing: {spacingMs: 0, jitterMs: 0}},
    }),
    longVideoMinutes: current.longVideoMinutes,
    ...(current.cookiesFromBrowser && {cookiesFromBrowser: current.cookiesFromBrowser}),
    ...(binaries && {binaries}),
  })
  scheduler = new BatchScheduler(engine)
  coalescer = new EventCoalescer(bundle => send(CHANNEL.events, bundle))
  engine.on('job', snapshot => coalescer.job(snapshot))
  engine.on('log', entry => coalescer.log(entry))
  scheduler.on('batch', snapshot => coalescer.batch(snapshot))
  scheduler.on('item', (batchId, item) => coalescer.item(batchId, item))
}

function createWindow(): void {
  const stateFile = path.join(app.getPath('userData'), 'window.json')
  const bounds = restoreBounds(
    readWindowState(stateFile),
    screen.getAllDisplays().map(display => display.workArea),
    screen.getPrimaryDisplay().workArea,
  )
  window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Media Download Core',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1420' : '#eef6fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => {
    if (bounds.maximized) window?.maximize()
    window?.show()
  })
  // remember size and position for the next launch (normal bounds even when maximized)
  window.on('close', () => {
    if (!window) return
    writeWindowState(stateFile, {...window.getNormalBounds(), maximized: window.isMaximized()})
  })
  // the app never navigates; links (About, docs) open in the system browser, https only
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(({url}) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return {action: 'deny'}
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle(
    CHANNEL.info,
    (): AppInfo => ({
      version: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      cpus: MediaDownloader.cpuCount(),
      maxConcurrency: MediaDownloader.maxConcurrency(),
      dataDir: engine.dataDir,
      sessionId: engine.sessionId,
    }),
  )
  ipcMain.handle(CHANNEL.getSettings, () => settings.current)
  ipcMain.handle(CHANNEL.setSettings, async (_event, patch: unknown) => {
    const before = settings.current
    const next = await settings.update(patch)
    // live settings apply at once; the rest on next launch (the UI says so)
    if (next.concurrency !== before.concurrency) engine.setConcurrency(next.concurrency)
    if (next.validation !== before.validation) engine.setValidation(next.validation)
    if (next.portableNames !== before.portableNames) engine.setFileNames(next.portableNames ? 'portable' : 'original')
    if (next.theme !== before.theme) nativeTheme.themeSource = next.theme
    if (RESTART_SETTINGS.some(key => next[key] !== before[key])) {
      engine.log('info', 'settings changed that apply on the next launch')
    }
    return next
  })
  ipcMain.handle(CHANNEL.chooseFolder, async (_event, current: unknown) => {
    if (!window) return undefined
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      ...(typeof current === 'string' && {defaultPath: current}),
    })
    return result.canceled ? undefined : result.filePaths[0]
  })
  ipcMain.handle(CHANNEL.doctor, () => {
    // the first call (start-up) takes the check already running; later ones re-check
    const warm = warmDiagnosis
    warmDiagnosis = undefined
    return warm ?? engine.diagnose()
  })
  ipcMain.handle(CHANNEL.setup, async (_event, force: unknown): Promise<SetupOutcome> => {
    const result = await engine.setup({
      force: force === true,
      onProgress: progress => send(CHANNEL.setupProgress, progress),
    })
    return {ready: result.after.ready, installed: result.installed, diagnosis: result.after}
  })
  ipcMain.handle(CHANNEL.analyze, async (_event, url: unknown, maxItems: unknown): Promise<Preview> => {
    if (typeof url !== 'string') throw new Error('Invalid request.')
    const mix = isYouTubeMix(url)
    const valid = Number.isInteger(maxItems) && (maxItems as number) >= 1 && (maxItems as number) <= MAX_LISTED_ITEMS
    const cap = valid
      ? (maxItems as number)
      : mix
        ? MIX_DEFAULT_ITEMS
        : isTikTokProfile(url)
          ? TIKTOK_PROFILE_DEFAULT_ITEMS
          : MAX_LISTED_ITEMS
    const analysis = await engine.analyze(url, {maxEntries: cap})
    if (analysis.kind === 'video') {
      rememberPreview(url, analysis)
      return {kind: 'video', title: analysis.media.title, duration: analysis.media.duration}
    }
    return {
      kind: 'playlist',
      title: analysis.title,
      uploader: analysis.uploader,
      entries: analysis.entries,
      singleVideoUrl: analysis.singleVideoUrl,
      mix,
      maxItems: cap,
    }
  })
  ipcMain.handle(CHANNEL.schedule, (_event, input: ScheduleInput) => {
    if (typeof input?.url !== 'string' || typeof input.outDir !== 'string') throw new Error('Invalid request.')
    return scheduler.schedule({
      url: input.url,
      profile: toProfile(input),
      outDir: input.outDir,
      ...(input.selection && {selection: input.selection}),
      ...(!input.selection && {analysis: takePreview(input.url)}),
    })
  })
  ipcMain.handle(CHANNEL.state, async () => {
    await restoring
    return {batches: scheduler.batches(), jobs: engine.jobs()}
  })
  ipcMain.handle(CHANNEL.items, (_event, batchId: BatchId, offset: unknown, limit: unknown) =>
    scheduler.items(batchId, {
      offset: Number.isInteger(offset) ? (offset as number) : 0,
      limit: Number.isInteger(limit) ? Math.min(500, limit as number) : 50,
    }),
  )
  ipcMain.handle(CHANNEL.cancelBatch, (_event, id: BatchId) => scheduler.cancel(id))
  ipcMain.handle(CHANNEL.cancelJob, (_event, id: JobId) => engine.cancel(id))
  ipcMain.handle(CHANNEL.retryJob, (_event, id: JobId) => void engine.retry(id))
  ipcMain.handle(CHANNEL.pause, () => engine.pause())
  ipcMain.handle(CHANNEL.resume, () => engine.resume())
  ipcMain.handle(CHANNEL.clearFinished, () => {
    engine.clearFinished()
    scheduler.clearFinished()
  })
  ipcMain.handle(CHANNEL.searchLogs, (_event, id: unknown, limit: unknown) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9]{6,32}$/.test(id)) return {entries: [], total: 0}
    return searchTrace(path.join(engine.dataDir, 'logs'), id, {
      limit: Number.isInteger(limit) ? (limit as number) : 500,
    })
  })
  ipcMain.handle(CHANNEL.reveal, (_event, file: unknown) => {
    if (typeof file === 'string' && path.isAbsolute(file)) shell.showItemInFolder(file)
  })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })

  const start = async () => {
    const downloadDir = process.env['MDC_DOWNLOAD_DIR'] ?? app.getPath('downloads')
    const max = MediaDownloader.maxConcurrency()
    settings = new SettingsStore(
      path.join(app.getPath('userData'), 'settings.json'),
      // the user's ordered language list (System Settings), not just the app's UI locale
      defaultSettings(downloadDir, max, [...app.getPreferredSystemLanguages(), app.getLocale()]),
      max,
    )
    const current = await settings.load()
    nativeTheme.themeSource = current.theme
    createEngine(current)
    const firstDiagnosis = engine.diagnose()
    warmDiagnosis = firstDiagnosis
    registerIpc()
    // a damaged schedule must not keep the app from opening: log it and start empty
    restoring = scheduler
      .restore()
      .then(() => undefined)
      .catch(error => engine.log('error', `could not restore pending batches: ${String(error)}`))
    createWindow()
    await restoring
    // YouTube breaks old yt-dlp versions: refresh in the background once tools are in place
    void firstDiagnosis
      .then(d => (d.ready && !process.env['MDC_BINARIES'] ? engine.updateYtDlp() : undefined))
      .catch(error => engine.log('warn', `yt-dlp update check failed: ${String(error)}`))
  }

  // anything that escapes start-up is fatal: say why instead of leaving a blank window
  void app
    .whenReady()
    .then(start)
    .catch(error => {
      dialog.showErrorBox(
        'Media Download Core could not start',
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      )
      app.exit(1)
    })

  let quitting = false
  app.on('before-quit', event => {
    if (quitting || !engine) return
    event.preventDefault()
    quitting = true
    // saves pending batches and jobs, stops processes, keeps partial downloads for next launch
    void scheduler
      .dispose()
      .then(() => engine.dispose())
      .finally(() => {
        coalescer.dispose()
        app.quit()
      })
  })
  app.on('window-all-closed', () => app.quit())
}
