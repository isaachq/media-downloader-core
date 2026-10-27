// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {type Fetch, LiveProxy, type Playback, readMaster, rewriteMaster, rewriteMedia} from './live-proxy'

const USHER = 'https://usher.ttvnw.net/api/channel/hls/liveonair.m3u8?sig=a&token=b'
const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)"',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked"',
  'https://video-weaver.ttvnw.net/v1/playlist/chunked.m3u8?sig=1',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60"',
  'https://video-weaver.ttvnw.net/v1/playlist/720p60.m3u8?sig=1',
].join('\n')
const MEDIA = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-27T10:00:00Z"',
  '#EXT-X-PROGRAM-DATE-TIME:2026-10-27T10:00:00.000Z',
  '#EXTINF:2.000,live',
  'https://video-edge-1.abc.ttvnw.net/v1/segment/one.ts?sig=x',
  '#EXTINF:2.000,live',
  'segment/two.ts',
  '#EXT-X-TWITCH-PREFETCH:https://video-edge-1.abc.ttvnw.net/v1/segment/three.ts?sig=y',
].join('\n')

const get = (proxy: LiveProxy, url: string, init?: RequestInit) => proxy.handle(new Request(url, init))

/** A fake upstream: a master per signature, each variant answering per its signature. */
function upstream(opts: {refuseUntilSig?: number; alwaysRefuse?: boolean} = {}) {
  let signature = 1
  const calls = {playback: 0, fresh: 0, master: 0, variant: 0}
  const playback: Playback = async (_url, o) => {
    calls.playback++
    if (o?.fresh) {
      calls.fresh++
      signature++
    }
    return {url: `${USHER}&n=${signature}`}
  }
  const fetch: Fetch = async url => {
    if (url.startsWith(USHER)) {
      calls.master++
      const n = /n=(\d+)/.exec(url)?.[1]
      return new Response(MASTER.replaceAll('sig=1', `sig=${n}`))
    }
    if (url.includes('/v1/playlist/')) {
      calls.variant++
      const sig = Number(/sig=(\d+)/.exec(url)?.[1])
      if (opts.alwaysRefuse || sig < (opts.refuseUntilSig ?? 0)) return new Response('expired', {status: 403})
      return new Response(MEDIA)
    }
    return new Response('?', {status: 404})
  }
  return {playback, fetch, calls}
}

describe('live proxy: playlists', () => {
  it('reads the variants of a master by name, resolved against its url', () => {
    expect(readMaster(MASTER, USHER).map(variant => variant.name)).toEqual(['chunked', '720p60'])
  })

  it('points the variants at the session, keeping every tag', () => {
    const text = rewriteMaster(MASTER, 'abc')
    expect(text).toContain('mdc-live://abc/v/0.m3u8')
    expect(text).toContain('mdc-live://abc/v/1.m3u8')
    expect(text).not.toContain('ttvnw.net/v1/playlist')
    expect(text).toContain('#EXT-X-MEDIA:TYPE=VIDEO')
  })

  it('points segments at the session, drops the prefetch hints, keeps PDT and DATERANGE', () => {
    const text = rewriteMedia(MEDIA, 'https://video-weaver.ttvnw.net/v1/playlist/chunked.m3u8?sig=1', 'abc')
    const segments = text.split('\n').filter(line => line.startsWith('mdc-live://abc/s/'))
    expect(segments).toHaveLength(2)
    const decoded = segments.map(line => Buffer.from(line.split('/s/')[1]!, 'base64url').toString())
    expect(decoded).toEqual([
      'https://video-edge-1.abc.ttvnw.net/v1/segment/one.ts?sig=x',
      'https://video-weaver.ttvnw.net/v1/playlist/segment/two.ts',
    ])
    expect(text).not.toContain('PREFETCH')
    expect(text).not.toContain('sig=x')
    expect(text).toContain('#EXT-X-PROGRAM-DATE-TIME')
    expect(text).toContain('twitch-stitched-ad')
  })
})

describe('live proxy: sessions', () => {
  it('serves the master and a variant through the session, and nothing without one', async () => {
    const {playback, fetch} = upstream()
    const proxy = new LiveProxy({playback, fetch})
    const opened = await proxy.open('https://www.twitch.tv/liveonair')
    expect(opened?.src).toMatch(/^mdc-live:\/\/[0-9a-f]{32}\/master\.m3u8$/)
    const master = await get(proxy, opened!.src)
    expect(master.headers.get('content-type')).toBe('application/vnd.apple.mpegurl')
    expect(await master.text()).toContain(`mdc-live://${opened!.sid}/v/1.m3u8`)
    const media = await get(proxy, `mdc-live://${opened!.sid}/v/0.m3u8`)
    expect(media.status).toBe(200)
    expect(await media.text()).toContain(`mdc-live://${opened!.sid}/s/`)
    expect((await get(proxy, 'mdc-live://0123456789abcdef0123456789abcdef/master.m3u8')).status).toBe(404)
    proxy.close(opened!.sid)
    expect((await get(proxy, opened!.src)).status).toBe(404)
  })

  it('is undefined for a channel off the air', async () => {
    const proxy = new LiveProxy({playback: async () => undefined, fetch: async () => new Response('')})
    expect(await proxy.open('https://www.twitch.tv/offline')).toBeUndefined()
    expect(proxy.size).toBe(0)
  })

  it('keeps 4 players at most: the oldest closes', async () => {
    const {playback, fetch} = upstream()
    const proxy = new LiveProxy({playback, fetch})
    const first = await proxy.open('https://www.twitch.tv/a')
    for (const name of ['b', 'c', 'd', 'e']) await proxy.open(`https://www.twitch.tv/${name}`)
    expect(proxy.size).toBe(4)
    expect((await get(proxy, first!.src)).status).toBe(404)
  })
})

describe('live proxy: refusals', () => {
  it('signs again once for every variant request refused at the same time', async () => {
    const {playback, fetch, calls} = upstream({refuseUntilSig: 2})
    const proxy = new LiveProxy({playback, fetch})
    const {sid, src} = (await proxy.open('https://www.twitch.tv/liveonair'))!
    await (await get(proxy, src)).text()
    const answers = await Promise.all(
      Array.from({length: 5}, () => get(proxy, `mdc-live://${sid}/v/1.m3u8`).then(r => r.status)),
    )
    expect(answers).toEqual([200, 200, 200, 200, 200])
    expect(calls.fresh).toBe(1)
  })

  it('gives up after 3 re-signs in a row: 502, for the player to offer Try again', async () => {
    const {playback, fetch, calls} = upstream({alwaysRefuse: true})
    const proxy = new LiveProxy({playback, fetch})
    const {sid, src} = (await proxy.open('https://www.twitch.tv/liveonair'))!
    await (await get(proxy, src)).text()
    const answer = await get(proxy, `mdc-live://${sid}/v/0.m3u8`)
    expect(answer.status).toBe(502)
    expect(calls.fresh).toBe(3)
  })
})

describe('live proxy: segments', () => {
  const opened = async (fetch: Fetch) => {
    const {playback} = upstream()
    const proxy = new LiveProxy({playback, fetch})
    return {proxy, sid: (await proxy.open('https://www.twitch.tv/liveonair'))!.sid}
  }
  const segment = (sid: string, url: string) => `mdc-live://${sid}/s/${Buffer.from(url).toString('base64url')}`

  it('fetches only Twitch media hosts over https: never an open proxy', async () => {
    const asked: string[] = []
    const {proxy, sid} = await opened(async url => {
      asked.push(url)
      return new Response('ts')
    })
    for (const url of [
      'http://video-edge-1.abc.ttvnw.net/one.ts',
      'https://evil.example.com/one.ts',
      'https://ttvnw.net.evil.com/one.ts',
      'https://127.0.0.1/one.ts',
    ])
      expect((await get(proxy, segment(sid, url))).status).toBe(403)
    expect(asked).toEqual([])
    const ok = await get(proxy, segment(sid, 'https://video-edge-1.abc.ttvnw.net/one.ts'))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    expect(asked).toEqual(['https://video-edge-1.abc.ttvnw.net/one.ts'])
  })

  it('passes the Range on and streams the body through without holding it', async () => {
    const CHUNK = 64 * 1024
    const CHUNKS = 160 // 10 MB
    let pulled = 0
    let range: string | null = null
    const {proxy, sid} = await opened(async (_url, init) => {
      range = new Headers(init?.headers).get('range')
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled === CHUNKS) return controller.close()
          pulled++
          controller.enqueue(new Uint8Array(CHUNK))
        },
      })
      return new Response(body, {headers: {'content-type': 'video/mp2t', 'content-length': String(CHUNK * CHUNKS)}})
    })
    const answer = await get(proxy, segment(sid, 'https://video-edge-1.abc.ttvnw.net/big.ts'), {
      headers: {range: 'bytes=0-'},
    })
    expect(range).toBe('bytes=0-')
    expect(answer.headers.get('content-length')).toBe(String(CHUNK * CHUNKS))
    // nothing is read ahead of the player: the body is pulled as the reader asks
    expect(pulled).toBeLessThan(4)
    const reader = answer.body!.getReader()
    let total = 0
    let most = 0
    for (;;) {
      const before = pulled
      const {done, value} = await reader.read()
      if (done) break
      total += value.byteLength
      most = Math.max(most, pulled - before)
    }
    expect(total).toBe(CHUNK * CHUNKS)
    expect(most).toBeLessThanOrEqual(2)
  })
})
