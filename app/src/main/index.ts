import {appendFileSync, readFileSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell} from 'electron'
import {
  type BatchId,
  BatchScheduler,
  type BinaryPaths,
  type Diagnosis,
  type FormatProfile,
  folderFormat,
  isTikTokProfile,
  isYouTubeMix,
  type JobId,
  MAX_LISTED_ITEMS,
  MAX_REQUESTED_ITEMS,
  MediaDownloader,
  MIX_DEFAULT_ITEMS,
  PlayerPageSource,
  parsePlayerPageSites,
  SyncManager,
  searchTrace,
  slideshowOptions,
  syncProfile,
  syncSchedule,
  TIKTOK_PROFILE_DEFAULT_ITEMS,
  type VideoAnalysis,
} from 'media-downloader-core'
import {
  type AppInfo,
  type AppSettings,
  CHANNEL,
  type FinishedEntry,
  type FinishedPage,
  type FinishedQuery,
  isAudioFormat,
  type Preview,
  RESTART_SETTINGS,
  type ScheduleInput,
  type SetupOutcome,
  type SyncCheck,
  type SyncFolder,
  type SyncInput,
  type VerifySummary,
} from '../shared/contract'
import {EventCoalescer} from './events'
import {createPlayerBrowser} from './player-browser'
import {defaultSettings, SettingsStore} from './settings'
import {taskbarState} from './taskbar'
import {createTikTokBrowser} from './tiktok-browser'
import type {InstallKind} from './updates/feed'
import {detectInstallKind} from './updates/install'
import {Updater} from './updates/updater'
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

/** When this run (the engine's session) began. */
const STARTED_AT = Date.now()
let window: BrowserWindow | undefined
let engine: MediaDownloader
let scheduler: BatchScheduler
/** TikTok accounts kept in step with folders (the Sync tab); its schedule runs while sync is on. */
let sync: SyncManager
let settings: SettingsStore
/** Settles once the batches pending at last shutdown are back; the renderer's restore phase waits for it. */
let restoring: Promise<void> = Promise.resolve()
/** Hidden Chromium for TikTok pages that only open in a browser. */
const tiktokBrowser = createTikTokBrowser(process.env['MDC_TIKTOK_ORIGIN'])
/** Hidden Chromium windows of the player-page sites the user configured, one pool per site. */
const playerBrowsers: Array<ReturnType<typeof createPlayerBrowser>> = []
let updater: Updater | undefined
/** The link being read for a preview, if any. */
let reading: AbortController | undefined
/** Background update checks: shortly after start-up, then every few hours (when enabled). */
const FIRST_CHECK_MS = 8000
const CHECK_EVERY_MS = 6 * 60 * 60_000
const BUNDLE_ID = 'io.github.isaachq.mediadownloadcore'

async function createUpdater(): Promise<void> {
  const env = process.env
  // test hooks: a local release feed, a forced install kind, stop before installing
  const kind =
    (env['MDC_UPDATE_KIND'] as InstallKind | undefined) ??
    (app.isPackaged ? await detectInstallKind(process.execPath, env) : undefined)
  updater = new Updater({
    current: app.getVersion(),
    kind,
    arch: process.arch,
    dir: path.join(app.getPath('userData'), 'updates'),
    bundleId: BUNDLE_ID,
    execPath: process.execPath,
    env,
    feedUrl: env['MDC_UPDATE_FEED'],
    trustedPrefix: env['MDC_UPDATE_TRUSTED'],
    dryRun: env['MDC_UPDATE_DRY_RUN'] === '1',
    exit: how => {
      engine.log('info', `update installed — ${how === 'relaunch' ? 'restarting' : 'closing for the swap'}`)
      if (how === 'relaunch') app.relaunch()
      app.quit()
    },
  })
  updater.onChange(state => send(CHANNEL.update, state))
  await updater.cleanUp()
  const background = () => {
    if (settings.current.autoUpdate) void updater?.check({quiet: true})
  }
  setTimeout(background, FIRST_CHECK_MS).unref()
  setInterval(background, CHECK_EVERY_MS).unref()
}
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

/**
 * Player-page sites the user configured for themselves in a local file —
 * `<userData>/sites.json`, or the one MDC_SITES_FILE names. None ship with the
 * app: no file, no such sites. A broken file is reported in the log.
 */
function playerSources(log: (level: 'info' | 'warn', message: string) => void): PlayerPageSource[] {
  const file = process.env['MDC_SITES_FILE'] || path.join(app.getPath('userData'), 'sites.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  try {
    return parsePlayerPageSites(JSON.parse(text)).map(site => {
      const browser = createPlayerBrowser(site.hosts)
      playerBrowsers.push(browser)
      return new PlayerPageSource({site, resolveMedia: browser.resolve, log})
    })
  } catch (error) {
    log('warn', `${file}: ${error instanceof Error ? error.message : String(error)} — no sites from it were loaded`)
    return []
  }
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
    // TikTok pages that need a real browser go through the app's Chromium; e2e runs
    // point TikTok at a local fake site, without pacing delays
    tiktok: {
      browser: tiktokBrowser.render,
      ...(process.env['MDC_TIKTOK_ORIGIN'] && {
        origin: process.env['MDC_TIKTOK_ORIGIN'],
        pacing: {spacingMs: 0, jitterMs: 0},
      }),
    },
    // the engine's log isn't there yet: messages wait for it
    sources: playerSources((level, message) => queueMicrotask(() => engine.log(level, message))),
    longVideoMinutes: current.longVideoMinutes,
    ...(current.cookiesFromBrowser && {cookiesFromBrowser: current.cookiesFromBrowser}),
    ...(binaries && {binaries}),
  })
  scheduler = new BatchScheduler(engine)
  coalescer = new EventCoalescer(
    bundle => send(CHANNEL.events, bundle),
    () => engine.youtubePausedUntil,
  )
  engine.on('job', snapshot => coalescer.job(snapshot))
  engine.on('log', entry => coalescer.log(entry))
  scheduler.on('batch', snapshot => coalescer.batch(snapshot))
  scheduler.on('batch', () => showTaskbarProgress())
  sync = new SyncManager(engine, scheduler)
  sync.on('subscription', view => send(CHANNEL.syncEvent, {view}))
  sync.on('removed', removed => send(CHANNEL.syncEvent, {removed}))
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
  // the hidden TikTok reader must never keep the app alive on its own
  window.on('closed', () => {
    tiktokBrowser.close()
    for (const browser of playerBrowsers) browser.close()
  })
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
      startedAt: STARTED_AT,
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
    // a browser's session at once: YouTube requests paused by a bot check go on with it
    if (next.cookiesFromBrowser !== before.cookiesFromBrowser) engine.setCookiesFromBrowser(next.cookiesFromBrowser)
    if (next.syncEnabled !== before.syncEnabled) {
      if (next.syncEnabled) sync.startSchedule()
      else sync.stopSchedule()
    }
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
    const valid = Number.isInteger(maxItems) && (maxItems as number) >= 1 && (maxItems as number) <= MAX_REQUESTED_ITEMS
    const cap = valid
      ? (maxItems as number)
      : mix
        ? MIX_DEFAULT_ITEMS
        : (engine.defaultListSize(url) ?? (isTikTokProfile(url) ? TIKTOK_PROFILE_DEFAULT_ITEMS : MAX_LISTED_ITEMS))
    // one link is read at a time; a new one (or Cancel) stops the previous reading
    reading?.abort()
    const current = new AbortController()
    reading = current
    let lastSent = 0
    const analysis = await engine
      .analyze(url, {
        maxEntries: cap,
        signal: current.signal,
        onProgress: progress => {
          // ~8 updates a second are plenty for a progress bar
          const now = Date.now()
          if (now - lastSent < 125 && progress.listed !== progress.expected) return
          lastSent = now
          send(CHANNEL.analyzeProgress, progress)
        },
      })
      .finally(() => {
        if (reading === current) reading = undefined
      })
    if (analysis.kind === 'video') {
      rememberPreview(url, analysis)
      return {
        kind: 'video',
        title: analysis.media.title,
        duration: analysis.media.duration,
        slideshow: analysis.media.slideshow,
      }
    }
    return {
      kind: 'playlist',
      title: analysis.title,
      uploader: analysis.uploader,
      entries: analysis.entries,
      singleVideoUrl: analysis.singleVideoUrl,
      mix,
      maxItems: cap,
      total: analysis.total,
      complete: analysis.complete,
    }
  })
  ipcMain.handle(CHANNEL.analyzeCancel, () => reading?.abort())
  ipcMain.handle(CHANNEL.schedule, (_event, input: ScheduleInput) => {
    if (typeof input?.url !== 'string' || typeof input.outDir !== 'string') throw new Error('Invalid request.')
    return scheduler.schedule({
      url: input.url,
      profile: toProfile(input),
      outDir: input.outDir,
      slideshow: slideshowOptions(
        input.slideshow ?? {mode: settings.current.slideshowMode, secondsPerImage: settings.current.slideshowSeconds},
      ),
      ...(input.selection && {selection: input.selection}),
      ...(!input.selection && {analysis: takePreview(input.url)}),
    })
  })
  ipcMain.handle(CHANNEL.state, async () => {
    await restoring
    return {batches: scheduler.batches(), jobs: engine.jobs(), youtubePausedUntil: engine.youtubePausedUntil ?? null}
  })
  ipcMain.handle(CHANNEL.items, (_event, batchId: BatchId, offset: unknown, limit: unknown) =>
    scheduler.items(batchId, {
      offset: Number.isInteger(offset) ? (offset as number) : 0,
      limit: Number.isInteger(limit) ? Math.min(500, limit as number) : 50,
    }),
  )
  ipcMain.handle(CHANNEL.cancelBatch, (_event, id: BatchId) => scheduler.cancel(id))
  ipcMain.handle(CHANNEL.cancelJob, (_event, id: JobId) => engine.cancel(id))
  // through the scheduler: a job of a batch is retried with its batch, which reopens and follows it
  ipcMain.handle(CHANNEL.retryJob, (_event, id: JobId) => void scheduler.retryJob(id))
  ipcMain.handle(CHANNEL.retryBatch, (_event, id: BatchId) => scheduler.retryFailed(id))
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
  ipcMain.handle(CHANNEL.updateState, () => updater?.state ?? {status: 'idle'})
  ipcMain.handle(CHANNEL.updateCheck, () => updater?.check() ?? {status: 'idle'})
  ipcMain.handle(CHANNEL.updateInstall, () => updater?.update())
  ipcMain.handle(CHANNEL.reveal, (_event, file: unknown) => {
    if (typeof file === 'string' && path.isAbsolute(file)) opener.reveal(file)
  })
  ipcMain.handle(CHANNEL.finished, async (_event, query: unknown): Promise<FinishedPage> => {
    const q = (typeof query === 'object' && query !== null ? query : {}) as Partial<FinishedQuery>
    const page = await engine.archive.list({
      offset: Number.isInteger(q.offset) ? q.offset : 0,
      limit: Number.isInteger(q.limit) ? q.limit : 50,
      search: typeof q.search === 'string' ? q.search.slice(0, 200) : undefined,
      batchId: typeof q.batchId === 'string' ? q.batchId : undefined,
    })
    // only the page shown is checked on disk: ≤ 500 stats, in parallel
    const entries = await Promise.all(
      page.entries.map(async (entry): Promise<FinishedEntry> => {
        const stat = await fs.stat(entry.filepath).catch(() => undefined)
        return {
          key: entry.key,
          title: entry.title ?? path.basename(entry.filepath),
          filepath: entry.filepath,
          sizeBytes: entry.sizeBytes,
          duration: entry.duration,
          extractor: entry.extractor,
          url: entry.url,
          completedAt: entry.completedAt,
          sha256: entry.sha256,
          validation: entry.validation,
          batchId: entry.batchId,
          batchTitle: entry.batchTitle,
          file: stat?.isDirectory()
            ? 'ok' // a slideshow's folder of images
            : !stat?.isFile()
              ? 'missing'
              : stat.size === entry.sizeBytes
                ? 'ok'
                : 'changed',
        }
      }),
    )
    return {entries, total: page.total, bytes: page.bytes}
  })
  ipcMain.handle(CHANNEL.openFinished, async (_event, key: unknown, target: unknown) => {
    // a key from the archive, never a path from the renderer: only recorded downloads open
    if (typeof key !== 'string' || (target !== 'file' && target !== 'folder')) return false
    const hit = await engine.archive.find(key)
    if (!hit) return false
    if (target === 'folder') opener.reveal(hit.filepath)
    else await opener.open(hit.filepath)
    return true
  })
  ipcMain.handle(CHANNEL.finishedGroups, () => engine.archive.groups())
  ipcMain.handle(CHANNEL.syncList, () => sync.list())
  ipcMain.handle(CHANNEL.syncFolder, async (_event, folder: unknown): Promise<SyncFolder> => {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) return {files: 0, formats: []}
    const found = await folderFormat(folder)
    if (found.files === 0) return found
    const chosen = syncProfile(found, undefined, toProfile({format: 'mp4', quality: 'best'} as ScheduleInput))
    return 'problem' in chosen ? {...found, problem: chosen.problem} : {...found, format: chosen.profile.container}
  })
  ipcMain.handle(CHANNEL.syncAdd, (_event, input: unknown) => {
    const value = (typeof input === 'object' && input !== null ? input : {}) as Partial<SyncInput>
    return sync.add({
      url: String(value.url ?? ''),
      folder: String(value.folder ?? ''),
      // a folder with files keeps their format; the core refuses any other
      ...(value.format && {profile: toProfile({format: value.format, quality: 'best'} as ScheduleInput)}),
      schedule: syncSchedule(value.schedule) ?? {every: 'manual'},
      slideshow: {mode: settings.current.slideshowMode, secondsPerImage: settings.current.slideshowSeconds},
    })
  })
  ipcMain.handle(CHANNEL.syncUpdate, (_event, id: unknown, patch: unknown) => {
    const value = (typeof patch === 'object' && patch !== null ? patch : {}) as {schedule?: unknown}
    const schedule = value.schedule === undefined ? undefined : syncSchedule(value.schedule)
    return sync.update(String(id), {...(schedule && {schedule})})
  })
  ipcMain.handle(CHANNEL.syncRemove, (_event, id: unknown) => sync.remove(String(id)))
  ipcMain.handle(CHANNEL.syncRun, (_event, id: unknown, deep: unknown) => sync.run(String(id), {deep: deep === true}))
  ipcMain.handle(CHANNEL.syncCheck, async (_event, id: unknown, deep: unknown): Promise<SyncCheck> => {
    const plan = await sync.check(String(id), {deep: deep === true})
    return {
      listed: plan.listed,
      total: plan.total,
      inFolder: plan.inFolder,
      new: plan.entries.length,
      sample: plan.entries.slice(0, 50).map(entry => ({id: entry.id, title: entry.title})),
      gone: plan.gone.length,
      caughtUp: plan.caughtUp,
    }
  })
  // a click on a system notification brings the app forward
  ipcMain.handle(CHANNEL.focusWindow, () => {
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  ipcMain.handle(CHANNEL.verifyFinished, async (_event, target: unknown): Promise<VerifySummary> => {
    const only = await selectionOf(target)
    if (!only) return {checked: 0, ok: 0, missing: 0, changed: 0, corrupted: 0}
    let lastSent = 0
    const checks = await engine.verifyArchive(
      (done, total) => {
        const now = Date.now()
        if (now - lastSent < 200 && done !== total) return
        lastSent = now
        send(CHANNEL.verifyProgress, {done, total})
      },
      undefined,
      only,
    )
    const summary = {checked: checks.length, ok: 0, missing: 0, changed: 0, corrupted: 0}
    for (const check of checks) {
      if (check.ok) summary.ok++
      else if (check.problem === 'missing') summary.missing++
      else if (check.problem === 'size-changed') summary.changed++
      else summary.corrupted++
    }
    engine.log(
      'info',
      `checked ${summary.checked} finished file(s): ${summary.ok} ok, ${summary.missing} missing, ${summary.changed} changed, ${summary.corrupted} corrupted`,
    )
    return summary
  })
  ipcMain.handle(CHANNEL.removeFinished, async (_event, keys: unknown) => {
    if (!Array.isArray(keys)) return 0
    let removed = 0
    for (const key of keys.slice(0, MAX_REQUESTED_ITEMS)) {
      if (typeof key !== 'string') continue
      await engine.archive.remove(key)
      removed++
    }
    return removed
  })
  ipcMain.handle(CHANNEL.exportFinished, async (_event, target: unknown) => {
    const filter = filterOf(target)
    if (!filter) return undefined
    const stamp = new Date().toISOString().slice(0, 10)
    const suggested = path.join(settings.current.downloadDir, `media-download-core-finished-${stamp}.csv`)
    // e2e runs name the file instead of answering a dialog
    let file = process.env['MDC_EXPORT_FILE']
    if (!file) {
      if (!window) return undefined
      const choice = await dialog.showSaveDialog(window, {
        defaultPath: suggested,
        filters: [{name: 'CSV', extensions: ['csv']}],
      })
      if (choice.canceled || !choice.filePath) return undefined
      file = choice.filePath
    }
    await fs.writeFile(file, await finishedCsv(filter))
    return file
  })
  ipcMain.handle(CHANNEL.openFolder, async (_event, target: unknown) => {
    const folder = await folderOf(target)
    if (!folder) return false
    await opener.open(folder)
    return true
  })
}

/**
 * Progress of the batches at work on the Dock / taskbar icon, and on macOS
 * a badge with the items left — at most once a second, whatever the events.
 */
let taskbarTimer: NodeJS.Timeout | undefined
function showTaskbarProgress(): void {
  if (taskbarTimer) return
  taskbarTimer = setTimeout(() => {
    taskbarTimer = undefined
    if (!window || window.isDestroyed()) return
    const {progress, left} = taskbarState(scheduler.batches())
    window.setProgressBar(progress)
    app.dock?.setBadge(left > 0 ? String(left) : '')
  }, 1000)
  taskbarTimer.unref()
}

/**
 * Hands files and folders to the system (Finder / Explorer / the default
 * player). e2e runs record the requests in MDC_OPEN_LOG instead of opening
 * windows on the test machine.
 */
const opener = process.env['MDC_OPEN_LOG']
  ? {
      reveal: (file: string) => appendFileSync(process.env['MDC_OPEN_LOG']!, `reveal ${file}\n`),
      open: async (target: string) => appendFileSync(process.env['MDC_OPEN_LOG']!, `open ${target}\n`),
    }
  : {
      reveal: (file: string) => shell.showItemInFolder(file),
      open: async (target: string) => {
        const problem = await shell.openPath(target)
        if (problem) engine.log('warn', `could not open ${target}: ${problem}`)
      },
    }

/** A search / batch filter of the history from the renderer, validated. */
function filterOf(target: unknown): {search?: string | undefined; batchId?: string | undefined} | undefined {
  if (typeof target !== 'object' || target === null) return undefined
  const t = target as {search?: unknown; batchId?: unknown}
  return {
    search: typeof t.search === 'string' ? t.search.slice(0, 200) : undefined,
    batchId: typeof t.batchId === 'string' ? t.batchId : undefined,
  }
}

/** Which records a verification covers: given keys, one batch, or every match of a search. */
async function selectionOf(target: unknown): Promise<{keys?: readonly string[]; batchId?: string} | undefined> {
  if (typeof target !== 'object' || target === null) return undefined
  const t = target as {keys?: unknown; batchId?: unknown; all?: unknown; search?: unknown}
  if (Array.isArray(t.keys)) return {keys: t.keys.filter((key): key is string => typeof key === 'string')}
  if (t.all !== true) return typeof t.batchId === 'string' ? {batchId: t.batchId} : undefined
  const filter = filterOf(target)!
  if (!filter.search) return filter.batchId ? {batchId: filter.batchId} : {}
  return {keys: (await allFinished(filter)).map(entry => entry.key)}
}

/** Every record matching a filter, read a page (500) at a time. */
async function allFinished(filter: {search?: string | undefined; batchId?: string | undefined}) {
  const entries: Awaited<ReturnType<typeof engine.archive.list>>['entries'][number][] = []
  for (let offset = 0; ; offset += 500) {
    const page = await engine.archive.list({...filter, offset, limit: 500})
    entries.push(...page.entries)
    if (entries.length >= page.total || page.entries.length === 0) return entries
  }
}

/** The history as CSV (UTF-8 with a BOM, so spreadsheets keep accents), one row per file. */
async function finishedCsv(filter: {search?: string | undefined; batchId?: string | undefined}): Promise<string> {
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = ['title', 'file', 'size_bytes', 'duration_s', 'finished', 'site', 'url', 'check', 'sha256', 'batch']
  const rows = (await allFinished(filter)).map(entry =>
    [
      entry.title,
      entry.filepath,
      entry.sizeBytes,
      entry.duration === undefined ? '' : Math.round(entry.duration),
      new Date(entry.completedAt).toISOString(),
      entry.extractor,
      entry.url,
      entry.validation ?? '',
      entry.sha256 ?? '',
      entry.batchTitle ?? '',
    ]
      .map(cell)
      .join(','),
  )
  return `\uFEFF${[header.join(','), ...rows].join('\r\n')}\r\n`
}

/** The downloads folder (created if needed), or the folder holding a batch's files. */
async function folderOf(target: unknown): Promise<string | undefined> {
  if (target === 'downloads') {
    const dir = settings.current.downloadDir
    await fs.mkdir(dir, {recursive: true}).catch(() => {})
    return dir
  }
  const syncId = typeof target === 'object' && target !== null ? (target as {syncId?: unknown}).syncId : undefined
  if (typeof syncId === 'string') {
    const folder = (await sync.get(syncId))?.folder
    if (folder) await fs.mkdir(folder, {recursive: true}).catch(() => {})
    return folder
  }
  const batchId = typeof target === 'object' && target !== null ? (target as {batchId?: unknown}).batchId : undefined
  if (typeof batchId !== 'string') return undefined
  // a playlist's files sit in a sub-folder named after it: where its finished jobs went
  for (const job of engine.jobs()) {
    if (job.batchId === batchId && job.filepath) return path.dirname(job.filepath)
  }
  const batch = scheduler.batch(batchId as BatchId)
  if (!batch) return undefined
  const exists = await fs.stat(batch.outDir).then(
    stat => stat.isDirectory(),
    () => false,
  )
  return exists ? batch.outDir : undefined
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
    await createUpdater()
    await restoring
    // scheduled syncs (and any missed while the app was closed) once pending batches are back
    if (current.syncEnabled) sync.startSchedule()
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
    sync.dispose()
    tiktokBrowser.close()
    for (const browser of playerBrowsers) browser.close()
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
