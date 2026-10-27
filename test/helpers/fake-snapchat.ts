// A local stand-in for Snapchat's public web pages and its media CDN, with the
// shapes the real ones served (verified live 2026-10-26, trimmed to what is
// read): every page a Next.js page with its data in __NEXT_DATA__ → props.pageProps;
// a profile's userProfile ($case publicProfileInfo / userInfo), its live
// story, curated highlights (snaps without ids) and spotlights with their
// metadata aligned by index (empty placeholders included) and the cursors that
// say there is more; a story snap's page (showSnapExpiredToast for a gone one);
// a highlight's page; a spotlight's page with its feed of recommendations;
// `/spotlight/<id>` and `/add/<u>` redirecting as the site does; a 404 page
// that still has __NEXT_DATA__; short links; progressive MP4 / JPEG media, and
// a render that answers 200 with bytes that are not media.
import * as http from 'node:http'
import {listenLocal} from './listen.js'

export type FakeSnapchat = {
  readonly origin: string
  readonly ids: {
    readonly spotlight: string
    readonly otherSpotlight: string
    readonly khaledSpotlight: string
    readonly badSpotlight: string
    readonly storySnap: string
    readonly imageSnap: string
    readonly expiredSnap: string
    readonly highlight: string
    readonly khaledHighlight: string
  }
  readonly hits: Record<'page' | 'media' | 'short' | 'refused', number>
  /** Page paths asked for, in order. */
  readonly pages: readonly string[]
  /** A fetch that sends t.snapchat.com to this server (what the source is given in tests). */
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  close(): Promise<void>
}

export type FakeSnapchatConfig = {
  /** The first N page reads are refused (429). */
  readonly refusals?: number
  readonly mediaBytes?: number
}

const IDS = {
  spotlight: 'W7_EDlXWTBiXAEEniNoMPwAAYeG9xcGd0ZWd3AZ14BVv0AZ14BQkrAAAAAQ',
  otherSpotlight: 'W7_EDlXWTBiXAEEniNoMPwAAYZXhydHlmZ2dzAaFxGagZAaFxGagCAAAAAA',
  khaledSpotlight: 'W7_EDlXWTBiXAEEniNoMPwAAYbHJvd3p4ZWJxAaF5D6o6AaF5D5ecAAAAAA',
  badSpotlight: 'W7_EDlXWTBiXAEEniNoMPwAAYYXBweWdocWx0AaF1T1CGAaF1Tz5EAAAAAA',
  storySnap: 'sWO_duZfSV-aKluMi_U4sgAAgbnpwempiYm9oAaF5D6o6AaF5D5ecAAAAAA',
  imageSnap: 'sWO_duZfSV-aKluMi_U4sgAAgimagesnapAaF5D6o6AaF5D5ecAAAAAA',
  expiredSnap: 'sWO_duZfSV-aKluMi_U4sgAAgexpiredsnapAaF5D6o6AaF5D5ecAAAAA',
  highlight: 'ddf02468-ae16-4fc6-b1bc-bde7e1e22218',
  khaledHighlight: '7479819b-d2de-44ff-a394-8db45a27c8d6',
} as const

export async function startFakeSnapchat(config: FakeSnapchatConfig = {}): Promise<FakeSnapchat> {
  const size = config.mediaBytes ?? 32 * 1024
  const hits = {page: 0, media: 0, short: 0, refused: 0}
  const pages: string[] = []
  let refusalsLeft = config.refusals ?? 0
  let origin = ''

  const media = (key: string, render: string, uc = 94) =>
    `${origin}/d/${key}.${render}?mo=GlcaFDIBBDoBfUIGCMWw5M4GSAJQXmABUMIBWgdEZk1lZGlh&uc=${uc}`
  /** One snap as the site writes it: `snapId.value` is "" in highlights. */
  const snap = (index: number, snapId: string, type: 0 | 1, key: string, render: string, at: string) => ({
    snapIndex: index,
    snapId: {value: snapId},
    snapMediaType: type,
    snapUrls: {
      mediaUrl: media(key, render),
      mediaPreviewUrl: {value: media(key, type === 0 ? '256.IRZXSOY' : '410')},
      overlayUrl: null,
      attachmentUrl: null,
    },
    isSponsored: null,
    timestampInSec: {value: at},
    snapTitle: null,
    snapSubtitles: null,
    lat: null,
    lng: null,
    hasAttachment: null,
    intervalStartTimeMs: null,
    audioTranscriptionObjectUrl: null,
  })
  const story = (storyType: number, snapList: unknown[], extra: Record<string, unknown> = {}) => ({
    storyType,
    snapList,
    storyId: {value: ''},
    storyTitle: null,
    thumbnailUrl: {value: media('thumb', '256.IRZXSOY')},
    storySubtitle: null,
    storyShareId: null,
    canonicalUrlSuffix: null,
    emoji: null,
    storyTapId: '0',
    videoTrackUrl: null,
    highlightId: null,
    isAttributed: null,
    thumbnailTiles: [],
    ...extra,
  })
  const highlight = (id: string, title: string, snapList: unknown[]) =>
    story(3, snapList, {highlightId: {value: id}, storyTitle: {value: title}})
  const spotlightSlot = (id: string, key: string, at: string) =>
    story(15, [snap(0, id, 1, key, '27.IRZXSOY', at)], {storyId: {value: id}, isAttributed: {value: true}})
  /** What a removed slot looks like: storyType 0, no snaps, no id. */
  const placeholder = () => ({...story(0, []), storyId: null, thumbnailUrl: null})
  const videoMetadata = (user: string, name: string, key: string, uploaded: string, caption = '') => ({
    name,
    description: 'Another Spotlight Snap brought to you by Snapchat',
    thumbnailUrl: media(key, '256.IRZXSOY', 46),
    uploadDateMs: uploaded,
    viewCount: '25122',
    contentUrl: media(key, '27.IRZXSOY', 46),
    creator: {
      $case: 'personCreator',
      personCreator: {
        username: user,
        url: `https://www.snapchat.com/@${user}`,
        name: user === 'nasa' ? 'NASA' : 'DJ Khaled',
        followerCount: '0',
        websiteUrl: '',
      },
    },
    durationMs: '87330',
    width: 540,
    height: 960,
    keywords: [],
    shareCount: '0',
    embeddedTextCaption: caption,
  })
  const emptyMetadata = () => ({
    name: '',
    description: '',
    thumbnailUrl: '',
    uploadDateMs: '0',
    viewCount: '0',
    contentUrl: '',
    creator: null,
    durationMs: '0',
    width: 0,
    height: 0,
    keywords: [],
    shareCount: '0',
    embeddedTextCaption: '',
  })
  const metadata = (video: unknown) => ({
    videoMetadata: video,
    userMetadata: null,
    lensMetadata: null,
    hashtags: [],
    engagementStats: {viewCount: '9400', shareCount: '0', commentCount: '0', boostCount: '0', recommendCount: '0'},
    description: '',
  })
  const publicProfile = (user: string, title: string, hasStory: boolean) => ({
    $case: 'publicProfileInfo',
    publicProfileInfo: {
      username: user,
      title,
      badge: 1,
      subscriberCount: '752300',
      bio: '',
      profilePictureUrl: `${origin}/aps/bolt/avatar._RS0,90_FMjpeg`,
      hasCuratedHighlights: true,
      hasSpotlightHighlights: true,
      hasStory,
      creationTimestampMs: {value: '1558546707554'},
      lastUpdateTimestampMs: {value: '1791822999508'},
    },
  })

  const nasaHighlight = () =>
    highlight(IDS.highlight, 'Moon Joy', [
      snap(0, '', 1, 'wAUDrJs74QBAl504N3DhT', '1322', '1775835174'),
      snap(1, '', 1, 'h2ao1JvA4lER8PICU97Gc', '1322', '1775835174'),
      snap(2, '', 0, 'P3on7eEnru2cpdUoxfCAk', '400.IRZXSOY', '1775835174'),
    ])
  // NASA: no live story, a highlight, one spotlight; a highlights cursor says there is more
  const nasa = () => ({
    userProfile: publicProfile('nasa', 'NASA', false),
    story: null,
    curatedHighlights: [nasaHighlight()],
    spotlightHighlights: [spotlightSlot(IDS.spotlight, '1z1p5kZtkBheBrRMCmyGi', '1775835089')],
    spotlightStoryMetadata: [
      metadata(videoMetadata('nasa', 'Spotlight Snap', '1z1p5kZtkBheBrRMCmyGi', '1775835089195')),
    ],
    curatedHighlightsCursor: 'eyJkZGJfcGFnaW5hdGlvbl9jdXJzb3IiOiJleUprWkdKZiIsInN0bXNfcGFnaW5hdGlvbl9jdXJzb3IiOiIifQ',
    spotlightHighlightsCursor: '',
    showSnapExpiredToast: false,
    viewerInfo: {country: 'MX', locale: 'en-US', isGdprCountry: false},
  })
  // DJ Khaled: a live story (a video and a picture), a highlight, two spotlights and a placeholder between them
  const khaledStory = () =>
    story(
      5,
      [
        snap(0, IDS.storySnap, 1, 'fUYevfOsBYALwwK2nQcbJ', '1034.IRZXSOY', '1793032427'),
        snap(1, IDS.imageSnap, 0, 'Q3on7eEnru2cpdUoxfCAk', '400.IRZXSOY', '1793032500'),
      ],
      {storyId: {value: 'djkhaled305'}},
    )
  const khaled = (expired = false) => ({
    userProfile: publicProfile('djkhaled305', 'DJ Khaled', true),
    story: khaledStory(),
    storyMetadata: null,
    curatedHighlights: [
      highlight(IDS.khaledHighlight, 'Studio', [snap(0, '', 1, 'nwivMbQsIuWuYGXVVAsVE', '1325.IRZXSOY', '1793000000')]),
    ],
    spotlightHighlights: [
      spotlightSlot(IDS.khaledSpotlight, 'fUYevfOsBYALwwK2nQcbJ', '1793032427'),
      placeholder(),
      spotlightSlot(IDS.badSpotlight, 'badrenderkey', '1792969489'),
    ],
    spotlightStoryMetadata: [
      metadata(
        videoMetadata(
          'djkhaled305',
          'The bills don’t stop why should I',
          'fUYevfOsBYALwwK2nQcbJ',
          '1793032427420',
          'The bills don’t stop why should I',
        ),
      ),
      metadata(emptyMetadata()),
      metadata(videoMetadata('djkhaled305', 'Spotlight Snap', 'badrenderkey', '1792969489988')),
    ],
    curatedHighlightsCursor: '',
    spotlightHighlightsCursor: '',
    showSnapExpiredToast: expired,
  })
  const spotlightPage = () => ({
    spotlightFeed: {
      spotlightStories: [
        {
          story: spotlightSlot(IDS.spotlight, '1z1p5kZtkBheBrRMCmyGi', '1775835089'),
          metadata: metadata(videoMetadata('nasa', 'Spotlight Snap', '1z1p5kZtkBheBrRMCmyGi', '1775835089195')),
          contentSource: 'ssr_initial',
        },
        {
          story: spotlightSlot(IDS.otherSpotlight, 'otherCreatorKey0000001', '1700000000'),
          metadata: metadata(videoMetadata('someoneelse', 'Not this one', 'otherCreatorKey0000001', '1700000000000')),
          contentSource: 'ssr_feed',
        },
      ],
    },
    videoMetadata: videoMetadata('nasa', 'Spotlight Snap', '1z1p5kZtkBheBrRMCmyGi', '1775835089195'),
    isAttributed: true,
    restricted: false,
    variant: 'spotlight_snap',
  })

  const page = (pageName: string, pageProps: unknown) =>
    '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Snapchat</title>' +
    '<link rel="preload" as="video" href="x"/></head><body><div id="__next"></div>' +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {pageProps},
      page: pageName,
      query: {},
      buildId: 'Ts6KO1a2VYaAZzhl1g0iE',
      isFallback: false,
    })}</script></body></html>`

  /** Path → [status, html] (a redirect: [30x, location]). */
  const route = (pathname: string): [number, string] => {
    const decoded = decodeURIComponent(pathname)
    switch (decoded) {
      case '/@nasa':
        return [200, page('/at/[username]', nasa())]
      case '/@djkhaled305':
        return [200, page('/at/[username]', khaled())]
      case `/@djkhaled305/${IDS.storySnap}`:
      case `/@djkhaled305/${IDS.imageSnap}`:
        return [200, page('/at/[username]/[snapId]', khaled())]
      case `/@djkhaled305/${IDS.expiredSnap}`:
        return [200, page('/at/[username]/[snapId]', khaled(true))]
      case `/@nasa/highlight/${IDS.highlight}`:
        return [
          200,
          page('/at/[username]/highlight/[highlightId]', {
            highlight: nasaHighlight(),
            highlightId: IDS.highlight,
            publicUserProfile: {username: 'nasa', title: 'NASA'},
          }),
        ]
      case `/spotlight/${IDS.spotlight}`:
        return [301, `/@nasa/spotlight/${IDS.spotlight}`]
      case `/@nasa/spotlight/${IDS.spotlight}`:
        return [200, page('/@[username]/spotlight/[snapID]', spotlightPage())]
      case '/add/djkhaled305':
        return [308, '/@djkhaled305']
      // a private account (the web shows nothing: userProfile is its `userInfo` case)
      case '/@hiddenfriend':
        return [
          200,
          page('/at/[username]', {
            userProfile: {$case: 'userInfo', userInfo: {username: 'hiddenfriend', displayName: 'Hidden'}},
          }),
        ]
      // a page whose data moved: no key of a profile where it was
      case '/@movedthings':
        return [200, page('/at/[username]', {profileV2: {username: 'movedthings'}})]
      // a page without its data script at all
      case '/@nodatascript':
        return [200, '<!DOCTYPE html><html><body><div id="__next">Snapchat</div></body></html>']
      case '/t/aBcD1234':
        return [301, `https://www.snapchat.com/spotlight/${IDS.spotlight}?share_id=Zx9&locale=en-US`]
      case '/t/toNowhere':
        return [301, 'https://www.snapchat.com/discover/some-show/123']
      case '/__t/eFgH5678':
        return [302, 'https://www.snapchat.com/add/djkhaled305?share_id=abc']
      default:
        return [404, page('/404', {statusCode: 404})]
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const send = (status: number, body: string | Buffer, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(status, {'Content-Length': Buffer.byteLength(body), ...headers})
      res.end(body)
    }
    if (url.pathname.startsWith('/d/')) {
      hits.media++
      const name = url.pathname.slice(3)
      if (name.startsWith('badrenderkey')) {
        // a render the key lacks: 200, "video/mp4", and bytes that are no MP4 (encrypted, as seen live)
        return send(200, Buffer.alloc(size, 0x5a), {'Content-Type': 'video/mp4'})
      }
      const image = name.includes('.400') || name.includes('.256')
      const head = image
        ? Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
        : Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])
      const body = Buffer.concat([head, Buffer.alloc(size - head.length, `${name}|`)])
      return send(200, body, {
        'Content-Type': image ? 'image/jpeg' : 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Last-Modified': 'Fri, 10 Apr 2026 15:31:29 GMT',
      })
    }
    const short = url.pathname.startsWith('/t/') || url.pathname.startsWith('/__t/')
    if (short) hits.short++
    else {
      hits.page++
      pages.push(url.pathname)
      if (refusalsLeft > 0) {
        refusalsLeft--
        hits.refused++
        return send(429, 'Too Many Requests')
      }
    }
    const [status, body] = route(url.pathname)
    if (status >= 300 && status < 400) return send(status, '', {Location: body})
    return send(status, body, {'Content-Type': 'text/html; charset=utf-8'})
  })
  const port = await listenLocal(server)
  origin = `http://127.0.0.1:${port}`
  const fakeFetch = (input: string, init?: RequestInit) =>
    fetch(
      input.startsWith('https://t.snapchat.com/')
        ? `${origin}/__t/${input.slice('https://t.snapchat.com/'.length)}`
        : input,
      init,
    )
  return {
    origin,
    ids: IDS,
    hits,
    pages,
    fetch: fakeFetch,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
