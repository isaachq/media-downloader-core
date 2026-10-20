import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {type MediaTags, runFfmpeg} from '../../core/convert.js'
import type {DownloadedInfo} from '../../core/download.js'
import {fetchMedia} from '../media-fetch.js'
import {type Rendition, rankRenditions} from '../renditions.js'
import type {SourceDownload, SourceFile} from '../source.js'
import {buildSlideshowVideo, slideshowFrame} from '../tiktok/slideshow.js'
import type {MetaClient} from './client.js'
import {MetaError} from './errors.js'
import {imagesOf, type MetaImage, type MetaPost, type MetaVideo, shapeOf, titleOf, videosOf} from './post.js'

/**
 * Fetching a post's media for the engine, the same way for Instagram and
 * Facebook: a video as its best encoding for the profile (every mirror of
 * each, best first); a photo or a carousel of photos as what `slideshow`
 * asks (an MP4 of the images over the post's song, or a folder of them with
 * the song), or the song alone for an audio profile; a carousel with videos as
 * a folder of everything, kept as it is. Media is streamed with the site's
 * session and Referer (the CDNs often require one), 4 files at a time.
 */
const PARALLEL_FILES = 4

export type PostDownload = {
  readonly client: MetaClient
  readonly post: MetaPost
  readonly task: SourceDownload
  /** The site, for messages and the `extractor` field. */
  readonly site: string
  /** Sent with every media request. */
  readonly referer: string
}

export async function downloadPost({client, post, task, site, referer}: PostDownload): Promise<SourceFile> {
  const title = titleOf(post, site)
  const tags: MediaTags = {
    title,
    artist: post.authorName ?? post.author,
    date: post.createdAt ? new Date(post.createdAt * 1000).toISOString().slice(0, 10) : undefined,
    comment: post.url,
  }
  const info: DownloadedInfo = {id: post.id, title, extractor: site, publishedAt: post.createdAt ?? null}
  const shape = shapeOf(post)
  const videos = videosOf(post)
  const audioOnly = task.profile.kind === 'audio'

  if (shape === 'empty') throw new MetaError('no-media', 'This post has nothing to download.')

  // a video, or the soundtrack of the first video of a carousel
  if (shape === 'video' || (audioOnly && videos.length > 0)) {
    const video = videos[0]!
    task.onInfo({...info, duration: video.duration ?? null})
    const file = await fetchBest(client, video, post.id, task, site, referer)
    const hasAudio = await task.hasAudio(file.path)
    if (audioOnly && !hasAudio) {
      await fs.rm(file.path, {force: true})
      throw new MetaError('no-media', 'This video has no sound to extract.')
    }
    return {
      filepath: file.path,
      info: {
        ...info,
        duration: video.duration ?? null,
        vcodec: file.codec === 'h264' ? 'avc1' : 'hvc1',
        acodec: hasAudio ? 'mp4a' : 'none',
        filesize: file.bytes,
      },
      tags,
    }
  }
  if (audioOnly && !post.music) throw new MetaError('no-media', 'A photo has no sound to extract.')

  const folder = path.join(task.workDir, `${post.id}-items`)
  await fs.mkdir(folder, {recursive: true})
  const {mode, secondsPerImage} = task.slideshow

  // pictures only: a slideshow video (over the post's song), a folder of the pictures (and the song), or the song
  if (videos.length === 0) {
    const images = imagesOf(post)
    const seconds = images.length * secondsPerImage
    const music = post.music
    const wantsSound = audioOnly || mode !== 'images'
    task.onInfo({...info, duration: audioOnly ? (music?.duration ?? null) : mode === 'video' ? seconds : null})
    const sound =
      wantsSound && music
        ? await fetchOneOf(client, [music.url], folder, 'sound', '.m4a', task, site, referer)
        : undefined
    if (audioOnly) {
      // the song alone: the engine converts it to the profile's container
      return {
        filepath: sound!,
        info: {...info, duration: music?.duration ?? null, acodec: 'mp4a', filesize: (await fs.stat(sound!)).size},
        tags,
      }
    }
    const files = await fetchImages(client, images, folder, task, site, referer)
    if (mode === 'video') {
      const output = path.join(task.workDir, `${post.id}-slideshow.mp4`)
      task.onProgress({fraction: 0})
      await buildSlideshowVideo({
        ffmpeg: task.ffmpeg,
        images: files,
        frame: slideshowFrame(images),
        audio: sound,
        secondsPerImage,
        output,
        threads: task.threads,
        signal: task.signal,
        onProgress: fraction => task.onProgress({fraction}),
      })
      await fs.rm(folder, {recursive: true, force: true})
      const bytes = (await fs.stat(output)).size
      return {
        filepath: output,
        info: {...info, duration: seconds, vcodec: 'avc1', acodec: sound ? 'mp4a' : 'none', filesize: bytes},
        tags,
      }
    }
    return {filepath: folder, bundle: true, info: {...info, duration: sound ? (music?.duration ?? null) : null}}
  }

  // a carousel with videos: everything in order, each file as the site serves it
  task.onInfo({...info, duration: null})
  await fetchAll(client, post, folder, task, site, referer)
  return {filepath: folder, bundle: true, info: {...info, duration: null}}
}

/** Try encodings best first, every mirror of each. */
async function fetchBest(
  client: MetaClient,
  video: MetaVideo,
  postId: string,
  task: SourceDownload,
  site: string,
  referer: string,
): Promise<{path: string; bytes: number; codec: Rendition['codec']}> {
  if (video.renditions.length === 0) throw new MetaError('format-changed', 'This video has no downloadable encoding.')
  const ranked = rankRenditions(video.renditions, task.profile)
  let last: unknown
  for (const rendition of ranked) {
    for (const url of rendition.urls) {
      const file = path.join(task.workDir, `${postId}-${video.id}-${rendition.codec}-${rendition.resolution}.mp4`)
      try {
        if (rendition.audio) {
          const bytes = await fetchDash(client, url, rendition.audio.urls, file, task, site, referer)
          return {path: file, bytes, codec: rendition.codec}
        }
        const {bytes} = await fetchMedia(client.session, url, file, {
          site,
          headers: {Referer: referer},
          expected: rendition.bytes,
          signal: task.signal,
          onProgress: task.onProgress,
        })
        return {path: file, bytes, codec: rendition.codec}
      } catch (error) {
        if (task.signal.aborted) throw error
        await fs.rm(file, {force: true})
        last = error
      }
    }
  }
  throw last ?? new MetaError('format-changed', 'No downloadable encoding.')
}

/**
 * A DASH stream pair: the video-only file and the audio file, each streamed to
 * disk, then muxed into `file` by ffmpeg as a stream copy (no re-encoding,
 * constant memory whatever the size). The parts are removed either way.
 */
async function fetchDash(
  client: MetaClient,
  videoUrl: string,
  audioUrls: readonly string[],
  file: string,
  task: SourceDownload,
  site: string,
  referer: string,
): Promise<number> {
  const videoPart = `${file}.video.mp4`
  const audioPart = `${file}.audio.m4a`
  try {
    await fetchMedia(client.session, videoUrl, videoPart, {
      site,
      headers: {Referer: referer},
      signal: task.signal,
      onProgress: progress => task.onProgress({...progress, fraction: (progress.fraction ?? 0) * 0.9}),
    })
    let fetched = false
    let last: unknown
    for (const url of audioUrls) {
      try {
        await fetchMedia(client.session, url, audioPart, {
          site,
          headers: {Referer: referer},
          signal: task.signal,
          onProgress: () => {},
        })
        fetched = true
        break
      } catch (error) {
        if (task.signal.aborted) throw error
        await fs.rm(audioPart, {force: true})
        last = error
      }
    }
    if (!fetched) throw last ?? new MetaError('format-changed', 'The video came without its audio stream.')
    await runFfmpeg({ffmpeg: task.ffmpeg, input: videoPart, threads: 1, signal: task.signal}, file, [
      ['-i', audioPart],
      ['-map', '0:v:0'],
      ['-map', '1:a:0'],
      ['-c', 'copy'],
      ['-movflags', '+faststart'],
    ])
    task.onProgress({fraction: 1})
    return (await fs.stat(file)).size
  } finally {
    await fs.rm(videoPart, {force: true})
    await fs.rm(audioPart, {force: true})
  }
}

/** Images into `folder` as 01.jpg, 02.jpg…, PARALLEL_FILES at a time, each from its first mirror that answers. */
async function fetchImages(
  client: MetaClient,
  images: readonly MetaImage[],
  folder: string,
  task: SourceDownload,
  site: string,
  referer: string,
): Promise<string[]> {
  const files: string[] = new Array(images.length)
  await inParallel(images.length, async i => {
    files[i] = await fetchOneOf(client, images[i]!.urls, folder, nameFor(i, images.length), '.jpg', task, site, referer)
  })
  return files
}

/** A carousel's items in order (01, 02…): videos as their best encoding, images as they are. */
async function fetchAll(
  client: MetaClient,
  post: MetaPost,
  folder: string,
  task: SourceDownload,
  site: string,
  referer: string,
): Promise<void> {
  const items = post.items
  await inParallel(items.length, async i => {
    const item = items[i]!
    const name = nameFor(i, items.length)
    if (item.kind === 'image') {
      await fetchOneOf(client, item.urls, folder, name, '.jpg', task, site, referer)
      return
    }
    const ranked = rankRenditions(item.renditions, task.profile)
    const urls = ranked.flatMap(r => r.urls)
    if (urls.length === 0) throw new MetaError('format-changed', `Item ${i + 1} has no downloadable encoding.`)
    await fetchOneOf(client, urls, folder, name, '.mp4', task, site, referer)
  })
}

async function inParallel(count: number, work: (index: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    for (let i = next++; i < count; i = next++) await work(i)
  }
  await Promise.all(Array.from({length: Math.min(PARALLEL_FILES, count)}, worker))
}

async function fetchOneOf(
  client: MetaClient,
  urls: readonly string[],
  folder: string,
  name: string,
  fallbackExt: string,
  task: SourceDownload,
  site: string,
  referer: string,
): Promise<string> {
  let last: unknown
  for (const url of urls) {
    const partial = path.join(folder, `${name}.part`)
    try {
      const fetched = await fetchMedia(client.session, url, partial, {
        site,
        headers: {Referer: referer},
        signal: task.signal,
        onProgress: () => {},
      })
      const file = path.join(folder, `${name}${extensionOf(fetched.contentType, fallbackExt)}`)
      await fs.rename(partial, file)
      return file
    } catch (error) {
      if (task.signal.aborted) throw error
      await fs.rm(partial, {force: true})
      last = error
    }
  }
  throw last ?? new MetaError('format-changed', 'No mirror answered.')
}

const nameFor = (index: number, count: number): string =>
  String(index + 1).padStart(Math.max(2, String(count).length), '0')

/** A file extension for a media type ("image/webp" → ".webp"); `fallback` for anything else. */
export function extensionOf(contentType: string | undefined, fallback: string): string {
  const known: Readonly<Record<string, string>> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
  }
  return (contentType && known[contentType]) || fallback
}
