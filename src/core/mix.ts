import * as fs from 'node:fs/promises'
import {isFacebookListing} from '../sources/facebook/links.js'
import {isInstagramListing} from '../sources/instagram/links.js'
import {type MixLink, planMix} from '../sources/mix-plan.js'
import {isTikTokProfile} from '../sources/tiktok/links.js'
import {DEFAULT_SLIDESHOW} from '../sources/tiktok/slideshow.js'
import {isVkListing} from '../sources/vk/links.js'
import {isXProfile} from '../sources/x/links.js'
import type {
  FormatProfile,
  JobError,
  MixAnalysis,
  MixAnalyzeOptions,
  MixItem,
  MixSkipped,
  MixSkipReason,
  SlideshowOptions,
  VideoAnalysis,
} from '../types.js'
import {type ExtractResult, isYouTubeListing} from './analyze.js'
import type {DamagedEntry, DamagedLookup} from './damaged.js'
import {cancelledError} from './errors.js'

/** What the mix check needs of the engine (MediaDownloader): its network check, damaged and archive lookups. */
export type MixEngine = {
  preflight(
    items: ReadonlyArray<{readonly url: string}>,
    opts: {
      readonly signal?: AbortSignal | undefined
      readonly onResult?: ((url: string, result: ExtractResult) => void) | undefined
      readonly keepMetadata?: ((url: string) => boolean) | undefined
      readonly attempts?: number | undefined
    },
  ): Promise<ReadonlyMap<string, ExtractResult>>
  isDamaged(lookup: DamagedLookup): Promise<DamagedEntry | undefined>
  isArchived(
    extractor: string,
    mediaId: string,
    profile: FormatProfile,
    slideshow?: SlideshowOptions['mode'] | undefined,
  ): Promise<boolean>
  defaultListSize(url: string): number | undefined
}

/** Checked links whose metadata is kept for their download (~150 KiB each): the scheduler's own default. */
const MIX_CACHED_METADATA = 500
/** Archive and damaged lookups run this many at a time (one index hit and a stat each). */
const LOOKUP_SLICE = 200

/** A playlist, channel or profile: a list has a preview of its own, a mix list takes single items. */
export function isListingLink(url: string, engine: Pick<MixEngine, 'defaultListSize'>): boolean {
  return (
    engine.defaultListSize(url) !== undefined ||
    isYouTubeListing(url) ||
    isTikTokProfile(url) ||
    isInstagramListing(url) ||
    isFacebookListing(url) ||
    isVkListing(url) ||
    isXProfile(url)
  )
}

/** Why the check turned a link down, from its error: the code and hint every app already words. */
export function skipReasonOf(error: JobError): MixSkipReason {
  if (error.hint === 'private') return 'private'
  if (error.hint === 'needs-sign-in' || error.hint === 'members-only') return 'needs-sign-in'
  if (error.hint === 'damaged-source') return 'damaged'
  if (error.hint === 'unsupported-url' || error.code === 'binary-missing') return 'unsupported'
  if (error.code === 'unavailable') return 'unavailable'
  // the sources' word for a link that holds several items (a short link to a profile, an X post with several videos)
  if (error.code === 'invalid-request' && error.hint === undefined) return 'listing'
  return 'error'
}

/** Whether the media has a stream of the profile's kind (a batch item without one is unavailable). O(choices). */
const offers = (analysis: VideoAnalysis, profile: FormatProfile): boolean =>
  analysis.choices.some(choice => choice.profile.kind === profile.kind)

/** A photo post (made into an MP4 or a folder by `SlideshowOptions.mode`), not a carousel with videos. */
const isPhotoPost = (analysis: VideoAnalysis): boolean =>
  analysis.media.slideshow !== undefined && analysis.media.slideshow.videos !== true

/**
 * Check a pasted list of links of any sites as one: plan it locally (each link
 * once; lines without a link, repeats and lists left out), check what is left
 * with the engine's own preflight — natively read sites paced by their source,
 * the rest in chunks through yt-dlp, ⌊CPUs/2⌋ at a time — then leave out what
 * can't be downloaded, what is damaged at the source, and links that turned out
 * to name the same media. O(n) local work (Set and Map lookups only), the
 * network bounded by the engine's pool; partial failures land in `skipped`,
 * only a cancel rejects. Valid and skipped keep the order pasted.
 */
export async function analyzeMix(
  engine: MixEngine,
  input: string | readonly string[],
  options: MixAnalyzeOptions = {},
  /** Checks per link with `retries: 'thorough'` (the engine's ANALYZE_ATTEMPTS). */
  thoroughAttempts = 3,
): Promise<MixAnalysis> {
  const {signal, profile} = options
  if (signal?.aborted) throw cancelledError()
  const plan = planMix(input, {maxLinks: options.maxLinks})
  const skipped: MixSkipped[] = [...plan.skipped]
  const toCheck: MixLink[] = []
  for (const link of plan.links) {
    if (isListingLink(link.url, engine))
      skipped.push({line: link.line, input: link.url, site: link.site, reason: 'listing'})
    else toCheck.push(link)
  }

  // the network check: results stream in any order, kept by url (O(1) each)
  const results = new Map<string, ExtractResult>()
  let cached = 0
  let checked = 0
  if (toCheck.length > 0) {
    const total = toCheck.length
    options.onProgress?.({total, checked})
    await engine.preflight(
      toCheck.map(link => ({url: link.url})),
      {
        signal,
        attempts: options.retries === 'thorough' ? thoroughAttempts : 1,
        keepMetadata: () => cached++ < MIX_CACHED_METADATA,
        onResult: (url, result) => {
          if (results.has(url)) return
          results.set(url, result)
          checked++
          options.onProgress?.({total, checked})
        },
      },
    )
  }
  if (signal?.aborted) {
    await forget(results.values())
    throw cancelledError()
  }

  // in the order pasted: the first link of a media keeps it, a later one repeats it
  const valid: MixItem[] = []
  const firstOf = new Map<string, number>()
  const unused: ExtractResult[] = []
  for (const link of toCheck) {
    const result = results.get(link.url)
    if (!result) {
      skipped.push({
        line: link.line,
        input: link.url,
        site: link.site,
        reason: 'error',
        error: {code: 'unknown', message: 'The check gave no answer for this link.'},
      })
      continue
    }
    if (!result.ok) {
      // the site asks to confirm this is not a bot: it blocks for a while, not for good — checked when it downloads
      if (result.error.code === 'blocked') valid.push({line: link.line, url: link.url, site: link.site})
      else
        skipped.push({
          line: link.line,
          input: link.url,
          site: link.site,
          reason: skipReasonOf(result.error),
          error: result.error,
        })
      continue
    }
    const {analysis} = result
    const identity = analysis.media.id ? `${analysis.media.extractor}:${analysis.media.id}` : undefined
    const first = identity === undefined ? undefined : firstOf.get(identity)
    if (first !== undefined) {
      unused.push(result)
      skipped.push({line: link.line, input: link.url, site: link.site, reason: 'duplicate', duplicateOf: first})
      continue
    }
    if (identity !== undefined) firstOf.set(identity, link.line)
    if (profile && !offers(analysis, profile)) {
      unused.push(result)
      skipped.push({
        line: link.line,
        input: link.url,
        site: link.site,
        reason: 'unavailable',
        error: {code: 'unavailable', hint: 'format-unavailable', message: `No ${profile.kind} formats.`},
      })
      continue
    }
    valid.push({line: link.line, url: analysis.media.url || link.url, site: link.site, analysis})
  }

  const kept = await screen(engine, valid, skipped, options)
  await forget(unused)
  skipped.sort((a, b) => a.line - b.line)
  return {valid: kept, skipped, summary: summarize(kept, skipped)}
}

/**
 * Damaged at the source → skipped; already downloaded with the profile →
 * marked `archived`. LOOKUP_SLICE lookups at a time, each O(1).
 */
async function screen(
  engine: MixEngine,
  valid: readonly MixItem[],
  skipped: MixSkipped[],
  options: MixAnalyzeOptions,
): Promise<MixItem[]> {
  const kept: MixItem[] = []
  const dropped: VideoAnalysis[] = []
  const mode = (options.slideshow ?? DEFAULT_SLIDESHOW).mode
  for (let start = 0; start < valid.length; start += LOOKUP_SLICE) {
    const slice = valid.slice(start, start + LOOKUP_SLICE)
    const found = await Promise.all(
      slice.map(async item => {
        const media = item.analysis?.media
        const damaged = await engine.isDamaged({url: item.url, extractor: media?.extractor, mediaId: media?.id})
        if (damaged || !media?.id || !options.profile) return {damaged, archived: false}
        const archived = await engine.isArchived(
          media.extractor,
          media.id,
          options.profile,
          isPhotoPost(item.analysis!) ? mode : undefined,
        )
        return {damaged, archived}
      }),
    )
    slice.forEach((item, offset) => {
      const {damaged, archived} = found[offset]!
      if (damaged) {
        if (item.analysis) dropped.push(item.analysis)
        skipped.push({
          line: item.line,
          input: item.url,
          site: item.site,
          reason: 'damaged',
          error: {
            code: 'unavailable',
            hint: 'damaged-source',
            message: `Damaged at the source — not downloaded again: ${damaged.reason}`,
          },
        })
        return
      }
      kept.push(archived ? {...item, archived: true} : item)
    })
  }
  await forget(dropped.map(analysis => ({ok: true, analysis}) as const))
  return kept
}

/** Counts by site and by reason: O(n). */
function summarize(valid: readonly MixItem[], skipped: readonly MixSkipped[]): MixAnalysis['summary'] {
  const bySite: Partial<Record<MixItem['site'], number>> = {}
  for (const item of valid) bySite[item.site] = (bySite[item.site] ?? 0) + 1
  const byReason: Partial<Record<MixSkipReason, number>> = {}
  for (const item of skipped) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1
  return {total: valid.length + skipped.length, valid: valid.length, skipped: skipped.length, bySite, byReason}
}

/** Delete the metadata kept for checks that won't download (left out, or the whole check cancelled). */
async function forget(results: Iterable<ExtractResult>): Promise<void> {
  const files: string[] = []
  for (const result of results) if (result.ok && result.analysis.infoJsonPath) files.push(result.analysis.infoJsonPath)
  await Promise.all(files.map(file => fs.rm(file, {force: true})))
}
