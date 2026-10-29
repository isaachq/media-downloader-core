// A local stand-in for Threads' web pages, its listing query and its media CDN,
// with the shapes the real ones served (verified live 2026-10-26, trimmed to
// what is read): pages served with their data only to a page load
// (Sec-Fetch-Mode: navigate; anything else gets the gating shell); the data in
// `<script type="application/json" data-sjs>` blocks as Relay preloaders
// (`adp_<Query>RelayPreloader_<hash>` → `__bbox.result`), the queries the page's
// client sent (`queryID`, `variables`, `queryName`) and the LSD token; a post
// page's `BarcelonaPostPageTargetQuery` → `data.media` (a v1 item: progressive
// MP4 `video_versions` without sizes, a DASH manifest, `image_versions2`
// candidates best first, `carousel_media`, media_type 1 / 2 / 8 / 19); a
// profile page's `BarcelonaProfilePageDirectQuery` → `data.user` and its first 4
// threads with a base64-wrapped cursor (which the site ignores); `POST
// /api/graphql` paging the threads tab 10 threads at a time by GraphQL's own
// cursor; `/t/<code>` → 301 to the post page; a gone post → 302 home with
// `?error=invalid_post`; an unknown account → 302 to the login page; media
// with Range.
import * as http from 'node:http'
import {listenLocal} from './listen.js'

export type FakeThreads = {
  readonly origin: string
  readonly codes: {
    readonly video: string
    readonly photo: string
    readonly carousel: string
    readonly photos: string
    readonly text: string
    readonly gone: string
    readonly changed: string
    readonly hidden: string
  }
  /** The ids of @zuck's posts with media, newest first: what a whole listing must give. */
  readonly zuckMedia: readonly string[]
  readonly hits: Record<'page' | 'shell' | 'graphql' | 'media' | 'refused', number>
  /** Page paths asked for, in order. */
  readonly pages: readonly string[]
  /** Every listing query: its variables as sent. */
  readonly queries: ReadonlyArray<Readonly<Record<string, unknown>>>
  /** Requests that carried the sessionid cookie. */
  readonly signedInRequests: number
  close(): Promise<void>
}

export type FakeThreadsConfig = {
  /** The first N page reads are refused (429). */
  readonly refusals?: number
  /**
   * The site refuses the signed-in session: any page or query request carrying
   * the sessionid cookie answers 400 (counted in `hits.refused`); a request
   * without it is answered as usual. Media never asks for the cookie.
   */
  readonly sessionRefused?: boolean
}

const SESSION = 'sessionid'
/** Media urls are written before the port is known: the origin goes in as each answer is sent. */
const HERE = 'http://fake-threads.invalid'
const LSD = 'AdSXQNsKgefcwrooEaqcu2TDTA0'
const TAB_DOC_ID = '29174122042225760'
const PAGE_CURSOR = 'QVFCSDZQMDNFdGl1LWVZTGpLbF9ieTVLX2Nadzk2aVVvTXV0blRybHBZVHRL'
const ZUCK = {pk: '63055343223', username: 'zuck', full_name: 'Mark Zuckerberg'}
const OTHER = {pk: '314216', username: 'instagram', full_name: 'Instagram'}
const HIDDEN = {pk: '777000111', username: 'hiddenone', full_name: 'Hidden One'}
const CHATTY = {pk: '5550001', username: 'chatty', full_name: 'Chatty'}
const STUCK = {pk: '5550002', username: 'stuck', full_name: 'Stuck'}
/** Threads on @zuck's profile, newest first. */
const ZUCK_THREADS = 33
/** Threads on @chatty's: all text but the oldest (a photo). */
const CHATTY_THREADS = 35

const CODES = {
  video: 'DHV7vTivqWD',
  photo: 'DeZgeQhm6RW',
  carousel: 'DJDhoQfxb43',
  photos: 'DZ7eGA1G7wU',
  text: 'DeZtp7KER52',
  gone: 'AAAAAAAAAAA',
  changed: 'Changed0001',
  hidden: 'HiddenPost1',
} as const

export async function startFakeThreads(config: FakeThreadsConfig = {}): Promise<FakeThreads> {
  const hits = {page: 0, shell: 0, graphql: 0, media: 0, refused: 0}
  const pages: string[] = []
  const queries: Array<Record<string, unknown>> = []
  let signedInRequests = 0
  let refusalsLeft = config.refusals ?? 0
  let origin = ''
  /** Links expire in a day (the CDN's `oe`, hex unix seconds). */
  const oe = Math.floor(Date.now() / 1000 + 86_400).toString(16)
  const mediaUrl = (name: string, ext: 'mp4' | 'jpg' | 'webp') =>
    `${HERE}/v/t51/${name}.${ext}?stp=dst-jpg&_nc_cat=103&oh=00_x&oe=${oe}`

  // ─── v1 items, as the site writes them ──────────────────────────────────
  const candidates = (name: string, width: number, height: number) => [
    {url: mediaUrl(`${name}-full`, 'jpg'), width, height},
    {url: mediaUrl(`${name}-640`, 'jpg'), width: 640, height: Math.round((640 * height) / width)},
    {url: mediaUrl(`${name}-320`, 'webp'), width: 320, height: Math.round((320 * height) / width)},
  ]
  const manifest = (seconds: number) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${seconds}S"><Period id="0"></Period></MPD>`
  const textInfo = (pinned = false) => ({
    is_reply: false,
    pinned_post_info: {is_pinned_to_parent_post: false, is_pinned_to_profile: pinned},
    share_info: {quoted_post: null, reposted_post: null},
    direct_reply_count: 3,
  })
  const base = (pk: string, code: string, user: typeof ZUCK, type: number, caption: string, at: number) => ({
    pk,
    id: `${pk}_${user.pk}`,
    code,
    media_type: type,
    user: {...user, id: user.pk, is_verified: true, text_post_app_is_private: user === HIDDEN},
    caption: caption ? {text: caption} : null,
    taken_at: at,
    text_post_app_info: textInfo(),
    image_versions2: {candidates: []},
    original_width: 612,
    original_height: 612,
    video_versions: null,
    carousel_media: null,
    giphy_media_info: null,
    like_count: 10,
  })
  const videoOf = (pk: string, name: string, width: number, height: number, seconds: number) => ({
    pk,
    id: pk,
    media_type: 2,
    original_width: width,
    original_height: height,
    // three entries, one file, no sizes: what the site sends
    video_versions: [101, 102, 103].map(type => ({type, url: mediaUrl(name, 'mp4')})),
    video_dash_manifest: manifest(seconds),
    is_dash_eligible: 1,
    has_audio: true,
    image_versions2: {candidates: candidates(`${name}-cover`, width, height)},
  })
  const photoOf = (pk: string, name: string, width: number, height: number) => ({
    pk,
    id: pk,
    media_type: 1,
    original_width: width,
    original_height: height,
    video_versions: null,
    image_versions2: {candidates: candidates(name, width, height)},
  })
  const video = (pk: string, code: string, user: typeof ZUCK, caption: string, at: number) => ({
    ...base(pk, code, user, 2, caption, at),
    ...videoOf(pk, `v${pk}`, 720, 1280, 11.145578),
    id: `${pk}_${user.pk}`,
  })
  const photo = (pk: string, code: string, user: typeof ZUCK, caption: string, at: number) => ({
    ...base(pk, code, user, 1, caption, at),
    ...photoOf(pk, `p${pk}`, 1440, 1800),
    id: `${pk}_${user.pk}`,
  })
  const carousel = (pk: string, code: string, user: typeof ZUCK, caption: string, at: number, withVideo: boolean) => ({
    ...base(pk, code, user, 8, caption, at),
    original_width: 3530,
    original_height: 2214,
    image_versions2: {candidates: candidates(`c${pk}-cover`, 3530, 2214)},
    carousel_media: [
      photoOf(`${pk}1`, `c${pk}-1`, 3530, 2214),
      withVideo ? videoOf(`${pk}2`, `c${pk}-2`, 720, 1280, 11.145578) : photoOf(`${pk}2`, `c${pk}-2`, 1080, 1350),
      photoOf(`${pk}3`, `c${pk}-3`, 2048, 2560),
    ],
  })
  const text = (pk: string, code: string, user: typeof ZUCK, caption: string, at: number) =>
    base(pk, code, user, 19, caption, at)

  // the single posts any page can name
  const posts = new Map<string, Record<string, unknown>>([
    [
      CODES.video,
      video('3591039013441414531', CODES.video, ZUCK, 'Me finding out Llama hit 1 BILLION downloads.', 1742305717),
    ],
    [CODES.photo, photo('4006376160339141718', CODES.photo, ZUCK, 'Muse ordered me 🍉 how thoughtful!', 1791817277)],
    [
      CODES.carousel,
      carousel('3621886427362868791', CODES.carousel, ZUCK, 'Hosted our first ever LlamaCon today', 1745960000, true),
    ],
    [CODES.photos, carousel('3990000000000000001', CODES.photos, ZUCK, 'Our new line of glasses', 1782219462, false)],
    [
      CODES.text,
      text('4006434140014576097', CODES.text, ZUCK, 'You can use Muse Wonder to power your Muse', 1791824188),
    ],
    [CODES.hidden, photo('7770001110000000001', CODES.hidden, HIDDEN, 'Only for followers', 1791000000)],
  ])

  // ─── profiles: threads of posts, newest first ───────────────────────────
  type Thread = {readonly id: string; readonly items: ReadonlyArray<Record<string, unknown>>}
  const zuckThreads: Thread[] = []
  const zuckMedia: string[] = []
  for (let i = 0; i < ZUCK_THREADS; i++) {
    const at = 1791824189 - i * 3600
    const pk = String(4100000000000000000n - BigInt(i) * 1000n)
    const code = `Dz${String(i).padStart(9, '0')}`
    let items: Array<Record<string, unknown>>
    switch (i % 5) {
      case 0:
        items = [video(pk, code, ZUCK, `Video ${i}`, at)]
        break
      case 1:
        items = [photo(pk, code, ZUCK, `Photo ${i}`, at)]
        break
      case 2:
        items = [carousel(pk, code, ZUCK, `Carousel ${i}`, at, i % 2 === 0)]
        break
      case 3:
        // a text post, and a repost of someone else's photo: neither is listed
        items = [
          text(pk, code, ZUCK, `Text ${i}`, at),
          photo(`${pk}9`, `${code}R`, OTHER, 'Someone else’s photo', at - 10),
        ]
        break
      default:
        // a self-thread: text first, its photo second
        items = [
          text(pk, code, ZUCK, `Thread ${i}`, at),
          photo(`${pk}5`, `${code}S`, ZUCK, `Thread ${i} photo`, at + 1),
        ]
    }
    if (i === 1) items[0]!['text_post_app_info'] = textInfo(true)
    for (const item of items) {
      if (item['media_type'] !== 19 && (item['user'] as {pk: string}).pk === ZUCK.pk) zuckMedia.push(String(item['pk']))
    }
    zuckThreads.push({id: `thread-${pk}`, items})
  }
  const chattyThreads: Thread[] = Array.from({length: CHATTY_THREADS}, (_, i) => {
    const pk = String(4200000000000000000n - BigInt(i) * 1000n)
    const code = `Dc${String(i).padStart(9, '0')}`
    const at = 1791824189 - i * 60
    return {
      id: `thread-${pk}`,
      items: [
        i === CHATTY_THREADS - 1 ? photo(pk, code, CHATTY, 'Finally a photo', at) : text(pk, code, CHATTY, 'hi', at),
      ],
    }
  })
  const stuckThreads: Thread[] = Array.from({length: 10}, (_, i) => {
    const pk = String(4300000000000000000n - BigInt(i) * 1000n)
    return {
      id: `thread-${pk}`,
      items: [photo(pk, `Ds${String(i).padStart(9, '0')}`, STUCK, `Stuck ${i}`, 1791824189 - i)],
    }
  })
  const hiddenThreads: Thread[] = [{id: 'thread-hidden', items: [posts.get(CODES.hidden)!]}]
  const accounts = new Map<string, {readonly user: typeof ZUCK; readonly threads: readonly Thread[]}>([
    ['zuck', {user: ZUCK, threads: zuckThreads}],
    ['chatty', {user: CHATTY, threads: chattyThreads}],
    ['stuck', {user: STUCK, threads: stuckThreads}],
    ['hiddenone', {user: HIDDEN, threads: hiddenThreads}],
  ])
  const byPk = new Map([...accounts.values()].map(account => [account.user.pk, account]))

  const edges = (threads: readonly Thread[]) =>
    threads.map(thread => ({
      node: {
        thread_items: thread.items.map(post => ({post, line_type: 'line', should_show_replies_cta: false})),
        id: thread.id,
        __typename: 'XDTThread',
      },
      __typename: 'XDTUserTextPostsResponseEdge',
      cursor: '',
    }))
  const mediaData = (threads: readonly Thread[], next: string | undefined) => ({
    edges: edges(threads),
    page_info: {
      end_cursor: next ?? null,
      has_next_page: next !== undefined,
      has_previous_page: false,
      start_cursor: null,
    },
  })

  // ─── pages ──────────────────────────────────────────────────────────────
  const block = (body: unknown) =>
    `<script type="application/json" nonce="n0nc3" data-content-len="${JSON.stringify(body).length}" data-sjs>${JSON.stringify(body)}</script>`
  const preloader = (query: string, result: unknown) =>
    block({
      require: [
        [
          'ScheduledServerJS',
          'handle',
          null,
          [
            {
              __bbox: {
                require: [
                  [
                    'RelayPrefetchedStreamCache',
                    'next',
                    [],
                    [`adp_${query}RelayPreloader_6ae0155687a1255586`, {__bbox: {complete: true, result}}],
                  ],
                ],
              },
            },
          ],
        ],
      ],
    })
  const queryDef = (query: string, id: string, variables: Record<string, unknown>) =>
    block({
      require: [
        [
          'RequireDeferredReference',
          'requireDeferred',
          [],
          [
            {
              actorID: '0',
              preloaderID: `adp_${query}RelayPreloader_6ae0155687a1255586`,
              queryID: id,
              variables,
              queryName: query,
            },
          ],
        ],
      ],
    })
  const lsdBlock = () => block({define: [['LSD', [], {token: LSD}, 323]], require: []})
  const page = (title: string, blocks: string) =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>${title}</title>` +
    `<script nonce="n0nc3" src="data:application/x-javascript;base64,Oy8q"></script></head><body>` +
    `<script id="envjson" type="application/json" nonce="n0nc3">{"x":1}</script>${blocks}</body></html>`
  /** What a client that doesn't say "page load" gets: the app shell, no data. */
  const shell = () => page('Threads', lsdBlock())
  const tabVariables = (userID: string) => ({
    allow_page_info_for_lox_user: true,
    first: 4,
    userID,
    __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
    __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
  })

  const profilePage = (name: string) => {
    const account = accounts.get(name)!
    const {user, threads} = account
    const visible = user !== HIDDEN
    return page(
      `${user.full_name} (&#064;${user.username}) • Threads, Say more`,
      lsdBlock() +
        preloader('BarcelonaProfilePageDirectQuery', {
          data: {
            user: {
              ...user,
              id: user.pk,
              text_post_app_is_private: !visible,
              follower_count: 5752253,
              is_verified: true,
              biography: 'Mostly superintelligence',
            },
          },
          extensions: {is_final: true},
        }) +
        queryDef('BarcelonaProfilePageDirectQuery', '29983026914619878', {userID: user.pk}) +
        (visible
          ? preloader('BarcelonaProfileThreadsTabDirectQuery', {
              data: {mediaData: mediaData(threads.slice(0, 4), PAGE_CURSOR), viewer: {user: null}},
              extensions: {is_final: true},
            }) + queryDef('BarcelonaProfileThreadsTabDirectQuery', TAB_DOC_ID, tabVariables(user.pk))
          : ''),
    )
  }
  const postPage = (code: string) => {
    const post = posts.get(code)!
    // what a post page also carries: the thread under it (another post with its own code)
    const reply = text('4999999999999999999', 'ReplyCode01', OTHER, 'Nice', 1791824190)
    return page(
      String((post['caption'] as {text?: string} | null)?.text ?? 'Threads'),
      lsdBlock() +
        preloader('BarcelonaPostPageTargetQuery', {
          data: {media: post, viewer: {user: null}},
          extensions: {is_final: true},
        }) +
        preloader('BarcelonaPostPageDownwardQuery', {
          data: {data: {edges: edges([{id: 'thread-reply', items: [reply]}]), page_info: {}}},
        }) +
        queryDef('BarcelonaPostPageTargetQuery', '29020279704322644', {postID: post['pk']}),
    )
  }
  const changedPage = () =>
    page('Threads', lsdBlock() + preloader('BarcelonaPostPageSomethingNewQuery', {data: {thing: {}}}))

  // ─── the listing query ──────────────────────────────────────────────────
  /** GraphQL's own cursors: `AQH` + the index of the next thread. */
  const pageOf = (threads: readonly Thread[], after: unknown, first: number) => {
    const start = typeof after === 'string' && after.startsWith('AQH') ? Number(after.slice(3)) : 0
    const slice = threads.slice(start, start + first)
    const next = start + first < threads.length ? `AQH${start + first}` : undefined
    return mediaData(slice, next)
  }

  const send = (res: http.ServerResponse, status: number, body: string, headers: http.OutgoingHttpHeaders = {}) => {
    res.writeHead(status, {'Content-Type': 'text/html; charset="utf-8"', ...headers})
    res.end(body.split(HERE).join(origin))
  }
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>(resolve => {
      let body = ''
      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => resolve(body))
    })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const cookies = String(req.headers.cookie ?? '')
    const signedIn = cookies.includes(`${SESSION}=`)
    if (signedIn) signedInRequests++

    // the CDN: any path under /v/, with Range
    if (url.pathname.startsWith('/v/')) {
      hits.media++
      const isVideo = url.pathname.endsWith('.mp4')
      const head = isVideo
        ? Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
        : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
      const full = Buffer.concat([head, Buffer.alloc(4096, 7)])
      const range = /^bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
      const start = range ? Number(range[1]) : 0
      res.writeHead(range ? 206 : 200, {
        'Content-Type': isVideo ? 'video/mp4' : 'image/jpeg',
        'Content-Length': String(full.length - start),
        'Accept-Ranges': 'bytes',
        ...(range && {'Content-Range': `bytes ${start}-${full.length - 1}/${full.length}`}),
      })
      res.end(full.subarray(start))
      return
    }

    // a session the site stopped accepting: 400 to anything that carries its cookie
    if (config.sessionRefused && signedIn) {
      hits.refused++
      send(res, 400, 'bad request')
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/graphql') {
      hits.graphql++
      const form = new URLSearchParams(await readBody(req))
      const variables = JSON.parse(form.get('variables') ?? '{}') as Record<string, unknown>
      queries.push(variables)
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, {'Content-Type': 'text/javascript; charset=utf-8'})
        res.end(JSON.stringify(body).split(HERE).join(origin))
      }
      // what the web client sends, or Threads won't answer
      if (
        form.get('lsd') !== LSD ||
        req.headers['x-fb-lsd'] !== LSD ||
        req.headers['x-ig-app-id'] !== '238260118697367' ||
        req.headers['sec-fetch-mode'] !== 'cors'
      ) {
        json({error: 1357004, errorSummary: 'Sorry, something went wrong'}, 400)
        return
      }
      if (form.get('doc_id') !== TAB_DOC_ID) {
        json({errors: [{message: 'document not found', severity: 'CRITICAL'}], data: null})
        return
      }
      const account = byPk.get(String(variables['userID']))
      if (!account) {
        json({data: {mediaData: {edges: [], page_info: {has_next_page: false}}}})
        return
      }
      if (account.user === HIDDEN && !signedIn) {
        json({data: {mediaData: null, viewer: {user: null}}, extensions: {is_final: true}})
        return
      }
      const first = Math.min(15, Number(variables['first'] ?? 10))
      // a cursor the site keeps handing back with the same threads
      const data =
        account.user === STUCK
          ? mediaData(account.threads, 'AQH0stuck')
          : pageOf(account.threads, variables['after'], first)
      json({data: {mediaData: data, viewer: {user: null}}, extensions: {is_final: true}})
      return
    }

    if (req.method !== 'GET') {
      send(res, 405, '')
      return
    }
    hits.page++
    pages.push(url.pathname)
    if (refusalsLeft > 0) {
      refusalsLeft--
      hits.refused++
      send(res, 429, 'Too many requests')
      return
    }
    // a client that doesn't present itself as a page load gets no data
    if (req.headers['sec-fetch-mode'] !== 'navigate') {
      hits.shell++
      send(res, 200, shell())
      return
    }
    const cookie = 'csrftoken=NfQc35rYNBVI856upntA5b; Max-Age=34560000; path=/; secure; SameSite=None'
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 't' && parts[1]) {
      const post = posts.get(parts[1])
      const user = post ? (post['user'] as {username: string}).username : 'zuck'
      send(res, 301, '', {Location: `/@${user}/post/${parts[1]}`})
      return
    }
    if (url.pathname === '/' || url.pathname.startsWith('/login')) {
      send(res, 200, page('Threads • Log in', lsdBlock()), {'Set-Cookie': cookie})
      return
    }
    const name = parts[0]?.startsWith('@') ? parts[0].slice(1).toLowerCase() : undefined
    if (!name) {
      send(res, 404, page('Page not found', ''))
      return
    }
    if (parts[1] === 'post' && parts[2]) {
      const code = parts[2]
      if (code === CODES.changed) {
        send(res, 200, changedPage(), {'Set-Cookie': cookie})
        return
      }
      const post = posts.get(code)
      // gone, or a private account's post to someone it doesn't share it with
      if (!post || (code === CODES.hidden && !signedIn)) {
        send(res, 302, '', {Location: '/?error=invalid_post'})
        return
      }
      send(res, 200, postPage(code), {'Set-Cookie': cookie})
      return
    }
    if (parts.length === 1 && name === 'movedthings') {
      send(res, 200, changedPage(), {'Set-Cookie': cookie})
      return
    }
    if (parts.length === 1 && accounts.has(name)) {
      send(res, 200, profilePage(name), {'Set-Cookie': cookie})
      return
    }
    send(res, 302, '', {Location: `/login/?next=${encodeURIComponent(`${origin}${url.pathname}/`)}`})
  })
  const port = await listenLocal(server)
  origin = `http://127.0.0.1:${port}`
  return {
    origin,
    codes: CODES,
    zuckMedia,
    hits,
    pages,
    queries,
    get signedInRequests() {
      return signedInRequests
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
