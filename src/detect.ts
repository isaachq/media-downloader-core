// `media-downloader-core/detect`: which site a link is, and the links a pasted
// text holds — pure (no Node built-ins, no URL class), for the apps' renderers
// (Electron, Hermes on Android) to answer the moment something is pasted.

export {audioOnlyFormats, type DetectedLink, detectLink, LINK_SITES, type LinkSite} from './sources/detect.js'
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
