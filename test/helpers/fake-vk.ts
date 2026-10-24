// A local stand-in for VK's video endpoint, with the behaviours the real one
// has (and that the built-in extractor must survive): `al_video.php` answers
// in windows-1251 (not UTF-8), `{"payload":[0,[title, html, js, html, {player}]]}`
// with the progressive MP4s as `url144`…`url1080`, error answers as code "8"
// with the message JSON-encoded, an owner's videos and albums listed by
// offset (`act=load_videos_silent`), vk.cc short links through /away.php,
// media links that want the browser's user agent, 429s, and live streams.
import * as http from 'node:http'
import {listenLocal} from './listen.js'

export type FakeVkConfig = {
  /** Videos of the owner (oid -1000), newest first. Default 3. */
  readonly videos?: number
  /** Sizes each video is offered in (the urlNNN keys). Default 240, 480, 720, 1080. */
  readonly qualities?: readonly number[]
  /** Listing entries per page. Default 4. */
  readonly pageSize?: number
  /** The first N answers of the endpoint are refused (429). */
  readonly refusals?: number
  /** The answer's shape changed: no `player` anywhere. */
  readonly changed?: boolean
  /** Answers with the older `<!--` prefixed al format. */
  readonly legacyPrefix?: boolean
  /** Video ids (by index) that are live streams. */
  readonly live?: readonly number[]
  /** Video ids (by index) that only have HLS. */
  readonly hlsOnly?: readonly number[]
  readonly mediaBytes?: number
}

export type FakeVk = {
  readonly origin: string
  readonly oid: string
  readonly ids: readonly string[]
  /** A title with Cyrillic, an accent and an entity, as VK escapes them. */
  readonly title: (index: number) => string
  readonly hits: Record<'show' | 'listing' | 'media' | 'refusedMedia' | 'refused' | 'short', number>
  /** Every media path asked for, in order. */
  readonly served: readonly string[]
  /** The `video` and `list` fields of every act=show. */
  readonly shows: ReadonlyArray<{readonly video: string; readonly list: string | null}>
  close(): Promise<void>
}

const OID = '-1000'
const BASE_ID = 456_239_000
const BASE_TIME = 1_790_000_000
export const PRIVATE_VIDEO = '5_456239017'
export const DELETED_VIDEO = '-1000_1'
const ALBUM = '7'

/** Text as windows-1251 bytes (ASCII, Cyrillic А…я, Ёё; anything else as an HTML entity, as VK does). */
export function encodeWindows1251(value: string): Buffer {
  const bytes: number[] = []
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code < 0x80) bytes.push(code)
    else if (code >= 0x410 && code <= 0x44f) bytes.push(code - 0x410 + 0xc0)
    else if (code === 0x401) bytes.push(0xa8)
    else if (code === 0x451) bytes.push(0xb8)
    else for (const b of Buffer.from(`&#${code};`)) bytes.push(b)
  }
  return Buffer.from(bytes)
}

export async function startFakeVk(config: FakeVkConfig = {}): Promise<FakeVk> {
  const count = config.videos ?? 3
  const qualities = config.qualities ?? [240, 480, 720, 1080]
  const pageSize = config.pageSize ?? 4
  const size = config.mediaBytes ?? 32 * 1024
  const ids = Array.from({length: count}, (_, i) => String(BASE_ID + count - i))
  const hits = {show: 0, listing: 0, media: 0, refusedMedia: 0, refused: 0, short: 0}
  const served: string[] = []
  const shows: Array<{video: string; list: string | null}> = []
  let refusalsLeft = config.refusals ?? 0
  let origin = ''
  // VK escapes non-Cyrillic characters as entities; "&amp;" stays escaped
  const title = (index: number) => `Видео номер ${index + 1} — café & co`
  const escapedTitle = (index: number) => `Видео номер ${index + 1} — caf&#233; &amp; co`

  const answer = (res: http.ServerResponse, payload: unknown) => {
    const body = `${config.legacyPrefix ? '<!--' : ''}${JSON.stringify({payload, static: '', langVersion: '1'})}`
    res.writeHead(200, {'Content-Type': 'application/json; charset=windows-1251'})
    res.end(encodeWindows1251(body))
  }
  const failure = (res: http.ServerResponse, message: string) =>
    answer(res, ['8', [JSON.stringify(message), 'false', '""']])

  const player = (index: number) => {
    const id = ids[index]!
    const params: Record<string, unknown> = {
      oid: Number(OID),
      vid: Number(id),
      md_title: escapedTitle(index),
      md_author: 'Фейк Канал',
      duration: 10 + index,
      date: BASE_TIME - index * 3600,
      jpg: `${origin}/thumb/${id}.jpg`,
      hls: `${origin}/media/${id}/video.m3u8?srcAg=CHROME_MAC`,
    }
    if (config.live?.includes(index)) {
      params['live'] = 2
      params['hls_live'] = `${origin}/media/${id}/live.m3u8`
      return {type: 'vk', params: [params]}
    }
    if (!config.hlsOnly?.includes(index)) {
      for (const q of qualities) params[`url${q}`] = `${origin}/media/${id}/${q}.mp4?srcAg=CHROME_MAC&sig=x`
    }
    return {type: 'vk', params: [params]}
  }
  const entry = (index: number) => {
    const id = ids[index]!
    const row: unknown[] = new Array(51).fill('')
    row[0] = Number(OID)
    row[1] = Number(id)
    row[2] = `${origin}/thumb/${id}.jpg`
    row[3] = escapedTitle(index)
    row[5] = `0:${10 + index}`
    row[8] = `<a href='${origin}/@fake' class='VideoCard__ownerLink'>Фейк Канал</a>`
    row[9] = BASE_TIME - index * 3600
    row[19] = 10 + index
    row[20] = `/video${OID}_${id}`
    return row
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (status: number, body: string | Buffer = '', headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, headers)
      res.end(body)
    }
    if (url.pathname.startsWith('/media/')) {
      hits.media++
      served.push(url.pathname)
      // the links are signed for the browser that asked (srcAg): no user agent, no file
      if (!/Chrome/.test(req.headers['user-agent'] ?? '')) {
        hits.refusedMedia++
        return send(400, 'no')
      }
      const quality = url.pathname.split('/')[3]?.replace('.mp4', '') ?? ''
      const body = Buffer.alloc(size, `q${quality}`)
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        return send(206, body.subarray(start), {'Content-Length': String(size - start), 'Content-Type': 'video/mp4'})
      }
      return send(200, body, {'Content-Length': String(size), 'Content-Type': 'video/mp4'})
    }
    if (url.pathname.startsWith('/cc/')) {
      hits.short++
      // vk.cc sends through VK's redirect page, the target in `to`
      const target = `${origin}/video${OID}_${ids[0]}`
      return send(302, '', {Location: `${origin}/away.php?cc_key=x&to=${encodeURIComponent(target)}`})
    }
    if (url.pathname === '/cc-nowhere') return send(302, '', {Location: `${origin}/`})
    if (url.pathname === '/al_video.php' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => {
        if (refusalsLeft > 0) {
          refusalsLeft--
          hits.refused++
          return send(429, 'Too many requests')
        }
        const form = new URLSearchParams(body)
        const act = form.get('act')
        if (act === 'show') {
          hits.show++
          const video = form.get('video') ?? ''
          shows.push({video, list: form.get('list')})
          if (video === PRIVATE_VIDEO) return failure(res, 'Access restricted')
          const index = ids.findIndex(id => `${OID}_${id}` === video)
          if (index === -1) return failure(res, 'This video has been deleted and is no longer available.')
          const holder = config.changed
            ? {videoPlayer: {sources: []}}
            : {mvData: {oid: Number(OID), vid: Number(ids[index])}, player: player(index), player_unavailable: false}
          return answer(res, [0, [escapedTitle(index), '<div>html</div>', 'js', '<div>info</div>', holder]])
        }
        if (act === 'load_videos_silent') {
          hits.listing++
          const section = form.get('section') ?? 'all'
          const offset = Number(form.get('offset') ?? 0)
          if (form.get('oid') !== OID) return answer(res, [0, [{[section]: {list: [], count: 0}}, null]])
          // the album holds every other video
          const indexes = Array.from({length: count}, (_, i) => i).filter(
            i => section === 'all' || (section === `album_${ALBUM}` && i % 2 === 0),
          )
          const page = indexes.slice(offset, offset + pageSize).map(entry)
          const albums =
            form.get('need_albums') === '1'
              ? [['Лучшее &amp; другое', indexes.length, '', `/video/playlist/${OID}_${ALBUM}`, '', '', Number(ALBUM)]]
              : null
          return answer(res, [0, [{[section]: {list: page, count: page.length, total: indexes.length}}, albums]])
        }
        return failure(res, 'Unknown error')
      })
      return
    }
    send(404, 'not found')
  })

  origin = `http://127.0.0.1:${await listenLocal(server)}`
  return {
    origin,
    oid: OID,
    ids,
    title,
    hits,
    served,
    shows,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

export const FAKE_VK_ALBUM = ALBUM
