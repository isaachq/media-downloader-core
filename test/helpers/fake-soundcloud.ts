// A local stand-in for SoundCloud's web app, api-v2, short links and media CDN, with the shapes the real
// ones served (verified live 2026-10-27, trimmed to what is read; samples in .local/soundcloud/): the
// home page with its hydration client id and bundle script tags; a 2.9 MB-style bundle (padded, the
// id near its end, so the scan crosses chunks); `/resolve?url=` for tracks, sets and users (404 `{}`
// for anything else, `m.` pages included as the real API does); `/tracks?ids=` (50 at most, 51 is a
// 400 `{}`, answered in no particular order, missing ids left out, a private set's playlistSecretToken
// required); `/users/<id>/{tracks,likes,playlists,albums}` with `linked_partitioning` and short pages
// (fewer than `limit`) whose `next_href` leaves out `client_id`; transcoding calls that mint the media
// url (`{url}`, 404 `{}` for `abr_*`), clear HLS on a fake-hls origin (fMP4 AAC, or packed MP3), legacy
// progressive MP3 with Range; DRM (cbc-/ctr-encrypted-hls), Go+ previews, region blocks; a 401 with an
// empty body for a client id that is not (or no longer) good; DataDome's 403; on.soundcloud.com 302s
// with the sharer's tracking query. Every request is counted by kind.
import * as http from 'node:http'
import type {Socket} from 'node:net'
import {type FakeHls, type FakeTrack, startFakeHls} from './fake-hls.js'
import {listenLocal} from './listen.js'

export const HYDRATION_ID = 'HydrationClientIdAAAAAAAAAAAAAAA'
export const BUNDLE_ID = 'BundleClientIdBBBBBBBBBBBBBBBBBB'
export const OPTION_ID = 'OptionClientIdCCCCCCCCCCCCCCCCCC'

/** Tracks by name: their numeric ids. */
export const IDS = {
  clear: 1001,
  low: 1002,
  drm: 1003,
  snip: 1004,
  partial: 1005,
  geo: 1006,
  privateTrack: 1007,
  legacy: 1008,
  expiring: 1009,
  hlsMp3: 1010,
  drmPlaylist: 1011,
  previewStream: 1012,
  nothing: 1013,
} as const

export const USER = {id: 501, permalink: 'artist', name: 'The Artist'} as const
export const SECRET = 's-Secr3t'
export const SET_SECRET = 's-SetT0k'
/** Tracks the artist's profile lists (newest first), after its named ones. */
export const PROFILE_TRACKS = 130
/** Stubs of the big set (beyond its 5 whole tracks). */
export const SET_STUBS = 120
/** Ids of stub tracks the API leaves out (removed since the set was made). */
export const REMOVED_STUBS: readonly number[] = [3007]
/** The private set's stubs: the API gives them only with the set's id and token. */
export const PRIVATE_STUBS: readonly number[] = [3900, 3901, 3902]
const SEGMENTS = 6
const SEGMENT_SECONDS = 10
const MP3_BYTES = 32 * 1024

type Spec = {
  readonly id: number
  readonly slug: string
  readonly title: string
  readonly policy?: string
  readonly secret?: string
  readonly transcodings: ReadonlyArray<{
    readonly preset: string
    readonly protocol: string
    readonly snipped?: boolean
    readonly mime?: string
  }>
  readonly seconds?: number
}

const aac = (preset: string) => ({preset, protocol: 'hls', mime: 'audio/mp4; codecs="mp4a.40.2"'})
const abr = {preset: 'abr_sq', protocol: 'hls', mime: 'audio/mpegurl'}

const SPECS: readonly Spec[] = [
  {id: IDS.clear, slug: 'clear-track', title: 'Clear Track', transcodings: [aac('aac_160k'), aac('aac_96k'), abr]},
  {id: IDS.low, slug: 'low-only', title: 'Low Only', transcodings: [abr, aac('aac_96k')]},
  {
    id: IDS.drm,
    slug: 'label-release',
    title: 'Label Release',
    policy: 'MONETIZE',
    transcodings: [
      {preset: 'aac_160k', protocol: 'cbc-encrypted-hls'},
      {preset: 'aac_160k', protocol: 'ctr-encrypted-hls'},
      {preset: 'abr_sq', protocol: 'ctr-encrypted-hls'},
    ],
  },
  {
    id: IDS.snip,
    slug: 'go-plus',
    title: 'Go Plus',
    policy: 'SNIP',
    seconds: 30,
    transcodings: [{...aac('aac_160k'), snipped: true}],
  },
  {
    id: IDS.partial,
    slug: 'preview-and-full',
    title: 'Preview and Full',
    transcodings: [{...aac('aac_160k'), snipped: true}, aac('aac_96k')],
  },
  {id: IDS.geo, slug: 'not-here', title: 'Not Here', policy: 'BLOCK', transcodings: []},
  {id: IDS.privateTrack, slug: 'secret-demo', title: 'Secret Demo', secret: SECRET, transcodings: [aac('aac_160k')]},
  {
    id: IDS.legacy,
    slug: 'old-upload',
    title: 'Old Upload',
    seconds: 8,
    transcodings: [
      {preset: 'mp3_0_0', protocol: 'hls', mime: 'audio/mpeg'},
      {preset: 'mp3_0_0', protocol: 'progressive', mime: 'audio/mpeg'},
    ],
  },
  {id: IDS.expiring, slug: 'long-mix', title: 'Long Mix', transcodings: [aac('aac_160k')]},
  {
    id: IDS.hlsMp3,
    slug: 'old-hls',
    title: 'Old HLS',
    transcodings: [{preset: 'mp3_0_0', protocol: 'hls', mime: 'audio/mpeg'}],
  },
  {id: IDS.drmPlaylist, slug: 'sneaky-drm', title: 'Sneaky DRM', transcodings: [aac('aac_160k')]},
  {id: IDS.previewStream, slug: 'preview-stream', title: 'Preview Stream', transcodings: [aac('aac_160k')]},
  {
    id: IDS.nothing,
    slug: 'odd-formats',
    title: 'Odd Formats',
    transcodings: [{preset: 'flac_0_0', protocol: 'dash', mime: 'audio/flac'}],
  },
]

export const trackUrl = (slug: string, secret?: string) =>
  `https://soundcloud.com/${USER.permalink}/${slug}${secret ? `/${secret}` : ''}`

export type FakeSoundcloudConfig = {
  /** The page's hydration id; undefined: the page has none. */
  readonly hydrationId?: string | undefined
  /** Ids the API takes (default: both the hydration and the bundle id). */
  readonly valid?: readonly string[]
  /** The home page is a bot check (HTTP 202 with a challenge script). */
  readonly wafHome?: boolean
  /** Listings answer DataDome's 403. */
  readonly datadome?: boolean
}

export type FakeSoundcloud = {
  readonly origin: string
  readonly api: string
  readonly hls: FakeHls
  /** Requests by kind: home, script, resolve, ids, page, mint, short, cdn, expired, denied (401). */
  readonly hits: Partial<Record<HitKind, number>>
  /** The client ids each API request carried, in order. */
  readonly clientIds: string[]
  /** The query of every mint request. */
  readonly mints: URLSearchParams[]
  /** The `ids` asked by each `/tracks?ids=` request, and its other query. */
  readonly idRequests: URLSearchParams[]
  /** Ids the API takes from now on. */
  setValid(ids: readonly string[]): void
  /** The next mints of `id` answer a playlist url that has already run out (403), this many times. */
  expireNextMint(id: number, times?: number): void
  close(): Promise<void>
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8'}).end(JSON.stringify(body))
}

export type HitKind = 'home' | 'script' | 'resolve' | 'ids' | 'page' | 'mint' | 'short' | 'cdn' | 'expired' | 'denied'

export async function startFakeSoundcloud(config: FakeSoundcloudConfig = {}): Promise<FakeSoundcloud> {
  const hlsTracks: Record<string, FakeTrack> = {}
  for (const spec of SPECS) {
    const segments = spec.id === IDS.expiring ? 12 : SEGMENTS
    hlsTracks[`t${spec.id}`] = {
      segments,
      duration: SEGMENT_SECONDS,
      format: spec.id === IDS.hlsMp3 ? 'mp3' : 'fmp4',
      bytes: 2048,
      // the long mix's segment links run out after 4 requests: re-signed through a new mint
      ...(spec.id === IDS.expiring && {signed: {validFor: 4}}),
      ...(spec.id === IDS.drmPlaylist && {drm: true}),
    }
  }
  const hls = await startFakeHls({tracks: hlsTracks})
  const hits: Partial<Record<HitKind, number>> = {}
  const hit = (kind: HitKind) => {
    hits[kind] = (hits[kind] ?? 0) + 1
  }
  const clientIds: string[] = []
  const mints: URLSearchParams[] = []
  const idRequests: URLSearchParams[] = []
  let valid = new Set(config.valid ?? [HYDRATION_ID, BUNDLE_ID, OPTION_ID])
  const expiring = new Map<number, number>()
  const sockets = new Set<Socket>()
  let origin = ''
  let api = ''

  const transcodingsOf = (spec: Spec) =>
    spec.transcodings.map(t => ({
      preset: t.preset,
      protocol: t.protocol,
      mime: t.mime ?? 'audio/mp4; codecs="mp4a.40.2"',
      snipped: t.snipped ?? false,
      quality: t.preset === 'aac_96k' ? 'lq' : 'sq',
      legacy: t.preset.startsWith('mp3'),
      url: `${api}/media/soundcloud:tracks:${spec.id}/${t.preset}/${t.protocol}${spec.secret ? `?secret_token=${spec.secret}` : ''}`,
    }))
  const fullTrack = (spec: Spec) => ({
    id: spec.id,
    kind: 'track',
    title: spec.title,
    permalink_url: trackUrl(spec.slug, spec.secret),
    duration: (spec.seconds ?? SEGMENTS * SEGMENT_SECONDS) * 1000,
    full_duration: (spec.id === IDS.snip ? 240 : (spec.seconds ?? SEGMENTS * SEGMENT_SECONDS)) * 1000,
    policy: spec.policy ?? 'ALLOW',
    monetization_model: 'NOT_APPLICABLE',
    sharing: spec.secret ? 'private' : 'public',
    secret_token: spec.secret ?? null,
    user: {id: USER.id, permalink: USER.permalink, username: USER.name},
    media: {transcodings: transcodingsOf(spec)},
    track_authorization: `jwt-${spec.id}`,
    publisher_metadata: spec.id === IDS.clear ? {artist: 'Credited Artist'} : null,
    artwork_url: `https://i1.sndcdn.com/artworks-${spec.id}-large.jpg`,
    created_at: '2026-01-02T03:04:05Z',
  })
  /** A filler track: clear AAC, its page `filler-<n>`. */
  const fillerSpec = (id: number): Spec => ({
    id,
    slug: `filler-${id}`,
    title: `Filler ${id}`,
    transcodings: [aac('aac_160k')],
  })
  const specOf = (id: number): Spec | undefined =>
    SPECS.find(s => s.id === id) ?? (id >= 2000 && id < 4000 ? fillerSpec(id) : undefined)
  // the profile: the named public tracks, then fillers 2000.. (newest first)
  const profile: number[] = [
    ...SPECS.filter(s => !s.secret).map(s => s.id),
    ...Array.from({length: PROFILE_TRACKS - SPECS.filter(s => !s.secret).length}, (_, i) => 2000 + i),
  ]
  const setTracks = [IDS.clear, IDS.low, 3000, 3001, 3002, ...Array.from({length: SET_STUBS}, (_, i) => 3003 + i)]
  /** A private set's stubs: given only with its playlistSecretToken. */
  const privateTracks = [IDS.clear, IDS.low, 3000, 3001, 3002, ...PRIVATE_STUBS]
  const set = (secret?: string) => ({
    id: secret ? 801 : 800,
    kind: 'playlist',
    title: secret ? 'Private Set' : 'Big Set',
    permalink_url: `https://soundcloud.com/${USER.permalink}/sets/${secret ? 'private-set' : 'big-set'}${secret ? `/${secret}` : ''}`,
    secret_token: secret ?? null,
    set_type: '',
    track_count: secret ? privateTracks.length : setTracks.length,
    user: {id: USER.id, permalink: USER.permalink, username: USER.name},
    tracks: (secret ? privateTracks : setTracks).map((id, i) => {
      const spec = specOf(id)
      return i < 5 && spec
        ? fullTrack(spec)
        : {id, kind: 'track', monetization_model: 'NOT_APPLICABLE', policy: 'ALLOW'}
    }),
  })
  const userJson = {
    kind: 'user',
    id: USER.id,
    permalink: USER.permalink,
    username: USER.name,
    track_count: profile.length,
  }

  /** A page of a listing: `items` from `offset`, `limit` asked but 3 fewer given (pages come back short). */
  const page = (url: URL, all: readonly unknown[], path: string) => {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const take = Math.max(1, limit - 3)
    const items = all.slice(offset, offset + take)
    const next = offset + take < all.length ? `${api}${path}?offset=${offset + take}&limit=${limit}` : null
    return {collection: items, next_href: next, query_urn: null}
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    if (p === '/') {
      hit('home')
      if (config.wafHome) {
        res
          .writeHead(202, {'content-type': 'text/html'})
          .end('<html><script src="/challenge.js"></script>aws-waf</html>')
        return
      }
      const hydration = config.hydrationId
      res
        .writeHead(200, {'content-type': 'text/html; charset=utf-8'})
        .end(
          [
            '<!doctype html><html><head><title>SoundCloud</title>',
            '<script src="https://dwt.soundcloud.com/tags.js"></script>',
            `<script crossorigin src="${origin}/assets/0-aaaa.js"></script>`,
            `<script crossorigin src="${origin}/assets/55-bbbb.js"></script>`,
            `<script>window.__sc_version="1792770952"</script>`,
            hydration
              ? `<script>window.__sc_hydration = [{"hydratable":"apiClient","data":{"id":"${hydration}","isExpiring":true}}];</script>`
              : '',
            '</head><body></body></html>',
          ].join('\n'),
        )
      return
    }
    if (p.startsWith('/assets/')) {
      hit('script')
      if (p.includes('55-')) {
        // ~300 KB of code, the id near the end, split across many chunks on the way
        const filler = 'var a=function(){return 1};'.repeat(11_000)
        res
          .writeHead(200, {'content-type': 'application/javascript'})
          .end(`${filler}client_application_id:46941,client_id:"${BUNDLE_ID}",client_is_expiring:!1,env:"production"`)
      } else res.writeHead(200, {'content-type': 'application/javascript'}).end('console.log("other bundle")')
      return
    }
    const short = /^\/short\/([A-Za-z0-9]+)$/.exec(p)
    if (short) {
      hit('short')
      if (short[1] === 'gone') {
        res.writeHead(404).end()
        return
      }
      res
        .writeHead(302, {
          location: `${trackUrl('clear-track')}?ref=clipboard&p=i&c=1&si=0123456789abcdef&utm_source=clipboard`,
        })
        .end()
      return
    }
    if (p === '/expired.m3u8') {
      hit('expired')
      res.writeHead(403, {'content-type': 'text/plain'}).end('expired')
      return
    }
    const cdn = /^\/cdn\/(\d+)\.mp3$/.exec(p)
    if (cdn) {
      hit('cdn')
      const body = Buffer.alloc(MP3_BYTES, 0x55)
      body[0] = 0xff
      body[1] = 0xfb
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      res.writeHead(range ? 206 : 200, {
        'content-type': 'audio/mpeg',
        'content-length': body.length - start,
        ...(range && {'content-range': `bytes ${start}-${body.length - 1}/${body.length}`}),
      })
      res.end(body.subarray(start))
      return
    }
    if (!p.startsWith('/api/')) {
      res.writeHead(404).end()
      return
    }
    const path = p.slice('/api'.length)
    const id = url.searchParams.get('client_id') ?? ''
    clientIds.push(id)
    if (!valid.has(id)) {
      hit('denied')
      res.writeHead(401).end()
      return
    }
    if (path === '/resolve') {
      hit('resolve')
      const target = url.searchParams.get('url') ?? ''
      const m = /^https:\/\/soundcloud\.com\/([^/?]+)(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\/([^/?]+))?$/.exec(target)
      if (!m || m[1] !== USER.permalink) return json(res, 404, {})
      const [, , second, third, fourth] = m
      if (second === undefined) return json(res, 200, userJson)
      if (second === 'sets') {
        if (third === 'big-set' && fourth === undefined) return json(res, 200, set())
        if (third === 'private-set' && fourth === SET_SECRET) return json(res, 200, set(SET_SECRET))
        return json(res, 404, {})
      }
      const spec =
        SPECS.find(s => s.slug === second) ??
        (second.startsWith('filler-') ? specOf(Number(second.slice(7))) : undefined)
      if (!spec || (spec.secret ?? undefined) !== (third ?? undefined)) return json(res, 404, {})
      return json(res, 200, fullTrack(spec))
    }
    if (path === '/tracks') {
      hit('ids')
      idRequests.push(url.searchParams)
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number)
      if (ids.length > 50) return json(res, 400, {})
      const unlocked =
        url.searchParams.get('playlistId') === '801' && url.searchParams.get('playlistSecretToken') === SET_SECRET
      const found = ids
        .filter(i => !REMOVED_STUBS.includes(i) && (unlocked || !PRIVATE_STUBS.includes(i)))
        .map(specOf)
        .filter((s): s is Spec => s !== undefined)
        .map(fullTrack)
      // the API answers in no particular order: reversed here, so a caller that trusts the order fails
      return json(res, 200, found.reverse())
    }
    const listing = /^\/users\/(\d+)\/(tracks|likes|playlists|albums)$/.exec(path)
    if (listing) {
      hit('page')
      if (config.datadome) {
        res
          .writeHead(403, {'content-type': 'application/json', 'x-datadome': 'protected'})
          .end('{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=x"}')
        return
      }
      if (url.searchParams.get('linked_partitioning') !== '1') return json(res, 400, {error: 'partitioning'})
      const tab = listing[2]
      if (tab === 'tracks') {
        return json(
          res,
          200,
          page(
            url,
            profile.map(i => fullTrack(specOf(i)!)),
            path,
          ),
        )
      }
      if (tab === 'likes') {
        const likes = profile
          .slice(0, 40)
          .flatMap((i, n) => [
            {created_at: '2026-01-01T00:00:00Z', kind: 'like', track: fullTrack(specOf(i)!)},
            ...(n % 10 === 0
              ? [{created_at: '2026-01-01T00:00:00Z', kind: 'like', playlist: {id: 900 + n, kind: 'playlist'}}]
              : []),
          ])
        return json(res, 200, page(url, likes, path))
      }
      return json(res, 200, page(url, tab === 'albums' ? [set()] : [set(), set()], path))
    }
    const mint = /^\/media\/soundcloud:tracks:(\d+)\/([^/]+)\/([^/]+)$/.exec(path)
    if (mint) {
      hit('mint')
      mints.push(url.searchParams)
      const trackId = Number(mint[1])
      const [preset, protocol] = [mint[2] ?? '', mint[3] ?? '']
      const spec = specOf(trackId)
      if (!spec || preset.startsWith('abr')) return json(res, 404, {})
      if (spec.secret && url.searchParams.get('secret_token') !== spec.secret) return json(res, 404, {})
      const left = expiring.get(trackId) ?? 0
      if (left > 0) {
        expiring.set(trackId, left - 1)
        return json(res, 200, {url: `${origin}/expired.m3u8?Policy=old`})
      }
      if (protocol === 'progressive') return json(res, 200, {url: `${origin}/cdn/${trackId}.mp3?Policy=p`})
      if (trackId === IDS.previewStream) return json(res, 200, {url: `${hls.origin}/preview/playlist.m3u8`})
      const name = hlsTracks[`t${trackId}`] ? `t${trackId}` : `t${IDS.clear}`
      return json(res, 200, {url: hls.playlistUrl(name)})
    }
    json(res, 404, {})
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const port = await listenLocal(server)
  origin = `http://127.0.0.1:${port}`
  api = `${origin}/api`
  return {
    origin,
    api,
    hls,
    hits,
    clientIds,
    mints,
    idRequests,
    setValid(ids) {
      valid = new Set(ids)
    },
    expireNextMint(id, times = 1) {
      expiring.set(id, times)
    },
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await hls.close()
    },
  }
}
