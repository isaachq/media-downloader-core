// The contract between the main process (engine owner), the preload bridge
// and the renderer. Types only cross the boundary — no engine code runs in
// the renderer.
import type {
  AudioContainer,
  BatchId,
  BatchSelection,
  BatchSnapshot,
  Diagnosis,
  InstallProgress,
  JobId,
  JobSnapshot,
  LogEntry,
  PlaylistEntry,
  PreflightItem,
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
export type Format = VideoContainer | AudioContainer
export type Quality = 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360'

export const VIDEO_FORMATS: readonly VideoContainer[] = ['mp4', 'webm', 'mkv']
export const AUDIO_FORMATS: readonly AudioContainer[] = ['m4a', 'mp3', 'opus', 'flac', 'wav']
export const QUALITIES: readonly Quality[] = ['best', '2160', '1440', '1080', '720', '480', '360']

export const isAudioFormat = (format: Format): format is AudioContainer =>
  (AUDIO_FORMATS as readonly string[]).includes(format)

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
}

/** Settings the engine reads at construction — changing them asks for a restart. */
export const RESTART_SETTINGS: ReadonlyArray<keyof AppSettings> = [
  'cookiesFromBrowser',
  'embedMetadata',
  'embedThumbnail',
  'longVideoMinutes',
]

export type AppInfo = {
  readonly version: string
  readonly platform: string
  readonly cpus: number
  readonly maxConcurrency: number
  readonly dataDir: string
  readonly sessionId: string
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
}

export type ScheduleInput = {
  readonly url: string
  readonly format: Format
  readonly quality: Quality
  readonly outDir: string
  /** Entries picked in the preview: downloaded as-is, the list is not fetched again. */
  readonly selection?: BatchSelection | undefined
}

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
  | {readonly kind: 'video'; readonly title: string; readonly duration?: number | undefined}
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
    }

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
  schedule(input: ScheduleInput): Promise<BatchSnapshot>
  state(): Promise<{readonly batches: readonly BatchSnapshot[]; readonly jobs: readonly JobSnapshot[]}>
  items(batchId: BatchId, offset: number, limit: number): Promise<PreflightItem[]>
  cancelBatch(batchId: BatchId): Promise<void>
  cancelJob(jobId: JobId): Promise<void>
  retryJob(jobId: JobId): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  clearFinished(): Promise<void>
  searchLogs(id: string, limit: number): Promise<{readonly entries: readonly LogEntry[]; readonly total: number}>
  reveal(path: string): Promise<void>
  updateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  /** Download, verify and install the available update, then restart. */
  installUpdate(): Promise<void>
  onUpdate(listener: (state: UpdateState) => void): () => void
  onEvents(listener: (bundle: EventBundle) => void): () => void
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
  schedule: 'mdc:schedule',
  state: 'mdc:state',
  items: 'mdc:items',
  cancelBatch: 'mdc:cancel-batch',
  cancelJob: 'mdc:cancel-job',
  retryJob: 'mdc:retry-job',
  pause: 'mdc:pause',
  resume: 'mdc:resume',
  clearFinished: 'mdc:clear-finished',
  searchLogs: 'mdc:search-logs',
  reveal: 'mdc:reveal',
  updateState: 'mdc:update:state',
  updateCheck: 'mdc:update:check',
  updateInstall: 'mdc:update:install',
  update: 'mdc:update',
  events: 'mdc:events',
} as const
