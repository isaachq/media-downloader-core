// Real media for the fake sites: by default they serve synthetic bytes (fast, and the
// fake ffmpeg "decodes" anything); the nightly matrix hands them real clips, pictures
// and soundtracks from the media lab, so the real ffmpeg has something to convert.
import * as fs from 'node:fs'
import type * as http from 'node:http'

export type RealMedia = {
  /** The video every post serves (an H.264 MP4, or whatever the case needs). */
  readonly video?: string | undefined
  /** The "HD" encoding where the site has one; `video` when absent. */
  readonly hd?: string | undefined
  /** Every picture (a slideshow's images, a carousel's photos, covers). */
  readonly image?: string | undefined
  /** A slideshow's soundtrack. */
  readonly sound?: string | undefined
  /** The clip's real duration in seconds, for the site to announce (the engine checks it). */
  readonly duration?: number | undefined
  /** The soundtrack's real duration in seconds. */
  readonly soundDuration?: number | undefined
}

export type Served = {
  readonly status: number
  readonly body: Buffer
  readonly headers: http.OutgoingHttpHeaders
}

const cache = new Map<string, Buffer>()

/** A real file as a site would serve it: whole, or from `Range` on, with its type. */
export function serveReal(file: string, contentType: string, range: string | undefined): Served {
  let body = cache.get(file)
  if (!body) {
    body = fs.readFileSync(file)
    cache.set(file, body)
  }
  const size = body.length
  const from = /^bytes=(\d+)-$/.exec(range ?? '')
  const common = {'Content-Type': contentType, 'Accept-Ranges': 'bytes'}
  if (from) {
    const start = Number(from[1])
    return {
      status: 206,
      body: body.subarray(start),
      headers: {
        ...common,
        'Content-Length': String(size - start),
        'Content-Range': `bytes ${start}-${size - 1}/${size}`,
      },
    }
  }
  return {status: 200, body, headers: {...common, 'Content-Length': String(size)}}
}
