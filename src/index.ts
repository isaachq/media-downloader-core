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
  isYouTubeListing,
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
export {isListingLink, skipReasonOf} from './core/mix.js'
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
export {
  ANALYZE_ATTEMPTS,
  ANALYZE_PATIENCE_MS,
  type ArchiveCheck,
  MediaDownloader,
  relaxProfile,
  retryDelay,
} from './downloader.js'
export {BatchScheduler} from './scheduler.js'
export type {BlueskyEndpoints} from './sources/bluesky/endpoints.js'
export {type BlueskyLink, isBlueskyListing, parseBlueskyLink} from './sources/bluesky/links.js'
export {BLUESKY_PROFILE_DEFAULT_ITEMS, type BlueskyOptions, BlueskySource} from './sources/bluesky/source.js'
export type {BrowserAssist, BrowserPage, MediaResolver, PlayerMedia} from './sources/browser.js'
export {type DetectedLink, detectLink, LINK_SITES, type LinkSite} from './sources/detect.js'
export {DIRECT_NAME, DirectFileSource, type DirectOptions, directFile} from './sources/direct/source.js'
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
export {
  type InstagramLink,
  isInstagramListing,
  parseInstagramLink,
  unwrapInstagramRedirect,
} from './sources/instagram/links.js'
export {
  INSTAGRAM_PROFILE_DEFAULT_ITEMS,
  type InstagramOptions,
  InstagramSource,
} from './sources/instagram/source.js'
export {type FetchedMedia, fetchMedia, type MediaFetch} from './sources/media-fetch.js'
export {MetaClient, type MetaClientOptions} from './sources/meta/client.js'
export {MetaError, type MetaProblem} from './sources/meta/errors.js'
export type {MetaMedia, MetaPost} from './sources/meta/post.js'
export {
  linkKey,
  MIX_MAX_LINKS,
  type MixLink,
  type MixPlan,
  type MixPlanOptions,
  type MixPlanSkip,
  type MixPlanSkipped,
  planMix,
} from './sources/mix-plan.js'
export {COOLING_DOWN, Pacer, type PacerOptions, withPatience} from './sources/pacer.js'
export {parsePlayerPageSites} from './sources/player-page/config.js'
export {
  PLAYER_PAGE_DEFAULT_ITEMS,
  type PlayerPageOptions,
  type PlayerPageSite,
  PlayerPageSource,
} from './sources/player-page/source.js'
export {type Rendition, rankRenditions, renditionChoices, type VideoCodec} from './sources/renditions.js'
export type {SessionCookies, SessionProvider, SiteSession} from './sources/session.js'
export type {SnapchatEndpoints} from './sources/snapchat/endpoints.js'
export {isSnapchatListing, parseSnapchatLink, type SnapchatLink} from './sources/snapchat/links.js'
export {SNAPCHAT_LIST_DEFAULT_ITEMS, type SnapchatOptions, SnapchatSource} from './sources/snapchat/source.js'
export type {ListingProgress, MediaSource, RecordingSummary, SourceDownload, SourceFile} from './sources/source.js'
export type {ThreadsQueries} from './sources/threads/endpoints.js'
export {isThreadsListing, parseThreadsLink, type ThreadsLink} from './sources/threads/links.js'
export {THREADS_PROFILE_DEFAULT_ITEMS, type ThreadsOptions, ThreadsSource} from './sources/threads/source.js'
export {TikTokError, type TikTokProblem} from './sources/tiktok/errors.js'
export {isTikTokProfile, parseTikTokLink, type TikTokLink} from './sources/tiktok/links.js'
export {DEFAULT_SLIDESHOW, slideshowOptions} from './sources/tiktok/slideshow.js'
export {TIKTOK_PROFILE_DEFAULT_ITEMS, type TikTokOptions, TikTokSource} from './sources/tiktok/source.js'
export {readLiveStream, type TwitchLiveStream} from './sources/twitch/data.js'
export {
  ALT_CLIENT_ID as TWITCH_ALT_CLIENT_ID,
  type TwitchEndpoints,
  WEB_CLIENT_ID as TWITCH_WEB_CLIENT_ID,
} from './sources/twitch/endpoints.js'
export {isTwitchListing, parseTwitchLink, type TwitchLink} from './sources/twitch/links.js'
export {TWITCH_LIST_DEFAULT_ITEMS, type TwitchOptions, TwitchSource} from './sources/twitch/source.js'
export {VkError, type VkProblem} from './sources/vk/data.js'
export {isVkListing, parseVkLink, type VkLink} from './sources/vk/links.js'
export {VK_LIST_DEFAULT_ITEMS, type VkOptions, VkSource} from './sources/vk/source.js'
export {readTweetResult, syndicationToken, type XPost, type XVideo} from './sources/x/data.js'
export {isXProfile, parseXLink, type XLink} from './sources/x/links.js'
export {type XOptions, XSource} from './sources/x/source.js'
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
