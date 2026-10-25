import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {parseNetscape, toNetscape} from '../src/core/cookies.js'
import type {DownloadError} from '../src/core/errors.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import type {BrowserAssist} from '../src/sources/browser.js'
import {
  checkStatus,
  codeToPk,
  pkToCode,
  readEmbedPage,
  readGraphNode,
  readLoggedOutPostQuery,
  readMediaInfo,
  readPostPage,
  readV1Item,
  readWebInfoQuery,
} from '../src/sources/instagram/data.js'
import {isInstagramListing, parseInstagramLink, unwrapInstagramRedirect} from '../src/sources/instagram/links.js'
import {linkExpiry, QueryBook, RouteHealth} from '../src/sources/instagram/routes.js'
import {type InstagramOptions, InstagramSource} from '../src/sources/instagram/source.js'
import {MetaError} from '../src/sources/meta/errors.js'
import {walkCursor} from '../src/sources/meta/listing.js'
import {choicesOf, shapeOf, summaryOf, titleOf} from '../src/sources/meta/post.js'
import {findAllWithKey, findWithKey, jsonScripts} from '../src/sources/meta/relay.js'
import {COOLING_DOWN} from '../src/sources/pacer.js'
import {SOURCE_BLOCKED} from '../src/sources/source.js'
import {type FakeInstagram, SESSION_COOKIE, startFakeInstagram} from './helpers/fake-instagram.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const audio = {kind: 'audio', container: 'mp3'} as const
const images = {mode: 'images', secondsPerImage: 3} as const

describe('Instagram links', () => {
  it("Instagram's outbound wrapper (l.instagram.com/?u=) is unwrapped without a request; only to http(s)", () => {
    const wrapped = `https://l.instagram.com/?u=${encodeURIComponent('https://www.instagram.com/p/DeRxA44ssLU/')}&e=AT0`
    assert.deepEqual(parseInstagramLink(wrapped), {kind: 'post', code: 'DeRxA44ssLU'})
    assert.equal(unwrapInstagramRedirect(wrapped), 'https://www.instagram.com/p/DeRxA44ssLU/')
    assert.equal(
      unwrapInstagramRedirect('https://lm.instagram.com/?u=https%3A%2F%2Fexample.com%2Fv.mp4'),
      'https://example.com/v.mp4',
    )
    const script = 'https://l.instagram.com/?u=javascript%3Aalert(1)'
    assert.equal(unwrapInstagramRedirect(script), script)
    assert.equal(
      unwrapInstagramRedirect('https://www.instagram.com/p/X/?u=https://a.b'),
      'https://www.instagram.com/p/X/?u=https://a.b',
    )
  })

  it('a code under a user name is a post, whatever the route: /p/, /reel/, /reels/, /tv/', () => {
    for (const route of ['p', 'reel', 'reels', 'tv']) {
      assert.deepEqual(parseInstagramLink(`https://www.instagram.com/nasa/${route}/DeTUk4sDSp-/?img_index=2`), {
        kind: 'post',
        code: 'DeTUk4sDSp-',
        user: 'nasa',
      })
    }
    assert.deepEqual(parseInstagramLink('https://www.instagram.com/nasa/reels/'), {kind: 'profile', user: 'nasa'})
  })

  it('recognizes posts, reels, profiles, stories, highlights and share links', () => {
    assert.deepEqual(parseInstagramLink('https://www.instagram.com/p/C0DE000001/?igsh=abc'), {
      kind: 'post',
      code: 'C0DE000001',
    })
    assert.deepEqual(parseInstagramLink('https://www.instagram.com/reel/C0DE000002/'), {
      kind: 'post',
      code: 'C0DE000002',
    })
    assert.deepEqual(parseInstagramLink('https://instagram.com/some.user/reel/C0DE000003/'), {
      kind: 'post',
      code: 'C0DE000003',
      user: 'some.user',
    })
    assert.deepEqual(parseInstagramLink('https://www.instagram.com/some.user/'), {kind: 'profile', user: 'some.user'})
    assert.deepEqual(parseInstagramLink('https://www.instagram.com/some.user/reels/'), {
      kind: 'profile',
      user: 'some.user',
    })
    assert.deepEqual(parseInstagramLink('https://www.instagram.com/stories/some.user/'), {
      kind: 'stories',
      user: 'some.user',
    })
    assert.deepEqual(parseInstagramLink('https://www.instagram.com/stories/some.user/3600000000000000001/'), {
      kind: 'stories',
      user: 'some.user',
      id: '3600000000000000001',
    })
    assert.deepEqual(parseInstagramLink('https://www.instagram.com/stories/highlights/17900000000000000/'), {
      kind: 'highlight',
      id: '17900000000000000',
    })
    assert.equal(parseInstagramLink('https://www.instagram.com/share/p/abc123/')?.kind, 'short')
    assert.equal(parseInstagramLink('https://www.instagram.com/explore/'), undefined)
    assert.equal(parseInstagramLink('https://www.instagram.com/accounts/login/'), undefined)
    assert.equal(parseInstagramLink('https://www.tiktok.com/@x'), undefined)
    assert.equal(isInstagramListing('https://www.instagram.com/some.user/'), true)
    assert.equal(isInstagramListing('https://www.instagram.com/p/C0DE000001/'), false)
  })
})

describe('Instagram data', () => {
  it('reads v1 items: a video, a carousel, a story; captions make titles, hashtags are dropped', () => {
    const video = readV1Item({
      pk: 1,
      code: 'ABCDE',
      media_type: 2,
      taken_at: 1_700_000_000,
      caption: {text: 'Hola mundo #uno #dos\nsegunda línea'},
      user: {username: 'u', full_name: 'User'},
      video_versions: [
        {url: 'https://cdn/hd.mp4', width: 1080, height: 1920, bandwidth: 2},
        {url: 'https://cdn/sd.mp4', width: 720, height: 1280, bandwidth: 1},
        {url: 'https://cdn/hd.mp4', width: 1080, height: 1920},
      ],
      image_versions2: {candidates: [{url: 'https://cdn/cover.jpg', width: 1080, height: 1920}]},
      video_duration: 12.5,
    })
    assert.equal(video.id, '1')
    assert.equal(video.url, 'https://www.instagram.com/p/ABCDE/')
    assert.equal(shapeOf(video), 'video')
    assert.equal(titleOf(video, 'Instagram'), 'Hola mundo')
    const item = video.items[0]!
    assert.equal(item.kind, 'video')
    if (item.kind === 'video') {
      assert.deepEqual(
        item.renditions.map(r => [r.resolution, r.urls[0]]),
        [
          [1080, 'https://cdn/hd.mp4'],
          [720, 'https://cdn/sd.mp4'],
        ],
        'duplicate urls are dropped',
      )
      assert.equal(item.duration, 12.5)
      assert.equal(item.cover, 'https://cdn/cover.jpg')
    }
    assert.deepEqual(
      choicesOf(video)
        .slice(0, 2)
        .map(c => c.label),
      ['1080p · MP4', '720p · MP4'],
    )

    const carousel = readV1Item({
      pk: '2',
      code: 'CAR',
      media_type: 8,
      carousel_media: [
        {
          pk: '21',
          media_type: 1,
          image_versions2: {candidates: [{url: 'https://cdn/a.jpg', width: 1080, height: 1350}]},
        },
        {
          pk: '22',
          media_type: 2,
          video_versions: [{url: 'https://cdn/v.mp4', width: 720, height: 900}],
          video_duration: 3,
        },
      ],
      user: {username: 'u'},
    })
    assert.equal(shapeOf(carousel), 'carousel')
    assert.deepEqual(summaryOf(carousel, 'Instagram').slideshow, {images: 2, audio: true, videos: true})
    assert.equal(titleOf(carousel, 'Instagram'), 'Instagram 2')

    const story = readV1Item(
      {
        pk: '3',
        media_type: 1,
        taken_at: 1_700_000_000,
        expiring_at: 1_700_086_400,
        user: {username: 'u'},
        image_versions2: {candidates: [{url: 'https://cdn/s.jpg', width: 1080, height: 1920}]},
      },
      {story: true},
    )
    assert.equal(story.url, 'https://www.instagram.com/stories/u/3/')
    assert.equal(story.expiresAt, 1_700_086_400)
    assert.match(titleOf(story, 'Instagram'), /^Instagram story 2023-11-14/)
    assert.equal(shapeOf(story), 'photo')
  })

  it('reads GraphQL nodes (profile info, post query) into the same model', () => {
    const post = readGraphNode({
      __typename: 'XDTGraphSidecar',
      id: '9',
      shortcode: 'SIDE',
      taken_at_timestamp: 1_700_000_000,
      owner: {username: 'u', full_name: 'User'},
      edge_media_to_caption: {edges: [{node: {text: 'Carrusel'}}]},
      display_url: 'https://cdn/1.jpg',
      dimensions: {width: 1080, height: 1350},
      edge_sidecar_to_children: {
        edges: [
          {
            node: {
              __typename: 'XDTGraphImage',
              id: '91',
              display_url: 'https://cdn/1.jpg',
              display_resources: [{src: 'https://cdn/1-small.jpg'}, {src: 'https://cdn/1.jpg'}],
              dimensions: {width: 1080, height: 1350},
            },
          },
          {
            node: {
              __typename: 'XDTGraphVideo',
              id: '92',
              is_video: true,
              video_url: 'https://cdn/2.mp4',
              display_url: 'https://cdn/2.jpg',
              dimensions: {width: 720, height: 1280},
              video_duration: 4,
            },
          },
        ],
      },
    })
    assert.equal(post.items.length, 2)
    assert.deepEqual(post.items[0]!.kind === 'image' ? post.items[0]!.urls : [], [
      'https://cdn/1.jpg',
      'https://cdn/1-small.jpg',
    ])
    assert.equal(post.items[1]!.kind, 'video')
    assert.equal(post.caption, 'Carrusel')
  })

  it('tells login walls, rate limits, checkpoints and gone posts apart', () => {
    const problem = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return (error as MetaError).problem
      }
      return 'none'
    }
    assert.equal(
      problem(() => checkStatus({status: 'ok'})),
      'none',
    )
    assert.equal(
      problem(() => checkStatus({status: 'fail', message: 'login_required'})),
      'login-required',
    )
    assert.equal(
      problem(() => checkStatus({status: 'fail', message: 'Please wait a few minutes before you try again.'})),
      'refused',
    )
    assert.equal(
      problem(() => checkStatus({status: 'fail', message: 'checkpoint_required'})),
      'challenge',
    )
    assert.equal(
      problem(() => checkStatus({status: 'fail', message: 'Media not found'})),
      'removed',
    )
    assert.equal(
      problem(() => readPostPage({html: '<html/>', url: 'https://www.instagram.com/accounts/login/?next=/p/x/'})),
      'challenge',
    )
    assert.equal(
      problem(() =>
        readPostPage({html: "<html>Sorry, this page isn't available.</html>", url: 'https://www.instagram.com/p/x/'}),
      ),
      'removed',
    )
    assert.equal(
      problem(() => readPostPage({html: '<html><div id="new"></div></html>', url: 'https://www.instagram.com/p/x/'})),
      'format-changed',
    )
  })
})

// The anonymous routes, from fixtures shaped like what the site answers today (the embed's
// contextJSON, the page's data-sjs blobs, the app API's item) — ported from the Android host's
// instagram-anon tests — and the wall each of them turns into when Instagram limits a network.
describe('Instagram anonymous routes', () => {
  const node = {
    id: '3956405067326902270',
    shortcode: 'Dbn-XJhk0_-',
    is_video: true,
    product_type: 'clips',
    video_url: 'https://scontent.cdninstagram.com/v/t66/reel.mp4?x=1',
    dimensions: {width: 720, height: 1280},
    video_duration: 12.5,
    has_audio: true,
    display_url: 'https://scontent.cdninstagram.com/cover.jpg',
    owner: {username: 'nasa', full_name: 'NASA'},
    taken_at_timestamp: 1760000000,
    edge_media_to_caption: {edges: [{node: {text: 'Earth from orbit #space #nasa\nmore'}}]},
  }
  const item = {
    pk: '3956405067326902270',
    code: 'Dbn-XJhk0_-',
    media_type: 2,
    product_type: 'clips',
    video_duration: 12.5,
    has_audio: true,
    taken_at: 1760000000,
    caption: {text: 'Earth from orbit'},
    user: {username: 'nasa', full_name: 'NASA'},
    image_versions2: {candidates: [{url: 'https://scontent.cdninstagram.com/cover.jpg'}]},
    video_versions: [
      {type: 101, width: 720, height: 1280, url: 'https://scontent.cdninstagram.com/v/hd.mp4'},
      {type: 102, width: 480, height: 854, url: 'https://scontent.cdninstagram.com/v/sd.mp4'},
      {type: 103, width: 480, height: 854, url: 'https://scontent.cdninstagram.com/v/sd.mp4'},
    ],
  }
  const embedHtml = (gql: unknown) =>
    `<!DOCTYPE html><html><head><title>Instagram</title></head><body><script>(function(){require("EmbedSimple").init(${JSON.stringify({contextJSON: JSON.stringify({gql_data: gql})})});})();</script></body></html>`
  /** Instagram's wall: the whole app shell, a bare "Instagram" title, no post data. */
  const wallHtml = `<!DOCTYPE html><html><head><title>Instagram</title></head><body><script data-sjs>{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"define":[["PolarisLoginPage",[],{},1]]}}]]]}</script>${'x'.repeat(2000)}</body></html>`
  const embedUrl = 'https://www.instagram.com/p/Dbn-XJhk0_-/embed/captioned/'
  const problemOf = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      return error instanceof MetaError ? error.problem : String(error)
    }
    return 'none'
  }

  it('shortcode ↔ media id bi-directional conversion', () => {
    assert.equal(codeToPk('Dbn-XJhk0_-'), '3956405067326902270')
    assert.equal(pkToCode('3956405067326902270'), 'Dbn-XJhk0_-')
    assert.equal(pkToCode(3956405067326902270n), 'Dbn-XJhk0_-')
    assert.equal(pkToCode('1'), 'B')
    assert.equal(codeToPk('B'), '1')
    assert.match(codeToPk('CXFxcdXMxM3'), /^\d{16,20}$/)
    assert.equal(
      problemOf(() => codeToPk('bad code')),
      'format-changed',
    )
  })

  it('the web_info query and the logged-out post query → their v1 item; null → removed; no data → changed', () => {
    const item = {
      pk: '100',
      code: 'WEBV1',
      media_type: 1,
      taken_at: 1_700_000_000,
      user: {username: 'webuser'},
      image_versions2: {candidates: [{url: 'https://cdn/web.jpg', width: 1080, height: 1080}]},
    }
    const web = readWebInfoQuery({data: {xdt_api__v1__media__shortcode__web_info: {items: [item]}}})
    assert.equal(web.id, '100')
    assert.equal(web.author, 'webuser')
    assert.equal(
      problemOf(() => readWebInfoQuery({data: {xdt_api__v1__media__shortcode__web_info: {items: []}}})),
      'removed',
    )
    assert.equal(
      problemOf(() => readWebInfoQuery({data: {}})),
      'format-changed',
    )
    assert.equal(
      problemOf(() => readWebInfoQuery({message: 'x', require_login: true, status: 'fail'})),
      'login-required',
    )

    const polaris = readLoggedOutPostQuery({data: {xig_polaris_media: {if_not_gated_logged_out: item}}})
    assert.equal(polaris.id, '100')
    assert.equal(
      problemOf(() => readLoggedOutPostQuery({data: {xig_polaris_media: null}})),
      'removed',
    )
    assert.equal(
      problemOf(() => readLoggedOutPostQuery({data: {xig_polaris_media: {}}})),
      'login-required',
    )
  })

  it('QueryBook reads the query ids a page preloads, by name, and its LSD token; both expire', () => {
    let now = 1_000_000
    const book = new QueryBook(() => now)
    const html =
      '<script>{"expectedPreloaders":[{"actorID":"0","preloaderID":"adp_x","queryID":"27776306792043877","variables":{"media_id":"4"},"queryName":"PolarisLoggedOutDesktopWWWPostRootContentQuery"},' +
      '{"actorID":"0","queryID":"26363073793392167","variables":{"location_id":null,"user_id":"1"},"queryName":"Other"}]}' +
      '["LSD",[],{"token":"AdSUbFWLQEfHq9tB70AP5xBEBnQ"},323]</script>'
    assert.equal(book.learn(html), 2)
    assert.equal(book.id('PolarisLoggedOutDesktopWWWPostRootContentQuery'), '27776306792043877')
    assert.equal(book.id('Other'), '26363073793392167')
    assert.equal(book.lsd, 'AdSUbFWLQEfHq9tB70AP5xBEBnQ')
    now += 31 * 60_000
    assert.equal(book.lsd, undefined)
    now += 24 * 60 * 60_000
    assert.equal(book.id('Other'), undefined)
  })

  it('RouteHealth: a refusal rests one route, not the others; scores order routes and drift back with time', () => {
    let now = 0
    const health = new RouteHealth(() => now)
    const routes = ['a', 'b', 'c']
    assert.deepEqual(
      health.order(routes, r => r),
      ['a', 'b', 'c'],
    )
    health.refused('a')
    assert.ok(health.coolingDownMs('a') > 0)
    assert.equal(health.coolingDownMs('b'), 0)
    assert.deepEqual(
      health.order(routes, r => r),
      ['b', 'c', 'a'],
    )
    health.succeeded('c')
    health.succeeded('c')
    assert.deepEqual(
      health.order(routes, r => r),
      ['c', 'b', 'a'],
    )
    // two refusals in a row: twice the rest
    now += 61_000
    assert.equal(health.coolingDownMs('a'), 0)
    const second = health.refused('a')
    assert.equal(second, 120_000)
    // hours later every score is back near the prior: the default order again
    now += 10 * 60 * 60_000
    assert.ok(Math.abs(health.score('c') - 0.5) < 0.01)
    assert.ok(Math.abs(health.score('a') - 0.5) < 0.01)
  })

  it('linkExpiry reads the CDN oe parameter (hex unix seconds)', () => {
    assert.equal(linkExpiry('https://scontent.cdninstagram.com/v/x.jpg?stp=a&oe=68F2A1B0&_nc_sid=1'), 0x68f2a1b0 * 1000)
    assert.equal(linkExpiry('https://cdn/x.jpg?oe=68F2A1B0'), 0x68f2a1b0 * 1000)
    assert.equal(linkExpiry('https://cdn/x.jpg'), undefined)
  })

  it('the embed page: contextJSON → the reel, its caption without trailing tags, one H.264 rendition', () => {
    const post = readEmbedPage({html: embedHtml({shortcode_media: node}), url: embedUrl})
    assert.equal(post.id, '3956405067326902270')
    assert.equal(post.author, 'nasa')
    assert.equal(titleOf(post, 'Instagram'), 'Earth from orbit')
    const video = post.items[0]!
    assert.equal(video.kind, 'video')
    if (video.kind === 'video') {
      assert.equal(video.duration, 12.5)
      assert.deepEqual(video.renditions, [
        {
          codec: 'h264',
          width: 720,
          height: 1280,
          resolution: 720,
          bitrate: 0,
          urls: ['https://scontent.cdninstagram.com/v/t66/reel.mp4?x=1'],
        },
      ])
    }
    assert.ok(
      choicesOf(post).some(c => c.profile.kind === 'video' && c.profile.maxHeight === 720 && !c.requiresConversion),
    )
  })

  it('the embed page: a carousel and a photo are read too; a gone post says so', () => {
    const sidecar = readEmbedPage({
      html: embedHtml({
        shortcode_media: {
          ...node,
          edge_sidecar_to_children: {
            edges: [{node}, {node: {...node, id: '2', is_video: false, video_url: undefined}}],
          },
        },
      }),
      url: embedUrl,
    })
    assert.equal(shapeOf(sidecar), 'carousel')
    assert.equal(
      shapeOf(
        readEmbedPage({
          html: embedHtml({shortcode_media: {...node, is_video: false, video_url: undefined}}),
          url: embedUrl,
        }),
      ),
      'photo',
    )
    assert.equal(
      problemOf(() => readEmbedPage({html: embedHtml({shortcode_media: null}), url: embedUrl})),
      'removed',
    )
  })

  it('the wall: the login page, a login redirect, the bare app shell and "please wait" are walls, never "sign in"', () => {
    assert.equal(
      problemOf(() => readEmbedPage({html: wallHtml, url: embedUrl})),
      'challenge',
    )
    assert.equal(
      problemOf(() =>
        readEmbedPage({html: '<html></html>', url: 'https://www.instagram.com/accounts/login/?next=/p/x/'}),
      ),
      'challenge',
    )
    assert.equal(
      problemOf(() => readPostPage({html: wallHtml, url: 'https://www.instagram.com/p/x/'})),
      'challenge',
    )
    assert.equal(
      problemOf(() =>
        readMediaInfo({
          message: 'Please wait a few minutes before you try again.',
          require_login: true,
          status: 'fail',
        }),
      ),
      'login-required',
      'a wall to the anonymous routes (WALL_PROBLEMS), never reported as such on its own',
    )
  })

  it('the post page: data-sjs blobs → xig_polaris_media.if_not_gated_logged_out (yt-dlp) or the shortcode web info', () => {
    const polaris = `<html><head><title>NASA on Instagram</title></head><body><script data-sjs>${JSON.stringify({require: [['ScheduledServerJS', 'handle', null, [{__bbox: {require: [['RelayPrefetchedStreamCache', 'next', [], ['adp_x', {__bbox: {result: {data: {xig_polaris_media: {if_not_gated_logged_out: item}}}}}]]]}}]]]})}</script></body></html>`
    const post = readPostPage({html: polaris, url: 'https://www.instagram.com/p/Dbn-XJhk0_-/'})
    assert.equal(post.id, '3956405067326902270')
    const video = post.items[0]!
    assert.equal(video.kind === 'video' && video.renditions.length, 2, 'the same url is one rendition')
    assert.equal(video.kind === 'video' && video.renditions[0]!.resolution, 720)
    assert.equal(video.kind === 'video' && video.cover, 'https://scontent.cdninstagram.com/cover.jpg')
    const webInfo = `<html><head><title>x</title></head><body><script data-sjs>${JSON.stringify({a: {b: {xdt_api__v1__media__shortcode__web_info: {items: [item]}}}})}</script></body></html>`
    assert.equal(readPostPage({html: webInfo, url: 'u'}).code, 'Dbn-XJhk0_-')
    const changed = '<html><head><title>x</title></head><body><script data-sjs>{"nothing":1}</script></body></html>'
    assert.equal(
      problemOf(() => readPostPage({html: changed, url: 'u'})),
      'format-changed',
    )
  })

  it('the app API: items[0] → the post, photos and carousels included; no items is a gone post', () => {
    const post = readMediaInfo({items: [item], status: 'ok'})
    assert.equal(post.caption, 'Earth from orbit')
    assert.equal(shapeOf(readMediaInfo({items: [{...item, media_type: 8, carousel_media: [item, item]}]})), 'carousel')
    assert.equal(
      problemOf(() => readMediaInfo({items: []})),
      'removed',
    )
  })
})

describe('Relay payloads', () => {
  it('finds JSON scripts and keys deep inside them, bounded, in page order', () => {
    const html = `<html><script>var x = 1</script><script type="application/json" data-sjs>{"a":{"b":[{"c":1},{"d":{"target":"first"}}]}}</script><script type="application/json" data-sjs>{"target":"second"}</script><script type="application/json">not json</script></html>`
    const scripts = jsonScripts(html)
    assert.equal(scripts.length, 2)
    assert.deepEqual(findWithKey(scripts, 'target'), {target: 'first'})
    assert.equal(findAllWithKey(scripts, 'target').length, 2)
    assert.equal(findWithKey(scripts, 'missing'), undefined)
  })
})

describe('Cursor walk', () => {
  const pages = (n: number, perPage: number) => async (cursor: string | undefined) => {
    const start = cursor ? Number(cursor) : 0
    const items = Array.from({length: Math.min(perPage, n - start)}, (_, i) => ({id: String(start + i)}))
    const end = start + items.length
    return {items, next: end < n ? String(end) : undefined}
  }
  it('walks to the end, respects the cap, and resumes from a kept cursor', async () => {
    const all = await walkCursor(pages(25, 10), {max: 100, idOf: i => i.id})
    assert.equal(all.items.length, 25)
    assert.equal(all.complete, true)
    const capped = await walkCursor(pages(25, 10), {max: 15, idOf: i => i.id})
    assert.equal(capped.items.length, 15)
    assert.equal(capped.cursor, '10', 'the page the cap fell in: read again (de-duplicated) when continuing')
    const resumed = await walkCursor(pages(25, 10), {
      max: 100,
      idOf: i => i.id,
      resume: {items: capped.items, cursor: capped.cursor},
    })
    assert.equal(resumed.items.length, 25)
  })
  it('stops after 20 known regular items in a row (incremental) and on a cursor that repeats', async () => {
    const known = new Set(Array.from({length: 40}, (_, i) => String(i + 5)))
    const incremental = await walkCursor(pages(100, 10), {max: 1000, idOf: i => i.id, known})
    assert.equal(incremental.caughtUp, true)
    assert.ok(incremental.items.length < 100)
    let calls = 0
    const repeating = await walkCursor(
      async () => {
        calls++
        return {items: [{id: 'same'}], next: 'loop'}
      },
      {max: 10, idOf: i => i.id},
    )
    assert.equal(repeating.items.length, 1)
    assert.ok(calls <= 4, `${calls} calls: the walk gives up on a repeating cursor`)
  })
})

describe('cookies.txt → cookies', () => {
  it('round-trips through toNetscape and filters by domain', () => {
    const text = toNetscape([
      {
        name: 'sessionid',
        value: 'abc',
        domain: '.instagram.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expirationDate: 1_800_000_000,
      },
      {name: 'c_user', value: '1', domain: '.facebook.com'},
      {name: 'SID', value: 'x', domain: '.google.com'},
    ])
    const ig = parseNetscape(text, ['instagram.com'])
    assert.equal(ig.length, 1)
    assert.equal(ig[0]!.name, 'sessionid')
    assert.equal(ig[0]!.httpOnly, true)
    assert.equal(ig[0]!.domain, 'instagram.com')
    assert.equal(parseNetscape(text).length, 3)
  })
})

// ─── end to end against a local fake ────────────────────────────────────────

let root: string
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-instagram-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

const [sessionName, sessionValue] = SESSION_COOKIE.split('=') as [string, string]

async function setup(
  name: string,
  config: Parameters<typeof startFakeInstagram>[0] = {},
  extra: {
    readonly signedIn?: boolean
    readonly browser?: (origin: string) => BrowserAssist
    readonly pacing?: InstagramOptions['pacing']
  } = {},
) {
  const site = await startFakeInstagram(config)
  const host = new URL(site.origin).hostname
  const options: InstagramOptions = {
    origin: site.origin,
    pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 30, maxBackoffMs: 100, ...extra.pacing},
    ...(extra.browser && {browser: extra.browser(site.origin)}),
    cookies: async () => (extra.signedIn ? [{name: sessionName, value: sessionValue, domain: host}] : undefined),
  }
  const engine = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    maxRetries: 3,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: false,
    facebook: false,
    instagram: options,
  })
  // the fake's videos say how long they last: their size forecast is no test of the runner's free disk
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0, diskCheck: 'off'})
  cleanups.push(async () => {
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  return {site, engine, scheduler, out: path.join(root, name, 'out')}
}

const postUrl = (site: FakeInstagram, i = 0) => `${site.origin}/p/${site.codes[i]}/`
const profileUrl = (site: FakeInstagram) => `${site.origin}/${site.user}/`

describe('Instagram, end to end (local fake)', () => {
  it('downloads one post as MP4: the embed, the HD encoding, the CDN Referer, a portable name', async () => {
    const {site, scheduler, out} = await setup('single')
    const batch = scheduler.schedule({url: postUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    const files = await fs.readdir(out)
    assert.equal(files.length, 1)
    assert.match(files[0]!, /^Post-numero-1-con-acentos-\d+\.mp4$/)
    assert.equal((await fs.readFile(path.join(out, files[0]!), 'utf8')).slice(0, 1), 'h', 'the HD encoding')
    assert.equal(site.hits.embed, 1, 'one anonymous read, reused by the download')
    assert.equal(site.hits.app + site.hits.graphql + site.hits.page, 0, 'nothing else needed')
    assert.equal(site.hits.refusedMedia, 0)
  })

  it('without the embed, the web_info query reads the post; then the post page; then the logged-out query the page names; then the app API; then the web client query', async () => {
    const pacing = {spacingMs: 0, jitterMs: 0}
    // the embed retired: the web_info query (JSON) answers first
    const web = await startFakeInstagram({posts: 2, noEmbed: true})
    cleanups.push(() => web.close())
    const fromWeb = new InstagramSource({origin: web.origin, pacing})
    const read = await fromWeb.analyze(`${web.origin}/reel/${web.codes[1]}/`)
    assert.equal(read.kind === 'video' && read.media.id, web.ids[1])
    assert.deepEqual([web.hits.embed, web.hits.webInfo, web.hits.page, web.hits.app, web.hits.graphql], [1, 1, 0, 0, 0])
    // its query ids rotated too: the page a logged-out visitor gets (xig_polaris_media)
    const page = await startFakeInstagram({posts: 2, noEmbed: true, noWebInfo: true})
    cleanups.push(() => page.close())
    const fromPage = new InstagramSource({origin: page.origin, pacing})
    const paged = await fromPage.analyze(`${page.origin}/reel/${page.codes[1]}/`)
    assert.equal(paged.kind === 'video' && paged.media.id, page.ids[1])
    assert.deepEqual([page.hits.webInfo, page.hits.page, page.hits.app], [2, 1, 0], 'both web_info ids, then the page')
    // the page without the item but naming its logged-out query: that query, with the page's token
    const named = await startFakeInstagram({posts: 2, noEmbed: true, noWebInfo: true, noPage: true, preloaders: true})
    cleanups.push(() => named.close())
    const fromNamed = new InstagramSource({origin: named.origin, pacing})
    const queried = await fromNamed.analyze(`${named.origin}/p/${named.codes[0]}/`)
    assert.equal(queried.kind === 'video' && queried.media.id, named.ids[0])
    assert.deepEqual([named.hits.page, named.hits.loggedOut, named.hits.app], [1, 1, 0])
    // the page names nothing: the app API, asked as the app
    const api = await startFakeInstagram({posts: 2, noEmbed: true, noWebInfo: true, noPage: true})
    cleanups.push(() => api.close())
    const source = new InstagramSource({origin: api.origin, pacing})
    const reel = await source.analyze(`${api.origin}/reel/${api.codes[1]}/`)
    assert.equal(reel.kind === 'video' && reel.media.id, api.ids[1])
    assert.deepEqual([api.hits.embed, api.hits.app, api.hits.graphql], [1, 1, 0])
    // everything anonymous retired: the web client's query, as before
    const {site, engine} = await setup('routes', {
      posts: 2,
      noEmbed: true,
      noWebInfo: true,
      noPage: true,
      noAppApi: true,
    })
    const result = await engine.analyze(postUrl(site))
    assert.equal(result.kind, 'video')
    assert.deepEqual([site.hits.embed, site.hits.app, site.hits.graphql], [1, 1, 1])
  })

  it('a route that refuses rests on its own (the others go on, no shared cool-down); one that answers goes first next time', async () => {
    const site = await startFakeInstagram({posts: 3, noEmbed: true, appApiNeedsSession: true, noWebInfo: true})
    cleanups.push(() => site.close())
    const source = new InstagramSource({origin: site.origin, pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 60_000}})
    const first = await source.analyze(`${site.origin}/p/${site.codes[0]}/`)
    assert.equal(first.kind, 'video')
    const asked = {...site.hits}
    // the next post: the page that answered is asked first; the embed and web_info (which failed) after it
    const second = await source.analyze(`${site.origin}/p/${site.codes[1]}/`)
    assert.equal(second.kind, 'video')
    assert.equal(site.hits.page - asked.page, 1)
    assert.equal(site.hits.embed - asked.embed, 0, 'the page answered: nothing else asked')
    assert.equal(site.hits.webInfo - asked.webInfo, 0)
  })

  it('reads of the same post at once share one request; a share link is followed once', async () => {
    const site = await startFakeInstagram({posts: 2})
    cleanups.push(() => site.close())
    const source = new InstagramSource({origin: site.origin, pacing: {spacingMs: 0, jitterMs: 0}})
    const code = site.codes[0]!
    await Promise.all([
      source.analyze(`${site.origin}/p/${code}/`),
      source.analyze(`${site.origin}/reel/${code}/`),
      source.analyze(`${site.origin}/${site.user}/p/${code}/?img_index=1`),
    ])
    assert.equal(site.hits.embed, 1, 'three links to one post: one read')
    await source.analyze(`${site.origin}/share/abc/`)
    await source.analyze(`${site.origin}/share/abc/`)
    assert.equal(site.hits.short, 1, 'the share link is asked once')
  })

  it('every route walled: oEmbed tells a gone post from a limited network', async () => {
    const {site, engine} = await setup('walled-probe', {posts: 1, loginWall: true})
    await assert.rejects(engine.analyze(`${site.origin}/p/C0DE999999/`), (e: DownloadError) => {
      assert.equal(e.hint, 'removed')
      return true
    })
    assert.ok(site.hits.oembed >= 1)
  })

  it('a carousel read from the embed keeps all its items; a gone post ends the search at once', async () => {
    const {site, scheduler, engine, out} = await setup('embed-carousel', {
      posts: 2,
      carousels: [0],
      mixedCarousels: true,
    })
    const batch = scheduler.schedule({url: postUrl(site), profile: mp4, outDir: out, slideshow: images})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    const folder = (await fs.readdir(out))[0]!
    assert.deepEqual(await fs.readdir(path.join(out, folder)), ['01.jpg', '02.jpg', '03.mp4'])
    assert.equal(site.hits.graphql, 0)
    await assert.rejects(engine.analyze(`${site.origin}/p/GONE000000/`), (e: DownloadError) => e.hint === 'removed')
    assert.equal(site.hits.graphql + site.hits.app, 0, 'the embed said it is gone: nothing else asked')
  })

  it('when every route gets the login wall, the error says the network is limited — not "sign in"', async () => {
    const site = await startFakeInstagram({loginWall: true})
    cleanups.push(() => site.close())
    const logs: string[] = []
    const source = new InstagramSource({
      origin: site.origin,
      pacing: {spacingMs: 0, jitterMs: 0},
      log: (_, message) => logs.push(message),
    })
    await assert.rejects(source.analyze(postUrl(site)), (e: DownloadError) => {
      assert.equal(e.hint, 'retry-later')
      assert.equal(e.details, SOURCE_BLOCKED, 'yt-dlp may still get through, with cookies')
      assert.match(e.message, /limiting this network/)
      return true
    })
    assert.equal(
      site.hits.login,
      3,
      'the embed, the post page and the signed route’s page were sent to the login page (the APIs answered 401)',
    )
    assert.ok(
      logs.some(l => /every route got the wall/.test(l)),
      logs.join('\n'),
    )
  })

  it('backs up a whole profile: listed by cursor in pages of 12, videos as MP4, photos and carousels as folders', async () => {
    const {site, scheduler, out} = await setup('profile', {
      posts: 30,
      photos: [1],
      carousels: [2, 29],
      mixedCarousels: true,
    })
    const batch = scheduler.schedule({url: profileUrl(site), profile: mp4, outDir: out, slideshow: images})
    assert.equal(batch.maxItems, 500, 'profiles load 500 by default, wherever the source serves them')
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 30)
    assert.equal(site.hits.profile, 1, 'the account is read once')
    assert.equal(site.hits.graphql, 3, '30 posts: 3 listing pages, no per-post request (the listing carries the media)')
    const folder = (await fs.readdir(out))[0]!
    assert.equal(folder, 'Instagram-fakeuser')
    const entries = await fs.readdir(path.join(out, folder), {withFileTypes: true})
    assert.equal(entries.length, 30)
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
    assert.equal(dirs.length, 3, 'a photo and two carousels become folders')
    assert.match(dirs[0]!, /^002-/)
    const carousel = await fs.readdir(path.join(out, folder, dirs[1]!))
    assert.deepEqual(carousel, ['01.jpg', '02.jpg', '03.mp4'], 'a carousel with a video: everything in order, as it is')
    assert.ok(entries.filter(e => e.isFile()).every(e => /^\d{3}-.+\.mp4$/.test(e.name)))
  })

  it('a photo becomes a slideshow MP4 by default, and says it has no sound for an audio format', async () => {
    const {site, engine, scheduler, out} = await setup('photo', {photos: [0]})
    const batch = scheduler.schedule({url: postUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.match((await fs.readdir(out))[0]!, /\.mp4$/)
    const sound = engine.add({url: postUrl(site), profile: audio, outDir: path.join(out, 'audio')})
    await engine.whenIdle()
    const failed = engine.job(sound.id)!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error?.code, 'unavailable')
    assert.match(failed.error?.message ?? '', /no sound/)
  })

  it('a carousel of photos, whose embed has no data, is read anonymously from web_info: every picture; its song needs a session', async () => {
    const {site, engine, scheduler, out} = await setup('photo-carousel', {posts: 2, carousels: [0]})
    const result = await engine.analyze(postUrl(site))
    assert.equal(result.kind, 'video')
    if (result.kind !== 'video') return
    assert.deepEqual(result.media.slideshow, {images: 3, audio: false, songNeedsSession: true})
    assert.deepEqual(
      [site.hits.embed, site.hits.webInfo, site.hits.page, site.hits.app, site.hits.graphql],
      [1, 1, 0, 0, 0],
    )
    const batch = scheduler.schedule({url: postUrl(site), profile: mp4, outDir: out, slideshow: images})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    const folder = (await fs.readdir(out))[0]!
    assert.deepEqual(await fs.readdir(path.join(out, folder)), ['01.jpg', '02.jpg', '03.jpg'])
  })

  it('a photo with a song: without a session the song is not there (and the post says so); signed in, its song is asked once more', async () => {
    const anonymous = await setup('photo-music-anon', {photos: [0], music: [0], posts: 1})
    const unsigned = await anonymous.engine.analyze(postUrl(anonymous.site))
    assert.equal(unsigned.kind === 'video' && unsigned.media.slideshow?.audio, false)
    assert.equal(unsigned.kind === 'video' && unsigned.media.slideshow?.songNeedsSession, true)
  })

  it('a photo read before signing in gets its song once the user signs in (the cached post asks for it)', async () => {
    const site = await startFakeInstagram({photos: [0], music: [0], posts: 1})
    cleanups.push(() => site.close())
    let signedIn = false
    const host = new URL(site.origin).hostname
    const source = new InstagramSource({
      origin: site.origin,
      pacing: {spacingMs: 0, jitterMs: 0},
      cookies: async () => (signedIn ? [{name: sessionName, value: sessionValue, domain: host}] : undefined),
    })
    const url = `${site.origin}/p/${site.codes[0]}/`
    const before = await source.analyze(url)
    assert.equal(before.kind === 'video' && before.media.slideshow?.songNeedsSession, true)
    signedIn = true
    const after = await source.analyze(url)
    assert.equal(after.kind === 'video' && after.media.slideshow?.audio, true, 'the song, now that there is a session')
    assert.equal(after.kind === 'video' && after.media.slideshow?.songNeedsSession, undefined)
  })

  it('a photo with a song, signed in: a slideshow with sound, a folder with the song, or the song alone', async () => {
    const {site, engine, out} = await setup(
      'photo-music',
      {photos: [0], carousels: [1], music: [0, 1], posts: 2},
      {signedIn: true},
    )
    const single = await engine.analyze(postUrl(site))
    assert.equal(single.kind === 'video' && single.media.slideshow?.songNeedsSession, undefined)
    assert.equal(single.kind === 'video' && single.media.slideshow?.audio, true, 'its song is its sound')
    assert.ok(
      single.kind === 'video' && single.choices.some(c => c.profile.kind === 'audio'),
      'audio formats are offered',
    )
    // pictures and the song, kept as they are
    const kept = engine.add({
      url: postUrl(site, 1),
      profile: mp4,
      outDir: path.join(out, 'kept'),
      slideshow: {mode: 'images-audio', secondsPerImage: 3},
      photoPost: true,
    })
    await engine.whenIdle()
    const folder = engine.job(kept.id)!
    assert.equal(folder.status, 'completed', JSON.stringify(folder.error))
    assert.deepEqual((await fs.readdir(folder.filepath!)).sort(), ['01.jpg', '02.jpg', '03.jpg', 'sound.m4a'])
    // the song alone, for an audio format
    const song = engine.add({url: postUrl(site), profile: audio, outDir: path.join(out, 'song')})
    await engine.whenIdle()
    const done = engine.job(song.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.match(done.filepath ?? '', /\.mp3$/)
    // the pictures only: no song fetched
    const before = site.hits.media
    const plain = engine.add({
      url: postUrl(site, 1),
      profile: mp4,
      outDir: path.join(out, 'plain'),
      slideshow: images,
      photoPost: true,
    })
    await engine.whenIdle()
    assert.equal(engine.job(plain.id)?.status, 'completed')
    assert.equal(site.hits.media - before, 3, 'three pictures, no song')
  })

  it('a private account fails at once with the reason', async () => {
    const {site, scheduler, out} = await setup('private', {private: true})
    const batch = scheduler.schedule({url: profileUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'failed')
    assert.equal(scheduler.batch(batch.id)?.error?.hint, 'private')
  })

  it('retries rate limits ("please wait a few minutes") natively after the shared cool-down', async () => {
    const {site, scheduler, out} = await setup('refused', {refusals: 2})
    const batch = scheduler.schedule({url: postUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal(site.hits.refused, 2)
    assert.equal(site.hits.webInfo + site.hits.page, 1, '2 refusals (429: the network waits) + 1 success, all native')
    assert.equal(site.hits.app + site.hits.graphql, 0)
  })

  it('rate limited while someone waits: the analysis fails at once with "try again in", a batch waits it out', async () => {
    // a real cool-down (20 s, doubling): the link pasted on screen must not hang on it
    const {site, engine} = await setup(
      'rate-limited',
      {refusals: 10},
      {pacing: {backoffMs: 20_000, maxBackoffMs: 600_000}},
    )
    const started = performance.now()
    await assert.rejects(engine.analyze(postUrl(site)), (e: DownloadError) => {
      assert.equal(e.hint, 'retry-later')
      assert.equal(e.details, COOLING_DOWN)
      assert.match(e.message, /Instagram is rate limiting this network: try again in about 20 s/)
      return true
    })
    assert.ok(performance.now() - started < 5_000, `answered in ${Math.round(performance.now() - started)} ms`)
    const total = () => Object.values(site.hits).reduce((sum, n) => sum + n, 0)
    const asked = total()
    assert.equal(site.hits.refused, 1, 'one 429 cools the whole network down: no other route is knocked on')
    // pasted again during the cool-down: told at once, nothing sent
    await assert.rejects(engine.analyze(postUrl(site, 0)), (e: DownloadError) => e.details === COOLING_DOWN)
    assert.equal(total(), asked, 'no request at all while it cools down')
  })

  it('a login wall is not solved: Instagram goes to yt-dlp for a while, without knocking again', async () => {
    const {site, engine, scheduler, out} = await setup('wall', {loginWall: true, posts: 2})
    const batch = scheduler.schedule({url: postUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    const second = scheduler.schedule({url: postUrl(site, 1), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(second.id)?.status, 'completed')
    assert.equal(
      site.hits.login,
      3,
      'the embed and the post page, then the signed page: one login redirect each, then hands off',
    )
    assert.ok(engine.jobs().every(job => job.attempts.length === 1))
  })

  it('with the user’s session, a login-walled profile and its stories are read natively; images stay images', async () => {
    const {site, scheduler, engine, out} = await setup(
      'session',
      {loginWall: true, posts: 14, stories: ['video', 'image', 'video']},
      {signedIn: true},
    )
    const listing = await engine.analyze(`${site.origin}/stories/${site.user}/`)
    assert.equal(listing.kind, 'playlist')
    if (listing.kind !== 'playlist') return
    assert.equal(listing.entries.length, 3)
    assert.equal(listing.title, 'Instagram @fakeuser stories')
    assert.deepEqual(listing.entries[1]!.slideshow, {images: 1, audio: false})
    assert.equal(listing.complete, true)
    const batch = scheduler.schedule({
      url: listing.url.replace('https://www.instagram.com', site.origin),
      profile: mp4,
      outDir: out,
      slideshow: images,
      selection: {title: listing.title, entries: listing.entries},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 3)
    assert.equal(site.hits.stories, 1, 'the stories are read once for the preview and the downloads')
    const folder = (await fs.readdir(out))[0]!
    const entries = (await fs.readdir(path.join(out, folder), {withFileTypes: true})).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    assert.equal(entries.filter(e => e.isFile()).length, 2)
    assert.equal(entries.filter(e => e.isDirectory()).length, 1, 'the image story is a folder with its picture')
    // the profile, signed in: the feed API pages by max_id
    const profile = await engine.analyze(profileUrl(site))
    assert.equal(profile.kind === 'playlist' && profile.entries.length, 14)
    assert.equal(site.hits.feed, 2, '14 posts: two feed pages')
    assert.equal(site.hits.graphql, 0, 'signed in: no Relay query')
  })

  it('stories without a session fail with "needs sign-in", not a retry', async () => {
    const {site, scheduler, out} = await setup('nostories', {stories: ['video']})
    const batch = scheduler.schedule({url: `${site.origin}/stories/${site.user}/`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'failed')
    assert.equal(scheduler.batch(batch.id)?.error?.hint, 'needs-sign-in')
    assert.equal(site.hits.stories, 0, 'not even asked: the session is checked first')
  })

  it('a highlight lists its items with its title', async () => {
    const {site, engine} = await setup('highlight', {stories: ['image', 'video']}, {signedIn: true})
    const result = await engine.analyze(`${site.origin}/stories/highlights/${site.userId}/`)
    assert.equal(result.kind, 'playlist')
    if (result.kind !== 'playlist') return
    assert.equal(result.title, 'Instagram highlight Mi highlight · @fakeuser')
    assert.equal(result.entries.length, 2)
  })

  it('when Instagram rotates the listing query, the profile still lists its first posts and says it is not complete', async () => {
    const {site, engine} = await setup('rotated', {posts: 20, rotatedQueries: true})
    const warnings: string[] = []
    engine.on('log', entry => entry.level === 'warn' && warnings.push(entry.message))
    const result = await engine.analyze(profileUrl(site))
    assert.equal(result.kind, 'playlist')
    if (result.kind !== 'playlist') return
    assert.equal(result.entries.length, 12, 'the first page the profile info carries')
    assert.equal(result.total, 20)
    assert.equal(result.complete, false)
    assert.ok(
      warnings.some(w => /listing query did not answer/.test(w)),
      warnings.join('\n'),
    )
  })

  it('a checkpoint goes through a real browser once; its session then serves the API over HTTP', async () => {
    const browserCalls: string[] = []
    const browser = (): BrowserAssist => async url => {
      browserCalls.push(url)
      const host = new URL(url).hostname
      return {
        html: '<html><body>profile page</body></html>',
        cookies: [{name: 'ig_ok', value: '1', domain: host}],
        userAgent: 'FakeBrowser/1',
      }
    }
    const {site, scheduler, out} = await setup('checkpoint', {jsChallenge: true, posts: 2}, {browser})
    const batch = scheduler.schedule({url: profileUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 2)
    assert.equal(browserCalls.length, 1, 'one browser visit')
    assert.match(browserCalls[0]!, /\/fakeuser\/$/)
  })

  it('a checkpoint even the browser cannot pass hands Instagram to yt-dlp (no solving)', async () => {
    const browser = (): BrowserAssist => async () => ({
      html: '<html><a href="/challenge/">checkpoint_required</a></html>',
      cookies: [],
      userAgent: 'x',
    })
    const {site, engine, scheduler, out} = await setup(
      'captcha',
      {jsChallenge: true, captcha: true, noEmbed: true},
      {browser},
    )
    const batch = scheduler.schedule({url: postUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', 'yt-dlp took over')
    assert.ok(engine.jobs().every(job => job.attempts.length === 1))
    assert.ok(site.hits.graphql <= 2)
  })

  it('reports listing progress, reopens a profile from memory, and lists only what is new for a sync', async () => {
    const {site, engine} = await setup('progress', {posts: 50})
    const seen: number[] = []
    const first = await engine.analyze(profileUrl(site), {maxEntries: 30, onProgress: p => seen.push(p.listed)})
    assert.equal(first.kind === 'playlist' && first.entries.length, 30)
    assert.deepEqual(seen.slice(-1), [30])
    assert.ok(seen.includes(12))
    const queries = site.hits.graphql
    const again = await engine.analyze(profileUrl(site), {maxEntries: 30})
    assert.equal(again.kind === 'playlist' && again.entries.length, 30)
    assert.equal(site.hits.graphql, queries, 'answered from memory')
    const more = await engine.analyze(profileUrl(site), {maxEntries: 50})
    assert.equal(more.kind === 'playlist' && more.entries.length, 50)
    assert.equal(more.kind === 'playlist' && more.complete, true)
    assert.equal(
      site.hits.graphql,
      queries + 3,
      'continued from the page the cap fell in: that page again, then two more',
    )
    // a sync that already has everything but the 3 newest stops after 20 known posts
    const known = new Set(site.ids.slice(3))
    const incremental = await engine.analyze(profileUrl(site), {maxEntries: 500, known})
    assert.equal(incremental.kind === 'playlist' && incremental.caughtUp, true)
    assert.ok(incremental.kind === 'playlist' && incremental.entries.length < 50)
  })

  it('a listing page that repeats itself does not loop, and the end is still reached', async () => {
    const {site, engine} = await setup('repeat', {posts: 30, repeatPage: true})
    const result = await engine.analyze(profileUrl(site))
    assert.equal(result.kind === 'playlist' && result.entries.length, 30)
    assert.ok(site.hits.graphql <= 5)
  })

  it('resolves share links and dates the file by the post’s publication', async () => {
    const {site, scheduler, out} = await setup('share')
    const batch = scheduler.schedule({url: `${site.origin}/share/p/abc/`, profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    assert.equal(site.hits.short, 1)
    const [file] = await fs.readdir(out)
    const stat = await fs.stat(path.join(out, file!))
    assert.equal(Math.floor(stat.mtimeMs / 1000), 1_790_000_000)
  })
})

describe('Instagram that answers 403', () => {
  it('is a wall, not a rate limit: yt-dlp reads the link at once instead of waiting out cool-downs', async () => {
    const {site, engine} = await setup('forbidden', {forbidden: true})
    const started = Date.now()
    const result = await engine.analyze(postUrl(site))
    // the fake yt-dlp answers for any link: the engine fell back to it, without the source's back-off
    assert.equal(result.kind, 'video')
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
    assert.ok(site.hits.refused >= 1)
  })
})

describe('Instagram photos and carousels in the archive (local fake)', () => {
  it('a photo is a new download as images after its MP4; a carousel with videos is one folder whatever the mode', async () => {
    // post 1 a photo, post 2 a carousel of two photos and a video, posts 0 and 3 videos
    const {site, engine, scheduler, out} = await setup('archive-modes', {
      posts: 4,
      photos: [1],
      carousels: [2],
      mixedCarousels: true,
    })
    const run = async (mode: 'video' | 'images') => {
      const batch = scheduler.schedule({url: profileUrl(site), profile: mp4, outDir: out, slideshow: {...images, mode}})
      await scheduler.whenIdle()
      const jobs = engine.jobs().filter(job => job.batchId === batch.id)
      return site.ids.map(id => jobs.find(job => job.mediaId === id)?.status)
    }
    assert.deepEqual(await run('video'), ['completed', 'completed', 'completed', 'completed'])
    // the photo was an MP4: its picture is new; the carousel's folder is what images give too
    assert.deepEqual(await run('images'), ['skipped', 'completed', 'skipped', 'skipped'])
    assert.deepEqual(await run('images'), ['skipped', 'skipped', 'skipped', 'skipped'])
    assert.deepEqual(await run('video'), ['skipped', 'skipped', 'skipped', 'skipped'])
    const {entries} = await engine.archive.list({limit: 50})
    assert.equal(entries.length, 5, '4 posts + the photo as a picture')
    assert.deepEqual(
      entries.filter(entry => entry.mediaId === site.ids[2]).map(entry => entry.slideshow),
      [undefined],
      'one record for the carousel with a video',
    )
  })
})
