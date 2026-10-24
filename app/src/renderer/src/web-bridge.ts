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
import {
  type AnalyzeProgress,
  type AppInfo,
  type AppSettings,
  detectLink,
  type EventBundle,
  type FailedRetry,
  type FinishedEntry,
  type FinishedGroup,
  type FinishedIntegrity,
  type FinishedPage,
  type FinishedQuery,
  type FinishedTarget,
  type Format,
  type MdcApi,
  type OpenTarget,
  type Preview,
  type ScheduleInput,
  type SetupOutcome,
  SIZE_LIMITS,
  type SyncCheck,
  type SyncFolder,
  type SyncInput,
  toProfile,
  type UpdateState,
  type VerifySummary,
  type YouTubeState,
} from '../../shared/contract'

const STORAGE_KEY_SETTINGS = 'mdc_web_settings'
const STORAGE_KEY_FINISHED = 'mdc_web_finished'
const STORAGE_KEY_SYNCS = 'mdc_web_syncs'
const STORAGE_KEY_LOGS = 'mdc_web_logs'

const DEFAULT_SETTINGS: AppSettings = {
  language: 'en',
  theme: 'light',
  downloadDir: 'Downloads',
  format: 'mp4',
  quality: 'best',
  concurrency: 4,
  validation: 'full',
  cookiesFromBrowser: '',
  embedMetadata: true,
  embedThumbnail: true,
  longVideoMinutes: 30,
  notifications: true,
  portableNames: true,
  autoUpdate: true,
  slideshowMode: 'video',
  slideshowSeconds: 3,
  tourDone: true,
  syncEnabled: true,
  validateAfter: false,
  cpuBoost: true,
}

const DEFAULT_FINISHED: FinishedEntry[] = [
  {
    key: 'f-101',
    title: 'The Great Open Source Documentary (1080p).mp4',
    filepath: 'Downloads/The Great Open Source Documentary (1080p).mp4',
    sizeBytes: 842_310_000,
    duration: 3420,
    extractor: 'youtube',
    url: 'https://www.youtube.com/watch?v=mock-doc-1',
    site: 'youtube',
    completedAt: Date.now() - 3600_000 * 2,
    sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
    validation: 'full',
    file: 'ok',
    batchId: 'B-sample-1',
    batchTitle: 'Open Source Tech Talks',
  },
  {
    key: 'f-102',
    title: 'Node.js 22 Architecture & Performance Deep Dive.mp4',
    filepath: 'Downloads/Node.js 22 Architecture & Performance Deep Dive.mp4',
    sizeBytes: 254_800_000,
    duration: 1850,
    extractor: 'youtube',
    url: 'https://www.youtube.com/watch?v=mock-node-2',
    site: 'youtube',
    completedAt: Date.now() - 3600_000 * 5,
    sha256: '9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba',
    validation: 'quick',
    file: 'ok',
    batchId: 'B-sample-1',
    batchTitle: 'Open Source Tech Talks',
  },
  {
    key: 'f-103',
    title: 'Lo-Fi Chill Beats for Coding Session - Vol 4.mp3',
    filepath: 'Downloads/Lo-Fi Chill Beats for Coding Session - Vol 4.mp3',
    sizeBytes: 48_200_000,
    duration: 2100,
    extractor: 'youtube',
    url: 'https://www.youtube.com/watch?v=mock-lofi-3',
    site: 'youtube',
    completedAt: Date.now() - 3600_000 * 18,
    sha256: '55aa33bb11cc77dd99ee22ff44aa66bb88cc00dd22ee44ff66aa88bb00cc22dd',
    validation: 'full',
    file: 'ok',
    batchId: 'B-sample-2',
    batchTitle: 'Coding Soundtracks',
  },
  {
    key: 'f-104',
    title: 'Modern Web Engineering in 2026.webm',
    filepath: 'Downloads/Modern Web Engineering in 2026.webm',
    sizeBytes: 112_400_000,
    duration: 940,
    extractor: 'youtube',
    url: 'https://www.youtube.com/watch?v=mock-web-4',
    site: 'youtube',
    completedAt: Date.now() - 3600_000 * 40,
    sha256: '777888999aaabbbcccdddeeefff000111222333444555666777888999aaabbbc',
    validation: 'none',
    file: 'ok',
    batchId: 'B-sample-3',
    batchTitle: 'Web Development',
  },
]

function loadStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function saveStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage quota errors
  }
}

let counter = 1000
const nextId = (prefix: string) => `${prefix}${String(++counter).padStart(30 - prefix.length, '0')}x`

export function createWebBridge(): MdcApi {
  let settings: AppSettings = loadStorage(STORAGE_KEY_SETTINGS, DEFAULT_SETTINGS)
  let finishedEntries: FinishedEntry[] = loadStorage(STORAGE_KEY_FINISHED, DEFAULT_FINISHED)
  let syncs: SubscriptionView[] = loadStorage(STORAGE_KEY_SYNCS, [])
  let logs: LogEntry[] = loadStorage(STORAGE_KEY_LOGS, [])

  let logSaveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSaveLogs = () => {
    if (logSaveTimer) return
    logSaveTimer = setTimeout(() => {
      logSaveTimer = null
      saveStorage(STORAGE_KEY_LOGS, logs)
    }, 400)
  }

  const log = (level: LogEntry['level'], message: string, extra?: Record<string, unknown>) => {
    const entry: LogEntry = {
      sessionId: 'web-session',
      time: Date.now(),
      level,
      message,
      ...(extra as Record<string, unknown> as object),
    }
    logs.push(entry)
    if (logs.length > 500) logs = logs.slice(-400)
    scheduleSaveLogs()
    emitEvents({logs: [entry]})
  }

  const batches = new Map<BatchId, BatchSnapshot>()
  const jobs = new Map<JobId, JobSnapshot>()
  const preflightItems = new Map<BatchId, PreflightItem[]>()

  const eventListeners = new Set<(bundle: EventBundle) => void>()
  const analyzeListeners = new Set<(progress: AnalyzeProgress) => void>()
  const syncListeners = new Set<(event: {readonly view?: SubscriptionView; readonly removed?: string}) => void>()
  const verifyListeners = new Set<(progress: {readonly done: number; readonly total: number}) => void>()
  const updateListeners = new Set<(state: UpdateState) => void>()
  const youtubeListeners = new Set<(state: YouTubeState) => void>()
  const setupListeners = new Set<(progress: InstallProgress) => void>()

  let youtubeStateValue: YouTubeState = {
    level: 'open',
    pausedUntil: null,
    tokens: true,
    signedIn: false,
  }

  let updateStateValue: UpdateState = {
    status: 'up-to-date',
    checkedAt: Date.now(),
  }

  const diagnosisValue: Diagnosis = {
    ready: true,
    platform: 'web-browser',
    cpus: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 8 : 8,
    maxConcurrency: 4,
    node: '22.0.0',
    dataDir: {path: 'Downloads', state: 'ok', freeBytes: 150_000_000_000},
    tools: [
      {name: 'yt-dlp', state: 'ok', version: '2026.04.10', source: 'managed', command: 'yt-dlp', notes: []},
      {name: 'ffmpeg', state: 'ok', version: '9.0', source: 'managed', command: 'ffmpeg', notes: []},
      {name: 'ffprobe', state: 'ok', version: '9.0', source: 'managed', command: 'ffprobe', notes: []},
    ],
  }

  const emitEvents = (bundle: Partial<EventBundle>) => {
    const full: EventBundle = {
      jobs: bundle.jobs ?? [],
      batches: bundle.batches ?? [],
      items: bundle.items ?? [],
      logs: bundle.logs ?? [],
      youtubePausedUntil: bundle.youtubePausedUntil,
    }
    for (const listener of eventListeners) {
      try {
        listener(full)
      } catch (err) {
        console.error('Error in event listener', err)
      }
    }
  }

  // Active download worker simulator
  let activeTimer: ReturnType<typeof setInterval> | null = null

  const startWorkerLoop = () => {
    if (activeTimer) return
    activeTimer = setInterval(() => {
      let hasRunning = false
      const updatedJobs: JobSnapshot[] = []
      const updatedBatches: BatchSnapshot[] = []

      for (const currentJob of jobs.values()) {
        if (currentJob.status !== 'downloading') continue
        hasRunning = true

        const currentFraction = currentJob.progress?.fraction ?? 0
        const stepIndex = currentJob.steps.findIndex(s => s.state === 'in-progress')

        if (currentFraction < 1) {
          const increment = 0.05 + Math.random() * 0.08
          const newFraction = Math.min(1, currentFraction + increment)
          const speed = Math.floor(6_000_000 + Math.random() * 8_000_000)
          const remainingSec = Math.max(1, Math.round((1 - newFraction) * 20))

          const updated: JobSnapshot = {
            ...currentJob,
            progress: {fraction: newFraction, speed, eta: remainingSec},
          }
          jobs.set(currentJob.id, updated)
          updatedJobs.push(updated)
        } else if (stepIndex !== -1 && stepIndex < currentJob.steps.length - 1) {
          // Advance to next step (download -> convert -> validate -> finalize)
          const newSteps = currentJob.steps.map((step, idx) => {
            if (idx === stepIndex) return {...step, state: 'success' as const}
            if (idx === stepIndex + 1) return {...step, state: 'in-progress' as const}
            return step
          })
          const updated: JobSnapshot = {
            ...currentJob,
            steps: newSteps,
          }
          jobs.set(currentJob.id, updated)
          updatedJobs.push(updated)
          log('info', `Job "${currentJob.title}": step ${newSteps[stepIndex + 1]?.name} started`, {
            jobId: currentJob.id,
          })
        } else {
          // Job complete!
          const finishedSteps = currentJob.steps.map(s => ({...s, state: 'success' as const}))
          const completedJob: JobSnapshot = {
            ...currentJob,
            status: 'completed',
            outcome: 'success',
            progress: {fraction: 1, speed: 0, eta: 0},
            steps: finishedSteps,
          }
          jobs.set(currentJob.id, completedJob)
          updatedJobs.push(completedJob)

          // Add to finished entries
          const finishedEntry: FinishedEntry = {
            key: `f-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            title: `${completedJob.title ?? 'Download'}.${completedJob.profile.container}`,
            filepath: `Downloads/${completedJob.title ?? 'Download'}.${completedJob.profile.container}`,
            sizeBytes: Math.floor(45_000_000 + Math.random() * 120_000_000),
            duration: 180 + Math.floor(Math.random() * 600),
            extractor: 'web',
            url: completedJob.url,
            site: detectLink(completedJob.url)?.site ?? 'web',
            completedAt: Date.now(),
            sha256: Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join(''),
            validation: 'full',
            file: 'ok',
            batchId: currentJob.batchId,
          }
          finishedEntries = [finishedEntry, ...finishedEntries]
          saveStorage(STORAGE_KEY_FINISHED, finishedEntries)
          log('info', `Completed download: ${finishedEntry.title}`, {jobId: currentJob.id})

          // Update parent batch in O(J) single-pass
          if (currentJob.batchId) {
            const batch = batches.get(currentJob.batchId)
            if (batch) {
              let succeeded = 0
              let running = 0
              let queued = 0
              for (const j of jobs.values()) {
                if (j.batchId === batch.id) {
                  if (j.status === 'completed') succeeded++
                  else if (j.status === 'downloading') running++
                  else if (j.status === 'queued') queued++
                }
              }
              const allDone = running === 0 && queued === 0

              const updatedBatch: BatchSnapshot = {
                ...batch,
                status: allDone ? 'completed' : 'running',
                jobs: {
                  ...batch.jobs,
                  succeeded,
                  running,
                  queued,
                },
              }
              batches.set(batch.id, updatedBatch)
              updatedBatches.push(updatedBatch)
            }
          }
        }
      }

      if (updatedJobs.length || updatedBatches.length) {
        emitEvents({jobs: updatedJobs, batches: updatedBatches})
      }

      if (!hasRunning) {
        if (activeTimer) {
          clearInterval(activeTimer)
          activeTimer = null
        }
      }
    }, 250)
  }

  return {
    async info(): Promise<AppInfo> {
      return {
        version: '1.18.0',
        platform: 'web',
        cpus: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 8 : 8,
        maxConcurrency: 4,
        boostedConcurrency: 6,
        dataDir: settings.downloadDir,
        sessionId: `WEB-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        startedAt: Date.now(),
      }
    },

    async getSettings(): Promise<AppSettings> {
      return settings
    },

    async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
      settings = {...settings, ...patch}
      saveStorage(STORAGE_KEY_SETTINGS, settings)
      log('info', 'Settings updated', {patch})
      return settings
    },

    async chooseFolder(current?: string): Promise<string | undefined> {
      return current || 'Downloads'
    },

    async doctor(): Promise<Diagnosis> {
      return diagnosisValue
    },

    async setup(force: boolean): Promise<SetupOutcome> {
      for (const listener of setupListeners) {
        listener({tool: 'yt-dlp', stage: 'downloading', version: '2026.04.10', transfer: {received: 50, total: 100}})
      }
      log('info', `Tool setup completed (force=${force})`)
      return {
        ready: true,
        installed: ['yt-dlp 2026.04.10', 'ffmpeg 9.0', 'ffprobe 9.0'],
        diagnosis: diagnosisValue,
      }
    },

    async analyze(url: string, maxItems = 50): Promise<Preview> {
      log('info', `Analyzing link: ${url}`)
      const clean = url.trim()
      const isPlaylist = clean.includes('list=') || clean.includes('/playlist') || clean.includes('/sets/')
      const isProfile = clean.includes('/@') || clean.includes('/channel/')

      if (isPlaylist || isProfile) {
        const title = isProfile
          ? `Profile @${clean.split('/@')[1]?.split(/[?/#]/)[0] ?? 'creator'} Content`
          : 'Featured Media Playlist'
        const count = Math.min(maxItems, 8)
        const entries = Array.from({length: count}, (_, i) => ({
          id: `entry-${i + 1}`,
          index: i + 1,
          title: `${title} - Episode ${i + 1}`,
          duration: 120 + i * 45,
          url: `${clean}#item${i + 1}`,
          extractor: 'web',
          isLive: false,
        }))

        return {
          kind: 'playlist',
          title,
          uploader: 'Content Creator',
          entries,
          mix: false,
          maxItems,
          total: count,
          complete: true,
        }
      }

      // Single video
      let title = 'Downloaded Media'
      try {
        const parsed = new URL(clean)
        const vParam = parsed.searchParams.get('v')
        if (vParam) title = `Video (${vParam})`
        else {
          const segs = parsed.pathname.split('/').filter(Boolean)
          if (segs.length) title = decodeURIComponent(segs[segs.length - 1] ?? 'Video')
        }
      } catch {
        // Fallback
      }

      return {
        kind: 'video',
        title,
        duration: 240,
      }
    },

    async cancelAnalyze(): Promise<void> {
      log('info', 'Analysis cancelled')
    },

    onAnalyzeProgress(listener: (progress: AnalyzeProgress) => void): () => void {
      analyzeListeners.add(listener)
      return () => analyzeListeners.delete(listener)
    },

    async schedule(input: ScheduleInput): Promise<BatchSnapshot> {
      const batchId = nextId('B') as BatchId
      log('info', `Scheduling download: ${input.url}`, {batchId, format: input.format, quality: input.quality})

      let title = input.url
      try {
        const u = new URL(input.url)
        title = u.pathname.split('/').filter(Boolean).pop() || input.url
      } catch {
        //
      }

      const count = input.selection ? ((input.selection as unknown as {items?: unknown[]})?.items?.length ?? 1) : 1
      const batch: BatchSnapshot = {
        id: batchId,
        url: input.url,
        profile: toProfile(input),
        outDir: input.outDir || settings.downloadDir,
        status: 'running',
        kind: count > 1 ? 'playlist' : 'video',
        title: count > 1 ? `Batch: ${title}` : title,
        preflight: {total: count, checked: count, ok: count, unavailable: 0},
        jobs: {total: count, queued: 0, running: count, succeeded: 0, failed: 0, cancelled: 0},
        createdAt: Date.now(),
      }

      batches.set(batchId, batch)

      const createdJobs: JobSnapshot[] = []
      for (let i = 0; i < count; i++) {
        const jobId = nextId('J') as JobId
        const jobTitle = count > 1 ? `${title} (${i + 1}/${count})` : title
        const job: JobSnapshot = {
          id: jobId,
          batchId,
          url: input.url,
          profile: toProfile(input),
          status: 'downloading',
          outcome: 'in-progress',
          tier: 'normal',
          weight: 1,
          title: jobTitle,
          progress: {fraction: 0.05, speed: 7_500_000, eta: 18},
          steps: [
            {id: 's1', name: 'download', state: 'in-progress'},
            {id: 's2', name: 'convert', state: 'pending'},
            {id: 's3', name: 'validate', state: 'pending'},
            {id: 's4', name: 'finalize', state: 'pending'},
          ],
          attempts: [{id: 'a1', strategy: 'primary', attempt: 1, startedAt: Date.now()}],
          attempt: 1,
          maxAttempts: 3,
          createdAt: Date.now(),
        }
        jobs.set(jobId, job)
        createdJobs.push(job)
      }

      emitEvents({batches: [batch], jobs: createdJobs})
      startWorkerLoop()
      return batch
    },

    async state(): Promise<{
      readonly batches: readonly BatchSnapshot[]
      readonly jobs: readonly JobSnapshot[]
      readonly youtubePausedUntil?: number | null | undefined
      readonly youtube?: YouTubeState | undefined
    }> {
      return {
        batches: Array.from(batches.values()),
        jobs: Array.from(jobs.values()),
        youtubePausedUntil: youtubeStateValue.pausedUntil,
        youtube: youtubeStateValue,
      }
    },

    async items(batchId: BatchId, offset: number, limit: number): Promise<PreflightItem[]> {
      const items = preflightItems.get(batchId) || []
      return items.slice(offset, offset + limit)
    },

    async cancelBatch(batchId: BatchId): Promise<void> {
      const batch = batches.get(batchId)
      if (batch) {
        const updated: BatchSnapshot = {...batch, status: 'cancelled'}
        batches.set(batchId, updated)
        const updatedJobs: JobSnapshot[] = []
        for (const j of jobs.values()) {
          if (j.batchId === batchId && (j.status === 'downloading' || j.status === 'queued')) {
            const updatedJob: JobSnapshot = {...j, status: 'cancelled', outcome: 'failed'}
            jobs.set(j.id, updatedJob)
            updatedJobs.push(updatedJob)
          }
        }
        emitEvents({batches: [updated], jobs: updatedJobs})
        log('info', `Batch ${batchId} cancelled`)
      }
    },

    async cancelJob(jobId: JobId): Promise<void> {
      const job = jobs.get(jobId)
      if (job) {
        const updated: JobSnapshot = {...job, status: 'cancelled', outcome: 'failed'}
        jobs.set(jobId, updated)
        emitEvents({jobs: [updated]})
        log('info', `Job ${jobId} cancelled`)
      }
    },

    async retryJob(jobId: JobId): Promise<void> {
      const job = jobs.get(jobId)
      if (job) {
        const updated: JobSnapshot = {
          ...job,
          status: 'downloading',
          outcome: 'in-progress',
          progress: {fraction: 0.1, speed: 6_000_000, eta: 15},
        }
        jobs.set(jobId, updated)
        emitEvents({jobs: [updated]})
        startWorkerLoop()
        log('info', `Job ${jobId} retried`)
      }
    },

    async retryBatch(batchId: BatchId): Promise<number> {
      let count = 0
      const updatedJobs: JobSnapshot[] = []
      for (const j of jobs.values()) {
        if (j.batchId === batchId && (j.status === 'failed' || j.status === 'cancelled')) {
          const updated: JobSnapshot = {
            ...j,
            status: 'downloading',
            outcome: 'in-progress',
            progress: {fraction: 0.05, speed: 7_000_000, eta: 20},
          }
          jobs.set(j.id, updated)
          updatedJobs.push(updated)
          count++
        }
      }
      if (count > 0) {
        const batch = batches.get(batchId)
        if (batch) {
          const updatedBatch: BatchSnapshot = {...batch, status: 'running'}
          batches.set(batchId, updatedBatch)
          emitEvents({batches: [updatedBatch], jobs: updatedJobs})
        }
        startWorkerLoop()
      }
      return count
    },

    async pause(): Promise<void> {
      for (const j of jobs.values()) {
        if (j.status === 'downloading') {
          jobs.set(j.id, {...j, status: 'queued'})
        }
      }
      emitEvents({jobs: Array.from(jobs.values())})
      log('info', 'Downloads paused')
    },

    async resume(): Promise<void> {
      for (const j of jobs.values()) {
        if (j.status === 'queued') {
          jobs.set(j.id, {...j, status: 'downloading'})
        }
      }
      emitEvents({jobs: Array.from(jobs.values())})
      startWorkerLoop()
      log('info', 'Downloads resumed')
    },

    async clearFinished(): Promise<void> {
      for (const [id, batch] of batches.entries()) {
        if (batch.status === 'completed' || batch.status === 'cancelled' || batch.status === 'failed') {
          batches.delete(id)
        }
      }
      emitEvents({batches: Array.from(batches.values())})
    },

    async searchLogs(
      id: string,
      limit: number,
    ): Promise<{readonly entries: readonly LogEntry[]; readonly total: number}> {
      const q = id.toLowerCase()
      const matched = logs.filter(
        l =>
          l.message.toLowerCase().includes(q) ||
          String((l as unknown as Record<string, unknown>)['jobId'] ?? '')
            .toLowerCase()
            .includes(q) ||
          String((l as unknown as Record<string, unknown>)['batchId'] ?? '')
            .toLowerCase()
            .includes(q),
      )
      return {
        entries: matched.slice(-limit),
        total: matched.length,
      }
    },

    async reveal(path: string): Promise<void> {
      log('info', `Reveal path: ${path}`)
    },

    async finished(query: FinishedQuery): Promise<FinishedPage> {
      const words = (query.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const integrity = (entry: FinishedEntry): FinishedIntegrity =>
        entry.damaged
          ? 'damaged'
          : entry.file !== 'ok'
            ? entry.file
            : entry.validation === 'quick' || entry.validation === 'full'
              ? 'verified'
              : entry.validation === 'none' || !entry.sha256
                ? 'unverified'
                : 'checksum'

      const matching = finishedEntries.filter(
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
    },

    async openFinished(key: string, target: 'file' | 'folder'): Promise<boolean> {
      log('info', `Open finished entry ${key} (${target})`)
      return true
    },

    async openFolder(_target: OpenTarget): Promise<boolean> {
      log('info', 'Open folder requested')
      return true
    },

    async syncList(): Promise<readonly SubscriptionView[]> {
      return syncs
    },

    async syncAdd(input: SyncInput): Promise<SubscriptionView> {
      const user = /@([\w.-]+)/.exec(input.url)?.[1] ?? 'creator'
      const view: SubscriptionView = {
        id: nextId('S'),
        site: 'tiktok',
        user,
        url: `https://www.tiktok.com/@${user}`,
        folder: input.folder || settings.downloadDir,
        profile: toProfile({format: input.format ?? 'mp4', quality: 'best'}),
        schedule: input.schedule,
        createdAt: Date.now(),
        runs: [],
        state: 'idle',
      }
      syncs = [...syncs, view]
      saveStorage(STORAGE_KEY_SYNCS, syncs)
      for (const listener of syncListeners) listener({view})
      log('info', `Added sync subscription for @${user}`)
      return view
    },

    async syncFolder(_folder: string): Promise<SyncFolder> {
      return {files: 0, formats: []}
    },

    async syncUpdate(id: string, patch: {readonly schedule?: SyncSchedule}): Promise<SubscriptionView> {
      const found = syncs.find(s => s.id === id)
      if (!found) throw new Error('Subscription not found')
      const updated: SubscriptionView = {...found, ...(patch.schedule && {schedule: patch.schedule})}
      syncs = syncs.map(s => (s.id === id ? updated : s))
      saveStorage(STORAGE_KEY_SYNCS, syncs)
      for (const listener of syncListeners) listener({view: updated})
      return updated
    },

    async syncRemove(id: string): Promise<void> {
      syncs = syncs.filter(s => s.id !== id)
      saveStorage(STORAGE_KEY_SYNCS, syncs)
      for (const listener of syncListeners) listener({removed: id})
    },

    async syncRun(id: string, deep: boolean): Promise<SyncRun> {
      log('info', `Running sync for ${id} (deep=${deep})`)
      return {
        id: `R-${Date.now()}`,
        trigger: 'manual',
        deep,
        status: 'running',
        startedAt: Date.now(),
        listed: 12,
        inFolder: 10,
        new: 2,
        downloaded: 0,
        failed: 0,
        batchId: `B-sync-${id}`,
      }
    },

    async syncCheck(_id: string, _deep: boolean): Promise<SyncCheck> {
      return {listed: 24, total: 120, inFolder: 115, new: 5, sample: [], gone: 0, caughtUp: true}
    },

    onSync(listener: (event: {readonly view?: SubscriptionView; readonly removed?: string}) => void): () => void {
      syncListeners.add(listener)
      return () => syncListeners.delete(listener)
    },

    async focusWindow(): Promise<void> {
      // Focus in browser
    },

    async finishedGroups(): Promise<readonly FinishedGroup[]> {
      const groups = new Map<string, FinishedGroup>()
      for (const entry of finishedEntries) {
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
    },

    async verifyFinished(_target: FinishedTarget): Promise<VerifySummary> {
      const total = finishedEntries.length
      for (let i = 1; i <= total; i++) {
        for (const listener of verifyListeners) listener({done: i, total})
      }
      log('info', `Verified ${total} finished media files against stored SHA-256 hashes`)
      return {
        checked: total,
        ok: total,
        missing: 0,
        changed: 0,
        corrupted: 0,
      }
    },

    onVerifyProgress(listener: (progress: {readonly done: number; readonly total: number}) => void): () => void {
      verifyListeners.add(listener)
      return () => verifyListeners.delete(listener)
    },

    async removeFinished(keys: readonly string[]): Promise<number> {
      const before = finishedEntries.length
      const keySet = new Set(keys)
      finishedEntries = finishedEntries.filter(e => !keySet.has(e.key))
      saveStorage(STORAGE_KEY_FINISHED, finishedEntries)
      return before - finishedEntries.length
    },

    async pruneFinished(_target: FinishedTarget): Promise<number> {
      const before = finishedEntries.length
      finishedEntries = finishedEntries.filter(e => e.file !== 'missing')
      saveStorage(STORAGE_KEY_FINISHED, finishedEntries)
      return before - finishedEntries.length
    },

    async redownloadFinished(target: FinishedTarget): Promise<number> {
      const keys = 'keys' in target ? new Set(target.keys) : undefined
      const gone = finishedEntries.filter(e => e.file === 'missing' && (!keys || keys.has(e.key)))
      if (gone.length === 0) return 0
      await this.schedule({
        url: gone[0]!.url,
        format: 'mp4',
        quality: 'best',
        outDir: settings.downloadDir,
      })
      return gone.length
    },

    async retryFailed(items: readonly FailedRetry[]): Promise<BatchSnapshot> {
      return this.schedule({
        url: items[0]?.url ?? 'https://example.com/retry',
        format: (items[0]?.profile.container as Format) ?? 'mp4',
        quality: 'best',
        outDir: settings.downloadDir,
      })
    },

    async damagedList(): Promise<readonly DamagedEntry[]> {
      return []
    },

    async damagedForget(_key: string): Promise<void> {
      //
    },

    async relaunch(): Promise<void> {
      if (typeof window !== 'undefined') {
        window.location.reload()
      }
    },

    async exportFinished(_target: FinishedTarget): Promise<string | undefined> {
      const lines = ['Key,Title,FilePath,SizeBytes,DurationSeconds,Extractor,URL,CompletedAt,SHA256,Validation']
      for (const e of finishedEntries) {
        lines.push(
          `"${e.key}","${e.title.replace(/"/g, '""')}","${e.filepath.replace(/"/g, '""')}",${e.sizeBytes},${e.duration ?? 0},"${e.extractor}","${e.url}",${e.completedAt},"${e.sha256 ?? ''}","${e.validation ?? ''}"`,
        )
      }
      const csv = lines.join('\n')
      if (typeof window !== 'undefined') {
        const blob = new Blob([csv], {type: 'text/csv;charset=utf-8;'})
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `media-download-core-finished-${Date.now()}.csv`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }
      return 'downloads/finished.csv'
    },

    async updateState(): Promise<UpdateState> {
      return updateStateValue
    },

    async checkForUpdates(): Promise<UpdateState> {
      updateStateValue = {status: 'up-to-date', checkedAt: Date.now()}
      for (const listener of updateListeners) listener(updateStateValue)
      return updateStateValue
    },

    async installUpdate(): Promise<void> {
      log('info', 'Install update called')
    },

    onUpdate(listener: (state: UpdateState) => void): () => void {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },

    onEvents(listener: (bundle: EventBundle) => void): () => void {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },

    async youtubeState(): Promise<YouTubeState> {
      return youtubeStateValue
    },

    async youtubeSignIn(): Promise<{readonly ok: boolean; readonly reason?: 'closed' | 'refused' | undefined}> {
      youtubeStateValue = {...youtubeStateValue, signedIn: true, level: 'account', pausedUntil: null}
      for (const listener of youtubeListeners) listener(youtubeStateValue)
      log('info', 'YouTube account signed in')
      return {ok: true}
    },

    async youtubeSignOut(): Promise<void> {
      youtubeStateValue = {...youtubeStateValue, signedIn: false, level: 'attested'}
      for (const listener of youtubeListeners) listener(youtubeStateValue)
      log('info', 'YouTube signed out')
    },

    async youtubeWait(): Promise<void> {
      youtubeStateValue = {...youtubeStateValue, pausedUntil: Date.now() + 15 * 60_000}
      for (const listener of youtubeListeners) listener(youtubeStateValue)
    },

    onYouTube(listener: (state: YouTubeState) => void): () => void {
      youtubeListeners.add(listener)
      return () => youtubeListeners.delete(listener)
    },

    onSetupProgress(listener: (progress: InstallProgress) => void): () => void {
      setupListeners.add(listener)
      return () => setupListeners.delete(listener)
    },
  }
}
