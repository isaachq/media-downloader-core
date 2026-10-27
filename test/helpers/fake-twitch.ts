// A local stand-in for Twitch's GraphQL endpoint and its clip CDN, with the
// shapes the real ones served (verified live 2026-10-26, trimmed to what is
// read; samples in .local/twitch/): `POST /gql` with a plain query and its
// variables (a missing Client-ID is a 400, as on the real one), `clip(slug)`
// with its H.264 `videoQualities`, its landscape and portrait assets and its
// `playbackAccessToken` (a JSON value naming the HEVC 1440p file, `expires`
// ~20 h ahead, `authorization.forbidden`), aliased batches c0…c14 (more than
// 15 root fields is an error), `user(login).clips(first: 100, after, criteria)`
// with the cursor on the last edge only (base64 of the offset), `hasNextPage`
// false at offset 1000, and every page after the first an
// `IntegrityCheckFailed` for the web player's client id; `clip: null` and
// `user: null` for what is not there; GraphQL errors for a field Twitch
// renamed. The CDN serves a signed file only (401 unsigned or with another
// signature) and answers Range with 206.
import * as http from 'node:http'
import {listenLocal} from './listen.js'

export const WEB_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

export const SLUGS = {
  /** A 2026 clip: H.264 1080/720/480/360, a portrait asset, HEVC 1440 in its token. */
  good: 'PreciousRelievedCodCorgiDerp-IqjaHMAL8JQQH78F',
  /** A 2016 clip: one /avc/1080 file, no HEVC. */
  old: 'FaintLightGullWholeWheat',
  /** Its token says forbidden (subscriber-only / restricted). */
  forbidden: 'LockedAwayClipForSubsOnly-abcdEFGHijklMNOP',
  /** No encodings in the answer. */
  empty: 'ProcessingClipNoQualities-abcdEFGHijklMNOP',
  /** `clip: null`: deleted. */
  gone: 'DeletedClipNoLongerThere-abcdEFGHijklMNOP',
  /** Twitch renamed a field: a GraphQL error and no data. */
  changed: 'RenamedFieldClipAnswer-abcdEFGHijklMNOP',
  /** Its first token is refused by the CDN (it ran out); a fresh read signs again. */
  stale: 'StaleTokenClipSignedTwice-abcdEFGHijklMNOP',
} as const

/** VODs: one whose broadcast is still on the air, one finished, one deleted. */
export const VODS = {recording: '2911744751', recorded: '2602093345', gone: '9999'} as const

export const CHANNELS = {
  /** 1,200 clips (the listing stops at 1,000). */
  big: 'bigchannel',
  /** 250 clips: three pages. */
  mid: 'midchannel',
  /** No clip in any period. */
  empty: 'quietchannel',
  /** Every page an integrity check, whatever the client id. */
  gated: 'gatedchannel',
  /** On the air right now (`stream` set); every other channel is offline. */
  live: 'liveonair',
} as const

const VIDEO_BYTES = 48 * 1024
const PAGE = 100
const LIMIT = 1000
const SIZES: Readonly<Record<string, readonly [number, number]>> = {
  '1080': [1920, 1080],
  '720': [1280, 720],
  '480': [853, 480],
  '360': [640, 360],
}

export type FakeTwitch = {
  readonly origin: string
  readonly gql: string
  readonly hits: {
    clip: number
    batch: number
    page: number
    media: number
    refused: number
    denied: number
    stream: number
    vod: number
  }
  /** Variables of every listing page asked. */
  readonly pages: Array<Record<string, unknown>>
  /** Slugs of every batch asked, in order. */
  readonly batches: string[][]
  /** Range headers the CDN saw (undefined: none). */
  readonly ranges: Array<string | undefined>
  close(): Promise<void>
}

export type FakeTwitchConfig = {
  /** The first N GraphQL requests answer 429. */
  readonly refusals?: number | undefined
}

export async function startFakeTwitch(config: FakeTwitchConfig = {}): Promise<FakeTwitch> {
  const hits = {clip: 0, batch: 0, page: 0, media: 0, refused: 0, denied: 0, stream: 0, vod: 0}
  const pages: Array<Record<string, unknown>> = []
  const batches: string[][] = []
  const ranges: Array<string | undefined> = []
  /** slug → reads so far (each read signs anew: sig-<slug>-<n>). */
  const reads = new Map<string, number>()
  let refusalsLeft = config.refusals ?? 0
  let origin = ''

  const media = (uuid: string, path: string) => `${origin}/media/${uuid}/${path}/index.mp4`
  const quality = (uuid: string, q: string, codec = 'h264', orientation = 'landscape') => {
    const [w, h] = SIZES[q]!
    const [width, height] = orientation === 'portrait' ? [h, w] : [w, h]
    return {
      quality: q,
      frameRate: 60,
      width,
      height,
      bitrate: Number(q) * 5000,
      codecs: codec === 'h264' ? 'avc1.4D401F,mp4a.40.2' : 'hvc1.1.6.L120.90',
      sourceURL: media(uuid, `${orientation}/${codec}/${q}`),
    }
  }
  const token = (slug: string, uuid: string, forbidden = false) => {
    const n = (reads.get(slug) ?? 0) + 1
    reads.set(slug, n)
    return {
      signature: `sig-${slug}-${n}`,
      value: JSON.stringify({
        authorization: {forbidden, reason: forbidden ? 'UNAUTHORIZED_ENTITLEMENTS' : ''},
        clip_uri: media(uuid, 'landscape/hevc/1440'),
        clip_slug: slug,
        device_id: null,
        expires: Math.floor(Date.now() / 1000) + 20 * 3600,
        user_id: '',
        version: 3,
      }),
    }
  }
  const clip = (slug: string, id: string, channel: string, extra: Record<string, unknown> = {}) => {
    const uuid = `uuid-${slug.toLowerCase()}`
    const landscape = ['1080', '720', '480', '360'].map(q => quality(uuid, q))
    return {
      id,
      slug,
      url: `https://www.twitch.tv/${channel}/clip/${slug}`,
      title: `Clip ${slug.slice(0, 12)}`,
      createdAt: '2026-10-10T05:25:43Z',
      durationSeconds: 51,
      viewCount: 1000,
      language: 'EN',
      thumbnailURL: `${origin}/thumb/${uuid}.jpg`,
      broadcaster: {login: channel, displayName: channel.toUpperCase()},
      curator: {login: 'someone', displayName: 'Someone'},
      game: {name: 'A Game'},
      videoQualities: landscape,
      assets: [
        {aspectRatio: 16 / 9, videoQualities: landscape},
        {aspectRatio: 9 / 16, videoQualities: ['720', '480'].map(q => quality(uuid, q, 'h264', 'portrait'))},
      ],
      playbackAccessToken: token(slug, uuid),
      ...extra,
    }
  }
  const node = (slug: string): unknown => {
    switch (slug) {
      case SLUGS.good:
      case SLUGS.stale:
        return clip(slug, slug === SLUGS.good ? '3573895506' : '777', 'shroud')
      case SLUGS.old: {
        const uuid = 'uuid-old'
        return clip(slug, '396245304', 'ea', {
          videoQualities: [{quality: '1080', frameRate: 0, sourceURL: media(uuid, 'landscape/avc/1080')}],
          assets: [],
          playbackAccessToken: {
            ...token(slug, uuid),
            value: JSON.stringify({
              authorization: {forbidden: false, reason: ''},
              clip_uri: media(uuid, 'landscape/avc/1080'),
              expires: Math.floor(Date.now() / 1000) + 20 * 3600,
            }),
          },
        })
      }
      case SLUGS.forbidden:
        return clip(slug, '888', 'subsonly', {playbackAccessToken: token(slug, 'uuid-forbidden', true)})
      case SLUGS.empty:
        return clip(slug, '999', 'shroud', {videoQualities: [], assets: []})
      default:
        // a listed clip, or a slug that was never there
        return /^Listed\d+-/.test(slug) ? listed(slug.split('-')[1]!, Number(slug.slice(6, slug.indexOf('-')))) : null
    }
  }
  const listed = (channel: string, i: number) => clip(`Listed${i}-${channel}`, String(100_000 + i), channel)
  const totals: Readonly<Record<string, number>> = {
    [CHANNELS.big]: 1200,
    [CHANNELS.mid]: 250,
    [CHANNELS.empty]: 0,
    [CHANNELS.gated]: 50,
  }

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {'content-type': 'application/json'})
    res.end(JSON.stringify(body))
  }

  const answer = (res: http.ServerResponse, clientId: string, query: string, variables: Record<string, unknown>) => {
    if (query.startsWith('query Clip(')) {
      hits.clip++
      const slug = String(variables['slug'])
      if (slug === SLUGS.changed) {
        return json(res, 200, {
          errors: [{message: 'Cannot query field "videoQualities" on type "Clip".', path: ['query', 'clip']}],
        })
      }
      return json(res, 200, {data: {clip: node(slug)}})
    }
    if (query.startsWith('query Clips(')) {
      hits.batch++
      const slugs = Object.keys(variables)
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
        .map(key => String(variables[key]))
      batches.push(slugs)
      if (slugs.length > 15) return json(res, 200, {errors: [{message: 'root field aliases limit allowed (15)'}]})
      const data: Record<string, unknown> = {}
      slugs.forEach((slug, i) => {
        data[`c${i}`] = node(slug)
      })
      return json(res, 200, {data})
    }
    if (query.startsWith('query ChannelStream(')) {
      hits.stream++
      const login = String(variables['login'])
      if (login !== CHANNELS.live && totals[login] === undefined) return json(res, 200, {data: {user: null}})
      const stream =
        login === CHANNELS.live
          ? {id: '320926770780', type: 'live', title: 'On the air', createdAt: '2026-10-26T20:59:27Z'}
          : null
      return json(res, 200, {data: {user: {id: '71092938', login, displayName: login.toUpperCase(), stream}}})
    }
    if (query.startsWith('query VodStatus(')) {
      hits.vod++
      const id = String(variables['id'])
      if (id === VODS.gone) return json(res, 200, {data: {video: null}})
      const status = id === VODS.recording ? 'RECORDING' : 'RECORDED'
      return json(res, 200, {data: {video: {id, status, broadcastType: 'ARCHIVE', owner: {login: CHANNELS.live}}}})
    }
    if (query.startsWith('query ChannelClips(')) {
      hits.page++
      pages.push(variables)
      const login = String(variables['login'])
      const total = totals[login]
      if (total === undefined) return json(res, 200, {data: {user: null}})
      const after =
        typeof variables['after'] === 'string' ? Number(Buffer.from(variables['after'], 'base64').toString()) : 0
      const user = {id: '37402112', login, displayName: login.toUpperCase()}
      if ((after > 0 && clientId === WEB_ID) || login === CHANNELS.gated) {
        return json(res, 200, [
          {
            errors: [
              {message: 'failed integrity check', path: ['user', 'clips'], extensions: {code: 'IntegrityCheckFailed'}},
            ],
            data: {user: {...user, clips: null}},
            extensions: {challenge: {type: 'integrity'}},
          },
        ])
      }
      const end = Math.min(total, after + PAGE)
      const edges = []
      for (let i = after; i < end; i++) edges.push({cursor: null as string | null, node: listed(login, i)})
      if (edges.length > 0) edges[edges.length - 1]!.cursor = Buffer.from(String(end)).toString('base64')
      return json(res, 200, {
        data: {user: {...user, clips: {pageInfo: {hasNextPage: end < total && end < LIMIT}, edges}}},
      })
    }
    return json(res, 200, {errors: [{message: `Unknown query: ${query.slice(0, 40)}`}]})
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake.test')
    if (req.method === 'POST' && url.pathname === '/gql') {
      let raw = ''
      req.on('data', chunk => {
        raw += chunk
      })
      req.on('end', () => {
        const clientId = req.headers['client-id']
        if (typeof clientId !== 'string' || !clientId) {
          return json(res, 400, {
            error: 'Bad Request',
            status: 400,
            message: 'The "Client-ID" header is missing from the request.',
          })
        }
        if (refusalsLeft > 0) {
          refusalsLeft--
          hits.refused++
          return json(res, 429, {error: 'Too Many Requests'})
        }
        let body: {query?: unknown; variables?: unknown}
        try {
          body = JSON.parse(raw)
        } catch {
          return json(res, 400, {error: 'Bad Request', message: 'invalid JSON'})
        }
        return answer(res, clientId, String(body.query ?? ''), (body.variables ?? {}) as Record<string, unknown>)
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      hits.media++
      const uuid = url.pathname.split('/')[2] ?? ''
      const slug = [...reads.keys()].find(
        s => `uuid-${s.toLowerCase()}` === uuid || (uuid === 'uuid-old' && s === SLUGS.old),
      )
      const sig = url.searchParams.get('sig')
      const tokenValue = url.searchParams.get('token')
      const n = slug ? (reads.get(slug) ?? 0) : 0
      const valid =
        slug !== undefined &&
        tokenValue !== null &&
        sig?.startsWith(`sig-${slug}-`) &&
        // the stale clip's first signature ran out
        !(slug === SLUGS.stale && sig === `sig-${slug}-1`) &&
        Number(sig.slice(`sig-${slug}-`.length)) <= n
      if (!valid) {
        hits.denied++
        res.writeHead(401, {'content-type': 'text/xml'})
        return res.end('<Error><Code>AccessDenied</Code></Error>')
      }
      const body = mp4(VIDEO_BYTES)
      const range = req.headers.range
      ranges.push(range)
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
      res.writeHead(range ? 206 : 200, {
        'content-type': 'binary/octet-stream',
        'accept-ranges': 'bytes',
        'content-length': String(body.length - start),
        ...(range && {'content-range': `bytes ${start}-${body.length - 1}/${body.length}`}),
      })
      return res.end(body.subarray(start))
    }
    res.writeHead(404)
    return res.end()
  })
  const port = await listenLocal(server)
  origin = `http://127.0.0.1:${port}`
  return {
    origin,
    gql: `${origin}/gql`,
    hits,
    pages,
    batches,
    ranges,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Bytes that start like an MP4 (an ftyp box), then zeros. */
function mp4(size: number): Buffer {
  const bytes = Buffer.alloc(size)
  bytes.writeUInt32BE(24, 0)
  bytes.write('ftypisom', 4, 'latin1')
  return bytes
}
