// Building blocks for hosts that want their own orchestration.

export {assertHttpUrl} from './core/analyze.js'
export {type ArchiveEntry, archiveKey, DownloadArchive} from './core/archive.js'
export {
  BinaryError,
  BinaryManager,
  compareVersions,
  defaultJsRuntime,
  type ResolvedBinaries,
  type UpdateResult,
  ytDlpBuildFor,
} from './core/binaries.js'
export {ensureContainer} from './core/convert.js'
export {classifyYtDlpError, DownloadError, isRetryable} from './core/errors.js'
export {sanitizeFilename} from './core/files.js'
export {
  AUDIO_CONTAINERS,
  AUDIO_RULES,
  type CodecRules,
  catalogFormats,
  genericChoices,
  planChoices,
  profileArgs,
  profileKey,
  profileLabel,
  profileProblem,
  rulesFor,
  VIDEO_CONTAINERS,
  VIDEO_RULES,
} from './core/formats.js'
export {HashPool} from './core/hash-pool.js'
export {clampConcurrency, cpuCount, maxConcurrency, TaskPool} from './core/pool.js'
export {ffprobe, summarizeProbe, validateFile} from './core/validate.js'
export {type ArchiveCheck, MediaDownloader} from './downloader.js'
export type * from './types.js'
export {formatBytes, formatClock, formatRate} from './util/units.js'
