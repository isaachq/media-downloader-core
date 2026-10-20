// A local stand-in for Instagram, with the behaviours the real one has (and
// that the built-in extractor must survive): the web client's API behind its
// X-IG-App-ID header, posts embedded in their pages, a profile listed by cursor
// through Relay queries (and through the signed-in feed with a session), stories
// for signed-in sessions only, login walls, rate limits ("please wait a few
// minutes"), rotated query ids, carousels and photos, media CDN with a Referer.
import * as http from 'node:http'
import {codeToPk} from '../../src/sources/instagram/data.js'
import {listenLocal} from './listen.js'
import {type RealMedia, serveReal} from './real-media.js'

export type FakeInstagramConfig = {
  readonly user?: string
  readonly posts?: number
  /** The account is private. */
  readonly private?: boolean
  /** Posts (by index, 0 = newest) that are photos. */
  readonly photos?: readonly number[]
  /** Posts (by index) that are carousels of 3 items: two photos and, with `mixedCarousels`, a video. */
  readonly carousels?: readonly number[]
  readonly mixedCarousels?: boolean
  /** Story items for the account: 'video' or 'image' each. */
  readonly stories?: ReadonlyArray<'video' | 'image'>
  /** Pages redirect to the login page and the API answers 401 unless the session is signed in. */
  readonly loginWall?: boolean
  /** The embed page answers 404, as if Instagram retired it. */
  readonly noEmbed?: boolean
  /** A logged-out post page carries no post data (as before Instagram's xig_polaris_media). */
  readonly noPage?: boolean
  /** Photo posts / carousels (by index) with a song (Instagram's music sticker): `music_metadata`. */
  readonly music?: readonly number[]
  /** The app's media info API answers 404, as if Instagram retired it. */
  readonly noAppApi?: boolean
  /** The first N page / API answers are rate limited ("please wait a few minutes"). */
  readonly refusals?: number
  /** Every page and API answer is 403 (a client the site won't serve). */
  readonly forbidden?: boolean
  /** The listing queries' ids changed: GraphQL answers errors for them. */
  readonly rotatedQueries?: boolean
  /** API answers a checkpoint (HTML) until a browser visited a page (cookie ig_ok=1). */
  readonly jsChallenge?: boolean
  /** With jsChallenge: even browsers get the checkpoint. */
  readonly captcha?: boolean
  readonly mediaBytes?: number
  /** Real files to serve as the media (the nightly matrix); synthetic bytes without it. */
  readonly media?: RealMedia | undefined
  /** Posts the account counts but never lists. */
  readonly unlisted?: number
  /** The 2nd listing page repeats the 1st (cursor stall). */
  readonly repeatPage?: boolean
}

export type FakeInstagram = {
  readonly origin: string
  readonly user: string
  readonly userId: string
  readonly ids: readonly string[]
  readonly codes: readonly string[]
  readonly storyIds: readonly string[]
  readonly hits: Record<
    | 'page'
    | 'embed'
    | 'app'
    | 'profile'
    | 'graphql'
    | 'feed'
    | 'stories'
    | 'media'
    | 'refusedMedia'
    | 'login'
    | 'refused'
    | 'short',
    number
  >
  close(): Promise<void>
}

const BASE_TIME = 1_790_000_000
const USER_ID = '7777'
export const SESSION_COOKIE = 'sessionid=fake-session'

export async function startFakeInstagram(config: FakeInstagramConfig = {}): Promise<FakeInstagram> {
  const user = config.user ?? 'fakeuser'
  const count = config.posts ?? 3
  const size = config.mediaBytes ?? 48 * 1024
  const ids = Array.from({length: count}, (_, i) => String(3_500_000_000_000_000_000n + BigInt(count - i)))
  const codes = ids.map((_, i) => `C0DE${String(count - i).padStart(6, '0')}`)
  const storyIds = (config.stories ?? []).map((_, i) => String(3_600_000_000_000_000_000n + BigInt(i + 1)))
  const hits = {
    page: 0,
    embed: 0,
    app: 0,
    profile: 0,
    graphql: 0,
    feed: 0,
    stories: 0,
    media: 0,
    refusedMedia: 0,
    login: 0,
    refused: 0,
    short: 0,
  }
  let refusalsLeft = config.refusals ?? 0
  let listCalls = 0
  let origin = ''

  const image = (id: string, n: number, w = 1080, h = 1350) => ({
    image_versions2: {
      candidates: [
        {url: `${origin}/image/${id}/${n}.jpg`, width: w, height: h},
        {url: `${origin}/image/${id}/${n}-small.jpg`, width: 640, height: 800},
      ],
    },
    original_width: w,
    original_height: h,
  })
  const videoVersions = (id: string) => [
    {type: 101, url: `${origin}/media/${id}/hd.mp4`, width: 1080, height: 1920, bandwidth: 2_000_000},
    {type: 102, url: `${origin}/media/${id}/sd.mp4`, width: 720, height: 1280, bandwidth: 900_000},
    {type: 102, url: `${origin}/media/${id}/hd.mp4`, width: 1080, height: 1920}, // a duplicate url: ignored
  ]
  const song = (id: string) => ({
    music_metadata: {
      music_canonical_id: '0',
      audio_type: 'licensed_music',
      music_info: {
        music_asset_info: {
          progressive_download_url: `${origin}/audio/${id}.m4a`,
          duration_in_ms: (config.media?.soundDuration ?? 30) * 1000,
          title: 'Canción',
          display_artist: 'Artista',
        },
      },
    },
  })
  /** A post as a v1 item (the API, the timeline query, the post page). */
  const v1 = (index: number) => {
    const id = ids[index]!
    const base = {
      ...(config.music?.includes(index) && song(id)),
      pk: id,
      id: `${id}_${USER_ID}`,
      code: codes[index]!,
      taken_at: BASE_TIME - index * 3600,
      caption: {text: `Post número ${index + 1} con acentos 🎵 #fyp #music`},
      user: {pk: USER_ID, username: user, full_name: 'Fake User'},
    }
    if (config.carousels?.includes(index)) {
      const children = [
        {pk: `${id}1`, media_type: 1, ...image(id, 1)},
        {pk: `${id}2`, media_type: 1, ...image(id, 2, 1080, 1080)},
        ...(config.mixedCarousels
          ? [
              {
                pk: `${id}3`,
                media_type: 2,
                video_versions: videoVersions(id),
                video_duration: config.media?.duration ?? 7.5,
                ...image(id, 3),
              },
            ]
          : [{pk: `${id}3`, media_type: 1, ...image(id, 3)}]),
      ]
      return {...base, media_type: 8, carousel_media: children}
    }
    if (config.photos?.includes(index)) return {...base, media_type: 1, ...image(id, 1)}
    return {
      ...base,
      media_type: 2,
      video_versions: videoVersions(id),
      video_duration: config.media?.duration ?? 12.3,
      ...image(id, 0, 1080, 1920),
    }
  }
  /** The same post as a GraphQL node (the profile info, the post query). */
  const node = (index: number) => {
    const id = ids[index]!
    const item = v1(index) as Record<string, unknown>
    const toNode = (child: Record<string, unknown>, childId: string) => {
      const versions = child['video_versions'] as Array<{url: string}> | undefined
      const candidates = (child['image_versions2'] as {candidates: Array<{url: string; width: number; height: number}>})
        .candidates
      return {
        __typename: versions ? 'XDTGraphVideo' : 'XDTGraphImage',
        id: childId,
        is_video: Boolean(versions),
        ...(versions && {video_url: versions[0]!.url, video_duration: child['video_duration']}),
        display_url: candidates[0]!.url,
        display_resources: candidates.map(c => ({src: c.url, config_width: c.width, config_height: c.height})),
        dimensions: {width: child['original_width'], height: child['original_height']},
      }
    }
    const children = item['carousel_media'] as Array<Record<string, unknown>> | undefined
    return {
      ...(children ? {__typename: 'XDTGraphSidecar'} : toNode(item, id)),
      id,
      shortcode: codes[index]!,
      taken_at_timestamp: item['taken_at'],
      owner: {id: USER_ID, username: user, full_name: 'Fake User'},
      edge_media_to_caption: {edges: [{node: {text: (item['caption'] as {text: string}).text}}]},
      ...(children && {
        edge_sidecar_to_children: {edges: children.map(c => ({node: toNode(c, String(c['pk']))}))},
        display_url: `${origin}/image/${id}/1.jpg`,
        dimensions: {width: 1080, height: 1350},
      }),
    }
  }
  const story = (index: number) => {
    const id = storyIds[index]!
    const kind = config.stories![index]!
    return {
      pk: id,
      id: `${id}_${USER_ID}`,
      media_type: kind === 'video' ? 2 : 1,
      taken_at: BASE_TIME - index * 600,
      expiring_at: BASE_TIME + 86_400,
      user: {pk: USER_ID, username: user, full_name: 'Fake User'},
      ...image(id, 0, 1080, 1920),
      ...(kind === 'video' && {video_versions: videoVersions(id), video_duration: 5}),
    }
  }

  const sjs = (payload: unknown) =>
    `<!doctype html><html><head><title>Instagram</title></head><body>` +
    `<script type="application/json" data-content-len="1" data-sjs>${JSON.stringify({require: [['ScheduledServerJS', 'handle', null, [{__bbox: {require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_1', {__bbox: {complete: true, result: {data: payload}}}]]]}}]]]})}</script>` +
    `</body></html>`

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const send = (status: number, body: string | Buffer, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, headers)
      res.end(body)
    }
    const json = (status: number, body: unknown) =>
      send(status, JSON.stringify(body), {'Content-Type': 'application/json; charset=utf-8'})
    const parts = url.pathname.split('/').filter(Boolean)
    const cookie = req.headers.cookie ?? ''
    const signedIn = cookie.includes(SESSION_COOKIE)
    const isApi = parts[0] === 'api' || parts[0] === 'graphql'
    const isPage =
      !isApi && parts[0] !== 'media' && parts[0] !== 'image' && parts[0] !== 'audio' && parts[0] !== 'accounts'

    if (parts[0] === 'accounts') {
      return send(200, '<html><body><form id="loginForm">Log in</form></body></html>', {'Content-Type': 'text/html'})
    }
    if (parts[0] === 'share') {
      hits.short++
      return send(302, '', {Location: `/p/${codes[0]}/`})
    }
    if (parts[0] === 'media' || parts[0] === 'image' || parts[0] === 'audio') {
      hits.media++
      if (!(req.headers.referer ?? '').startsWith(origin)) {
        hits.refusedMedia++
        return send(403, 'forbidden')
      }
      if (parts[0] === 'audio') {
        if (config.media?.sound) {
          const real = serveReal(config.media.sound, 'audio/mp4', req.headers.range)
          return send(real.status, real.body, real.headers)
        }
        return send(200, Buffer.from(`M4A ${parts[1]}`), {'Content-Type': 'audio/mp4'})
      }
      if (parts[0] === 'image') {
        if (config.media?.image) {
          const real = serveReal(config.media.image, 'image/jpeg', req.headers.range)
          return send(real.status, real.body, real.headers)
        }
        return send(200, Buffer.from(`JPEG ${parts[1]} ${parts[2]}`), {'Content-Type': 'image/jpeg'})
      }
      if (config.media?.video) {
        const file = parts[2] === 'hd.mp4' ? (config.media.hd ?? config.media.video) : config.media.video
        const real = serveReal(file, 'video/mp4', req.headers.range)
        return send(real.status, real.body, real.headers)
      }
      // content tells the encodings apart: "h" HD, "4" SD
      const body = Buffer.alloc(size, parts[2] === 'hd.mp4' ? 'h' : '4')
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        return send(206, body.subarray(start), {'Content-Length': String(size - start)})
      }
      return send(200, body, {'Content-Length': String(size), 'Content-Type': 'video/mp4'})
    }

    if (config.forbidden && (isApi || isPage)) {
      hits.refused++
      return send(403, 'forbidden')
    }
    if (refusalsLeft > 0 && (isApi || isPage)) {
      refusalsLeft--
      hits.refused++
      if (isApi) return json(429, {message: 'Please wait a few minutes before you try again.', status: 'fail'})
      return send(429, 'Please wait a few minutes before you try again.')
    }
    if (config.jsChallenge && isApi && !cookie.includes('ig_ok=1')) {
      return send(200, '<html><body><a href="/challenge/">checkpoint_required</a></body></html>', {
        'Content-Type': 'text/html',
      })
    }
    if (config.loginWall && !signedIn) {
      if (isApi) return json(401, {message: 'login_required', status: 'fail'})
      if (isPage) {
        hits.login++
        return send(302, '', {Location: `/accounts/login/?next=${encodeURIComponent(url.pathname)}`})
      }
    }

    if (isApi && req.headers['x-ig-app-id'] !== '936619743392459') return send(400, 'missing app id')

    // the app's own API, asked as the app: /api/v1/media/<pk>/info/
    if (parts[0] === 'api' && parts[2] === 'media' && parts[4] === 'info') {
      hits.app++
      if (config.noAppApi) return send(404, 'not found')
      if (!String(req.headers['user-agent']).startsWith('Instagram '))
        return json(400, {message: 'useragent mismatch', status: 'fail'})
      const index = codes.findIndex(code => codeToPk(code) === parts[3])
      if (index === -1) return json(400, {message: 'Media not found or unavailable', status: 'fail'})
      return json(200, {items: [v1(index)], num_results: 1, status: 'ok'})
    }
    if (parts[0] === 'api' && parts[3] === 'web_profile_info') {
      hits.profile++
      if (url.searchParams.get('username') !== user) return json(404, {message: 'Not Found', status: 'fail'})
      const total = count + (config.unlisted ?? 0)
      const first = ids.slice(0, 12).map((_, i) => ({node: node(i)}))
      return json(200, {
        data: {
          user: {
            id: USER_ID,
            username: user,
            full_name: 'Fake User',
            is_private: config.private === true,
            edge_owner_to_timeline_media: {
              count: total,
              page_info: {has_next_page: count > 12, end_cursor: count > 12 ? 'GQL-12' : null},
              edges: config.private ? [] : first,
            },
          },
        },
        status: 'ok',
      })
    }
    if (parts[0] === 'api' && parts[2] === 'feed' && parts[3] === 'reels_media') {
      hits.stories++
      if (!signedIn) return json(401, {message: 'login_required', status: 'fail'})
      const reelId = url.searchParams.get('reel_ids') ?? ''
      if (reelId !== USER_ID && reelId !== `highlight:${USER_ID}`) return json(200, {reels: {}, status: 'ok'})
      const items = (config.stories ?? []).map((_, i) => story(i)).reverse() // Instagram lists oldest first
      return json(200, {
        reels: {
          [reelId]: {
            id: reelId,
            items,
            user: {pk: USER_ID, username: user},
            ...(reelId.startsWith('highlight') && {title: 'Mi highlight'}),
          },
        },
        reels_media: [{id: reelId, items}],
        status: 'ok',
      })
    }
    const listPage = (cursor: string | undefined, pageSize: number) => {
      listCalls++
      const start = cursor ? Number(cursor.replace(/^\D+/, '')) : 0
      const from = config.repeatPage && listCalls === 2 ? 0 : start
      const items = ids.slice(from, from + pageSize).map((_, i) => v1(from + i))
      const end = from + items.length
      return {items, more: end < count, next: end < count ? `CUR-${end}` : undefined}
    }
    if (parts[0] === 'api' && parts[2] === 'feed' && parts[3] === 'user') {
      hits.feed++
      if (!signedIn) return json(401, {message: 'login_required', status: 'fail'})
      if (parts[4] !== USER_ID) return json(404, {message: 'Not Found', status: 'fail'})
      if (config.private && !signedIn) return json(200, {items: [], more_available: false, status: 'ok'})
      const page = listPage(url.searchParams.get('max_id') ?? undefined, Number(url.searchParams.get('count')) || 12)
      return json(200, {items: page.items, more_available: page.more, next_max_id: page.next ?? null, status: 'ok'})
    }
    if (parts[0] === 'graphql' && req.method === 'POST') {
      hits.graphql++
      let body = ''
      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        const docId = form.get('doc_id')
        const variables = JSON.parse(form.get('variables') ?? '{}') as Record<string, unknown>
        if (docId === '8845758582119845') {
          const index = codes.indexOf(String(variables['shortcode']))
          if (index === -1) return json(200, {data: {xdt_shortcode_media: null}, status: 'ok'})
          return json(200, {data: {xdt_shortcode_media: node(index)}, status: 'ok'})
        }
        if (docId === '9310670392322965' || docId === '7898261790222653') {
          if (config.rotatedQueries) return json(200, {errors: [{message: 'Query not found'}], data: null})
          if (config.private && !signedIn) {
            return json(200, {
              data: {
                xdt_api__v1__feed__user_timeline_graphql_connection: {
                  edges: [],
                  page_info: {has_next_page: false, end_cursor: null},
                },
              },
            })
          }
          const page = listPage(typeof variables['after'] === 'string' ? variables['after'] : undefined, 12)
          return json(200, {
            data: {
              xdt_api__v1__feed__user_timeline_graphql_connection: {
                edges: page.items.map(item => ({node: item, cursor: 'x'})),
                page_info: {has_next_page: page.more, end_cursor: page.next ?? null},
              },
            },
            status: 'ok',
          })
        }
        return json(200, {errors: [{message: 'Unknown query'}], data: null})
      })
      return
    }

    // the embed page: the post as the embed's contextJSON (a GraphQL node)
    if (parts[0] === 'p' && parts[2] === 'embed') {
      hits.embed++
      if (config.noEmbed) return send(404, 'not found')
      // as Instagram since October 2026: the embed is a page load or it is the login page
      if (req.headers['sec-fetch-mode'] !== 'navigate') {
        return send(200, '<html><body><form id="loginForm" action="/accounts/login/"></form></body></html>', {
          'Content-Type': 'text/html',
        })
      }
      const index = codes.indexOf(parts[1] ?? '')
      // as Instagram since October 2026: a post without a video is drawn by the server, contextJSON null
      const item = index === -1 ? undefined : (v1(index) as Record<string, unknown>)
      const children = item?.['carousel_media'] as Array<Record<string, unknown>> | undefined
      const hasVideo = item !== undefined && (children ?? [item]).some(c => c['video_versions'] !== undefined)
      if (item && !hasVideo) {
        return send(
          200,
          `<!DOCTYPE html><html><head><title>Instagram</title></head><body><img class="EmbeddedMediaImage" src="${origin}/image/${ids[index]}/1.jpg"><script>(function(){require("EmbedSimple").init({"contextJSON":null});})();</script></body></html>`,
          {'Content-Type': 'text/html'},
        )
      }
      const context = JSON.stringify({gql_data: {shortcode_media: index === -1 ? null : node(index)}})
      return send(
        200,
        `<!DOCTYPE html><html><head><title>Instagram</title></head><body><script>(function(){require("EmbedSimple").init(${JSON.stringify({contextJSON: context})});})();</script></body></html>`,
        {'Content-Type': 'text/html', 'Set-Cookie': 'csrftoken=csrf-1; Path=/'},
      )
    }
    if (parts[0] === 'p' || parts[0] === 'reel') {
      hits.page++
      const index = codes.indexOf(parts[1] ?? '')
      if (index === -1) {
        return send(200, "<html><body>Sorry, this page isn't available.</body></html>", {'Content-Type': 'text/html'})
      }
      // a logged-out visitor: the item as xig_polaris_media (every picture of a carousel, the song)
      if (!signedIn) {
        if (config.noPage) return send(200, '<html><head><title>Post</title></head><body></body></html>')
        return send(
          200,
          sjs({xig_polaris_media: {__typename: 'XIGPolarisImageMedia', if_not_gated_logged_out: v1(index)}}),
          {
            'Content-Type': 'text/html',
            'Set-Cookie': 'csrftoken=csrf-1; Path=/',
          },
        )
      }
      return send(200, sjs({xdt_api__v1__media__shortcode__web_info: {items: [v1(index)]}}), {
        'Content-Type': 'text/html',
        'Set-Cookie': 'csrftoken=csrf-1; Path=/',
      })
    }
    if (parts[0] === user && !parts[1]) {
      hits.profile++
      return send(200, '<html><body><div id="profile">profile page</div></body></html>', {
        'Content-Type': 'text/html',
        'Set-Cookie': ['csrftoken=csrf-1; Path=/', 'ig_did=did-1; Path=/'],
      })
    }
    send(404, 'not found')
  })

  origin = `http://127.0.0.1:${await listenLocal(server)}`
  return {
    origin,
    user,
    userId: USER_ID,
    ids,
    codes,
    storyIds,
    hits,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
