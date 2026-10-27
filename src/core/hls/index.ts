// Internal to the core (decision 11): the Sources import from here; nothing is exported from the package.
//
// What a live recorder can reuse on its own: `parsePlaylist` / `fetchPlaylist` (sliding windows parse
// fully: media and discontinuity sequences, program date-time, date ranges), `fetchSegment` +
// `verifySegment` (one segment to a checked file), `KeyCache` + `fetchKey` + `ivFor` (AES-128),
// `TrackAppender` + `StateWriter` (in-order append per period, keyed by media sequence, with a resume
// cursor) and `assembleHls` (the one ffmpeg -c copy). `downloadHls` is the VOD loop over them and
// refuses open-ended playlists as `live-now`; `recordHls` is the live loop over the same pieces (a sliding
// window re-read every target duration, Stop keeps and finalizes, cancel discards). Twitch only reaches it.
export {type AppenderOptions, type AppendSegment, StaleResumeError, TrackAppender} from './appender.js'
export {type AssembleOptions, type AssembleTrack, assembleHls, containerFor, type HlsContainer} from './assemble.js'
export {
  downloadHls,
  type HlsDownloadOptions,
  type HlsEvent,
  type HlsResult,
  type HlsTrackInput,
  type RefreshPlaylist,
  refreshBudget,
  samePlaylist,
  segmentConcurrency,
} from './download.js'
export {HlsError, type HlsFailure, isHlsError} from './errors.js'
export {
  asMaster,
  asMedia,
  type ByteRange,
  fetchPlaylist,
  type HlsAudioTrack,
  type HlsDateRange,
  type HlsInit,
  type HlsKey,
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  type HlsPlaylist,
  type HlsSegment,
  type HlsSegmentFormat,
  type HlsVariant,
  isOpenEnded,
  type ParseOptions,
  parseAttributes,
  parsePlaylist,
  pathOf,
} from './playlist.js'
export {
  DEFAULT_EMPTY_RELOADS,
  DEFAULT_MAX_RECORDING,
  type HlsRecordEnd,
  type HlsRecordEvent,
  type HlsRecordOptions,
  type HlsRecordResult,
  LIVE_STALL_MS,
  type RefreshLive,
  recordHls,
} from './record.js'
export {
  decipherFor,
  fetchKey,
  fetchSegment,
  ivFor,
  KeyCache,
  type SegmentFetch,
  sniff,
  verifySegment,
} from './segment.js'
export {
  type HlsResumeState,
  type HlsTrack,
  type HlsTrackCursor,
  playlistIdentity,
  readState,
  StateWriter,
  writeState,
} from './state.js'
export {chooseVariant, type VariantChoice, variantChoices, variantRenditions} from './variants.js'
