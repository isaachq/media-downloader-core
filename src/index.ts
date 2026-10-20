// Building blocks for hosts that want their own orchestration.

export {FFMPEG_REQUIREMENTS, type FfmpegCapabilities, inspectFfmpeg} from './binaries/capabilities.js'
export {type CheckState, type Diagnosis, diagnose, type SetupResult, setup, type ToolReport} from './binaries/doctor.js'
export {
  binaryPath,
  describeExecutable,
  type Executable,
  invoke as invokeExecutable,
  toExecutable,
} from './binaries/executable.js'
export type {ManagedInstall, ManagedTool} from './binaries/managed.js'
export {
  type AvailableBinaries,
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
  type YtDlpPolicy,
} from './binaries/manager.js'
export {BinaryError, ffmpegRelease, type Release, ytDlpBuildFor, ytDlpRelease} from './binaries/sources.js'
export {
  assertHttpUrl,
  isYouTubeMix,
  isYouTubeUrl,
  MAX_LISTED_ITEMS,
  MAX_REQUESTED_ITEMS,
  MIX_DEFAULT_ITEMS,
} from './core/analyze.js'
export {
  type ArchiveEntry,
  type ArchiveGroup,
  type ArchivePage,
  type ArchiveQuery,
  type ArchiveSlideshow,
  type ArchiveSort,
  archiveKey,
  archiveSlideshow,
  DownloadArchive,
} from './core/archive.js'
export {ensureContainer} from './core/convert.js'
export {
  BrowserCookies,
  type CookieRecord,
  exportBrowserCookies,
  keepDomains,
  parseNetscape,
  toNetscape,
  writeJar,
  YOUTUBE_COOKIE_DOMAINS,
} from './core/cookies.js'
export {estimateBytes, jobTier, peakBytes, TIER_WEIGHT} from './core/cost.js'
export {
  type DamagedEntry,
  type DamagedLookup,
  DamagedRegistry,
  isSourceDamage,
  SOURCE_DAMAGE,
} from './core/damaged.js'
export {
  type DetectedMediaType,
  diagnoseFailure,
  type FailureCode,
  type FailureDiagnostic,
  type FailureStage,
  mediaTypeOf,
  type Platform,
  platformOf,
} from './core/diagnostic.js'
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
export {
  clampConcurrency,
  cpuCount,
  cpuShare,
  DEFAULT_CPU_SHARE,
  MAX_CPU_SHARE,
  maxConcurrency,
  TaskPool,
} from './core/pool.js'
export {searchTrace} from './core/trace-log.js'
export {ffprobe, summarizeProbe, validateFile} from './core/validate.js'
export {type ArchiveCheck, MediaDownloader, relaxProfile, retryDelay} from './downloader.js'
export {BatchScheduler} from './scheduler.js'
export type {BrowserAssist, BrowserPage, MediaResolver, PlayerMedia} from './sources/browser.js'
export type {FacebookQueries} from './sources/facebook/endpoints.js'
export {type FacebookLink, isFacebookListing, parseFacebookLink} from './sources/facebook/links.js'
export {
  FACEBOOK_PROFILE_DEFAULT_ITEMS,
  type FacebookOptions,
  FacebookSource,
} from './sources/facebook/source.js'
export {HttpSession} from './sources/http.js'
export {codeToPk, pkToCode} from './sources/instagram/data.js'
export type {InstagramQueries} from './sources/instagram/endpoints.js'
export {type InstagramLink, isInstagramListing, parseInstagramLink} from './sources/instagram/links.js'
export {
  INSTAGRAM_PROFILE_DEFAULT_ITEMS,
  type InstagramOptions,
  InstagramSource,
} from './sources/instagram/source.js'
export {type FetchedMedia, fetchMedia, type MediaFetch} from './sources/media-fetch.js'
export {MetaClient, type MetaClientOptions} from './sources/meta/client.js'
export {MetaError, type MetaProblem} from './sources/meta/errors.js'
export type {MetaMedia, MetaPost} from './sources/meta/post.js'
export {Pacer, type PacerOptions} from './sources/pacer.js'
export {parsePlayerPageSites} from './sources/player-page/config.js'
export {
  PLAYER_PAGE_DEFAULT_ITEMS,
  type PlayerPageOptions,
  type PlayerPageSite,
  PlayerPageSource,
} from './sources/player-page/source.js'
export {type Rendition, rankRenditions, renditionChoices, type VideoCodec} from './sources/renditions.js'
export type {SessionCookies, SessionProvider, SiteSession} from './sources/session.js'
export type {ListingProgress, MediaSource, SourceDownload, SourceFile} from './sources/source.js'
export {TikTokError, type TikTokProblem} from './sources/tiktok/errors.js'
export {isTikTokProfile, parseTikTokLink, type TikTokLink} from './sources/tiktok/links.js'
export {DEFAULT_SLIDESHOW, slideshowOptions} from './sources/tiktok/slideshow.js'
export {TIKTOK_PROFILE_DEFAULT_ITEMS, type TikTokOptions, TikTokSource} from './sources/tiktok/source.js'
export {type FolderFormat, type FolderScan, folderFormat, scanFolder, syncProfile} from './sync/folder.js'
export {
  type NewSubscription,
  type SubscriptionView,
  SyncManager,
  type SyncPlan,
  type SyncState,
} from './sync/manager.js'
export {
  isDue,
  nextRunAt,
  type Subscription,
  SubscriptionStore,
  type SyncRun,
  type SyncSchedule,
  type SyncTrigger,
  syncSchedule,
} from './sync/subscriptions.js'
export type * from './types.js'
export {formatBytes, formatClock, formatRate} from './util/units.js'
export {
  AttestationError,
  type AttestationOptions,
  type AttestationStatus,
  type AttestationStrategy,
  type MintedToken,
  type MintSession,
  type PoTokenContext,
  PoTokenService,
  type StrategyStatus,
} from './youtube/attestation.js'
export {PoTokenBroker} from './youtube/broker.js'
export {type Refusal, type YouTubeAccess, YouTubeGate, type YouTubeLevel} from './youtube/gate.js'
export {installPlugin, PLUGIN_SOURCE} from './youtube/plugin.js'
