import * as path from 'node:path'
import {
  type ArchiveEntry,
  AUDIO_CONTAINERS,
  type AudioContainer,
  type BatchTarget,
  DEFAULT_SLIDESHOW,
  type FormatProfile,
  type JobRequest,
  mediaFileStem,
  VIDEO_CONTAINERS,
  type VideoContainer,
} from 'media-downloader-core'

/**
 * The format a record was downloaded in, read back from its profile key
 * (`video:mp4:1080`, `video:mkv:best`, `audio:mp3:0`). Undefined for a key
 * this version doesn't know: such a record is not downloaded again.
 */
export function profileFromKey(key: string): FormatProfile | undefined {
  const [kind, container, rest] = key.split(':')
  if (!container || rest === undefined) return undefined
  if (kind === 'video' && (VIDEO_CONTAINERS as readonly string[]).includes(container)) {
    if (rest === 'best') return {kind: 'video', container: container as VideoContainer}
    const maxHeight = Number(rest)
    return Number.isInteger(maxHeight) && maxHeight > 0
      ? {kind: 'video', container: container as VideoContainer, maxHeight}
      : undefined
  }
  if (kind === 'audio' && (AUDIO_CONTAINERS as readonly string[]).includes(container) && rest) {
    return {kind: 'audio', container: container as AudioContainer, quality: rest}
  }
  return undefined
}

type HistoryRecord = Pick<
  ArchiveEntry,
  'url' | 'title' | 'mediaId' | 'extractor' | 'profile' | 'filepath' | 'duration' | 'slideshow'
>

const POSITION = /^(\d{3,})(?: - |-)/

/**
 * The list position a file's name starts with ("002 - Title [id]" or
 * "002-Title-id"), so it comes back under the same name. Only when the name
 * is exactly what that position would give (a title starting with digits is
 * not a position); undefined otherwise. O(1) per record.
 */
export function positionOf(record: Pick<HistoryRecord, 'title' | 'mediaId' | 'filepath'>): number | undefined {
  const name = path.basename(record.filepath)
  const stem = name.slice(0, name.length - path.extname(name).length)
  const found = POSITION.exec(stem)
  if (!found || record.title === undefined) return undefined
  const index = Number(found[1])
  const media = {title: record.title, id: record.mediaId, index}
  return mediaFileStem('original', media) === stem || mediaFileStem('portable', media) === stem ? index : undefined
}

/**
 * Where a failed download is retried: the folder, format, list position and,
 * for a photo post, the slideshow mode its job had (a folder of images is
 * retried as images, not as the batch's default MP4); the downloads folder
 * and the given format when the job is no longer known. O(1).
 */
export function retryTarget(
  index: number,
  known: Pick<JobRequest, 'outDir' | 'profile' | 'playlist' | 'slideshow' | 'photoPost'> | undefined,
  fallback: {readonly outDir: string; readonly profile: FormatProfile},
): BatchTarget {
  return {
    index,
    outDir: known?.outDir ?? fallback.outDir,
    profile: known?.profile ?? fallback.profile,
    ...(known?.playlist && {playlist: known.playlist}),
    ...(known?.photoPost && known.slideshow && {slideshow: known.slideshow}),
  }
}

/**
 * One batch that downloads these records again from the link each kept: each
 * into the folder its file was in, under its old name, in the format it had
 * (a photo post kept as a folder, as that folder again). Records whose format
 * can't be read back are left out; undefined when none is left. O(n).
 */
/**
 * A live recording's record: its id is `live-<stream>-<start>` (the Twitch source's). Its link is
 * the channel's, which records whatever is on the air now: it is never downloaded again. O(1).
 */
export function isLiveRecord(record: Pick<HistoryRecord, 'mediaId' | 'extractor'>): boolean {
  return record.mediaId.startsWith('live-') && record.extractor.toLowerCase() === 'twitch'
}

export function redownloadRequest(records: readonly HistoryRecord[], title: string) {
  const entries = []
  const targets: BatchTarget[] = []
  for (const record of records) {
    if (isLiveRecord(record)) continue
    const profile = profileFromKey(record.profile)
    if (!profile || !record.url) continue
    const index: number = entries.length + 1
    entries.push({
      id: record.mediaId,
      index,
      url: record.url,
      title: record.title ?? record.url,
      duration: record.duration,
      extractor: record.extractor,
      isLive: false,
    })
    const outDir = path.dirname(record.filepath)
    const position = positionOf(record)
    targets.push({
      index,
      outDir,
      profile,
      // its old position: the file name starts with it again
      ...(position !== undefined && {playlist: {id: '', title: path.basename(outDir), index: position}}),
      // a folder of images (and sound) is made again, not an MP4
      ...(record.slideshow && {
        slideshow: {mode: record.slideshow, secondsPerImage: DEFAULT_SLIDESHOW.secondsPerImage},
      }),
    })
  }
  if (targets.length === 0) return undefined
  return {
    url: entries[0]!.url,
    profile: targets[0]!.profile,
    outDir: targets[0]!.outDir,
    selection: {title, entries},
    targets,
  }
}
