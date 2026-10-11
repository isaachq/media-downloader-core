import type {
  BatchId,
  BatchSnapshot,
  Diagnosis,
  InstallProgress,
  JobId,
  JobSnapshot,
  LogEntry,
  PreflightItem,
} from 'media-downloader-core'
import {vi} from 'vitest'
import type {
  AnalyzeProgress,
  AppInfo,
  AppSettings,
  EventBundle,
  MdcApi,
  Preview,
  ScheduleInput,
  UpdateState,
} from '../../../shared/contract'

export const INFO: AppInfo = {
  version: '0.1.0-test',
  platform: 'test-x64',
  cpus: 12,
  maxConcurrency: 6,
  dataDir: '/data',
  sessionId: 'S'.repeat(32),
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
    jobs: {total: 2, queued: 0, running: 1, succeeded: 1, failed: 0},
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
    } = {},
  ) {
    this.settings = {...SETTINGS, ...opts.settings}
    this.diagnosis = opts.diagnosis ?? READY
    this.state = vi.fn(async () => opts.state ?? {batches: [], jobs: []})
  }

  info = vi.fn(async () => INFO)
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
    batch({url: input.url, status: 'scheduled', kind: undefined, title: undefined}),
  )
  state: MdcApi['state']
  items = vi.fn(async () => this.itemsPage)
  cancelBatch = vi.fn(async () => {})
  cancelJob = vi.fn(async () => {})
  retryJob = vi.fn(async () => {})
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
}
