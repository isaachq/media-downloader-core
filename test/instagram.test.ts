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
  readEmbedPage,
  readGraphNode,
  readMediaInfo,
  readPostPage,
  readV1Item,
} from '../src/sources/instagram/data.js'
import {isInstagramListing, parseInstagramLink} from '../src/sources/instagram/links.js'
import {type InstagramOptions, InstagramSource} from '../src/sources/instagram/source.js'
import {MetaError} from '../src/sources/meta/errors.js'
import {walkCursor} from '../src/sources/meta/listing.js'
import {choicesOf, shapeOf, summaryOf, titleOf} from '../src/sources/meta/post.js'
import {findAllWithKey, findWithKey, jsonScripts} from '../src/sources/meta/relay.js'
import {SOURCE_BLOCKED} from '../src/sources/source.js'
import {type FakeInstagram, SESSION_COOKIE, startFakeInstagram} from './helpers/fake-instagram.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

const mp4 = {kind: 'video', container: 'mp4'} as const
const audio = {kind: 'audio', container: 'mp3'} as const
const images = {mode: 'images', secondsPerImage: 3} as const

describe('Instagram links', () => {
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
    assert.deepEqual(summaryOf(carousel, 'Instagram').slideshow, {images: 2, audio: true})
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

  it('shortcode → media id, the way the app API wants it', () => {
    assert.equal(codeToPk('Dbn-XJhk0_-'), '3956405067326902270')
    assert.match(codeToPk('CXFxcdXMxM3'), /^\d{16,20}$/)
    assert.equal(
      problemOf(() => codeToPk('bad code')),
      'format-changed',
    )
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
  extra: {readonly signedIn?: boolean; readonly browser?: (origin: string) => BrowserAssist} = {},
) {
  const site = await startFakeInstagram(config)
  const host = new URL(site.origin).hostname
  const options: InstagramOptions = {
    origin: site.origin,
    pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 30, maxBackoffMs: 100},
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
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
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

  it('without the embed, the app API reads the post; without both, the web client query does', async () => {
    // the embed retired, the app API answering: the post by its pk, asked as the app
    const api = await startFakeInstagram({posts: 2, noEmbed: true})
    cleanups.push(() => api.close())
    const source = new InstagramSource({origin: api.origin, pacing: {spacingMs: 0, jitterMs: 0}})
    const reel = await source.analyze(`${api.origin}/reel/${api.codes[1]}/`)
    assert.equal(reel.kind === 'video' && reel.media.id, api.ids[1])
    assert.deepEqual([api.hits.embed, api.hits.app, api.hits.graphql], [1, 1, 0])
    // both retired: the web client's query, as before
    const {site, engine} = await setup('routes', {posts: 2, noEmbed: true, noAppApi: true})
    const result = await engine.analyze(postUrl(site))
    assert.equal(result.kind, 'video')
    assert.deepEqual([site.hits.embed, site.hits.app, site.hits.graphql], [1, 1, 1])
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
    assert.equal(site.hits.login, 2, 'the embed and the page were sent to the login page (the APIs answered 401)')
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
    assert.equal(site.hits.graphql, 1, '2 refusals + 1 success, all native')
  })

  it('a login wall is not solved: Instagram goes to yt-dlp for a while, without knocking again', async () => {
    const {site, engine, scheduler, out} = await setup('wall', {loginWall: true, posts: 2})
    const batch = scheduler.schedule({url: postUrl(site), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(batch.id)?.status, 'completed', JSON.stringify(scheduler.batch(batch.id)?.error))
    const second = scheduler.schedule({url: postUrl(site, 1), profile: mp4, outDir: out})
    await scheduler.whenIdle()
    assert.equal(scheduler.batch(second.id)?.status, 'completed')
    assert.equal(site.hits.login, 2, 'the embed and the page each got one login redirect, then hands off')
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
