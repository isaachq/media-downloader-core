// A local stand-in for a "player page" site: paged search results whose menu
// shows featured videos on every page, pagination that only links a few pages
// around the current one, video pages whose player is given the best
// rendition, removed videos that redirect home, and a media server with Range
// and Last-Modified.
import * as http from 'node:http'
import type {MediaResolver} from '../../src/sources/browser.js'
import {listenLocal} from './listen.js'

export type FakePlayerSiteConfig = {
  /** Search results in all. */
  readonly results?: number
  readonly perPage?: number
  /** Heights every video is offered in, best first. */
  readonly heights?: readonly number[]
  /** Video ids whose page redirects home (removed). */
  readonly removed?: readonly string[]
  readonly mediaBytes?: number
  /** What a page past the last one answers: the last page again (default), no results, or 404. */
  readonly pastEnd?: 'repeat' | 'empty' | 'missing'
  /** Page 1 of a listing answers this late (the other pages answer first). */
  readonly firstPageDelayMs?: number
  /**
   * Listing pages answer only once this many are asked for at the same time
   * (or after 5 s): proves the pages go out together whatever the machine's
   * speed, where a stopwatch would only measure the machine.
   */
  readonly openingRound?: number
}

export type FakePlayerSite = {
  readonly origin: string
  readonly host: string
  /** Result ids in listing order. */
  readonly ids: readonly string[]
  readonly hits: {listing: number; video: number; media: number; resolved: number}
  /** With `openingRound`: whether that many pages were asked for at once (false: the 5 s ran out first). */
  readonly openedTogether: boolean | undefined
  /** Media paths requested, in order. */
  readonly mediaPaths: string[]
  /** Last-Modified of every media file, unix seconds. */
  readonly published: number
  /** Stands in for the app's browser: the player's link for a page. */
  readonly resolve: MediaResolver
  searchUrl(term: string, page?: number): string
  close(): Promise<void>
}

const MENU_IDS = ['900001', '900002', '900003']
const PUBLISHED = 1_660_831_500 // 2022-08-18T14:05:00Z

export async function startFakePlayerSite(config: FakePlayerSiteConfig = {}): Promise<FakePlayerSite> {
  const total = config.results ?? 195
  const perPage = config.perPage ?? 24
  const heights = config.heights ?? [1080, 720, 480]
  const removed = new Set(config.removed ?? [])
  const size = config.mediaBytes ?? 32 * 1024
  const ids = Array.from({length: total}, (_, i) => String(10_000 + total - i))
  const pages = Math.ceil(total / perPage)
  const hits = {listing: 0, video: 0, media: 0, resolved: 0}
  const mediaPaths: string[] = []
  let origin = ''
  // the opening-round gate: listing answers held until enough are open together
  const held: Array<() => void> = []
  let openedTogether: boolean | undefined
  let holdTimer: NodeJS.Timeout | undefined
  const release = (together: boolean) => {
    clearTimeout(holdTimer)
    openedTogether = together
    for (const answer of held.splice(0)) answer()
  }

  const card = (id: string) =>
    `<div class="item"><a href="/video/${id}/clip-${id}"> <div class="thumb-overlay"> <img src="/thumbs/${id}.jpg" title="Clip ${id} &amp; more" alt="Clip ${id}"/> <div class="duration"> <span class="hd-text-icon">HD</span> 12:${String(Number(id) % 60).padStart(2, '0')} </div></div></a>` +
    `<div class="content-info"><a href="/video/${id}/clip-${id}"> <span class="content-title">Clip ${id} &amp; more</span> </a></div></div>`

  const listing = (term: string, page: number) => {
    const link = (n: number, label = String(n)) =>
      `<li><a class="page-link" href="${origin}/search/videos/${term}?type=public&amp;page=${n}">${label}</a></li>`
    const around = [page - 3, page - 2, page - 1, page + 1, page + 2, page + 3].filter(n => n >= 1 && n <= pages)
    const pagination = `<ul class="pagination">${around.map(n => link(n)).join('')}${page < pages ? link(page + 1, '&raquo;') : ''}</ul>`
    return `<!DOCTYPE html><html><head><title>Search - Videos - Fake</title></head><body>
      <nav><div class="sub-menu-content">${MENU_IDS.map(card).join('')}</div></nav>
      <div class="well-filters"><h1>Search - Videos</h1></div>
      <div class="row">${ids
        .slice((page - 1) * perPage, page * perPage)
        .map(card)
        .join('')}</div>
      <div class="d-block">${pagination}</div><div class="d-none">${pagination}</div>
      <footer><h4>About</h4><a href="/video/900009/footer-link">not a result</a></footer></body></html>`
  }

  const videoPage = (id: string) => `<!DOCTYPE html><html><head>
    <meta property="og:title" content="Clip ${id} &amp; more">
    <meta property="og:image" content="${origin}/thumbs/${id}.jpg">
    <script>var video_duration = "61.5"; var video_id = "${id}";</script>
    <title>Clip ${id} - Fake</title></head><body>
    <script>let files = '{"files":[${heights.map(h => `{"src":"opaque","label":"${h}p", "res":"${h}"}`).join(',')}]}'</script>
    <video id="video" preload="auto" controls></video></body></html>`

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const parts = url.pathname.split('/').filter(Boolean)
    const send = (status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8', ...headers})
      res.end(body)
    }
    if (parts[0] === 'search') {
      hits.listing++
      const page = Number(url.searchParams.get('page') ?? 1)
      const answer = () => {
        if (page > pages && config.pastEnd === 'missing') return send(404, 'no such page')
        if (page > pages) return send(200, listing(parts[2] ?? '', config.pastEnd === 'empty' ? pages + 1 : pages))
        if (page === 1 && config.firstPageDelayMs) {
          setTimeout(() => send(200, listing(parts[2] ?? '', page)), config.firstPageDelayMs)
          return
        }
        return send(200, listing(parts[2] ?? '', page))
      }
      if (openedTogether !== undefined || !config.openingRound) return answer()
      held.push(answer)
      if (held.length >= config.openingRound) release(true)
      else if (held.length === 1) holdTimer = setTimeout(() => release(false), 5000)
      return
    }
    if (parts[0] === 'video') {
      hits.video++
      const id = parts[1] ?? ''
      if (removed.has(id) || !(ids.includes(id) || MENU_IDS.includes(id))) return send(301, '', {Location: '/'})
      return send(200, videoPage(id))
    }
    if (parts[0] === 'media') {
      hits.media++
      mediaPaths.push(url.pathname)
      const height = Number(/_(\d+)p\.mp4$/.exec(url.pathname)?.[1])
      if (!heights.includes(height)) return send(404, 'no')
      if (!(req.headers.referer ?? '').startsWith(origin)) return send(403, 'forbidden')
      const body = Buffer.alloc(size, String(height % 10))
      const modified = {'Last-Modified': new Date(PUBLISHED * 1000).toUTCString(), 'Accept-Ranges': 'bytes'}
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        return send(206, body.subarray(start), {
          ...modified,
          'Content-Length': String(size - start),
          'Content-Range': `bytes ${start}-${size - 1}/${size}`,
          'Content-Type': 'video/mp4',
        })
      }
      return send(200, body, {...modified, 'Content-Length': String(size), 'Content-Type': 'video/mp4'})
    }
    return send(200, '<html><h1>Home</h1></html>')
  })
  const port = await listenLocal(server)
  const host = 'localhost'
  origin = `http://${host}:${port}`

  return {
    origin,
    host,
    ids,
    hits,
    get openedTogether() {
      return openedTogether
    },
    mediaPaths,
    published: PUBLISHED,
    resolve: async pageUrl => {
      hits.resolved++
      const id = /\/video\/(\d+)/.exec(pageUrl)?.[1]
      // the player is given the best rendition
      return {url: `${origin}/media/videos/h264/${id}_${heights[0]}p.mp4`, cookies: [], userAgent: 'test-browser'}
    },
    searchUrl: (term, page) => `${origin}/search/videos/${term}?type=public${page ? `&page=${page}` : ''}`,
    close: () => {
      clearTimeout(holdTimer)
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}
