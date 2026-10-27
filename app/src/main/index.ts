import {randomUUID} from 'node:crypto'
import {appendFileSync, readFileSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, screen, shell} from 'electron'
import {
  type BatchId,
  BatchScheduler,
  type BatchTarget,
  type BinaryPaths,
  type Diagnosis,
  type FormatProfile,
  folderFormat,
  isTikTokProfile,
  isYouTubeMix,
  type JobId,
  type JobSnapshot,
  MAX_CPU_SHARE,
  MAX_LISTED_ITEMS,
  MAX_REQUESTED_ITEMS,
  MediaDownloader,
  MIX_DEFAULT_ITEMS,
  type MixAnalysis,
  type MixItem,
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
import windowIcon from '../../build/icons/512x512.png?asset'
import type {Language} from '../shared/contract'
import {
  type AppInfo,
  type AppSettings,
  CHANNEL,
  detectLink,
  type FailedRetry,
  FINISHED_INTEGRITY,
  type FinishedEntry,
  type FinishedFilter,
  type FinishedIntegrity,
  type FinishedPage,
  type FinishedQuery,
  type FinishedSort,
  isFormat,
  isQuality,
  type LinkSite,
  type MixPreview,
  type MixScheduleInput,
  type Preview,
  QUIT_CHOICES,
  type QuitChoice,
  RESTART_SETTINGS,
  type ScheduleInput,
  type SetupOutcome,
  SIZE_LIMITS,
  SIZE_RANGES,
  type SizeRange,
  type SyncCheck,
  type SyncFolder,
  type SyncInput,
  toProfile,
  type VerifySummary,
} from '../shared/contract'
import {EventCoalescer} from './events'
import {SCHEME as LIVE_SCHEME, LiveProxy} from './live-proxy'
import {createMetaBrowser} from './meta-browser'
import {createPlayerBrowser} from './player-browser'
import {isLiveRecord, redownloadRequest, retryTarget} from './redownload'
import {defaultSettings, SettingsStore} from './settings'
import {taskbarState} from './taskbar'
import {createTikTokBrowser} from './tiktok-browser'
import type {InstallKind} from './updates/feed'
import {detectInstallKind} from './updates/install'
import {Updater} from './updates/updater'
import {MIN_SIZE, readWindowState, restoreBounds, writeWindowState} from './window-state'
import {YouTubeController} from './youtube/controller'
import {runProbe} from './youtube/probe'

/** The titles the app gives the batches it starts itself (download again, retry failed), per language. */
const HOST_TITLES = {
  again: {
    en: 'Downloaded again',
    es: 'Descargados de nuevo',
    pt: 'Baixados de novo',
    it: 'Scaricati di nuovo',
    ru: 'Скачано заново',
    zh: '重新下载',
    id: 'Diunduh ulang',
    hi: 'फिर से डाउनलोड किए गए',
    vi: 'Tải lại',
    th: 'ดาวน์โหลดอีกครั้ง',
    tr: 'Yeniden indirilenler',
    ar: 'تنزيل مجدد',
    fr: 'Téléchargés à nouveau',
    de: 'Erneut heruntergeladen',
  },
  retried: {
    en: 'Failed, retried',
    es: 'Fallidos reintentados',
    pt: 'Falhas tentadas de novo',
    it: 'Non riusciti, riprovati',
    ru: 'Повтор неудачных',
    zh: '重试失败项',
    id: 'Yang gagal dicoba lagi',
    hi: 'विफल, फिर से कोशिश',
    vi: 'Thử lại mục lỗi',
    th: 'ลองรายการที่ล้มเหลวอีกครั้ง',
    tr: 'Başarısızlar yeniden denendi',
    ar: 'إعادة محاولة الفاشلة',
    fr: 'Échecs relancés',
    de: 'Fehlgeschlagene, erneut versucht',
  },
  mix: {
    en: 'Mix list',
    es: 'Lista mixta',
    pt: 'Lista mista',
    it: 'Lista mista',
    ru: 'Смешанный список',
    zh: '混合列表',
    id: 'Daftar campuran',
    hi: 'मिश्रित सूची',
    vi: 'Danh sách hỗn hợp',
    th: 'รายการรวม',
    tr: 'Karma liste',
    ar: 'قائمة مختلطة',
    fr: 'Liste mixte',
    de: 'Gemischte Liste',
  },
} as const satisfies Record<string, Record<Language, string>>
const hostTitle = (which: keyof typeof HOST_TITLES, language: Language): string => HOST_TITLES[which][language]
/** Now, in the language’s date and time (Electron ships a full ICU). */
const stamp = (language: Language): string =>
  new Date().toLocaleString(language === 'pt' ? 'pt-BR' : language === 'zh' ? 'zh-CN' : language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

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
/** The same for Instagram and Facebook pages. */
const metaBrowsers: Array<ReturnType<typeof createMetaBrowser>> = []
/** YouTube's attestation (after a bot check) and the account the user may choose to sign in with. */
const youtube = new YouTubeController(state => send(CHANNEL.youtube, state))
/** Hidden Chromium windows of the player-page sites (configured, or tried by host), one pool per site. */
const playerBrowsers: Array<ReturnType<typeof createPlayerBrowser>> = []
/** Player-page sources made for hosts yt-dlp doesn't support, by host: one per host however often asked. */
const hostSources = new Map<string, PlayerPageSource>()
let updater: Updater | undefined
/** The link being read for a preview, if any. */
let reading: AbortController | undefined
/** The mix list being checked: a new one (or Cancel) stops it. */
let mixing: AbortController | undefined
/** The last mix list checked, until it is scheduled or another replaces it: its checks are reused. */
let checkedMix: {readonly id: string; readonly analysis: MixAnalysis} | undefined
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
      // the installer waits for this process to end: a shutdown step that hangs must not keep the update out
      setTimeout(() => app.exit(0), 20_000).unref()
    },
  })
  updater.onChange(state => send(CHANNEL.update, state))
  const previous = await updater.cleanUp()
  if (previous) {
    const failed = updater.state.status === 'error' ? ` — ${updater.state.message}` : ''
    engine.log(failed ? 'warn' : 'info', `last update: ${previous.trim().split(/\r?\n/).join(' | ')}${failed}`)
  }
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

/** Recordings started from the window: a quit asks what to do with the ones still running. */
const recordings = new Set<JobId>()
const TERMINAL: ReadonlySet<JobSnapshot['status']> = new Set(['completed', 'skipped', 'failed', 'cancelled'])
/** The live player's proxy (mdc-live:), made with the engine. */
let liveProxy: LiveProxy | undefined
/** The user answered what to do with running recordings (or there was no window to ask). */
let recordingsDecided = false

/** Live recordings not over yet: started here, or a restored job recording. O(jobs), only at quit. */
function runningRecordings(): JobSnapshot[] {
  return engine
    .jobs()
    .filter(job => !TERMINAL.has(job.status) && (recordings.has(job.id) || job.progress.live === true))
}

/** Resolves once every one of these jobs has ended (completed, failed or cancelled). */
function whenEnded(ids: readonly JobId[]): Promise<void> {
  return new Promise(resolve => {
    const pending = new Set<JobId>()
    const onJob = (job: JobSnapshot) => {
      if (TERMINAL.has(job.status)) pending.delete(job.id)
      if (pending.size === 0) {
        engine.off('job', onJob)
        resolve()
      }
    }
    // listening first: a job that ends while this looks is not missed
    engine.on('job', onJob)
    for (const id of ids) {
      const job = engine.job(id)
      if (job && !TERMINAL.has(job.status)) pending.add(id)
    }
    if (pending.size === 0) {
      engine.off('job', onJob)
      resolve()
    }
  })
}

/**
 * Ends the running recordings before a quit: 'save' stops each (it is kept, validated and
 * archived like any download; one still queued has nothing to keep and is cancelled),
 * 'discard' cancels each. O(r).
 */
async function endRecordings(choice: 'save' | 'discard'): Promise<void> {
  const live = runningRecordings()
  for (const job of live) {
    if (choice === 'discard' || !engine.stop(job.id)) engine.cancel(job.id)
  }
  phase(`quit: ${live.length} recording(s) ${choice === 'save' ? 'stopped' : 'discarded'}`)
  await whenEnded(live.map(job => job.id))
  phase('quit: recordings ended')
}

function rememberPreview(url: string, analysis: VideoAnalysis): void {
  previews.delete(url)
  previews.set(url, {analysis, at: Date.now()})
  // Map iterates in insertion order: the first key is the oldest — O(1) eviction
  if (previews.size > PREVIEW_SLOTS) previews.delete(previews.keys().next().value!)
}

/** A checked mix list as the renderer sees it: what each link is, not its formats or metadata files. O(n). */
function mixPreview(id: string, analysis: MixAnalysis): MixPreview {
  return {
    id,
    valid: analysis.valid.map(item => {
      const media = item.analysis?.media
      return {
        line: item.line,
        url: item.url,
        site: item.site,
        title: media?.title,
        uploader: media?.uploader,
        duration: media?.duration,
        photoPost: media?.slideshow !== undefined && media.slideshow.videos !== true,
        archived: item.archived,
        unchecked: item.analysis === undefined,
      }
    }),
    skipped: analysis.skipped,
    summary: analysis.summary,
  }
}

/** Delete the metadata kept for checked links that won't download (a mix list replaced, or links removed). */
function forgetMix(items: readonly MixItem[]): void {
  for (const item of items) {
    const file = item.analysis?.infoJsonPath
    if (file) void fs.rm(file, {force: true})
  }
}

function takePreview(url: string): VideoAnalysis | undefined {
  const hit = previews.get(url)
  previews.delete(url)
  return hit && Date.now() - hit.at < PREVIEW_TTL_MS ? hit.analysis : undefined
}
let coalescer: EventCoalescer

/**
 * Start-up and quit, step by step, on stdout — only for the end-to-end runs
 * (MDC_E2E_TRACE=1), which attach it to a failed test: a quit that hangs says
 * at which step.
 */
const tracing = process.env['MDC_E2E_TRACE'] === '1'
function phase(step: string): void {
  if (tracing) process.stdout.write(`[mdc ${new Date().toISOString()}] ${step}\n`)
}

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
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

/**
 * Any http(s) link yt-dlp doesn't support is tried as a player-page site,
 * whatever its host — no site is named here or shipped with the app. The
 * engine keeps it once it finds videos there; its browser stays on that host.
 */
function hostSource(url: URL, log: (level: 'info' | 'warn', message: string) => void): PlayerPageSource {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const known = hostSources.get(host)
  if (known) return known
  const browser = createPlayerBrowser([host])
  playerBrowsers.push(browser)
  const source = new PlayerPageSource({site: {name: host, hosts: [host]}, resolveMedia: browser.resolve, log})
  hostSources.set(host, source)
  return source
}

/** A Meta site's hidden browser, kept to be closed with the app. */
function metaBrowser(partition: string, hosts: readonly string[]) {
  const browser = createMetaBrowser(partition, hosts)
  metaBrowsers.push(browser)
  return browser.render
}

/**
 * Every site is read in every run: TikTok, Instagram and Facebook through
 * their hidden browsers, the player-page sites, any other host tried as a
 * player page, and the engine's own defaults for the rest (YouTube, VK, X,
 * links straight to a file…). The link decides which one reads it.
 */
function siteSources() {
  return {
    // TikTok pages that need a real browser go through the app's Chromium; e2e runs
    // point TikTok at a local fake site, without pacing delays
    tiktok: {
      browser: tiktokBrowser.render,
      ...(process.env['MDC_TIKTOK_ORIGIN'] && {
        origin: process.env['MDC_TIKTOK_ORIGIN'],
        pacing: {spacingMs: 0, jitterMs: 0},
      }),
    },
    instagram: {browser: metaBrowser('instagram-reader', ['instagram.com']), ...metaOrigin('MDC_INSTAGRAM_ORIGIN')},
    facebook: {browser: metaBrowser('facebook-reader', ['facebook.com']), ...metaOrigin('MDC_FACEBOOK_ORIGIN')},
    // e2e runs read twitch.tv links from a local fake GraphQL + usher, Threads from a local fake site
    ...(process.env['MDC_TWITCH_ORIGIN'] && {
      twitch: {
        endpoints: {gql: `${process.env['MDC_TWITCH_ORIGIN']}/gql`, usher: process.env['MDC_TWITCH_ORIGIN']},
        pacing: {spacingMs: 0, jitterMs: 0},
      },
    }),
    ...(process.env['MDC_THREADS_ORIGIN'] && {threads: metaOrigin('MDC_THREADS_ORIGIN')}),
    // player-page sites (configured, or tried by host);
    // the engine's log isn't there yet: messages wait for it
    sources: playerSources((level, message) => queueMicrotask(() => engine.log(level, message))),
    unsupportedUrlSource: (url: URL) => hostSource(url, (level, message) => engine.log(level, message)),
  }
}

/** Test hook: a local fake of a Meta site, without pacing delays. */
function metaOrigin(variable: string) {
  const origin = process.env[variable]
  return origin ? {origin, pacing: {spacingMs: 0, jitterMs: 0}} : {}
}

function createEngine(current: AppSettings): void {
  const dataDir = app.getPath('userData')
  const binaries = binariesFromEnv()
  engine = new MediaDownloader({
    dataDir,
    concurrency: current.concurrency,
    maxCpuShare: current.cpuBoost ? MAX_CPU_SHARE : undefined,
    validation: current.validation,
    validationTiming: current.validateAfter ? 'after-batch' : 'during',
    embedMetadata: current.embedMetadata,
    embedThumbnail: current.embedThumbnail,
    fileNames: current.portableNames ? 'portable' : 'original',
    ...siteSources(),
    longVideoMinutes: current.longVideoMinutes,
    // a bot check: PO tokens from the app's own Chromium, then a hold for the user (sign in, or wait)
    youtube: {attestation: youtube.strategies, askUser: true},
    ...(current.cookiesFromBrowser && {cookiesFromBrowser: current.cookiesFromBrowser}),
    ...(binaries && {binaries}),
  })
  youtube.attach(engine)
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
    // macOS and Windows take the icon from the app bundle; a Linux window needs its own
    ...(process.platform === 'linux' && {icon: windowIcon}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1420' : '#eef6fb',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // shown once the first paint is ready; if that event never comes (seen on
  // some Windows machines), a second later all the same. Shown and focused,
  // never forced on top: an always-on-top flip steals focus from whatever
  // the user is doing and flashes over full-screen apps on macOS. A quit
  // within that second leaves the window destroyed: touching it then throws,
  // and Electron's "Uncaught Exception" dialog keeps the app from exiting
  const reveal = () => {
    if (!window || window.isDestroyed() || window.isVisible()) return
    if (bounds.maximized) window.maximize()
    window.show()
    window.focus()
  }
  window.once('ready-to-show', reveal)
  setTimeout(reveal, 1000).unref()
  // remember size and position for the next launch (normal bounds even when maximized)
  // the hidden TikTok reader must never keep the app alive on its own.
  // A closed window is let go: every `if (!window)` past this point skips it
  // instead of touching a destroyed object, which throws
  window.on('closed', () => {
    window = undefined
    tiktokBrowser.close()
    for (const browser of [...playerBrowsers, ...metaBrowsers]) browser.close()
  })
  window.on('close', event => {
    if (!window) return
    // closing the window quits the app: a recording running is asked about first
    if (!recordingsDecided && engine && runningRecordings().length > 0) {
      event.preventDefault()
      send(CHANNEL.quitRequested, runningRecordings().length)
      return
    }
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
      boostedConcurrency: MediaDownloader.maxConcurrency(MAX_CPU_SHARE),
      ...(Object.keys(SITE_ALIASES).length > 0 && {siteAliases: SITE_ALIASES}),
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
    if (next.cpuBoost !== before.cpuBoost) engine.setMaxCpuShare(next.cpuBoost ? MAX_CPU_SHARE : 0.5)
    if (next.concurrency !== before.concurrency || next.cpuBoost !== before.cpuBoost)
      engine.setConcurrency(next.concurrency)
    if (next.validateAfter !== before.validateAfter)
      engine.setValidationTiming(next.validateAfter ? 'after-batch' : 'during')
    if (next.validation !== before.validation) engine.setValidation(next.validation)
    if (next.portableNames !== before.portableNames) engine.setFileNames(next.portableNames ? 'portable' : 'original')
    // a browser's session at once: YouTube requests paused by a bot check go on with it
    if (next.cookiesFromBrowser !== before.cookiesFromBrowser) engine.setCookiesFromBrowser(next.cookiesFromBrowser)
    // Sync Up's schedule runs whenever it is on
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
        ...(analysis.media.isLive && {
          live: {
            channel: analysis.media.uploader ?? analysis.media.title,
            // unix seconds → ms, as the renderer's dates are
            startedAt: analysis.media.publishedAt === undefined ? undefined : analysis.media.publishedAt * 1000,
          },
        }),
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
  ipcMain.handle(
    CHANNEL.mixAnalyze,
    async (_event, text: unknown, format: unknown, quality: unknown): Promise<MixPreview> => {
      if (typeof text !== 'string' || !isFormat(format)) throw new Error('Invalid request.')
      mixing?.abort()
      const current = new AbortController()
      mixing = current
      let lastSent = 0
      const analysis = await engine
        .analyzeMix(text, {
          signal: current.signal,
          profile: toProfile({format, quality: isQuality(quality) ? quality : 'best'}),
          slideshow: {mode: settings.current.slideshowMode, secondsPerImage: settings.current.slideshowSeconds},
          onProgress: progress => {
            // ~8 updates a second are plenty for a progress bar
            const now = Date.now()
            if (now - lastSent < 125 && progress.checked !== progress.total) return
            lastSent = now
            send(CHANNEL.mixProgress, progress)
          },
        })
        .finally(() => {
          if (mixing === current) mixing = undefined
        })
      if (checkedMix) forgetMix(checkedMix.analysis.valid)
      checkedMix = {id: randomUUID(), analysis}
      return mixPreview(checkedMix.id, analysis)
    },
  )
  ipcMain.handle(CHANNEL.mixCancel, () => mixing?.abort())
  ipcMain.handle(CHANNEL.mixSchedule, (_event, input: MixScheduleInput) => {
    if (!Array.isArray(input?.urls) || typeof input.outDir !== 'string' || !isFormat(input.format)) {
      throw new Error('Invalid request.')
    }
    const kept = new Set(input.urls.filter((url): url is string => typeof url === 'string'))
    const checked = checkedMix?.id === input.id ? checkedMix.analysis : undefined
    checkedMix = undefined
    // the preview's links as checked, less those removed; a check gone (replaced) → the links, checked by the batch
    const mix = checked ? {...checked, valid: checked.valid.filter(item => kept.has(item.url))} : [...kept]
    if (checked) forgetMix(checked.valid.filter(item => !kept.has(item.url)))
    const language = settings.current.language
    // a format of its own for some links (one song as MP3 among videos): the core makes each a target of the same batch
    const formats: Record<string, FormatProfile> = {}
    for (const [url, own] of Object.entries(input.formats ?? {})) {
      if (kept.has(url) && isFormat(own?.format)) {
        formats[url] = toProfile({format: own.format, quality: isQuality(own.quality) ? own.quality : 'best'})
      }
    }
    return scheduler.scheduleMix(mix, {
      formats,
      profile: toProfile({format: input.format, quality: isQuality(input.quality) ? input.quality : 'best'}),
      outDir: input.outDir,
      title: `${hostTitle('mix', language)} · ${stamp(language)}`,
      slideshow: slideshowOptions({
        mode: settings.current.slideshowMode,
        secondsPerImage: settings.current.slideshowSeconds,
      }),
    })
  })
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
    return {
      batches: scheduler.batches(),
      jobs: engine.jobs(),
      youtubePausedUntil: engine.youtubePausedUntil ?? null,
      youtube: youtube.state,
    }
  })
  ipcMain.handle(CHANNEL.youtubeState, () => youtube.state)
  ipcMain.handle(CHANNEL.youtubeSignIn, () => youtube.signIn(window))
  ipcMain.handle(CHANNEL.youtubeSignOut, () => youtube.signOut())
  ipcMain.handle(CHANNEL.youtubeWait, () => youtube.waitItOut())
  ipcMain.handle(CHANNEL.items, (_event, batchId: BatchId, offset: unknown, limit: unknown) =>
    scheduler.items(batchId, {
      offset: Number.isInteger(offset) ? (offset as number) : 0,
      limit: Number.isInteger(limit) ? Math.min(500, limit as number) : 50,
    }),
  )
  ipcMain.handle(CHANNEL.cancelBatch, (_event, id: BatchId) => scheduler.cancel(id))
  ipcMain.handle(CHANNEL.cancelJob, (_event, id: JobId) => engine.cancel(id))
  ipcMain.handle(CHANNEL.record, async (_event, input: ScheduleInput): Promise<JobSnapshot> => {
    if (typeof input?.url !== 'string' || typeof input.outDir !== 'string') throw new Error('Invalid request.')
    // one recording per channel: Record again finds the one already running
    const running = runningRecordings().find(job => job.url === input.url)
    if (running) return running
    const analysis = takePreview(input.url) ?? (await engine.analyze(input.url))
    if (analysis.kind !== 'video' || !analysis.media.isLive) throw new Error('This channel is not live right now.')
    const job = engine.addVideo(analysis, toProfile(input), input.outDir)
    recordings.add(job.id)
    return job
  })
  ipcMain.handle(CHANNEL.stopJob, (_event, id: JobId) => engine.stop(id))
  ipcMain.handle(CHANNEL.liveOpen, async (_event, url: unknown) => {
    if (typeof url !== 'string' || !liveProxy) throw new Error('Invalid request.')
    return liveProxy.open(url)
  })
  ipcMain.handle(CHANNEL.liveClose, (_event, sid: unknown) => {
    if (typeof sid === 'string') liveProxy?.close(sid)
  })
  ipcMain.handle(CHANNEL.quitWith, async (_event, choice: QuitChoice) => {
    if (!QUIT_CHOICES.includes(choice)) throw new Error('Invalid request.')
    if (choice === 'keep') return
    recordingsDecided = true
    await endRecordings(choice)
    app.quit()
  })
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
    const filter = filterOf(q) ?? {}
    const sort: FinishedSort = (['oldest', 'largest', 'smallest'] as const).find(s => s === q.sort) ?? 'newest'
    const matches = await finishedMatches(filter, sort)
    const offset = Math.max(0, Number.isInteger(q.offset) ? (q.offset as number) : 0)
    const limit = Math.min(500, Math.max(1, Number.isInteger(q.limit) ? (q.limit as number) : 50))
    const page = {
      entries: matches.entries.slice(offset, offset + limit),
      total: matches.entries.length,
      bytes: matches.bytes,
    }
    // only the page shown is checked on disk: ≤ 500 stats, in parallel (a disk filter checked them all already)
    const entries = await Promise.all(
      page.entries.map(async (entry): Promise<FinishedEntry> => {
        const file = await fileState(entry)
        return {
          key: entry.key,
          title: entry.title ?? path.basename(entry.filepath),
          filepath: entry.filepath,
          sizeBytes: entry.sizeBytes,
          duration: entry.duration,
          extractor: entry.extractor,
          url: entry.url,
          site: siteOf(entry),
          completedAt: entry.completedAt,
          sha256: entry.sha256,
          validation: entry.validation,
          batchId: entry.batchId,
          batchTitle: entry.batchTitle,
          damaged: entry.damaged,
          ...(isLiveRecord(entry) && {live: true}),
          file,
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
  ipcMain.handle(CHANNEL.finishedGroups, () => {
    // the 2 s refresh asks with every page: grouped again only when the history changed
    const version = engine.archive.version
    const cached = groupsCache?.version === version ? groupsCache : {version, groups: engine.archive.groups()}
    groupsCache = cached
    return cached.groups
  })
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
  ipcMain.handle(CHANNEL.verifyFinished, (_event, target: unknown): Promise<VerifySummary> => {
    // one check at a time: a second request waits for the first instead of hashing the same disk twice
    const run = verifying.then(() => verifyFinished(target)).finally(forgetDiskScan)
    verifying = run.catch(() => undefined)
    return run
  })
  ipcMain.handle(CHANNEL.removeFinished, (_event, keys: unknown) => {
    if (!Array.isArray(keys)) return 0
    return engine.archive.removeMany(
      keys.slice(0, MAX_REQUESTED_ITEMS).filter((key): key is string => typeof key === 'string'),
    )
  })
  ipcMain.handle(CHANNEL.pruneFinished, async (_event, target: unknown) => {
    const gone = await missingOf(target)
    const removed = await engine.archive.removeMany(gone.map(entry => entry.key))
    forgetDiskScan()
    engine.log('info', `history: forgot ${removed} file(s) no longer where they were (deleted or moved)`)
    return removed
  })
  ipcMain.handle(CHANNEL.redownloadFinished, async (_event, target: unknown) => {
    // damaged at the source: never downloaded again (the Damaged list lets one go)
    const gone = (await missingOf(target)).filter(entry => !entry.damaged).slice(0, MAX_REQUESTED_ITEMS)
    const title = `${hostTitle('again', settings.current.language)} · ${stamp(settings.current.language)}`
    const request = redownloadRequest(gone, title)
    if (!request) return 0
    engine.log('info', `history: downloading again ${request.targets.length} file(s) no longer where they were`)
    // the records stay: the engine finds their files gone and replaces each record when its download finishes
    await scheduler.schedule(request)
    return request.targets.length
  })
  ipcMain.handle(CHANNEL.retryFailed, async (_event, items: unknown) => {
    if (!Array.isArray(items) || items.length === 0) throw new Error('Invalid request.')
    return scheduler.schedule(retryRequest(items.slice(0, MAX_REQUESTED_ITEMS) as FailedRetry[]))
  })
  ipcMain.handle(CHANNEL.damagedList, () => engine.damaged.list())
  ipcMain.handle(CHANNEL.damagedForget, async (_event, key: unknown) => {
    if (typeof key === 'string' && (await engine.damaged.remove(key))) {
      engine.log('info', 'a video damaged at the source may be downloaded again (the user asked)')
    }
  })
  ipcMain.handle(CHANNEL.relaunch, () => {
    // e2e runs only record it
    if (process.env['MDC_OPEN_LOG']) {
      appendFileSync(process.env['MDC_OPEN_LOG'], 'relaunch\n')
      return
    }
    app.relaunch()
    app.quit()
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

/** Test hooks: the local fakes e2e runs point TikTok / Instagram / Facebook at count as those sites. */
const SITE_ALIASES: Readonly<Record<string, LinkSite>> = Object.fromEntries(
  (
    [
      ['MDC_TIKTOK_ORIGIN', 'tiktok'],
      ['MDC_INSTAGRAM_ORIGIN', 'instagram'],
      ['MDC_FACEBOOK_ORIGIN', 'facebook'],
      ['MDC_THREADS_ORIGIN', 'threads'],
    ] as const
  ).flatMap(([variable, site]) => {
    try {
      return process.env[variable] ? [[new URL(process.env[variable]!).host.toLowerCase(), site]] : []
    } catch {
      return []
    }
  }),
)

/** A filter of the history from the renderer, validated: words, batch, integrity states, size ranges. */
function filterOf(target: unknown): FinishedFilter | undefined {
  if (typeof target !== 'object' || target === null) return undefined
  const t = target as {search?: unknown; batchId?: unknown; integrity?: unknown; size?: unknown}
  const integrity = Array.isArray(t.integrity)
    ? FINISHED_INTEGRITY.filter(state => (t.integrity as unknown[]).includes(state))
    : []
  const size = Array.isArray(t.size) ? SIZE_RANGES.filter(range => (t.size as unknown[]).includes(range)) : []
  return {
    search: typeof t.search === 'string' ? t.search.slice(0, 200) : undefined,
    batchId: typeof t.batchId === 'string' ? t.batchId : undefined,
    ...(integrity.length > 0 && {integrity}),
    ...(size.length > 0 && {size}),
  }
}

type ArchiveRecord = Awaited<ReturnType<typeof engine.archive.list>>['entries'][number]

/** Where a finished file stands on disk: there with its size, gone, or another size. */
async function fileState(entry: Pick<ArchiveRecord, 'filepath' | 'sizeBytes'>): Promise<FinishedEntry['file']> {
  const stat = await fs.stat(entry.filepath).catch(() => undefined)
  if (stat?.isDirectory()) return 'ok' // a slideshow's folder of images
  if (!stat?.isFile()) return 'missing'
  return stat.size === entry.sizeBytes ? 'ok' : 'changed'
}

/**
 * The site a finished file came from, by its link: worked out once per
 * record (records are kept and reused by the archive), so a refresh of the
 * history every 2 s during a batch doesn't read every link again.
 */
const sites = new WeakMap<ArchiveRecord, LinkSite>()
function siteOf(entry: ArchiveRecord): LinkSite {
  let site = sites.get(entry)
  if (site === undefined) {
    site = detectLink(entry.url, SITE_ALIASES)?.site ?? 'web'
    sites.set(entry, site)
  }
  return site
}

/** Its integrity state, as the Integrity column shows it (the disk state is asked separately). */
function recordedIntegrity(entry: ArchiveRecord): FinishedIntegrity {
  if (entry.damaged) return 'damaged'
  if (entry.validation === 'quick' || entry.validation === 'full') return 'verified'
  if (entry.validation === 'none' || !entry.sha256) return 'unverified'
  return 'checksum'
}

/** Run `task` over `items`, `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, async () => {
      for (let i = next++; i < items.length; i = next++) await task(items[i]!)
    }),
  )
}

/**
 * The archive query for a history filter: the size ranges, the integrity
 * states (files of every site). Missing / changed
 * files need a look at the disk: those are found first (stats in parallel).
 */
async function archiveFilter(
  filter: FinishedFilter,
): Promise<{search?: string; batchId?: string; match: (entry: ArchiveRecord) => boolean}> {
  const ranges = (filter.size ?? []).map((range: SizeRange) => SIZE_LIMITS[range])
  const wanted = new Set(filter.integrity ?? [])
  const onDisk = wanted.has('missing') || wanted.has('changed')
  const base = (entry: ArchiveRecord) =>
    ranges.length === 0 || ranges.some(([min, max]) => entry.sizeBytes >= min && entry.sizeBytes < max)
  let disk: DiskStates | undefined
  if (onDisk) {
    // one pass over the archive (not one per 500-record page), and the stats of the last scan reused
    const scope = (await engine.archive.matching({...plain(filter), match: base})).entries
    disk = await diskStates(scope)
  }
  return {
    ...plain(filter),
    match: entry => {
      if (!base(entry)) return false
      if (wanted.size === 0) return true
      if (wanted.has(recordedIntegrity(entry))) return true
      const state = disk?.get(entry)
      return state !== undefined && state !== 'ok' && wanted.has(state)
    },
  }
}

/** How long a scan of the disk answers the Missing / Changed filters (files change outside the app too). */
const DISK_SCAN_MS = 30_000

/**
 * The state on disk of each record seen by the last scan. Keyed by the record
 * itself: the archive makes a new one whenever a file is recorded again, so a
 * file downloaded since is never answered with its old state.
 */
type DiskStates = WeakMap<ArchiveRecord, FinishedEntry['file']>
let diskScan: {at: number; states: DiskStates} | undefined

const diskFresh = (scan = diskScan): scan is {at: number; states: DiskStates} =>
  scan !== undefined && Date.now() - scan.at <= DISK_SCAN_MS

/**
 * The disk state of each record of `scope`: stats only for the ones the last
 * scan (under 30 s old) didn't cover — a page change, or the 2 s refresh of a
 * Missing filter while a batch adds files, stats only the new ones. 32 at a time.
 */
async function diskStates(scope: readonly ArchiveRecord[]): Promise<DiskStates> {
  if (!diskFresh()) diskScan = {at: Date.now(), states: new WeakMap()}
  const {states} = diskScan!
  const unknown = scope.filter(entry => !states.has(entry))
  await eachLimited(unknown, 32, async entry => {
    states.set(entry, await fileState(entry))
  })
  return states
}

/** What the history derives from the archive, kept while it doesn't change. */
let groupsCache: {version: number; groups: ReturnType<typeof engine.archive.groups>} | undefined
let matchesCache:
  | {key: string; version: number; disk: unknown; matches: {entries: readonly ArchiveRecord[]; bytes: number}}
  | undefined

/** Forget what was seen on disk (after an action that removes or brings back files). */
function forgetDiskScan(): void {
  diskScan = undefined
}

/**
 * Every record a history filter shows, in its order — computed once per
 * (filter, sort, history version, disk scan) and shared by every page and
 * every refresh after it: a page is then O(page), not O(n).
 */
async function finishedMatches(filter: FinishedFilter, sort: FinishedSort) {
  const key = JSON.stringify([filter.search, filter.batchId, filter.integrity, filter.size, sort])
  const version = engine.archive.version
  const onDisk = filter.integrity?.some(state => state === 'missing' || state === 'changed') ?? false
  const cached = matchesCache
  if (cached?.key === key && cached.version === version && (!onDisk || (cached.disk === diskScan && diskFresh()))) {
    return cached.matches
  }
  const query = await archiveFilter(filter)
  const matches = await engine.archive.matching({...query, sort})
  matchesCache = {key, version, disk: diskScan, matches}
  return matches
}

/** The words and batch of a filter, as the archive takes them. */
function plain(filter: FinishedFilter): {search?: string; batchId?: string} {
  return {
    ...(filter.search && {search: filter.search}),
    ...(filter.batchId && {batchId: filter.batchId}),
  }
}

/**
 * One batch with failed downloads of any batches: each keeps its folder,
 * format and list position (from its job; the downloads folder and the
 * format it had when the job is no longer known).
 */
function retryRequest(items: readonly FailedRetry[]) {
  const entries = []
  const targets: BatchTarget[] = []
  for (const [position, item] of items.entries()) {
    if (typeof item?.url !== 'string') throw new Error('Invalid request.')
    const known = typeof item.jobId === 'string' ? engine.request(item.jobId as JobId) : undefined
    const index = position + 1
    entries.push({
      id: known?.mediaId ?? item.mediaId ?? '',
      index,
      url: item.url,
      title: known?.title ?? item.title ?? item.url,
      duration: known?.duration,
      extractor: known?.extractor ?? 'Generic',
      isLive: false,
    })
    targets.push(retryTarget(index, known, {outDir: settings.current.downloadDir, profile: item.profile}))
  }
  const title = `${hostTitle('retried', settings.current.language)} · ${stamp(settings.current.language)}`
  return {
    url: items[0]!.url,
    profile: targets[0]!.profile,
    outDir: settings.current.downloadDir,
    selection: {title, entries},
    targets,
  }
}

/** Which records a verification covers: given keys, one batch, or every match of a search. */
async function selectionOf(target: unknown): Promise<{keys?: readonly string[]; batchId?: string} | undefined> {
  if (typeof target !== 'object' || target === null) return undefined
  const t = target as {keys?: unknown; batchId?: unknown; all?: unknown; search?: unknown}
  if (Array.isArray(t.keys)) return {keys: t.keys.filter((key): key is string => typeof key === 'string')}
  if (t.all !== true) return typeof t.batchId === 'string' ? {batchId: t.batchId} : undefined
  // always as keys: the records the history shows for this filter
  return {keys: (await allFinished(filterOf(target)!)).map(entry => entry.key)}
}

/** The finished-files check in flight (serializes `verifyFinished`). */
let verifying: Promise<unknown> = Promise.resolve()

/** Re-hash the records a target covers; progress goes out at most every 200 ms (and at the end). */
async function verifyFinished(target: unknown): Promise<VerifySummary> {
  const summary = {checked: 0, ok: 0, missing: 0, changed: 0, corrupted: 0}
  const only = await selectionOf(target)
  if (!only || only.keys?.length === 0) return summary
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
  for (const check of checks) {
    if (check.ok) summary.ok++
    else if (check.problem === 'missing') summary.missing++
    else if (check.problem === 'size-changed') summary.changed++
    else summary.corrupted++
  }
  summary.checked = checks.length
  engine.log(
    'info',
    `checked ${summary.checked} finished file(s): ${summary.ok} ok, ${summary.missing} missing, ${summary.changed} changed, ${summary.corrupted} corrupted`,
  )
  return summary
}

/**
 * The records a target covers whose file is no longer where it was: given
 * keys (one pass over the archive, O(n)), or every match of a filter. Stats
 * run 16 at a time.
 */
async function missingOf(target: unknown): Promise<ArchiveRecord[]> {
  const only = await selectionOf(target)
  if (!only) return []
  let scope: readonly ArchiveRecord[]
  if (only.keys) {
    // from the records in memory, one pass — not a read of the whole log from disk
    const keys = new Set(only.keys)
    scope = (await engine.archive.matching({match: entry => keys.has(entry.key)})).entries
  } else scope = await allFinished({batchId: only.batchId})
  const gone: ArchiveRecord[] = []
  await eachLimited(scope, 16, async entry => {
    if ((await fileState(entry)) === 'missing') gone.push(entry)
  })
  return gone
}

/** Every record matching a filter, in one pass. */
async function allFinished(filter: FinishedFilter): Promise<readonly ArchiveRecord[]> {
  // one pass, O(n): paging 500 at a time filtered the whole history again for every page
  return (await engine.archive.matching(await archiveFilter(filter))).entries
}

/** The history as CSV (UTF-8 with a BOM, so spreadsheets keep accents), one row per file. */
async function finishedCsv(filter: FinishedFilter): Promise<string> {
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = [
    'title',
    'file',
    'size_bytes',
    'duration_s',
    'finished',
    'site',
    'url',
    'check',
    'sha256',
    'batch',
    'damaged',
  ]
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
      entry.damaged ?? '',
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

// the live player's playlists and segments (live-proxy.ts): fetch-able, streamed, CORS for the page
protocol.registerSchemesAsPrivileged([
  {
    scheme: LIVE_SCHEME,
    privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true},
  },
])

if (!app.requestSingleInstanceLock()) app.quit()
else {
  // opened again while this one is still quitting: its window may be gone already
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  const start = async () => {
    // the YouTube attestation health check (the watch workflow): a report, no window, then quit
    const probe = process.env['MDC_YOUTUBE_PROBE']
    if (probe) {
      const report = await runProbe(app.getPath('userData'), path.resolve(probe))
      app.exit(report.verdict === 'broken' ? 2 : 0)
      return
    }
    const downloadDir = process.env['MDC_DOWNLOAD_DIR'] ?? app.getPath('downloads')
    const max = MediaDownloader.maxConcurrency()
    settings = new SettingsStore(
      path.join(app.getPath('userData'), 'settings.json'),
      // the user's ordered language list (System Settings), not just the app's UI locale
      defaultSettings(downloadDir, max, [...app.getPreferredSystemLanguages(), app.getLocale()]),
      {half: max, boosted: MediaDownloader.maxConcurrency(MAX_CPU_SHARE)},
    )
    const current = await settings.load()
    phase('start: settings loaded')
    nativeTheme.themeSource = current.theme
    createEngine(current)
    phase('start: engine created')
    const twitchFake = process.env['MDC_TWITCH_LIVE_ORIGIN']
    liveProxy = new LiveProxy({
      playback: (url, opts) => engine.livePlayback(url, opts),
      fetch: (url, init) => net.fetch(url, init),
      // e2e runs serve "Twitch's CDN" from a local fake live origin
      ...(twitchFake && {
        allowSegment: url => url.origin === new URL(twitchFake).origin || url.hostname.endsWith('.ttvnw.net'),
      }),
    })
    protocol.handle(LIVE_SCHEME, request => liveProxy!.handle(request))
    const firstDiagnosis = engine.diagnose()
    warmDiagnosis = firstDiagnosis
    registerIpc()
    // a damaged schedule must not keep the app from opening: log it and start empty
    restoring = scheduler
      .restore()
      .then(() => undefined)
      .catch(error => engine.log('error', `could not restore pending batches: ${String(error)}`))
    createWindow()
    phase('start: window created')
    await createUpdater()
    phase('start: updater ready')
    await restoring
    phase('start: pending batches restored')
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
    phase(`quit: before-quit (quitting=${quitting}, engine=${Boolean(engine)})`)
    if (quitting || !engine) return
    // recordings running: the window asks (save / discard / keep), then quits through quitWith;
    // the forced-exit timer below is armed only once they have ended
    if (!recordingsDecided) {
      const live = runningRecordings()
      if (live.length > 0) {
        event.preventDefault()
        if (window && !window.isDestroyed()) {
          window.show()
          send(CHANNEL.quitRequested, live.length)
        } else {
          // no window to ask in (macOS: quit from the Dock after closing it): keep what was recorded
          recordingsDecided = true
          void endRecordings('save').finally(() => app.quit())
        }
        return
      }
    }
    event.preventDefault()
    quitting = true
    sync.dispose()
    tiktokBrowser.close()
    youtube.close()
    for (const browser of [...playerBrowsers, ...metaBrowsers]) browser.close()
    phase('quit: browsers closed')

    // a shutdown that hangs (a tool that ignores its kill, a browser that
    // never closes) must not leave the app running in the background: the
    // engine's own dispose gives up on its pool after 3 s, so this fires only
    // past that, after the pending journal had its time to freeze
    const forceExitTimer = setTimeout(() => {
      phase('quit: forced exit after 10 s')
      app.exit(0)
    }, 10_000)
    forceExitTimer.unref()

    // saves pending batches and jobs, stops processes, keeps partial downloads for next launch
    void scheduler
      .dispose()
      .then(() => {
        phase('quit: scheduler disposed')
        return engine.dispose()
      })
      .finally(() => {
        phase('quit: engine disposed')
        clearTimeout(forceExitTimer)
        coalescer.dispose()
        app.quit()
      })
  })
  app.on('will-quit', () => phase('quit: will-quit'))
  app.on('quit', (_event, code) => phase(`quit: quit (code ${code})`))
  app.on('window-all-closed', () => app.quit())
}
