// The contract between the main process (engine owner), the preload bridge
// and the renderer. Types only cross the boundary — no engine code runs in
// the renderer.
import type {
  AudioContainer,
  BatchId,
  BatchSelection,
  BatchSnapshot,
  DamagedEntry,
  Diagnosis,
  FormatProfile,
  InstallProgress,
  JobId,
  JobSnapshot,
  LogEntry,
  PlaylistEntry,
  PreflightItem,
  SlideshowOptions,
  SubscriptionView,
  SyncRun,
  SyncSchedule,
  ValidationLevel,
  VideoContainer,
} from 'media-downloader-core'

export type Language = 'en' | 'es'

/**
 * The interface language for a system's preferred languages, in the user's
 * order (e.g. ["es-MX", "en-US"]): the first one the app speaks wins, English
 * when none is Spanish or English. O(n).
 */
export function pickLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/, 1)[0]
    if (base === 'es' || base === 'en') return base
  }
  return 'en'
}
export type ThemeMode = 'system' | 'light' | 'dark'

/**
 * What one run of the app downloads: YouTube and other web sites, TikTok,
 * Instagram or Facebook — one per run, each with only its own screens and
 * controls (TikTok's Sync Up exists only in TikTok mode, YouTube's sign-in
 * only in web mode…), so a feature of one site can never act in another's.
 * Changing it restarts the app.
 */
export type RunMode = 'web' | 'tiktok' | 'instagram' | 'facebook'
export const RUN_MODES: readonly RunMode[] = ['web', 'tiktok', 'instagram', 'facebook']

const inDomain = (host: string, domains: readonly string[]): boolean =>
  domains.some(domain => host === domain || host.endsWith(`.${domain}`))

/**
 * The mode a link belongs to; undefined when it isn't an http(s) link. O(1).
 * `aliases` maps more hosts ("host:port") to a mode: the local fakes of e2e runs.
 */
export function platformOf(url: string, aliases?: Readonly<Record<string, RunMode>>): RunMode | undefined {
  let host: string
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    host = parsed.hostname.toLowerCase()
    const alias = aliases?.[parsed.host.toLowerCase()]
    if (alias) return alias
  } catch {
    return undefined
  }
  if (inDomain(host, ['tiktok.com'])) return 'tiktok'
  if (inDomain(host, ['instagram.com', 'instagr.am'])) return 'instagram'
  if (inDomain(host, ['facebook.com', 'fb.watch', 'fb.com', 'fb.me', 'fb.gg'])) return 'facebook'
  return 'web'
}

/** Thrown by the main process for a link of another mode; the renderer shows its own words for it. */
export const MODE_MISMATCH = 'mode-mismatch'
export type Format = VideoContainer | AudioContainer
export type Quality = 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360'

export const VIDEO_FORMATS: readonly VideoContainer[] = ['mp4', 'webm', 'mkv']
export const AUDIO_FORMATS: readonly AudioContainer[] = ['m4a', 'mp3', 'opus', 'flac', 'wav']
export const QUALITIES: readonly Quality[] = ['best', '2160', '1440', '1080', '720', '480', '360']

export const isAudioFormat = (format: Format): format is AudioContainer =>
  (AUDIO_FORMATS as readonly string[]).includes(format)

export function toProfile(input: {readonly format: Format; readonly quality?: Quality | undefined}): FormatProfile {
  if (isAudioFormat(input.format)) return {kind: 'audio', container: input.format}
  return {
    kind: 'video',
    container: input.format,
    ...(input.quality && input.quality !== 'best' ? {maxHeight: Number(input.quality)} : {}),
  }
}

export type AppSettings = {
  readonly language: Language
  readonly theme: ThemeMode
  readonly downloadDir: string
  readonly format: Format
  readonly quality: Quality
  /** Simultaneous jobs; the engine clamps it to ⌊CPUs/2⌋. */
  readonly concurrency: number
  readonly validation: ValidationLevel
  /** Browser to read cookies from ('' = none). Applied on next launch. */
  readonly cookiesFromBrowser: string
  readonly embedMetadata: boolean
  readonly embedThumbnail: boolean
  /** Videos this long or more count as long/heavy jobs. Applied on next launch. */
  readonly longVideoMinutes: number
  readonly notifications: boolean
  /** File and folder names with ASCII letters, digits and hyphens only (car stereos, TVs, USB sticks). */
  readonly portableNames: boolean
  /** Look for a new version at start-up and every few hours. */
  readonly autoUpdate: boolean
  /** What TikTok slideshows (photo posts) become with a video format; remembered from the last choice. */
  readonly slideshowMode: SlideshowOptions['mode']
  /** Seconds each image shows in a slideshow video (1–30). */
  readonly slideshowSeconds: number
  /** The first-steps guide was finished or closed (it shows once; Header → Guide replays it). */
  readonly tourDone: boolean
  /** TikTok mode: Sync Up's schedule runs while the app is open (the tab is always there in that mode). */
  readonly syncEnabled: boolean
  /** What the next run downloads (see RunMode); the run in progress keeps `AppInfo.mode`. */
  readonly mode: RunMode
  /**
   * Download a batch first and check its files once every download ended
   * (instead of each file before it finishes). Files broken at the source
   * are marked and never downloaded again.
   */
  readonly validateAfter: boolean
  /** Let downloads use up to 60% of the processors instead of half. */
  readonly cpuBoost: boolean
}

/** The most simultaneous downloads the settings allow on this machine. */
export const concurrencyCap = (info: AppInfo, settings: Pick<AppSettings, 'cpuBoost'>): number =>
  settings.cpuBoost ? info.boostedConcurrency : info.maxConcurrency

/** What a sync check found, small enough for the screen (a profile can have thousands of posts). */
export type SyncCheck = {
  readonly listed: number
  readonly total?: number | undefined
  readonly inFolder: number
  readonly new: number
  /** The first new posts, newest first. */
  readonly sample: ReadonlyArray<{readonly id: string; readonly title: string}>
  readonly gone: number
  readonly caughtUp: boolean
}

export type SyncInput = {
  readonly url: string
  readonly folder: string
  /** Only for an empty folder: one with files keeps their format. */
  readonly format?: Format | undefined
  readonly schedule: SyncSchedule
}

/** A folder before it is synced: its media files and their format (one, when it is consistent). */
export type SyncFolder = {
  readonly files: number
  readonly formats: readonly string[]
  /** The format a sync into it downloads; undefined when the folder is empty (the user picks). */
  readonly format?: Format | undefined
  /** Why it can't be synced (it mixes formats, or holds one sync doesn't download). */
  readonly problem?: string | undefined
}

/** Browsers whose cookies (signed-in session) yt-dlp can read. */
export const BROWSERS = ['chrome', 'chromium', 'edge', 'firefox', 'safari', 'brave', 'opera', 'vivaldi'] as const

/** Settings the engine reads at construction — changing them asks for a restart. */
export const RESTART_SETTINGS: ReadonlyArray<keyof AppSettings> = [
  'embedMetadata',
  'embedThumbnail',
  'longVideoMinutes',
  'mode',
]

export type AppInfo = {
  readonly version: string
  readonly platform: string
  readonly cpus: number
  /** Simultaneous downloads with half the processors. */
  readonly maxConcurrency: number
  /** With up to 60% of them (`cpuBoost`): on small machines the same as `maxConcurrency`. */
  readonly boostedConcurrency: number
  /** This run's mode (settings.mode applies from the next run). */
  readonly mode: RunMode
  /** Hosts ("host:port") standing in for a site: e2e runs point a mode at a local fake. */
  readonly siteAliases?: Readonly<Record<string, RunMode>> | undefined
  readonly dataDir: string
  /** This run's id: in every log line of it (the report shows it, the logs search it). */
  readonly sessionId: string
  /** When this run began (ms). */
  readonly startedAt: number
}

/**
 * Everything that changed since the last flush, sent at most every 100 ms:
 * the latest snapshot per job / batch (older ones are dropped, not queued),
 * resolved preflight items and new log lines.
 */
export type EventBundle = {
  readonly jobs: readonly JobSnapshot[]
  readonly batches: readonly BatchSnapshot[]
  readonly items: ReadonlyArray<{readonly batchId: BatchId; readonly item: PreflightItem}>
  readonly logs: readonly LogEntry[]
  /** YouTube requests are paused by a bot check until then (ms); null when they aren't. */
  readonly youtubePausedUntil?: number | null | undefined
}

/**
 * How YouTube is reached (the engine's ladder after a bot check) and whether
 * an account is signed in inside the app (it is used only once the user agreed).
 */
export type YouTubeState = {
  /** open: plain · attested: with PO tokens · held: waiting for the user · account: signed in, in use. */
  readonly level: 'open' | 'attested' | 'held' | 'account'
  /** YouTube requests wait until then (ms); null when they don't. */
  readonly pausedUntil: number | null
  /** Requests carry PO tokens. */
  readonly tokens: boolean
  /** An account is signed in inside the app (in use only at level 'account'). */
  readonly signedIn: boolean
}

export type ScheduleInput = {
  readonly url: string
  readonly format: Format
  readonly quality: Quality
  readonly outDir: string
  /** Entries picked in the preview: downloaded as-is, the list is not fetched again. */
  readonly selection?: BatchSelection | undefined
  /** What photo posts become. */
  readonly slideshow?: SlideshowOptions | undefined
}

export type AnalyzeProgress = {readonly listed: number; readonly expected?: number | undefined}

/** The updater, as the UI shows it. */
export type UpdateState =
  | {readonly status: 'idle'}
  /** Running from source or an install the updater doesn't know: update by hand. */
  | {readonly status: 'unsupported'; readonly page: string}
  | {readonly status: 'checking'}
  | {readonly status: 'up-to-date'; readonly checkedAt: number}
  | {
      readonly status: 'available'
      readonly version: string
      readonly notes: string
      readonly page: string
      readonly size: number
    }
  | {
      readonly status: 'downloading'
      readonly version: string
      readonly page: string
      readonly received: number
      readonly total: number
    }
  /** Downloaded and verified, not installed (test runs). */
  | {readonly status: 'ready'; readonly version: string; readonly page: string; readonly file: string}
  | {readonly status: 'installing'; readonly version: string; readonly page: string}
  | {readonly status: 'error'; readonly message: string; readonly page: string; readonly version?: string}

/** What a link holds, for the preview — without local paths or format lists. */
export type Preview =
  | {
      readonly kind: 'video'
      readonly title: string
      readonly duration?: number | undefined
      /** A TikTok photo post: its images and whether it has sound. */
      readonly slideshow?: {readonly images: number; readonly audio: boolean} | undefined
    }
  | {
      readonly kind: 'playlist'
      readonly title: string
      readonly uploader?: string | undefined
      readonly entries: readonly PlaylistEntry[]
      /** Set when the link is one video inside a list (watch?v=…&list=…). */
      readonly singleVideoUrl?: string | undefined
      /** A YouTube Mix: generated on the fly, practically endless. */
      readonly mix: boolean
      /** The entry cap the listing used. */
      readonly maxItems: number
      /** Items the list holds in all, when the site tells (a TikTok profile's video count). */
      readonly total?: number | undefined
      /** The listing reached the end: entries short of `total` are not listed publicly. */
      readonly complete?: boolean | undefined
    }

/** A finished download from the archive (every session, not just this one). */
export type FinishedEntry = {
  /** Archive key: what the renderer passes back to open it (never a path). */
  readonly key: string
  readonly title: string
  readonly filepath: string
  readonly sizeBytes: number
  readonly duration?: number | undefined
  readonly extractor: string
  readonly url: string
  readonly completedAt: number
  /** The SHA-256 recorded when the file was finished. */
  readonly sha256?: string | undefined
  /** The integrity check it passed; 'none' = checksum only; absent in records of older versions. */
  readonly validation?: 'none' | 'quick' | 'full' | undefined
  /** On disk with its recorded size; gone; or another size than recorded. */
  readonly file: 'ok' | 'missing' | 'changed'
  /** The batch it came from (absent for files of older versions). */
  readonly batchId?: string | undefined
  readonly batchTitle?: string | undefined
  /** Broken at the source (what the check found): kept, never downloaded again. */
  readonly damaged?: string | undefined
}

/** Integrity states the history can be filtered by (the Integrity column). */
export type FinishedIntegrity = 'verified' | 'unverified' | 'checksum' | 'damaged' | 'missing' | 'changed'
export const FINISHED_INTEGRITY: readonly FinishedIntegrity[] = [
  'verified',
  'unverified',
  'checksum',
  'damaged',
  'missing',
  'changed',
]
/** Size ranges the history can be filtered by (the Size column). */
export type SizeRange = 'lt10m' | '10m-100m' | '100m-1g' | 'gt1g'
export const SIZE_RANGES: readonly SizeRange[] = ['lt10m', '10m-100m', '100m-1g', 'gt1g']
export const SIZE_LIMITS: Readonly<Record<SizeRange, readonly [number, number]>> = {
  lt10m: [0, 10e6],
  '10m-100m': [10e6, 100e6],
  '100m-1g': [100e6, 1e9],
  gt1g: [1e9, Number.POSITIVE_INFINITY],
}
export type FinishedSort = 'newest' | 'oldest' | 'largest' | 'smallest'

/** What narrows the history: words, a batch, integrity states, size ranges (any of each). */
export type FinishedFilter = {
  readonly search?: string | undefined
  /** Only the files of this batch. */
  readonly batchId?: string | undefined
  readonly integrity?: readonly FinishedIntegrity[] | undefined
  readonly size?: readonly SizeRange[] | undefined
}

export type FinishedQuery = FinishedFilter & {
  readonly offset: number
  readonly limit: number
  readonly sort?: FinishedSort | undefined
}

/** A batch finished files came from, every session. */
export type FinishedGroup = {
  readonly batchId: string
  readonly title?: string | undefined
  readonly count: number
  readonly bytes: number
  readonly lastCompletedAt: number
}

/** What checking finished files again found. */
export type VerifySummary = {
  readonly checked: number
  readonly ok: number
  readonly missing: number
  /** Another size than when it finished. */
  readonly changed: number
  /** Same size, different content (SHA-256). */
  readonly corrupted: number
}

/** Which finished files an action applies to: some, one batch's, or all that match a search. */
export type FinishedTarget =
  | {readonly keys: readonly string[]}
  | {readonly batchId: string}
  | (FinishedFilter & {readonly all: true})

/** A failed download to try again in a new batch (with others, from any batch). */
export type FailedRetry = {
  readonly jobId: JobId
  readonly url: string
  readonly title?: string | undefined
  readonly mediaId?: string | undefined
  readonly profile: FormatProfile
}

export type FinishedPage = {
  readonly entries: readonly FinishedEntry[]
  /** Entries matching the search, all sessions. */
  readonly total: number
  /** Their bytes. */
  readonly bytes: number
}

export type OpenTarget = 'downloads' | {readonly batchId: BatchId} | {readonly syncId: string}

export type SetupOutcome = {
  readonly ready: boolean
  readonly installed: readonly string[]
  readonly diagnosis: Diagnosis
}

/** What the preload exposes as `window.mdc`. */
export type MdcApi = {
  info(): Promise<AppInfo>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  chooseFolder(current?: string): Promise<string | undefined>
  doctor(): Promise<Diagnosis>
  setup(force: boolean): Promise<SetupOutcome>
  /** List what a link holds; `maxItems` caps long lists (a Mix defaults to 50). */
  analyze(url: string, maxItems?: number): Promise<Preview>
  /** Stop the link being read (the analyze call then rejects). */
  cancelAnalyze(): Promise<void>
  /** Progress of a long listing (TikTok profiles): posts read so far, of how many. */
  onAnalyzeProgress(listener: (progress: AnalyzeProgress) => void): () => void
  schedule(input: ScheduleInput): Promise<BatchSnapshot>
  state(): Promise<{
    readonly batches: readonly BatchSnapshot[]
    readonly jobs: readonly JobSnapshot[]
    readonly youtubePausedUntil?: number | null | undefined
    readonly youtube?: YouTubeState | undefined
  }>
  items(batchId: BatchId, offset: number, limit: number): Promise<PreflightItem[]>
  cancelBatch(batchId: BatchId): Promise<void>
  cancelJob(jobId: JobId): Promise<void>
  retryJob(jobId: JobId): Promise<void>
  /** Download a batch's failed items again (the batch reopens); how many were retried. */
  retryBatch(batchId: BatchId): Promise<number>
  pause(): Promise<void>
  resume(): Promise<void>
  clearFinished(): Promise<void>
  searchLogs(id: string, limit: number): Promise<{readonly entries: readonly LogEntry[]; readonly total: number}>
  reveal(path: string): Promise<void>
  /** Finished downloads of every session, newest first, a page at a time. */
  finished(query: FinishedQuery): Promise<FinishedPage>
  /** Open a finished file with its app, or show it in its folder; false when it is gone. */
  openFinished(key: string, target: 'file' | 'folder'): Promise<boolean>
  /** Open the downloads folder, or the folder a batch's files went to; false when there is none yet. */
  openFolder(target: OpenTarget): Promise<boolean>
  /** TikTok accounts kept in step with folders. */
  syncList(): Promise<readonly SubscriptionView[]>
  syncAdd(input: SyncInput): Promise<SubscriptionView>
  /** What a folder holds, to show its format before adding it (the format is the folder's). */
  syncFolder(folder: string): Promise<SyncFolder>
  /** When it syncs. The format never changes: it is the format of the folder's files. */
  syncUpdate(id: string, patch: {readonly schedule?: SyncSchedule}): Promise<SubscriptionView>
  syncRemove(id: string): Promise<void>
  /** Sync now (download what is new); resolves once its batch is scheduled. */
  syncRun(id: string, deep: boolean): Promise<SyncRun>
  /** What a sync would download, without downloading. */
  syncCheck(id: string, deep: boolean): Promise<SyncCheck>
  onSync(listener: (event: {readonly view?: SubscriptionView; readonly removed?: string}) => void): () => void
  /** Bring the app's window to the front (a click on a system notification). */
  focusWindow(): Promise<void>
  /** The batches finished files came from, newest first. */
  finishedGroups(): Promise<readonly FinishedGroup[]>
  /** Re-hash files and compare with what was recorded (progress through `onVerifyProgress`). */
  verifyFinished(target: FinishedTarget): Promise<VerifySummary>
  onVerifyProgress(listener: (progress: {readonly done: number; readonly total: number}) => void): () => void
  /** Forget files from the history (the files themselves stay where they are). */
  removeFinished(keys: readonly string[]): Promise<number>
  /** Forget the records whose file is no longer where it was (deleted or moved); how many. */
  pruneFinished(target: FinishedTarget): Promise<number>
  /**
   * Download again, from the link each record kept, the files no longer where
   * they were (deleted or moved): one new batch, each into its old folder and
   * format. How many were queued (0: none of them is missing).
   */
  redownloadFinished(target: FinishedTarget): Promise<number>
  /** One new batch with these failed downloads, from however many batches; each keeps its folder. */
  retryFailed(items: readonly FailedRetry[]): Promise<BatchSnapshot>
  /** Videos found damaged at the source (never downloaded again), newest first. */
  damagedList(): Promise<readonly DamagedEntry[]>
  /** Let one be downloaded again. */
  damagedForget(key: string): Promise<void>
  /** Restart the app (a new mode applies). */
  relaunch(): Promise<void>
  /** Save the matching history as a CSV the user picks; its path, or undefined when cancelled. */
  exportFinished(target: FinishedTarget): Promise<string | undefined>
  updateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  /** Download, verify and install the available update, then restart. */
  installUpdate(): Promise<void>
  onUpdate(listener: (state: UpdateState) => void): () => void
  onEvents(listener: (bundle: EventBundle) => void): () => void
  youtubeState(): Promise<YouTubeState>
  /** Go on with YouTube as the account signed in inside the app — signing in first (a window) when needed. */
  youtubeSignIn(): Promise<{readonly ok: boolean; readonly reason?: 'closed' | 'refused' | undefined}>
  /** Forget the account; YouTube goes back to the guest session. */
  youtubeSignOut(): Promise<void>
  /** Don't sign in: held YouTube requests try again (with tokens) after a long pause. */
  youtubeWait(): Promise<void>
  onYouTube(listener: (state: YouTubeState) => void): () => void
  onSetupProgress(listener: (progress: InstallProgress) => void): () => void
}

export const CHANNEL = {
  info: 'mdc:info',
  getSettings: 'mdc:settings:get',
  setSettings: 'mdc:settings:set',
  chooseFolder: 'mdc:choose-folder',
  doctor: 'mdc:doctor',
  setup: 'mdc:setup',
  setupProgress: 'mdc:setup-progress',
  analyze: 'mdc:analyze',
  analyzeCancel: 'mdc:analyze:cancel',
  analyzeProgress: 'mdc:analyze:progress',
  schedule: 'mdc:schedule',
  state: 'mdc:state',
  items: 'mdc:items',
  cancelBatch: 'mdc:cancel-batch',
  cancelJob: 'mdc:cancel-job',
  retryJob: 'mdc:retry-job',
  retryBatch: 'mdc:retry-batch',
  pause: 'mdc:pause',
  resume: 'mdc:resume',
  clearFinished: 'mdc:clear-finished',
  searchLogs: 'mdc:search-logs',
  reveal: 'mdc:reveal',
  finished: 'mdc:finished',
  openFinished: 'mdc:open-finished',
  openFolder: 'mdc:open-folder',
  finishedGroups: 'mdc:finished-groups',
  focusWindow: 'mdc:focus-window',
  syncList: 'mdc:sync:list',
  syncFolder: 'mdc:sync:folder',
  syncAdd: 'mdc:sync:add',
  syncUpdate: 'mdc:sync:update',
  syncRemove: 'mdc:sync:remove',
  syncRun: 'mdc:sync:run',
  syncCheck: 'mdc:sync:check',
  syncEvent: 'mdc:sync:event',
  verifyFinished: 'mdc:verify-finished',
  verifyProgress: 'mdc:verify-progress',
  removeFinished: 'mdc:remove-finished',
  pruneFinished: 'mdc:prune-finished',
  redownloadFinished: 'mdc:redownload-finished',
  retryFailed: 'mdc:retry-failed',
  damagedList: 'mdc:damaged:list',
  damagedForget: 'mdc:damaged:forget',
  relaunch: 'mdc:relaunch',
  exportFinished: 'mdc:export-finished',
  updateState: 'mdc:update:state',
  updateCheck: 'mdc:update:check',
  updateInstall: 'mdc:update:install',
  update: 'mdc:update',
  events: 'mdc:events',
  youtube: 'mdc:youtube',
  youtubeState: 'mdc:youtube:state',
  youtubeSignIn: 'mdc:youtube:sign-in',
  youtubeSignOut: 'mdc:youtube:sign-out',
  youtubeWait: 'mdc:youtube:wait',
} as const
