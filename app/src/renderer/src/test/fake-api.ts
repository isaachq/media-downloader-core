import type {
  BatchId,
  BatchSnapshot,
  DamagedEntry,
  Diagnosis,
  InstallProgress,
  JobId,
  JobSnapshot,
  LogEntry,
  PreflightItem,
  SubscriptionView,
  SyncRun,
  SyncSchedule,
} from 'media-downloader-core'
import {vi} from 'vitest'
import {
  type AnalyzeProgress,
  type AppInfo,
  type AppSettings,
  type EventBundle,
  type FailedRetry,
  type FinishedEntry,
  type FinishedGroup,
  type FinishedPage,
  type FinishedQuery,
  type FinishedTarget,
  type MdcApi,
  type OpenTarget,
  type Preview,
  type ScheduleInput,
  SIZE_LIMITS,
  type SyncCheck,
  type SyncFolder,
  type SyncInput,
  toProfile,
  type UpdateState,
  type VerifySummary,
  type YouTubeState,
} from '../../../shared/contract'

export const INFO: AppInfo = {
  version: '0.1.0-test',
  platform: 'test-x64',
  cpus: 12,
  maxConcurrency: 6,
  boostedConcurrency: 7,
  mode: 'web',
  dataDir: '/data',
  sessionId: 'S'.repeat(32),
  startedAt: Date.UTC(2026, 9, 11, 15, 0),
}

export const SETTINGS: AppSettings = {
  language: 'en',
  theme: 'light',
  downloadDir: '/Users/me/Downloads',
  format: 'mp4',
  quality: 'best',
  concurrency: 6,
  validation: 'full',
  cookiesFromBrowser: '',
  embedMetadata: true,
  embedThumbnail: false,
  longVideoMinutes: 30,
  notifications: true,
  portableNames: true,
  autoUpdate: true,
  slideshowMode: 'video',
  slideshowSeconds: 3,
  // tests start past the first-steps guide (its own tests turn it back on)
  tourDone: true,
  syncEnabled: false,
  mode: 'web',
  validateAfter: false,
  cpuBoost: false,
}

export const READY: Diagnosis = {
  ready: true,
  platform: 'test-x64',
  cpus: 12,
  maxConcurrency: 6,
  node: '22.0.0',
  dataDir: {path: '/data', state: 'ok', freeBytes: 500e9},
  tools: [
    {name: 'yt-dlp', state: 'ok', version: '2099.01.01', source: 'managed', command: 'yt-dlp', notes: []},
    {name: 'ffmpeg', state: 'ok', version: '9.0', source: 'managed', command: 'ffmpeg', notes: []},
    {name: 'ffprobe', state: 'ok', version: '9.0', source: 'managed', command: 'ffprobe', notes: []},
  ],
}

export const NOT_READY: Diagnosis = {
  ...READY,
  ready: false,
  tools: [{name: 'yt-dlp', state: 'fail', notes: ['Not installed']}, ...READY.tools.slice(1)],
}

let counter = 0
const id = (prefix: string) => `${prefix}${String(++counter).padStart(31 - prefix.length, '0')}x`

export function batch(patch: Partial<BatchSnapshot> = {}): BatchSnapshot {
  return {
    id: id('B') as BatchId,
    url: 'https://example.com/list',
    profile: {kind: 'video', container: 'mp4'},
    outDir: '/Users/me/Downloads',
    status: 'running',
    kind: 'playlist',
    title: 'My playlist',
    preflight: {total: 3, checked: 3, ok: 2, unavailable: 1},
    jobs: {total: 2, queued: 0, running: 1, succeeded: 1, failed: 0, cancelled: 0},
    createdAt: Date.now(),
    ...patch,
  }
}

export function job(patch: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: id('J') as JobId,
    url: 'https://example.com/v',
    profile: {kind: 'video', container: 'mp4'},
    status: 'downloading',
    outcome: 'in-progress',
    tier: 'normal',
    weight: 1,
    title: 'A video',
    progress: {fraction: 0.42, speed: 2_500_000, eta: 15},
    steps: [
      {id: 's1', name: 'download', state: 'in-progress'},
      {id: 's2', name: 'convert', state: 'pending'},
      {id: 's3', name: 'validate', state: 'pending'},
      {id: 's4', name: 'finalize', state: 'pending'},
    ],
    attempts: [{id: 'a1', strategy: 'primary', attempt: 1, startedAt: 0}],
    attempt: 1,
    maxAttempts: 4,
    createdAt: Date.now(),
    ...patch,
  }
}

/** In-memory MdcApi: every call is a spy; tests push events with `emit`. */
export class FakeApi implements MdcApi {
  settings: AppSettings
  diagnosis: Diagnosis
  #events = new Set<(bundle: EventBundle) => void>()
  #setup = new Set<(progress: InstallProgress) => void>()
  itemsPage: PreflightItem[] = []

  constructor(
    opts: {
      settings?: Partial<AppSettings>
      diagnosis?: Diagnosis
      state?: {batches: BatchSnapshot[]; jobs: JobSnapshot[]}
      /** This run's info (e.g. another mode than the web one). */
      info?: Partial<AppInfo>
    } = {},
  ) {
    this.settings = {...SETTINGS, ...(opts.info?.mode && {mode: opts.info.mode}), ...opts.settings}
    this.appInfo = {...INFO, ...opts.info}
    this.diagnosis = opts.diagnosis ?? READY
    this.state = vi.fn(async () => opts.state ?? {batches: [], jobs: []})
  }

  appInfo: AppInfo
  info = vi.fn(async () => this.appInfo)
  getSettings = vi.fn(async () => this.settings)
  setSettings = vi.fn(async (patch: Partial<AppSettings>) => {
    this.settings = {...this.settings, ...patch}
    return this.settings
  })
  chooseFolder = vi.fn(async () => '/Volumes/Backup/Videos')
  doctor = vi.fn(async () => this.diagnosis)
  setup = vi.fn(async () => {
    for (const listener of this.#setup)
      listener({tool: 'ffmpeg', stage: 'downloading', version: '9.0', transfer: {received: 50, total: 100}})
    this.diagnosis = READY
    return {ready: true, installed: ['yt-dlp 2099.01.01', 'ffmpeg 9.0'], diagnosis: READY}
  })
  /** What `analyze` answers; a single video by default (scheduled without a preview). */
  preview: Preview = {kind: 'video', title: 'A video', duration: 60}
  analyze = vi.fn(async (_url: string, _maxItems?: number): Promise<Preview> => this.preview)
  cancelAnalyze = vi.fn(async () => {})
  #analyzeListeners = new Set<(progress: AnalyzeProgress) => void>()

  onAnalyzeProgress(listener: (progress: AnalyzeProgress) => void): () => void {
    this.#analyzeListeners.add(listener)
    return () => this.#analyzeListeners.delete(listener)
  }

  pushAnalyzeProgress(progress: AnalyzeProgress): void {
    for (const listener of this.#analyzeListeners) listener(progress)
  }
  schedule = vi.fn(async (input: ScheduleInput) =>
    batch({url: input.url, status: 'scheduled', profile: toProfile(input), kind: undefined, title: undefined}),
  )
  state: MdcApi['state']
  items = vi.fn(async () => this.itemsPage)
  cancelBatch = vi.fn(async () => {})
  cancelJob = vi.fn(async () => {})
  retryJob = vi.fn(async () => {})
  retryBatch = vi.fn(async (_batchId: BatchId) => 1)
  pause = vi.fn(async () => {})
  resume = vi.fn(async () => {})
  clearFinished = vi.fn(async () => {})
  searchLogs = vi.fn(
    async (_id: string, _limit: number): Promise<{entries: readonly LogEntry[]; total: number}> => ({
      entries: [],
      total: 0,
    }),
  )
  reveal = vi.fn(async () => {})
  /** The archive `finished` pages through, newest first. */
  finishedEntries: FinishedEntry[] = []
  finished = vi.fn(async (query: FinishedQuery): Promise<FinishedPage> => {
    const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const integrity = (entry: FinishedEntry) =>
      entry.damaged
        ? 'damaged'
        : entry.file !== 'ok'
          ? entry.file
          : entry.validation === 'quick' || entry.validation === 'full'
            ? 'verified'
            : entry.validation === 'none' || !entry.sha256
              ? 'unverified'
              : 'checksum'
    const matching = this.finishedEntries.filter(
      entry =>
        (query.batchId === undefined || entry.batchId === query.batchId) &&
        words.every(word => entry.title.toLowerCase().includes(word)) &&
        (!query.integrity?.length || query.integrity.includes(integrity(entry))) &&
        (!query.size?.length ||
          query.size.some(
            range => entry.sizeBytes >= SIZE_LIMITS[range][0] && entry.sizeBytes < SIZE_LIMITS[range][1],
          )),
    )
    if (query.sort === 'largest') matching.sort((a, b) => b.sizeBytes - a.sizeBytes)
    else if (query.sort === 'smallest') matching.sort((a, b) => a.sizeBytes - b.sizeBytes)
    else if (query.sort === 'oldest') matching.reverse()
    return {
      entries: matching.slice(query.offset, query.offset + query.limit),
      total: matching.length,
      bytes: matching.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    }
  })
  openFinished = vi.fn(
    async (key: string, _target: 'file' | 'folder') =>
      this.finishedEntries.find(entry => entry.key === key)?.file === 'ok',
  )
  openFolder = vi.fn(async (_target: OpenTarget) => true)
  focusWindow = vi.fn(async () => {})
  /** Synced accounts, as the main process keeps them. */
  syncs: SubscriptionView[] = []
  #syncListeners = new Set<(event: {view?: SubscriptionView; removed?: string}) => void>()
  /** What `syncCheck` answers. */
  syncCheckResult: SyncCheck = {listed: 20, total: 860, inFolder: 835, new: 3, sample: [], gone: 0, caughtUp: true}
  syncList = vi.fn(async () => this.syncs)
  syncAdd = vi.fn(async (input: SyncInput): Promise<SubscriptionView> => {
    const user = /@([\w.-]+)/.exec(input.url)?.[1] ?? 'someone'
    const view: SubscriptionView = {
      id: `S${this.syncs.length + 1}`.padEnd(32, '0'),
      site: 'tiktok',
      user,
      url: `https://www.tiktok.com/@${user}`,
      folder: input.folder,
      profile: toProfile({format: input.format ?? this.syncFolderResult.format ?? 'mp4', quality: 'best'}),
      schedule: input.schedule,
      createdAt: Date.now(),
      runs: [],
      state: 'idle',
    }
    this.syncs = [...this.syncs, view]
    this.pushSync({view})
    return view
  })
  /** What `syncFolder` answers: an empty folder unless a test says otherwise. */
  syncFolderResult: SyncFolder = {files: 0, formats: []}
  syncFolder = vi.fn(async (_folder: string) => this.syncFolderResult)
  syncUpdate = vi.fn(async (id: string, patch: {schedule?: SyncSchedule}) => {
    const view = {...this.syncs.find(item => item.id === id)!, ...(patch.schedule && {schedule: patch.schedule})}
    this.syncs = this.syncs.map(item => (item.id === id ? view : item))
    this.pushSync({view})
    return view
  })
  syncRemove = vi.fn(async (id: string) => {
    this.syncs = this.syncs.filter(item => item.id !== id)
    this.pushSync({removed: id})
  })
  syncRun = vi.fn(
    async (id: string, deep: boolean): Promise<SyncRun> => ({
      id: 'R1',
      trigger: 'manual',
      deep,
      status: 'running',
      startedAt: Date.now(),
      listed: 20,
      inFolder: 835,
      new: 3,
      downloaded: 0,
      failed: 0,
      batchId: `B-sync-${id}`,
    }),
  )
  syncCheck = vi.fn(async (_id: string, _deep: boolean) => this.syncCheckResult)
  onSync(listener: (event: {view?: SubscriptionView; removed?: string}) => void): () => void {
    this.#syncListeners.add(listener)
    return () => this.#syncListeners.delete(listener)
  }
  pushSync(event: {view?: SubscriptionView; removed?: string}): void {
    for (const listener of this.#syncListeners) listener(event)
  }
  finishedGroups = vi.fn(async (): Promise<FinishedGroup[]> => {
    const groups = new Map<string, FinishedGroup>()
    for (const entry of this.finishedEntries) {
      if (!entry.batchId) continue
      const group = groups.get(entry.batchId)
      groups.set(entry.batchId, {
        batchId: entry.batchId,
        title: entry.batchTitle,
        count: (group?.count ?? 0) + 1,
        bytes: (group?.bytes ?? 0) + entry.sizeBytes,
        lastCompletedAt: Math.max(group?.lastCompletedAt ?? 0, entry.completedAt),
      })
    }
    return [...groups.values()]
  })
  /** What `verifyFinished` answers. */
  verifySummary: VerifySummary = {checked: 0, ok: 0, missing: 0, changed: 0, corrupted: 0}
  #verifyListeners = new Set<(progress: {done: number; total: number}) => void>()
  verifyFinished = vi.fn(async (_target: FinishedTarget) => {
    for (const listener of this.#verifyListeners) listener({done: 1, total: 2})
    return this.verifySummary
  })
  onVerifyProgress(listener: (progress: {done: number; total: number}) => void): () => void {
    this.#verifyListeners.add(listener)
    return () => this.#verifyListeners.delete(listener)
  }
  removeFinished = vi.fn(async (keys: readonly string[]) => {
    this.finishedEntries = this.finishedEntries.filter(entry => !keys.includes(entry.key))
    return keys.length
  })
  pruneFinished = vi.fn(async (_target: FinishedTarget) => {
    const before = this.finishedEntries.length
    this.finishedEntries = this.finishedEntries.filter(entry => entry.file !== 'missing')
    return before - this.finishedEntries.length
  })
  retryFailed = vi.fn(async (items: readonly FailedRetry[]) =>
    batch({url: items[0]!.url, status: 'scheduled', kind: undefined, title: `Failed, retried (${items.length})`}),
  )
  damaged: DamagedEntry[] = []
  damagedList = vi.fn(async () => this.damaged)
  damagedForget = vi.fn(async (key: string) => {
    this.damaged = this.damaged.filter(entry => entry.key !== key)
  })
  relaunch = vi.fn(async () => {})
  exportFinished = vi.fn(
    async (_target: FinishedTarget): Promise<string | undefined> => '/Users/me/Downloads/finished.csv',
  )
  update: UpdateState = {status: 'up-to-date', checkedAt: 0}
  #updates = new Set<(state: UpdateState) => void>()
  updateState = vi.fn(async () => this.update)
  checkForUpdates = vi.fn(async () => this.update)
  installUpdate = vi.fn(async () => {})

  onUpdate(listener: (state: UpdateState) => void): () => void {
    this.#updates.add(listener)
    return () => this.#updates.delete(listener)
  }

  pushUpdate(state: UpdateState): void {
    this.update = state
    for (const listener of this.#updates) listener(state)
  }

  onEvents(listener: (bundle: EventBundle) => void): () => void {
    this.#events.add(listener)
    return () => this.#events.delete(listener)
  }

  onSetupProgress(listener: (progress: InstallProgress) => void): () => void {
    this.#setup.add(listener)
    return () => this.#setup.delete(listener)
  }

  emit(bundle: Partial<EventBundle>): void {
    const full: EventBundle = {jobs: [], batches: [], items: [], logs: [], ...bundle}
    for (const listener of this.#events) listener(full)
  }

  /** YouTube as the app reports it; `pushYouTube` changes it like the app would. */
  youtube: YouTubeState = {level: 'open', pausedUntil: null, tokens: false, signedIn: false}
  /** What signing in answers. */
  signInResult: {ok: boolean; reason?: 'closed' | 'refused'} = {ok: true}
  #youtube = new Set<(state: YouTubeState) => void>()
  youtubeState = vi.fn(async () => this.youtube)
  youtubeSignIn = vi.fn(async () => {
    if (this.signInResult.ok) this.pushYouTube({level: 'account', pausedUntil: null, signedIn: true})
    return this.signInResult
  })
  youtubeSignOut = vi.fn(async () => this.pushYouTube({level: 'attested', signedIn: false}))
  youtubeWait = vi.fn(async () => this.pushYouTube({level: 'attested', pausedUntil: Date.now() + 30 * 60_000}))

  onYouTube(listener: (state: YouTubeState) => void): () => void {
    this.#youtube.add(listener)
    return () => this.#youtube.delete(listener)
  }

  pushYouTube(patch: Partial<YouTubeState>): void {
    this.youtube = {...this.youtube, ...patch}
    for (const listener of this.#youtube) listener(this.youtube)
  }
}
