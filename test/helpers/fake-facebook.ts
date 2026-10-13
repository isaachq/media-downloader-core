// A local stand-in for Facebook, with the behaviours the real one has (and
// that the built-in extractor must survive): a video spread over several
// Relay objects in `data-sjs` scripts (urls in one, title and owner in
// another), HD and SD progressive urls under their several names, a Videos tab
// listed by cursor through the web client's pagination query (with the page's
// fb_dtsg / lsd tokens), stories for signed-in sessions only, login walls,
// removed videos, DASH-only videos, a CDN that wants a Referer.
import * as http from 'node:http'
import {listenLocal} from './listen.js'

export type FakeFacebookConfig = {
  readonly page?: string
  readonly videos?: number
  /** Story cards for the page: 'video' or 'image' each. */
  readonly stories?: ReadonlyArray<'video' | 'image'>
  /** Pages redirect to the login page unless the session is signed in. */
  readonly loginWall?: boolean
  /** The first N page answers are refused (429). */
  readonly refusals?: number
  /** Videos (by index) that only have a DASH manifest, no progressive url. */
  readonly dashOnly?: readonly number[]
  /** The pagination query id changed: the API answers errors. */
  readonly rotatedQueries?: boolean
  /** Videos per listing page. Default 8. */
  readonly pageSize?: number
  readonly mediaBytes?: number
}

export type FakeFacebook = {
  readonly origin: string
  readonly page: string
  readonly bucket: string
  readonly ids: readonly string[]
  readonly storyIds: readonly string[]
  readonly hits: Record<
    'video' | 'listing' | 'graphql' | 'stories' | 'media' | 'refusedMedia' | 'login' | 'refused' | 'short',
    number
  >
  close(): Promise<void>
}

const BASE_TIME = 1_790_000_000
const BUCKET = '100044000000001'
export const FB_SESSION_COOKIE = 'c_user=100044000000001'

export async function startFakeFacebook(config: FakeFacebookConfig = {}): Promise<FakeFacebook> {
  const page = config.page ?? 'fakepage'
  const count = config.videos ?? 3
  const size = config.mediaBytes ?? 48 * 1024
  const pageSize = config.pageSize ?? 8
  const ids = Array.from({length: count}, (_, i) => String(1_000_000_000_000_000n + BigInt(count - i)))
  const storyIds = (config.stories ?? []).map((_, i) => String(2_000_000_000_000_000n + BigInt(i + 1)))
  const hits = {video: 0, listing: 0, graphql: 0, stories: 0, media: 0, refusedMedia: 0, login: 0, refused: 0, short: 0}
  let refusalsLeft = config.refusals ?? 0
  let origin = ''

  const owner = () => ({__typename: 'Page', id: '555', name: 'Fake Page', url: `${origin}/${page}/`})
  /** The object with the media urls, as the player's query answers it. */
  const mediaNode = (index: number) => {
    const id = ids[index]!
    if (config.dashOnly?.includes(index)) {
      return {__typename: 'Video', id, videoId: id, dash_manifest: '<MPD/>', original_width: 1280, original_height: 720}
    }
    return {
      __typename: 'Video',
      id,
      videoId: id,
      playable_url: `${origin}/media/${id}/sd.mp4`,
      playable_url_quality_hd: `${origin}/media/${id}/hd.mp4`,
      videoDeliveryLegacyFields: {
        browser_native_sd_url: `${origin}/media/${id}/sd.mp4?dup=1`,
        browser_native_hd_url: `${origin}/media/${id}/hd.mp4`,
      },
      original_width: 1280,
      original_height: 720,
      playable_duration_in_ms: 61_500,
      thumbnailImage: {uri: `${origin}/thumb/${id}.jpg`},
    }
  }
  /** The object with the title and the owner, as the post's query answers it. */
  const infoNode = (index: number) => ({
    __typename: 'Video',
    id: ids[index]!,
    title: {text: `Video número ${index + 1} con acentos 🎬 #fb`},
    savable_description: {text: 'Descripción larga'},
    publish_time: BASE_TIME - index * 3600,
    owner: owner(),
    url: `${origin}/${page}/videos/${ids[index]}/`,
    permalink_url: `https://www.facebook.com/${page}/videos/${ids[index]}/`,
  })
  const listedNode = (index: number) => ({
    __typename: 'Video',
    id: ids[index]!,
    url: `${origin}/${page}/videos/${ids[index]}/`,
    title: {text: `Video número ${index + 1} con acentos 🎬 #fb`},
    playable_duration_in_ms: 61_500,
    publish_time: BASE_TIME - index * 3600,
    thumbnailImage: {uri: `${origin}/thumb/${ids[index]}.jpg`},
    owner: owner(),
  })
  const story = (index: number) => {
    const id = storyIds[index]!
    const kind = config.stories![index]!
    const media =
      kind === 'video'
        ? {
            __typename: 'Video',
            id,
            playable_url: `${origin}/media/${id}/sd.mp4`,
            browser_native_hd_url: `${origin}/media/${id}/hd.mp4`,
            playable_duration_in_ms: 5000,
            original_width: 720,
            original_height: 1280,
          }
        : {__typename: 'Photo', id, image: {uri: `${origin}/image/${id}/1.jpg`, width: 1080, height: 1920}}
    return {
      __typename: 'Story',
      id: `${id}0`,
      creation_time: BASE_TIME - index * 600,
      expiration_time: BASE_TIME + 86_400,
      owner: owner(),
      message: {text: index === 0 ? 'Primera historia' : ''},
      attachments: [{media}],
    }
  }
  const listing = (from: number) => {
    const slice = ids
      .slice(from, from + pageSize)
      .map((_, i) => ({node: {node: listedNode(from + i)}, cursor: `c${from + i}`}))
    const end = from + slice.length
    return {edges: slice, page_info: {has_next_page: end < count, end_cursor: end < count ? `CUR-${end}` : null}}
  }

  const sjs = (...payloads: unknown[]) =>
    `<!doctype html><html><head><title>Facebook</title></head><body>` +
    `<script>requireLazy(["x"], function(){ ${JSON.stringify(['DTSGInitialData', [], {token: 'dtsg-1'}]).slice(1, -1)}; ${JSON.stringify(['LSD', [], {token: 'lsd-1'}]).slice(1, -1)} })</script>` +
    payloads
      .map(
        payload =>
          `<script type="application/json" data-content-len="1" data-sjs>${JSON.stringify({require: [['ScheduledServerJS', 'handle', null, [{__bbox: {require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_x', {__bbox: {complete: true, result: {data: payload}}}]]]}}]]]})}</script>`,
      )
      .join('') +
    `</body></html>`

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const send = (status: number, body: string | Buffer, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, headers)
      res.end(body)
    }
    const html = (body: string, headers: http.OutgoingHttpHeaders = {}) =>
      send(200, body, {'Content-Type': 'text/html; charset=utf-8', ...headers})
    const json = (status: number, body: unknown) =>
      send(status, JSON.stringify(body), {'Content-Type': 'application/json'})
    const parts = url.pathname.split('/').filter(Boolean)
    const cookie = req.headers.cookie ?? ''
    const signedIn = cookie.includes(FB_SESSION_COOKIE)
    const isMedia = parts[0] === 'media' || parts[0] === 'image' || parts[0] === 'thumb'
    const isApi = parts[0] === 'api'

    if (parts[0] === 'login' || parts[0] === 'login.php') {
      return html('<html><body><form id="login_form">Log in</form></body></html>')
    }
    if (parts[0] === 'share') {
      hits.short++
      return send(302, '', {Location: `/watch/?v=${ids[0]}`})
    }
    if (isMedia) {
      hits.media++
      if (!(req.headers.referer ?? '').startsWith(origin)) {
        hits.refusedMedia++
        return send(403, 'forbidden')
      }
      if (parts[0] !== 'media') return send(200, Buffer.from(`JPEG ${parts[1]}`), {'Content-Type': 'image/jpeg'})
      const body = Buffer.alloc(size, parts[2]?.startsWith('hd') ? 'h' : '4')
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        return send(206, body.subarray(start), {'Content-Length': String(size - start)})
      }
      return send(200, body, {'Content-Length': String(size), 'Content-Type': 'video/mp4'})
    }
    if (refusalsLeft > 0) {
      refusalsLeft--
      hits.refused++
      return send(429, 'Too many requests')
    }
    if (config.loginWall && !signedIn && !isApi) {
      hits.login++
      return send(302, '', {Location: `/login/?next=${encodeURIComponent(url.pathname)}`})
    }

    if (isApi && parts[1] === 'graphql' && req.method === 'POST') {
      hits.graphql++
      let body = ''
      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        if (form.get('fb_dtsg') !== 'dtsg-1' || form.get('lsd') !== 'lsd-1')
          return json(200, {errors: [{message: 'Missing tokens'}]})
        if (config.rotatedQueries || form.get('doc_id') !== '8191727517565573') {
          return json(200, {errors: [{message: 'Query not found', summary: 'Unknown'}], data: null})
        }
        const variables = JSON.parse(form.get('variables') ?? '{}') as {cursor?: string; id?: string}
        if (variables.id !== 'COLLECTION-1') return json(200, {errors: [{message: 'Unknown node'}]})
        const from = Number((variables.cursor ?? 'CUR-0').replace('CUR-', ''))
        return json(200, {
          data: {node: {__typename: 'ProfileCometAppCollection', id: 'COLLECTION-1', pageItems: listing(from)}},
        })
      })
      return
    }

    const videoId =
      parts[0] === 'watch'
        ? url.searchParams.get('v')
        : parts[0] === 'reel'
          ? parts[1]
          : parts[1] === 'videos' && parts[2]
            ? parts[parts.length - 1]
            : undefined
    if (videoId !== undefined) {
      hits.video++
      const index = ids.indexOf(videoId ?? '')
      if (index === -1) return html("<html><body>This content isn't available right now</body></html>")
      return html(sjs({video: mediaNode(index)}, {node: infoNode(index)}), {'Set-Cookie': 'datr=d-1; Path=/'})
    }
    if (parts[0] === 'stories') {
      hits.stories++
      if (!signedIn) {
        hits.login++
        return send(302, '', {Location: `/login/?next=${encodeURIComponent(url.pathname)}`})
      }
      if (parts[1] !== BUCKET) return html("<html><body>This content isn't available right now</body></html>")
      const cards = (config.stories ?? []).map((_, i) => story(i))
      return html(
        sjs({bucket: {id: BUCKET, owner: owner(), unified_stories: {edges: cards.map(card => ({node: card}))}}}),
      )
    }
    if (parts[0] === page && (parts[1] === 'videos' || parts[1] === undefined)) {
      hits.listing++
      return html(
        sjs(
          {user: {id: '555', name: 'Fake Page', timeline_list_feed_units: {}}},
          {node: {__typename: 'ProfileCometAppCollection', id: 'COLLECTION-1', pageItems: listing(0)}},
        ),
      )
    }
    send(404, 'not found')
  })

  origin = `http://127.0.0.1:${await listenLocal(server)}`
  return {
    origin,
    page,
    bucket: BUCKET,
    ids,
    storyIds,
    hits,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
