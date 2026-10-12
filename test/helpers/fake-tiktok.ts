// A local stand-in for TikTok, with the behaviours the real one has (and that
// the built-in extractor must survive): media tied to the page's session
// cookie and a Referer, a listing that repeats pages and lists a pinned old
// post first, private accounts, verification pages, changed page layouts,
// short links, and encodings the extractor should skip.
import * as http from 'node:http'
import {listenLocal} from './listen.js'

export type FakeTikTokConfig = {
  readonly user?: string
  readonly posts?: number
  /** The account is private. */
  readonly private?: boolean
  /** The 2nd listing request repeats the 1st page (the real listing does this). */
  readonly repeatPage?: boolean
  /** The oldest post is pinned: listed first despite its date. */
  readonly pinned?: boolean
  /** Video pages answer with a verification page this many times first. */
  readonly challenges?: number
  /** Video pages answer 403 this many times first. */
  readonly refusals?: number
  /**
   * Pages and the listing need a cookie that only a browser earns: without it
   * they get a verification page whose script sets the cookie and reloads.
   */
  readonly jsChallenge?: boolean
  /** With jsChallenge: even browsers get a captcha (the script never passes). */
  readonly captcha?: boolean
  /** This post's page has no data script (layout changed). */
  readonly brokenPost?: string
  /** The H.264 encoding of every post has no sound. */
  readonly silentH264?: boolean
  readonly mediaBytes?: number
  /**
   * Posts (by index, 0 = newest) that are photo posts — slideshows of 3 images
   * (1080 × 1440 JPEGs) over a soundtrack; those listed in `silentSlides` have none.
   */
  readonly slideshows?: readonly number[]
  readonly silentSlides?: readonly number[]
  /** Seconds between two posts (newest first). Default 1 hour. */
  readonly spacingSeconds?: number
  /** Posts the account counts but its listing never returns (private, deleted, author-only). */
  readonly unlisted?: number
  /** After this many listing answers, the next `count` listing requests are refused (403, no data). */
  readonly listFailures?: {readonly after: number; readonly count: number}
}

export type FakeTikTok = {
  readonly origin: string
  readonly user: string
  readonly ids: readonly string[]
  /** Requests per route kind. */
  readonly hits: Record<'page' | 'profile' | 'list' | 'media' | 'refusedMedia' | 'short' | 'challenge', number>
  close(): Promise<void>
}

const BASE_TIME = 1_790_000_000 // unix seconds, newest post

export async function startFakeTikTok(config: FakeTikTokConfig = {}): Promise<FakeTikTok> {
  const user = config.user ?? 'fakeuser'
  const count = config.posts ?? 3
  const size = config.mediaBytes ?? 48 * 1024
  const ids = Array.from({length: count}, (_, i) => String(7_400_000_000_000_000_000n + BigInt(count - i)))
  const hits = {page: 0, profile: 0, list: 0, media: 0, refusedMedia: 0, short: 0, challenge: 0}
  let challengesLeft = config.challenges ?? 0
  let refusalsLeft = config.refusals ?? 0
  let listCalls = 0
  let refusedLists = 0
  let firstPage: unknown
  let session = 0
  let origin = ''

  const post = (index: number) => {
    const id = ids[index]!
    const pinned = config.pinned === true && index === count - 1
    const media = (codec: string) => `${origin}/media/${id}/${codec}.mp4`
    if (config.slideshows?.includes(index)) {
      const silent = config.silentSlides?.includes(index)
      return {
        id,
        desc: `Carrusel ${index + 1} #photo`,
        createTime: BASE_TIME - index * (config.spacingSeconds ?? 3600),
        author: {uniqueId: user, nickname: 'Fake User'},
        video: {duration: 0, width: 0, height: 0, cover: `${origin}/cover/${id}.jpg`},
        imagePost: {
          title: 'Carrusel',
          images: [1, 2, 3].map(n => ({
            imageWidth: 1080,
            imageHeight: 1440,
            // the first mirror of image 2 is down: the next one must be used
            imageURL: {
              urlList: [`${origin}/image/${id}/${n}${n === 2 ? '-down' : ''}.jpg`, `${origin}/image/${id}/${n}.jpg`],
            },
          })),
        },
        music: silent ? {title: 'none'} : {playUrl: `${origin}/sound/${id}.mp3`, title: 'original sound', duration: 42},
      }
    }
    return {
      id,
      desc: `Post número ${index + 1} con acentos 🎵 #fyp #music`,
      createTime: BASE_TIME - index * (config.spacingSeconds ?? 3600),
      isPinnedItem: pinned || undefined,
      author: {uniqueId: user, nickname: 'Fake User'},
      video: {
        duration: 10,
        width: 720,
        height: 1280,
        cover: `${origin}/cover/${id}.jpg`,
        playAddr: media('h264'),
        bitrateInfo: [
          {
            CodecType: 'bytevc2',
            Bitrate: 500_000,
            PlayAddr: {UrlList: [media('vvc')], Width: 1080, Height: 1920, DataSize: size},
          },
          {
            CodecType: 'h265_hvc1',
            Bitrate: 900_000,
            PlayAddr: {UrlList: [media('h265')], Width: 1080, Height: 1920, DataSize: size},
          },
          {
            CodecType: 'h264',
            Bitrate: 1_200_000,
            PlayAddr: {
              UrlList: [`${origin}/aweme/v1/play/?id=${id}`, media('h264')],
              Width: 720,
              Height: 1280,
              DataSize: size,
            },
          },
        ],
      },
      music: {playUrl: `${origin}/music/${id}.mp3`, title: 'original sound'},
    }
  }
  const ordered = () => {
    const list = ids.map((_, i) => post(i))
    if (config.pinned) list.unshift(list.pop()!)
    return list
  }

  const page = (scope: unknown) =>
    `<!doctype html><html><head><title>TikTok</title></head><body><div id="app"></div>` +
    `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({__DEFAULT_SCOPE__: scope})}</script>` +
    `</body></html>`

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const send = (status: number, body: string | Buffer, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, headers)
      res.end(body)
    }
    const parts = url.pathname.split('/').filter(Boolean)
    const passed = (req.headers.cookie ?? '').includes('waf_ok=1')
    const isPage = parts[0]?.startsWith('@')
    if (config.jsChallenge && !passed && isPage) {
      hits.challenge++
      const script = config.captcha ? '' : "document.cookie='waf_ok=1; path=/'; location.reload()"
      return send(
        200,
        `<html><head><title>Please wait...</title></head><body><script>var _wafchallengeid='x';${script}</script></body></html>`,
        {
          'Content-Type': 'text/html',
        },
      )
    }
    if (config.jsChallenge && !passed && parts[0] === 'api') {
      hits.list++
      return send(200, '')
    }

    if (parts[0] === 't') {
      hits.short++
      return send(302, '', {Location: `/@${user}/video/${ids[0]}`})
    }
    if (parts[0] === 'api' && parts[2] === 'item_list') {
      hits.list++
      const failures = config.listFailures
      if (failures && listCalls >= failures.after && refusedLists < failures.count) {
        refusedLists++
        return send(403, '')
      }
      listCalls++
      const cursor = Number(url.searchParams.get('cursor'))
      const pageSize = Number(url.searchParams.get('count')) || 15
      const all = ordered()
      const pinned = config.pinned ? all.slice(0, 1) : []
      const regular = all.filter(p => !p.isPinnedItem).filter(p => p.createTime * 1000 < cursor)
      const items = [...(listCalls === 1 ? pinned : []), ...regular.slice(0, pageSize)]
      let body = {statusCode: 0, itemList: items, hasMorePrevious: regular.length > pageSize}
      if (listCalls === 1) firstPage = body
      if (config.repeatPage && listCalls === 2) body = firstPage as typeof body
      return send(200, JSON.stringify(body), {'Content-Type': 'application/json'})
    }
    // slideshow images and soundtracks: plain files, no session needed (as on the real CDN)
    if (parts[0] === 'image') {
      hits.media++
      if (parts[2]?.includes('-down')) return send(404, 'gone')
      return send(200, Buffer.from(`JPEG ${parts[1]} ${parts[2]}`), {'Content-Type': 'image/jpeg'})
    }
    if (parts[0] === 'sound') {
      hits.media++
      return send(200, Buffer.from(`MP3 ${parts[1]}`), {'Content-Type': 'audio/mpeg'})
    }
    if (parts[0] === 'media') {
      hits.media++
      const cookie = req.headers.cookie ?? ''
      const referer = req.headers.referer ?? ''
      if (!cookie.includes('tt_chain_token=') || !referer.startsWith(origin)) {
        hits.refusedMedia++
        return send(403, 'forbidden')
      }
      if (parts[2] === 'vvc.mp4') return send(404, 'no')
      const silent = config.silentH264 && parts[2] === 'h264.mp4'
      // content tells the encodings apart: "4" H.264, "5" H.265, "s" silent
      const body = Buffer.alloc(size, silent ? 's' : parts[2] === 'h265.mp4' ? '5' : '4')
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        return send(206, body.subarray(start), {
          'Content-Length': String(size - start),
          'Content-Range': `bytes ${start}-${size - 1}/${size}`,
        })
      }
      return send(200, body, {'Content-Length': String(size), 'Content-Type': 'video/mp4'})
    }
    const handle = parts[0]?.startsWith('@') ? parts[0].slice(1) : undefined
    if (handle && !parts[1]) {
      hits.profile++
      return send(
        200,
        page({
          'webapp.user-detail': {
            statusCode: 0,
            userInfo: {
              user: {
                id: '42',
                uniqueId: handle,
                nickname: 'Fake User',
                secUid: `SEC-${handle}`,
                privateAccount: config.private === true,
              },
              stats: {videoCount: count + (config.unlisted ?? 0)},
            },
          },
        }),
        {'Content-Type': 'text/html'},
      )
    }
    if (handle && parts[1] === 'video' && parts[2]) {
      hits.page++
      if (refusalsLeft > 0) {
        refusalsLeft--
        return send(403, 'forbidden')
      }
      if (challengesLeft > 0) {
        challengesLeft--
        return send(200, '<html><body>Please wait... <script>var _wafchallengeid="x"</script></body></html>')
      }
      if (parts[2] === config.brokenPost) return send(200, '<html><body><div id="new-layout"></div></body></html>')
      const index = ids.indexOf(parts[2])
      if (index === -1) {
        return send(200, page({'webapp.video-detail': {statusCode: 10204, statusMsg: "item doesn't exist"}}))
      }
      session++
      return send(200, page({'webapp.video-detail': {statusCode: 0, itemInfo: {itemStruct: post(index)}}}), {
        'Content-Type': 'text/html',
        // the CDN only serves media to the session that read the page
        'Set-Cookie': `tt_chain_token=tok-${session}; Path=/; HttpOnly`,
      })
    }
    send(404, 'not found')
  })

  origin = `http://127.0.0.1:${await listenLocal(server)}`
  return {
    origin,
    user,
    ids,
    hits,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
