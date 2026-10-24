// A local stand-in for X's syndication endpoint (the data its embedded posts
// read), t.co and video.twimg.com, with the answers the real ones give (seen
// October 2026): a post with progressive MP4s at several sizes plus an HLS
// playlist, a post with several videos and a picture between them, an
// animated GIF (one MP4, bitrate 0, no size in its url), a picture-only post,
// a video card, a quote of a post with a video, tombstones, a 404 page for an
// id that never existed, `{}` for a request without its token, refusals, and
// t.co answering a browser with a meta-refresh page.
import * as http from 'node:http'
import {syndicationToken} from '../../src/sources/x/data.js'
import {listenLocal} from './listen.js'

export type FakeXConfig = {
  /** The first N post reads are refused (429). */
  readonly refusals?: number
  /** The first N t.co requests are refused (503). */
  readonly shortRefusals?: number
  readonly mediaBytes?: number
}

export type FakeX = {
  readonly origin: string
  /** Post ids by what they hold. */
  readonly ids: {
    readonly single: string
    readonly multi: string
    readonly gif: string
    readonly photos: string
    readonly card: string
    readonly quote: string
    readonly deleted: string
    readonly withdrawn: string
    readonly changed: string
    readonly hlsOnly: string
    readonly amplify: string
    readonly playerCard: string
    readonly article: string
    readonly suspended: string
    readonly withheld: string
  }
  readonly hits: Record<'post' | 'media' | 'short' | 'refused' | 'badToken', number>
  /** Every media path asked for, in order. */
  readonly served: readonly string[]
  /** A fetch that sends t.co links to this server (what the source is given in tests). */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  close(): Promise<void>
}

const IDS = {
  single: '1585341984679469056',
  multi: '1600649710662213632',
  gif: '1839019491835129889',
  photos: '266031293945503744',
  card: '1349794411333394432',
  quote: '1395079556562706435',
  deleted: '700207533655363584',
  withdrawn: '643211948184596480',
  changed: '1700000000000000001',
  hlsOnly: '1700000000000000002',
  amplify: '665052190608723968',
  playerCard: '1700000000000000004',
  article: '1700000000000000005',
  suspended: '852138619213144067',
  withheld: '1700000000000000006',
} as const

export async function startFakeX(config: FakeXConfig = {}): Promise<FakeX> {
  const size = config.mediaBytes ?? 32 * 1024
  const served: string[] = []
  const hits = {post: 0, media: 0, short: 0, refused: 0, badToken: 0}
  let refusalsLeft = config.refusals ?? 0
  let shortRefusalsLeft = config.shortRefusals ?? 0
  let origin = ''

  const sizes: ReadonlyArray<readonly [number, number, number]> = [
    [480, 270, 256_000],
    [1280, 720, 2_176_000],
    [1920, 1080, 10_368_000],
    [640, 360, 832_000],
  ]
  /** A video media object: progressive MP4s named by size, an HLS playlist first (as X lists them). */
  const video = (mediaId: string, portrait = false, list = sizes) => ({
    type: 'video',
    media_url_https: `${origin}/ext_tw_video_thumb/${mediaId}/pu/img/thumb.jpg`,
    original_info: portrait ? {width: 1080, height: 1920} : {width: 1920, height: 1080},
    ext_media_availability: {status: 'Available'},
    video_info: {
      aspect_ratio: portrait ? [9, 16] : [16, 9],
      duration_millis: 9301,
      variants: [
        {content_type: 'application/x-mpegURL', url: `${origin}/ext_tw_video/${mediaId}/pu/pl/list.m3u8?tag=14`},
        ...list.map(([w, h, bitrate]) => ({
          bitrate,
          content_type: 'video/mp4',
          url: `${origin}/ext_tw_video/${mediaId}/pu/vid/${portrait ? `${h}x${w}` : `${w}x${h}`}/file.mp4?tag=14`,
        })),
      ],
    },
  })
  const photo = () => ({
    type: 'photo',
    media_url_https: `${origin}/media/photo.jpg`,
    original_info: {width: 1200, height: 800},
  })
  const tweet = (id: string, text: string, media: unknown[] | undefined, extra: Record<string, unknown> = {}) => ({
    __typename: 'Tweet',
    id_str: id,
    text,
    created_at: '2022-10-26T18:45:58.000Z',
    user: {id_str: '44196397', name: 'Fake Account', screen_name: 'fakeaccount'},
    ...(media && {mediaDetails: media}),
    ...extra,
  })

  const posts = (): Record<string, unknown> => ({
    [IDS.single]: tweet(IDS.single, 'Entering the office &amp; more – let that sink in! https://t.co/D68z4K2wq7', [
      video('1585341912877146112'),
    ]),
    [IDS.multi]: tweet(IDS.multi, 'Two videos and a picture\nsecond line https://t.co/abcdEFGH12', [
      video('1600649511827038209', true),
      photo(),
      video('1600649511827013632', true),
    ]),
    [IDS.gif]: tweet(IDS.gif, 'A dancing cat https://t.co/K9DsIoec62', [
      {
        type: 'animated_gif',
        media_url_https: `${origin}/tweet_video_thumb/GYWCeZAaMAQ32uh.jpg`,
        original_info: {width: 498, height: 280},
        video_info: {
          aspect_ratio: [249, 140],
          variants: [{bitrate: 0, content_type: 'video/mp4', url: `${origin}/tweet_video/GYWCeZAaMAQ32uh.mp4`}],
        },
      },
    ]),
    [IDS.photos]: tweet(IDS.photos, 'Four more years. http://t.co/bAJE6Vom', [photo()], {photos: [{}]}),
    [IDS.card]: tweet(IDS.card, 'WATCH: the full session https://t.co/cardLink01', undefined, {
      card: {
        name: 'unified_card',
        binding_values: {
          unified_card: {
            type: 'STRING',
            string_value: JSON.stringify({
              type: 'video_website',
              media_entities: {'13_1349774757969989634': video('1349774757969989634')},
            }),
          },
        },
      },
    }),
    [IDS.quote]: tweet(IDS.quote, 'Here it is! Finished my cartoon https://t.co/quoteLink1', undefined, {
      quoted_tweet: {
        id_str: '1284162907446501377',
        text: 'Some test animation https://t.co/0BuUZCYhW7',
        created_at: '2020-07-17T16:00:00.000Z',
        user: {name: 'Quoted Artist', screen_name: 'quotedartist'},
        mediaDetails: [video('1284162716018413568')],
      },
    }),
    [IDS.deleted]: {
      __typename: 'TweetTombstone',
      tombstone: {text: {text: 'This Post was deleted by the Post author. Learn more', entities: []}},
    },
    [IDS.withdrawn]: {__typename: 'TweetTombstone', tombstone: {}},
    [IDS.changed]: tweet(IDS.changed, 'Moved things around', [{type: 'video', media_url_https: 'x'}]),
    [IDS.hlsOnly]: tweet(IDS.hlsOnly, 'A stream only', [video('1700000000000000003', false, [])]),
    // what the live endpoint answers for @starwars' 2015 trailer: no media, a link to the amplify player
    [IDS.amplify]: tweet(IDS.amplify, 'Watch the official 60 second #TV spot https://t.co/OkSqT2fjWJ', undefined, {
      entities: {
        urls: [
          {
            url: 'https://t.co/OkSqT2fjWJ',
            expanded_url: 'https://amp.twimg.com/v/93ad3568-03d2-47b9-a57b-624b88693acd',
          },
        ],
      },
    }),
    [IDS.playerCard]: tweet(IDS.playerCard, 'A clip in a player card', undefined, {
      card: {name: 'player', binding_values: {player_url: {type: 'STRING', string_value: 'https://example.com/embed'}}},
    }),
    // text, a link to an article and its preview card: no video anywhere
    [IDS.article]: tweet(IDS.article, 'Read this https://t.co/article01', undefined, {
      entities: {urls: [{url: 'https://t.co/article01', expanded_url: 'https://example.com/news/1'}]},
      card: {name: 'summary_large_image', binding_values: {title: {type: 'STRING', string_value: 'News'}}},
    }),
    [IDS.suspended]: {
      __typename: 'TweetTombstone',
      tombstone: {text: {text: 'This Post is from a suspended account. Learn more', entities: []}},
    },
    [IDS.withheld]: tweet(IDS.withheld, 'Withheld', [
      {...video('1700000000000000007'), ext_media_availability: {status: 'Unavailable', reason: 'Dmcaed'}},
    ]),
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const send = (status: number, body: string | Buffer, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, {'Content-Length': Buffer.byteLength(body), ...headers})
      res.end(body)
    }
    if (url.pathname === '/tweet-result') {
      hits.post++
      if (refusalsLeft > 0) {
        refusalsLeft--
        hits.refused++
        return send(429, 'Rate limit exceeded')
      }
      const id = url.searchParams.get('id') ?? ''
      if (url.searchParams.get('token') !== syndicationToken(id)) {
        hits.badToken++
        return send(200, '{}', {'Content-Type': 'application/json'})
      }
      const post = posts()[id]
      if (!post) return send(404, '<!DOCTYPE html><html class="dog"><body>Nothing here</body></html>')
      return send(200, JSON.stringify(post), {'Content-Type': 'application/json; charset=utf-8'})
    }
    if (url.pathname.startsWith('/tco/')) {
      hits.short++
      if (shortRefusalsLeft > 0) {
        shortRefusalsLeft--
        return send(503, 'Over capacity')
      }
      const code = url.pathname.slice('/tco/'.length)
      // t.co names a post's first video, whatever the post holds
      const target =
        code === 'multiLink1'
          ? `https://twitter.com/fakeaccount/status/${IDS.multi}/video/1`
          : code === 'singleLink'
            ? `https://twitter.com/fakeaccount/status/${IDS.single}/video/1`
            : code === 'outside01'
              ? 'https://example.com/article'
              : undefined
      if (!target) return send(404, 'Not found')
      // what t.co answers a desktop browser: a page that refreshes to the link
      return send(
        200,
        `<head><noscript><META http-equiv="refresh" content="0;URL=${target}"></noscript><title>${target}</title></head><script>location.replace("${target.replace(/\//g, '\\/')}")</script>`,
        {'Content-Type': 'text/html; charset=utf-8'},
      )
    }
    if (url.pathname.startsWith('/ext_tw_video/') || url.pathname.startsWith('/tweet_video/')) {
      hits.media++
      served.push(url.pathname)
      // the body says which file it is; a GIF is silent (a fake ffprobe reads "s…" as no audio stream)
      const label = url.pathname.startsWith('/tweet_video/')
        ? 's-gif'
        : (/\/(\d+x\d+)\//.exec(url.pathname)?.[1] ?? '?')
      const body = Buffer.alloc(size, `${label}|`)
      return send(200, body, {'Content-Type': 'video/mp4', 'Last-Modified': 'Wed, 26 Oct 2022 18:43:40 GMT'})
    }
    return send(404, 'Not found')
  })
  const port = await listenLocal(server)
  origin = `http://127.0.0.1:${port}`
  const fakeFetch = (input: string, init?: RequestInit) =>
    fetch(input.startsWith('https://t.co/') ? `${origin}/tco/${input.slice('https://t.co/'.length)}` : input, init)
  return {
    origin,
    ids: IDS,
    hits,
    served,
    fetch: fakeFetch,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
