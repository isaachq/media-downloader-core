// A local stand-in for Bluesky's public AppView, the PLC directory, a PDS and
// the image CDN, with the shapes the real ones served (verified live
// 2026-10-26, trimmed to what is read; samples in .local/bluesky/):
// getPostThread (`thread.$type` threadViewPost, notFoundPost / blockedPost,
// a 400 NotFound for a missing post), getPosts (DIDs only: a handle in an
// at-uri is a 500, as on the real one), getProfile, resolveHandle,
// getAuthorFeed (100 a page, an ISO cursor, no cursor on the last page, the
// pinned post first as reasonPin, reposts as reasonRepost), post views whose
// record holds the blob refs and whose view holds the CDN links (images,
// the 2026 gallery, video with presentation "gif", recordWithMedia, a quote,
// a link card, an embed type nobody knows), DID documents (did:plc on the
// directory, did:web on its host), getBlob as a PDS answers it (Range
// ignored: always a 200 with the whole body; ratelimit-* headers) and the
// CDN's WebP re-encode.
import * as http from 'node:http'
import {listenLocal} from './listen.js'

export const DIDS = {
  alice: 'did:plc:aliceaaaaaaaaaaaaaaaaaaa',
  bob: 'did:plc:bobbbbbbbbbbbbbbbbbbbbbb',
  hidden: 'did:plc:hiddenhhhhhhhhhhhhhhhhhh',
  stuck: 'did:plc:stuckssssssssssssssssss2',
  web: 'did:web:webby.example',
} as const

export const HANDLES = {
  alice: 'alice.bsky.social',
  bob: 'bob.bsky.social',
  hidden: 'hidden.bsky.social',
  stuck: 'stuck.bsky.social',
  web: 'webby.example',
} as const

/** Posts of alice (and one of webby), by rkey. */
export const RKEYS = {
  image: '3mimage1aaaa2',
  images: '3mimages3aaa2',
  gallery: '3mgallery5aa2',
  video: '3mvideo1aaaa2',
  gif: '3mgif1aaaaaa2',
  withMedia: '3mrwm1aaaaaa2',
  quote: '3mquote1aaaa2',
  link: '3mlink1aaaaa2',
  text: '3mtext1aaaaa2',
  strange: '3mstrange1aa2',
  gone: '3mgone1aaaaa2',
  blocked: '3mblocked1aa2',
  pinned: '3mpinned1aaa2',
  hidden: '3mhidden1aaa2',
  web: '3mweb1aaaaaa2',
} as const

/** How many media posts alice's feed lists after its singles (3 pages of 100 with them). */
const FEED_EXTRA = 230
const IMAGE_BYTES = 4096
const VIDEO_BYTES = 64 * 1024

export type FakeBluesky = {
  readonly origin: string
  /** alice's media posts, in the order her profile lists them (the pinned one first, once). */
  readonly aliceMedia: readonly string[]
  readonly hits: Record<
    'thread' | 'posts' | 'profile' | 'feed' | 'resolve' | 'plc' | 'didWeb' | 'blob' | 'cdn' | 'refused',
    number
  >
  /** getAuthorFeed queries, in order. */
  readonly feeds: ReadonlyArray<Readonly<Record<string, string>>>
  /** getPosts requests: the at-uris of each. */
  readonly posts: ReadonlyArray<readonly string[]>
  /** Blob requests: whether each carried a Range header. */
  readonly ranges: readonly boolean[]
  close(): Promise<void>
}

export type FakeBlueskyConfig = {
  /** The first N AppView requests are refused (429). */
  readonly refusals?: number
  /** The first N video blob downloads break half-way (the socket closes). */
  readonly brokenVideos?: number
  /** Every blob request answers 429 with a reset this many seconds ahead (0: a reset in the past). */
  readonly rateLimited?: number
  /** Every blob request answers 500: pictures come from the CDN. */
  readonly pdsDown?: boolean
}

type Json = Record<string, unknown>

export async function startFakeBluesky(config: FakeBlueskyConfig = {}): Promise<FakeBluesky> {
  const hits = {thread: 0, posts: 0, profile: 0, feed: 0, resolve: 0, plc: 0, didWeb: 0, blob: 0, cdn: 0, refused: 0}
  const feeds: Array<Record<string, string>> = []
  const postsAsked: string[][] = []
  const ranges: boolean[] = []
  let refusalsLeft = config.refusals ?? 0
  let brokenLeft = config.brokenVideos ?? 0
  let origin = ''

  const blob = (cid: string, mimeType: string, size: number) => ({$type: 'blob', ref: {$link: cid}, mimeType, size})
  const cdn = (did: string, cid: string, kind = 'feed_fullsize') => `${origin}/cdn/img/${kind}/plain/${did}/${cid}`
  const author = (key: keyof typeof DIDS) => ({
    did: DIDS[key],
    handle: HANDLES[key],
    displayName: key === 'alice' ? 'Alice' : key === 'web' ? 'Webby' : key,
    avatar: `${origin}/cdn/img/avatar/plain/${DIDS[key]}/bafkreiavatar`,
    associated: {chat: {allowIncoming: 'none'}},
    labels:
      key === 'hidden'
        ? [{src: DIDS.hidden, uri: `at://${DIDS.hidden}/app.bsky.actor.profile/self`, val: '!no-unauthenticated'}]
        : [],
    createdAt: '2023-04-12T04:53:57.057Z',
  })
  /** k pictures as the record writes them and as the view shows them. */
  const pictures = (did: string, prefix: string, k: number) => {
    const cids = Array.from({length: k}, (_, i) => `bafkrei${prefix}${i + 1}`)
    return {
      record: cids.map((cid, i) => ({
        alt: `picture ${i + 1}`,
        aspectRatio: {width: 1000, height: 750},
        image: blob(cid, 'image/jpeg', IMAGE_BYTES),
      })),
      view: cids.map(cid => ({
        thumb: cdn(did, cid, 'feed_thumbnail'),
        fullsize: cdn(did, cid),
        alt: 'picture',
        aspectRatio: {width: 1000, height: 750},
      })),
    }
  }
  const imagesEmbed = (did: string, prefix: string, k: number) => {
    const {record, view} = pictures(did, prefix, k)
    return {
      record: {$type: 'app.bsky.embed.images', images: record},
      view: {$type: 'app.bsky.embed.images#view', images: view},
    }
  }
  const galleryEmbed = (did: string, prefix: string, k: number) => {
    const {record, view} = pictures(did, prefix, k)
    return {
      record: {
        $type: 'app.bsky.embed.gallery',
        items: record.map(item => ({$type: 'app.bsky.embed.gallery#image', ...item})),
      },
      view: {
        $type: 'app.bsky.embed.gallery#view',
        items: view.map(item => ({$type: 'app.bsky.embed.gallery#viewImage', thumbnail: item.thumb, ...item})),
      },
    }
  }
  const videoEmbed = (did: string, cid: string, gif = false) => ({
    record: {
      $type: 'app.bsky.embed.video',
      alt: 'a clip',
      aspectRatio: {width: 2800, height: 1610},
      ...(gif && {presentation: 'gif'}),
      video: blob(cid, 'video/mp4', VIDEO_BYTES),
    },
    view: {
      $type: 'app.bsky.embed.video#view',
      cid,
      playlist: `https://video.bsky.app/watch/${encodeURIComponent(did)}/${cid}/playlist.m3u8`,
      thumbnail: `https://video.bsky.app/watch/${encodeURIComponent(did)}/${cid}/thumbnail.jpg`,
      aspectRatio: {width: 2800, height: 1610},
      ...(gif && {presentation: 'gif'}),
    },
  })
  // built on first use: the links carry the origin, known once the server listens
  const build = () => {
    const quoted = {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: `at://${DIDS.bob}/app.bsky.feed.post/3mbobquoted12`,
      cid: 'bafyreibobquoted',
      author: author('bob'),
      value: {$type: 'app.bsky.feed.post', text: 'the quoted one', embed: imagesEmbed(DIDS.bob, 'bobq', 1).record},
      embeds: [imagesEmbed(DIDS.bob, 'bobq', 1).view],
      indexedAt: '2026-01-01T00:00:00.000Z',
    }
    return {
      embeds: {
        [RKEYS.image]: imagesEmbed(DIDS.alice, 'img', 1),
        [RKEYS.images]: imagesEmbed(DIDS.alice, 'imgs', 3),
        [RKEYS.gallery]: galleryEmbed(DIDS.alice, 'gal', 5),
        [RKEYS.video]: videoEmbed(DIDS.alice, 'bafkreivideo1'),
        [RKEYS.gif]: videoEmbed(DIDS.alice, 'bafkreigif1', true),
        [RKEYS.withMedia]: {
          record: {
            $type: 'app.bsky.embed.recordWithMedia',
            media: imagesEmbed(DIDS.alice, 'rwm', 2).record,
            record: {$type: 'app.bsky.embed.record', record: {uri: quoted.uri, cid: quoted.cid}},
          },
          view: {
            $type: 'app.bsky.embed.recordWithMedia#view',
            media: imagesEmbed(DIDS.alice, 'rwm', 2).view,
            record: {record: quoted},
          },
        },
        [RKEYS.quote]: {
          record: {$type: 'app.bsky.embed.record', record: {uri: quoted.uri, cid: quoted.cid}},
          view: {$type: 'app.bsky.embed.record#view', record: quoted},
        },
        [RKEYS.link]: {
          record: {
            $type: 'app.bsky.embed.external',
            external: {uri: 'https://example.com/', title: 'Example', description: ''},
          },
          view: {
            $type: 'app.bsky.embed.external#view',
            external: {uri: 'https://example.com/', title: 'Example', description: ''},
          },
        },
        [RKEYS.text]: undefined,
        [RKEYS.pinned]: imagesEmbed(DIDS.alice, 'pin', 1),
        [RKEYS.strange]: {
          record: {$type: 'app.bsky.embed.hologram', depth: 3},
          view: {$type: 'app.bsky.embed.hologram#view'},
        },
        [RKEYS.hidden]: imagesEmbed(DIDS.hidden, 'hid', 1),
        [RKEYS.web]: imagesEmbed(DIDS.web, 'web', 1),
      } as Record<string, {record?: Json; view?: Json} | undefined>,
    }
  }
  let built: ReturnType<typeof build> | undefined
  const embedsOf = () => {
    built ??= build()
    return built.embeds
  }
  const owner = (rkey: string): keyof typeof DIDS =>
    rkey === RKEYS.hidden ? 'hidden' : rkey === RKEYS.web ? 'web' : 'alice'
  /** A post view as the AppView answers it. */
  const view = (rkey: string, key = owner(rkey), when = '2026-10-22T16:30:02.437Z'): Json => {
    const embed = embedsOf()[rkey] ?? (rkey.startsWith('3mx') ? imagesEmbed(DIDS[key], rkey.slice(3, 9), 1) : undefined)
    return {
      uri: `at://${DIDS[key]}/app.bsky.feed.post/${rkey}`,
      cid: `bafyrei${rkey}`,
      author: author(key),
      record: {
        $type: 'app.bsky.feed.post',
        createdAt: when,
        langs: ['en'],
        text: rkey === RKEYS.gallery ? 'Ten photos now\nsecond line' : `post ${rkey}`,
        ...(embed?.record && {embed: embed.record}),
      },
      ...(embed?.view && {embed: embed.view}),
      replyCount: 1,
      repostCount: 2,
      likeCount: 3,
      quoteCount: 0,
      indexedAt: when,
      labels: [],
    }
  }

  // alice's feed (posts_with_media): the pinned post first (reasonPin), her media posts, a repost
  // of bob's (reasonRepost), one of bob's own (never served by the real filter: defensive), more media
  const singles = [RKEYS.image, RKEYS.images, RKEYS.gallery, RKEYS.video, RKEYS.gif, RKEYS.withMedia]
  const extra = Array.from({length: FEED_EXTRA}, (_, i) => `3mx${String(i).padStart(9, '0')}a`)
  type Entry = {post: Json; reason?: Json}
  let feedCache: Entry[] | undefined
  const aliceFeed = (): Entry[] => {
    feedCache ??= [
      {post: view(RKEYS.pinned), reason: {$type: 'app.bsky.feed.defs#reasonPin'}},
      ...singles.map(rkey => ({post: view(rkey)})),
      {
        post: view('3mbobrepost12', 'bob'),
        reason: {$type: 'app.bsky.feed.defs#reasonRepost', by: author('alice'), indexedAt: '2026-10-01T00:00:00Z'},
      },
      {post: view('3mbobown12345', 'bob')},
      ...extra.map((rkey, i) => ({
        post: view(rkey, 'alice', new Date(Date.UTC(2026, 9, 1) - i * 3_600_000).toISOString()),
      })),
      // the pinned post again, where its date puts it
      {post: view(RKEYS.pinned)},
    ]
    return feedCache
  }
  const aliceMedia = [RKEYS.pinned, ...singles, ...extra]
  const listed: ReadonlySet<string> = new Set(aliceMedia)

  const send = (
    res: http.ServerResponse,
    status: number,
    body: string | Buffer,
    headers: http.OutgoingHttpHeaders = {},
  ) => {
    res.writeHead(status, {'Content-Length': Buffer.byteLength(body), ...headers})
    res.end(body)
  }
  const json = (res: http.ServerResponse, status: number, value: unknown, headers: http.OutgoingHttpHeaders = {}) =>
    send(res, status, JSON.stringify(value), {'Content-Type': 'application/json; charset=utf-8', ...headers})

  const actorKey = (actor: string): keyof typeof DIDS | undefined => {
    for (const key of Object.keys(DIDS) as Array<keyof typeof DIDS>) {
      if (DIDS[key] === actor || HANDLES[key] === actor) return key
    }
    return undefined
  }

  const xrpc = (res: http.ServerResponse, method: string, query: URLSearchParams) => {
    switch (method) {
      case 'app.bsky.feed.getPostThread': {
        hits.thread++
        const uri = query.get('uri') ?? ''
        const [actor, , rkey = ''] = uri.slice('at://'.length).split('/')
        const key = actorKey(actor ?? '')
        if (!key) return json(res, 400, {error: 'InvalidRequest', message: 'Unable to resolve handle'})
        if (rkey === RKEYS.blocked) {
          return json(res, 200, {thread: {$type: 'app.bsky.feed.defs#blockedPost', uri, blocked: true}})
        }
        if (!(rkey in embedsOf()) || rkey === RKEYS.gone || owner(rkey) !== key) {
          return json(res, 400, {error: 'NotFound', message: `Post not found: ${uri}`})
        }
        return json(res, 200, {thread: {$type: 'app.bsky.feed.defs#threadViewPost', post: view(rkey), replies: []}})
      }
      case 'app.bsky.feed.getPosts': {
        hits.posts++
        const uris = query.getAll('uris')
        postsAsked.push(uris)
        if (uris.length > 25)
          return json(res, 400, {error: 'InvalidRequest', message: 'uris must not have more than 25 elements'})
        if (uris.some(uri => !uri.startsWith('at://did:'))) {
          return json(res, 500, {error: 'InternalServerError', message: 'Internal Server Error'})
        }
        const found = uris.flatMap(uri => {
          const rkey = uri.slice(uri.lastIndexOf('/') + 1)
          const known = rkey in embedsOf() || listed.has(rkey)
          return known && rkey !== RKEYS.gone ? [view(rkey)] : []
        })
        return json(res, 200, {posts: found})
      }
      case 'app.bsky.actor.getProfile': {
        hits.profile++
        const key = actorKey(query.get('actor') ?? '')
        if (!key) return json(res, 400, {error: 'InvalidRequest', message: 'Profile not found'})
        return json(res, 200, {...author(key), postsCount: key === 'alice' ? 1200 : 3})
      }
      case 'com.atproto.identity.resolveHandle': {
        hits.resolve++
        const key = actorKey(query.get('handle') ?? '')
        if (!key) return json(res, 400, {error: 'InvalidRequest', message: 'Unable to resolve handle'})
        return json(res, 200, {did: DIDS[key]})
      }
      case 'app.bsky.feed.getAuthorFeed': {
        hits.feed++
        feeds.push(Object.fromEntries(query))
        const limit = Number(query.get('limit') ?? 50)
        if (limit > 100) {
          return json(res, 400, {
            error: 'InvalidRequest',
            message: `limit: integer too big (maximum 100, got ${limit})`,
          })
        }
        const key = actorKey(query.get('actor') ?? '')
        if (!key) return json(res, 400, {error: 'InvalidRequest', message: 'Profile not found'})
        if (key === 'stuck') {
          // a cursor that never moves, over the same page
          return json(res, 200, {feed: [{post: view('3mx000000000a', 'stuck')}], cursor: '2026-01-01T00:00:00.000Z'})
        }
        const entries = key === 'alice' ? aliceFeed() : []
        const cursor = query.get('cursor')
        const start = cursor ? Number(cursor.slice(cursor.indexOf('#') + 1)) : 0
        const page = entries.slice(start, start + limit)
        const next = start + limit < entries.length ? `2026-01-01T00:00:00.000Z#${start + limit}` : undefined
        return json(res, 200, {feed: page, ...(next && {cursor: next})})
      }
      default:
        return json(res, 501, {error: 'MethodNotImplemented', message: 'Method Not Implemented'})
    }
  }

  const didDocument = (did: string) => ({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    alsoKnownAs: [`at://${HANDLES[actorKey(did) ?? 'alice']}`],
    service: [{id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: `${origin}/pds/`}],
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const path = url.pathname
    if (path.startsWith('/xrpc/')) {
      if (refusalsLeft > 0) {
        refusalsLeft--
        hits.refused++
        return json(res, 429, {error: 'RateLimitExceeded', message: 'Rate Limit Exceeded'})
      }
      return xrpc(res, path.slice('/xrpc/'.length), url.searchParams)
    }
    if (path.startsWith('/plc/')) {
      hits.plc++
      const did = decodeURIComponent(path.slice('/plc/'.length))
      return actorKey(did) ? json(res, 200, didDocument(did)) : send(res, 404, 'DID not registered')
    }
    if (path.startsWith('/did-web/')) {
      hits.didWeb++
      return path === '/did-web/webby.example/did.json' ? json(res, 200, didDocument(DIDS.web)) : send(res, 404, 'nope')
    }
    if (path === '/pds/xrpc/com.atproto.sync.getBlob') {
      hits.blob++
      ranges.push(req.headers.range !== undefined)
      const now = Math.floor(Date.now() / 1000)
      const limits = {
        'ratelimit-limit': '3000',
        'ratelimit-policy': '3000;w=300',
        'ratelimit-remaining': config.rateLimited !== undefined ? '0' : '2999',
        'ratelimit-reset': String(config.rateLimited ? now + config.rateLimited : now - 1),
      }
      if (config.rateLimited !== undefined) return json(res, 429, {error: 'RateLimitExceeded'}, limits)
      if (config.pdsDown) return json(res, 500, {error: 'InternalServerError'}, limits)
      const cid = url.searchParams.get('cid') ?? ''
      const video = cid.includes('video') || cid.includes('gif')
      if (!cid.startsWith('bafkrei'))
        return json(res, 400, {error: 'InvalidRequest', message: 'Blob not found'}, limits)
      const head = video
        ? Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
        : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
      const size = video ? VIDEO_BYTES : IMAGE_BYTES
      const body = Buffer.concat([head, Buffer.alloc(size - head.length, `${cid}|`)])
      const headers = {
        ...limits,
        'Content-Type': video ? 'video/mp4' : 'image/jpeg',
        'Content-Disposition': `attachment; filename="${cid}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      }
      if (video && brokenLeft > 0) {
        brokenLeft--
        // the whole length announced, half of it sent, then the connection drops
        res.writeHead(200, {'Content-Length': body.length, ...headers})
        res.write(body.subarray(0, body.length / 2), () => res.destroy())
        return
      }
      // Range ignored, as on the real PDS: always the whole blob
      return send(res, 200, body, headers)
    }
    if (path.startsWith('/cdn/img/')) {
      hits.cdn++
      const head = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')
      return send(res, 200, Buffer.concat([head, Buffer.alloc(1024 - head.length, 1)]), {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=604800',
      })
    }
    return send(res, 404, 'Not Found')
  })
  const port = await listenLocal(server)
  origin = `http://127.0.0.1:${port}`
  return {
    origin,
    aliceMedia,
    hits,
    feeds,
    posts: postsAsked,
    ranges,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
