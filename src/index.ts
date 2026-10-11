// Building blocks for hosts that want their own orchestration.

export {FFMPEG_REQUIREMENTS, type FfmpegCapabilities, inspectFfmpeg} from './binaries/capabilities.js'
export {type CheckState, type Diagnosis, diagnose, type SetupResult, setup, type ToolReport} from './binaries/doctor.js'
export {binaryPath, describeExecutable, type Executable, toExecutable} from './binaries/executable.js'
export type {ManagedInstall, ManagedTool} from './binaries/managed.js'
export {
  BinaryManager,
  compareVersions,
  defaultJsRuntime,
  type InstallOptions,
  type InstallProgress,
  type InstallStage,
  type ResolvedBinaries,
  type ResolvedTool,
  type ToolName,
  type ToolSource,
  type UpdateResult,
} from './binaries/manager.js'
export {BinaryError, ffmpegRelease, type Release, ytDlpBuildFor, ytDlpRelease} from './binaries/sources.js'
export {assertHttpUrl, isYouTubeMix, MAX_LISTED_ITEMS, MIX_DEFAULT_ITEMS} from './core/analyze.js'
export {type ArchiveEntry, archiveKey, DownloadArchive} from './core/archive.js'
export {ensureContainer} from './core/convert.js'
export {estimateBytes, jobTier, peakBytes, TIER_WEIGHT} from './core/cost.js'
export {classifyYtDlpError, DownloadError, isRetryable} from './core/errors.js'
export {type WorkEstimate, WorkMeter} from './core/eta.js'
export {
  type FileNameStyle,
  folderName,
  mediaFileStem,
  portableName,
  removeRetrying,
  renameRetrying,
  sanitizeFilename,
} from './core/files.js'
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
export {searchTrace} from './core/trace-log.js'
export {ffprobe, summarizeProbe, validateFile} from './core/validate.js'
export {type ArchiveCheck, MediaDownloader, relaxProfile, retryDelay} from './downloader.js'
export {BatchScheduler} from './scheduler.js'
export {HttpSession} from './sources/http.js'
export {Pacer, type PacerOptions} from './sources/pacer.js'
export type {MediaSource, SourceDownload, SourceFile} from './sources/source.js'
export {TikTokError, type TikTokProblem} from './sources/tiktok/errors.js'
export {isTikTokProfile, parseTikTokLink, type TikTokLink} from './sources/tiktok/links.js'
export {TIKTOK_PROFILE_DEFAULT_ITEMS, type TikTokOptions, TikTokSource} from './sources/tiktok/source.js'
export type * from './types.js'
export {formatBytes, formatClock, formatRate} from './util/units.js'
