// core/hls without the network: the playlist grammar, variant choice, the resume file, segment checks
// and the key cache. The downloader against a fake origin is in hls-download.test.ts.
import {strict as assert} from 'node:assert'
import {createCipheriv} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, describe, it} from 'node:test'
import {
  chooseVariant,
  HlsError,
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  isOpenEnded,
  ivFor,
  KeyCache,
  parseAttributes,
  parsePlaylist,
  playlistIdentity,
  readState,
  refreshBudget,
  StateWriter,
  samePlaylist,
  segmentConcurrency,
  sniff,
  variantChoices,
  verifySegment,
  writeState,
} from '../src/core/hls/index.js'

const BASE = 'https://cdn.example/vod/abc/720p/index.m3u8'
const media = (text: string, url = BASE, opts = {}) => {
  const p = parsePlaylist(text, url, opts)
  assert.equal(p.kind, 'media')
  return p as HlsMediaPlaylist
}
const master = (text: string, url = 'https://usher.example/vod/1.m3u8') => {
  const p = parsePlaylist(text, url)
  assert.equal(p.kind, 'master')
  return p as HlsMasterPlaylist
}
const refused = (fn: () => unknown, reason: string) =>
  assert.throws(fn, (e: unknown) => e instanceof HlsError && e.reason === reason, `expected HlsError(${reason})`)

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-hls-unit-'))
after(() => fs.rm(tmp, {recursive: true, force: true}))

const TWITCH_MASTER = [
  '﻿#EXTM3U',
  '#EXT-X-TWITCH-INFO:ORIGIN="s3",B="false"',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=8534030,RESOLUTION=1920x1080,CODECS="hvc1.1.2.L123.90,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000',
  '# a comment between the tag and its uri',
  'https://cdn.example/vod/abc/chunked/index-dvr.m3u8',
  '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1440p60",NAME="1440p60",AUTOSELECT=YES,DEFAULT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440,CODECS="av01.0.12M.08,mp4a.40.2",VIDEO="1440p60"',
  'https://cdn.example/vod/abc/1440p60/index-dvr.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000',
  'https://cdn.example/vod/abc/720p60/index-dvr.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1427999,RESOLUTION=852x480,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="480p30"',
  '480p30/index-dvr.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=219999,CODECS="mp4a.40.2",VIDEO="audio_only"',
  'https://cdn.example/vod/abc/audio_only/index-dvr.m3u8',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="iframes.m3u8"',
].join('\r\n')

describe('HLS playlist grammar', () => {
  it('reads attribute lists with quoted commas', () => {
    const a = parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=640x360, NAME="a=b"')
    assert.equal(a.get('BANDWIDTH'), '1280000')
    assert.equal(a.get('CODECS'), 'avc1.4d401f,mp4a.40.2')
    assert.equal(a.get('RESOLUTION'), '640x360')
    assert.equal(a.get('NAME'), 'a=b')
  })

  it('reads a master playlist: BOM, CRLF, comments before the uri, names, codecs; I-frame variants dropped', () => {
    const m = master(TWITCH_MASTER)
    assert.equal(m.variants.length, 5)
    const [source, av1, hd, sd, audio] = m.variants
    assert.equal(source?.name, '1080p60 (source)')
    assert.deepEqual(source?.codecs, ['hvc1.1.2.L123.90', 'mp4a.40.2'])
    assert.equal(source?.frameRate, 60)
    assert.equal(av1?.height, 1440)
    assert.equal(hd?.width, 1280)
    assert.equal(sd?.uri, 'https://usher.example/vod/480p30/index-dvr.m3u8', 'relative to the master url')
    assert.equal(audio?.height, undefined)
    assert.equal(m.sessionKey, false)
  })

  it('reads a media playlist: sequences, EXTINF titles, the sum of durations, the format', () => {
    const p = media(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-MEDIA-SEQUENCE:5',
        '#EXTINF:10.000,first',
        '0.ts',
        '#EXTINF:9.5,',
        '1.ts?x=1',
        '#EXTINF:3',
        '/root/2.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    )
    assert.equal(p.segments.length, 3)
    assert.deepEqual(
      p.segments.map(s => [s.index, s.sequence, s.uri, s.title]),
      [
        [0, 5, 'https://cdn.example/vod/abc/720p/0.ts', 'first'],
        [1, 6, 'https://cdn.example/vod/abc/720p/1.ts?x=1', undefined],
        [2, 7, 'https://cdn.example/root/2.ts', undefined],
      ],
    )
    assert.equal(p.duration, 22.5)
    assert.equal(p.mediaSequence, 5)
    assert.equal(p.ended, true)
    assert.equal(p.playlistType, 'VOD')
    assert.equal(p.format, 'ts')
    assert.equal(p.periods, 1)
    assert.equal(p.byteLength, undefined)
    assert.equal(isOpenEnded(p), false)
  })

  it('resolves dot segments, absolute paths and other hosts against the final url', () => {
    const p = media(
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n../a.ts\n#EXTINF:2,\n./b.ts\n#EXTINF:2,\n//other.example/c.ts\n#EXT-X-ENDLIST\n',
    )
    assert.deepEqual(
      p.segments.map(s => s.uri),
      ['https://cdn.example/vod/abc/a.ts', 'https://cdn.example/vod/abc/720p/b.ts', 'https://other.example/c.ts'],
    )
  })

  it('refuses an https playlist that points at http media', () => {
    refused(
      () => media('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://cdn.example/a.ts\n#EXT-X-ENDLIST\n'),
      'unsupported',
    )
  })

  it('resolves byte ranges, continuing the offset only from the same uri', () => {
    const p = media(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:1000@720',
        'main.mp4',
        '#EXTINF:4,',
        '#EXT-X-BYTERANGE:2000',
        'main.mp4',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    )
    assert.deepEqual(p.segments[0]?.range, {offset: 720, length: 1000})
    assert.deepEqual(p.segments[1]?.range, {offset: 1720, length: 2000})
    assert.equal(p.byteLength, 3720, 'segments plus the init range')
    assert.equal(p.format, 'fmp4')
    refused(
      () =>
        media(
          '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n#EXT-X-BYTERANGE:10@0\na.ts\n#EXTINF:4,\n#EXT-X-BYTERANGE:10\nb.ts\n#EXT-X-ENDLIST\n',
        ),
      'unsupported',
    )
  })

  it('opens a period per discontinuity and per new EXT-X-MAP, and keeps the map written after EXTINF', () => {
    const p = media(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:2',
        '#EXTINF:2,',
        '#EXT-X-MAP:URI="init-a.mp4"', // after EXTINF: still this segment's
        'a0.m4s',
        '#EXTINF:2,',
        'a1.m4s',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-MAP:URI="init-a.mp4"', // the same map again (Twitch): the discontinuity makes the period
        '#EXTINF:2,',
        'b0.m4s',
        '#EXT-X-MAP:URI="init-c.mp4"', // a new map without a discontinuity: a period too
        '#EXTINF:2,',
        'c0.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    )
    assert.deepEqual(
      p.segments.map(s => [s.period, s.discontinuity]),
      [
        [0, 0],
        [0, 0],
        [1, 1],
        [2, 1],
      ],
    )
    assert.equal(p.periods, 3)
    assert.deepEqual(
      p.inits.map(i => i?.uri.split('/').pop()),
      ['init-a.mp4', 'init-a.mp4', 'init-c.mp4'],
    )
  })

  it('reads AES-128 keys: rotation, IVs, METHOD=NONE; refuses SAMPLE-AES and DRM key formats', () => {
    const p = media(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-KEY:METHOD=AES-128,URI="k0.bin"',
        '#EXTINF:2,',
        's0.ts',
        '#EXT-X-KEY:METHOD=AES-128,URI="k1.bin",IV=0x1F',
        '#EXTINF:2,',
        's1.ts',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXTINF:2,',
        's2.ts',
        '#EXT-X-KEY:METHOD=AES-128,URI="k0.bin"',
        '#EXTINF:2,',
        's3.ts',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    )
    assert.deepEqual(
      p.segments.map(s => s.key),
      [0, 1, -1, 0],
    )
    assert.equal(p.keys.length, 2)
    assert.equal(p.keys[1]?.iv?.[15], 0x1f)
    assert.equal(p.keys[1]?.iv?.[0], 0)
    const head = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n'
    const tail = '#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n'
    refused(() => media(`${head}#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k.bin"\n${tail}`), 'unsupported')
    refused(
      () =>
        media(`${head}#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n${tail}`),
      'drm',
    )
    refused(
      () =>
        media(
          `${head}#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n${tail}`,
        ),
      'drm',
    )
    const drm = (() => {
      try {
        media(`${head}#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"\n${tail}`)
      } catch (e) {
        return e as HlsError
      }
      return undefined
    })()
    assert.equal(drm?.code, 'unavailable')
    assert.equal(drm?.hint, 'format-unavailable', 'decision 6: DRM is reported as format-unavailable')
  })

  it('substitutes EXT-X-DEFINE variables; refuses IMPORT', () => {
    const p = media(
      '#EXTM3U\n#EXT-X-DEFINE:NAME="tok",VALUE="abc"\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ns0.ts?t={$tok}\n#EXT-X-ENDLIST\n',
    )
    assert.equal(p.segments[0]?.uri, 'https://cdn.example/vod/abc/720p/s0.ts?t=abc')
    refused(
      () => media('#EXTM3U\n#EXT-X-DEFINE:IMPORT="tok"\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n'),
      'unsupported',
    )
  })

  it('parses a live sliding window in full: sequences, program date-time, date ranges, gaps', () => {
    const p = media(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:1200',
        '#EXT-X-DISCONTINUITY-SEQUENCE:7',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-26T12:00:00.000Z',
        '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-10-26T12:00:02.000Z",DURATION=4.0,X-TV-TWITCH-AD-COMMERCIAL-ID="x1"',
        '#EXTINF:2.000,live',
        'a.ts',
        '#EXTINF:2.000,Amazon',
        'b.ts',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-GAP',
        '#EXTINF:2.000,',
        'c.ts',
        '#EXT-X-PART:DURATION=0.5,URI="d.part.ts"',
      ].join('\n'),
    )
    assert.equal(isOpenEnded(p), true)
    assert.equal(p.mediaSequence, 1200)
    assert.equal(p.discontinuitySequence, 7)
    assert.deepEqual(
      p.segments.map(s => [s.sequence, s.discontinuity, s.gap, s.title]),
      [
        [1200, 7, false, 'live'],
        [1201, 7, false, 'Amazon'],
        [1202, 8, true, undefined],
      ],
    )
    assert.equal(p.segments[0]?.programDateTime, Date.parse('2026-10-26T12:00:00.000Z'))
    assert.equal(p.segments[1]?.programDateTime, Date.parse('2026-10-26T12:00:02.000Z'), 'carried by EXTINF')
    assert.equal(p.segments[2]?.programDateTime, undefined, 'a discontinuity without a date has none')
    assert.equal(p.dateRanges.length, 1)
    assert.equal(p.dateRanges[0]?.class, 'twitch-stitched-ad')
    assert.equal(p.dateRanges[0]?.duration, 4)
    assert.equal(p.dateRanges[0]?.attributes['X-TV-TWITCH-AD-COMMERCIAL-ID'], 'x1')
    // an EVENT is open until it ends; a VOD without ENDLIST is not
    const event = (end: string) =>
      media(`#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n${end}`)
    assert.equal(isOpenEnded(event('')), true)
    assert.equal(isOpenEnded(event('#EXT-X-ENDLIST\n')), false)
    assert.equal(
      isOpenEnded(media('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.ts\n')),
      false,
    )
  })

  it('rewrites segment uris once while parsing (Twitch muted parts)', () => {
    const p = media('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n12-unmuted.ts\n#EXT-X-ENDLIST\n', BASE, {
      mapSegmentUri: (u: string) => u.replace(/-unmuted\.ts$/, '-muted.ts'),
    })
    assert.equal(p.segments[0]?.uri, 'https://cdn.example/vod/abc/720p/12-muted.ts')
  })

  it('refuses what is not a playlist, an empty one and a hostile segment count', () => {
    refused(() => parsePlaylist('<!doctype html><html>', BASE), 'not-hls')
    refused(() => parsePlaylist('{"error":"Not Found"}', BASE), 'not-hls')
    refused(() => parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-ENDLIST\n', BASE), 'empty')
    refused(() => parsePlaylist('#EXTM3U\n', BASE), 'empty')
    const many = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${'#EXTINF:2,\na.ts\n'.repeat(11)}`
    refused(() => parsePlaylist(many, BASE, {maxSegments: 10}), 'unsupported')
  })

  it('parses 20,000 segments in one linear pass', () => {
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2']
    for (let i = 0; i < 20_000; i++) lines.push('#EXTINF:2.000,', `${i}.ts`)
    lines.push('#EXT-X-ENDLIST')
    const text = lines.join('\n')
    const started = performance.now()
    const p = media(text)
    const ms = performance.now() - started
    assert.equal(p.segments.length, 20_000)
    assert.equal(p.segments[19_999]?.uri, 'https://cdn.example/vod/abc/720p/19999.ts')
    assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`)
  })
})

describe('HLS variant choice', () => {
  const m = () => master(TWITCH_MASTER)

  it('takes H.264 within the cap for mp4, the best stream for mkv, the audio-only variant for audio', () => {
    assert.equal(chooseVariant(m(), {kind: 'video', container: 'mp4'}).variant.height, 720, 'H.264 first for mp4')
    assert.equal(chooseVariant(m(), {kind: 'video', container: 'mp4', maxHeight: 480}).variant.height, 480)
    assert.equal(chooseVariant(m(), {kind: 'video', container: 'mkv'}).variant.height, 1440, 'AV1 source for mkv')
    assert.equal(chooseVariant(m(), {kind: 'video', container: 'mkv', maxHeight: 1080}).variant.height, 1080)
    const audio = chooseVariant(m(), {kind: 'audio', container: 'm4a'}, 3600)
    assert.equal(audio.variant.name, 'audio_only')
    assert.equal(audio.estimatedBytes, Math.ceil((219_999 * 3600) / 8))
    const choice = chooseVariant(m(), {kind: 'video', container: 'mp4'}, 100)
    assert.ok(choice.fallbacks.length >= 2, 'the other variants as fallbacks')
    assert.equal(choice.estimatedBytes, Math.ceil((3_422_999 * 100) / 8))
  })

  it('pairs a variant with its demuxed audio track, and downloads that track alone for audio', () => {
    const demuxed = master(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=YES,CHANNELS="2",URI="audio/en.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Español",LANGUAGE="es",DEFAULT=NO,URI="audio/es.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"',
        'video/720.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aac"',
        'video/360.m3u8',
      ].join('\n'),
      'https://video.example/watch/x/playlist.m3u8',
    )
    const video = chooseVariant(demuxed, {kind: 'video', container: 'mp4'})
    assert.equal(video.variant.height, 720)
    assert.equal(video.audio?.uri, 'https://video.example/watch/x/audio/en.m3u8')
    assert.equal(video.audio?.channels, 2)
    const audio = chooseVariant(demuxed, {kind: 'audio', container: 'mp3'})
    assert.equal(audio.variant.uri, 'https://video.example/watch/x/audio/en.m3u8', 'no video bytes for audio')
    assert.equal(audio.audio, undefined)
  })

  it('offers format choices from the variants; a master with nothing usable is refused', () => {
    const choices = variantChoices(m(), 600)
    assert.ok(choices.some(c => c.profile.kind === 'video' && c.profile.maxHeight === 1440))
    assert.ok(choices.some(c => c.profile.kind === 'audio'))
    const hd = choices.find(
      c => c.profile.kind === 'video' && c.profile.container === 'mp4' && c.profile.maxHeight === 720,
    )
    assert.equal(hd?.processingKind, 'none')
    assert.ok(hd?.estimatedBytes, 'sizes from the bandwidth and duration')
    const vp9 = master('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360,CODECS="vp09.00.10.08"\nv.m3u8\n')
    assert.throws(() => chooseVariant(vp9, {kind: 'video', container: 'mp4'}), HlsError)
  })
})

describe('HLS resume state and helpers', () => {
  const pl = (count: number, url = BASE) =>
    media(
      `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${Array.from({length: count}, (_, i) => `#EXTINF:2,\n${i}.ts?sig=${Math.random()}`).join('\n')}\n#EXT-X-ENDLIST\n`,
      url,
    )

  it('identifies a playlist by its paths, not its tokens', () => {
    assert.equal(playlistIdentity(pl(10)), playlistIdentity(pl(10)))
    assert.notEqual(playlistIdentity(pl(10)), playlistIdentity(pl(11)))
    assert.notEqual(playlistIdentity(pl(10)), playlistIdentity(pl(10), pl(10, 'https://cdn.example/a/index.m3u8')))
    assert.equal(samePlaylist(pl(10), pl(10)), true)
    assert.equal(samePlaylist(pl(10), pl(9)), false)
  })

  it('writes and reads the cursor, drops another playlist or a corrupt file', async () => {
    const dir = path.join(tmp, 'state')
    await fs.mkdir(dir, {recursive: true})
    const cursor = {
      next: 42,
      period: 1,
      bytes: 1000,
      periods: [[0, 500]] as const,
      measured: {bytes: 1500, seconds: 84},
      skipped: 1,
    }
    await writeState(dir, {v: 1, id: 'abc', tracks: {main: cursor}})
    assert.deepEqual((await readState(dir, 'abc'))?.tracks.main, cursor)
    assert.equal(await readState(dir, 'other'), undefined)
    await fs.writeFile(path.join(dir, 'state.json'), '{"v":1,"id":"abc","tracks":{"main":{"next":-1}}}')
    assert.equal(await readState(dir, 'abc'), undefined)
    await fs.writeFile(path.join(dir, 'state.json'), '{not json')
    assert.equal(await readState(dir, 'abc'), undefined)
  })

  it('writes the state at most once per interval', async () => {
    const dir = path.join(tmp, 'writer')
    await fs.mkdir(dir, {recursive: true})
    let t = 0
    const w = new StateWriter(dir, 'id', {now: () => t})
    const cursor = (next: number) => ({
      next,
      period: 0,
      bytes: next,
      periods: [],
      measured: {bytes: 0, seconds: 0},
      skipped: 0,
    })
    w.update('main', cursor(1))
    await w.maybeFlush()
    assert.equal((await readState(dir, 'id'))?.tracks.main?.next, 1)
    t = 500
    w.update('main', cursor(2))
    await w.maybeFlush()
    assert.equal((await readState(dir, 'id'))?.tracks.main?.next, 1, 'not again within a second')
    t = 1000
    await w.maybeFlush()
    assert.equal((await readState(dir, 'id'))?.tracks.main?.next, 2)
  })

  it('sizes the refresh budget and the segment concurrency', () => {
    assert.equal(refreshBudget(600), 3)
    assert.equal(refreshBudget(10 * 3600), 11)
    assert.equal(segmentConcurrency(undefined, 12), 3)
    assert.equal(segmentConcurrency(20, 12), 6, 'at most ⌊CPUs/2⌋')
    assert.equal(segmentConcurrency(0, 12), 1)
    assert.equal(segmentConcurrency(3, 1), 1)
  })
})

describe('HLS segment checks and keys', () => {
  it('sniffs TS, fMP4 and packed audio, and refuses an HTML body', () => {
    const ts = Buffer.alloc(376, 0)
    ts[0] = 0x47
    ts[188] = 0x47
    assert.equal(sniff(ts, 'ts'), true)
    ts[188] = 0
    assert.equal(sniff(ts, 'ts'), false)
    assert.equal(sniff(Buffer.from('\0\0\0\x18moof'), 'fmp4'), true)
    assert.equal(sniff(Buffer.from('\0\0\0\x18ftypisom'), 'init'), true)
    assert.equal(sniff(Buffer.from('ID3\x04'), 'packed-audio'), true)
    assert.equal(sniff(Buffer.from([0xff, 0xf1, 0x50]), 'packed-audio'), true)
    assert.equal(sniff(Buffer.from('  <!doctype html>'), 'unknown'), false)
  })

  it('derives the IV from the media sequence, big-endian', () => {
    const iv = ivFor({method: 'AES-128', uri: 'k'}, 0x0102030405)
    assert.deepEqual([...iv.subarray(10)], [0, 0x01, 0x02, 0x03, 0x04, 0x05])
    const own = new Uint8Array(16).fill(9)
    assert.equal(ivFor({method: 'AES-128', uri: 'k', iv: own}, 5), own)
  })

  it('checks an encrypted segment by its first bytes and its padding without reading it all', async () => {
    const key = Buffer.alloc(16, 3)
    const iv = Buffer.alloc(16, 4)
    const plain = Buffer.alloc(188 * 10, 1)
    for (let o = 0; o < plain.length; o += 188) plain[o] = 0x47
    const c = createCipheriv('aes-128-cbc', key, iv)
    const enc = Buffer.concat([c.update(plain), c.final()])
    const file = path.join(tmp, 'enc.ts')
    await fs.writeFile(file, enc)
    await verifySegment(file, enc.length, 'ts', 'Test', {key, iv})
    await assert.rejects(verifySegment(file, enc.length, 'ts', 'Test', {key: Buffer.alloc(16, 5), iv}), HlsError)
    await fs.writeFile(file, enc.subarray(0, enc.length - 8))
    await assert.rejects(verifySegment(file, enc.length - 8, 'ts', 'Test', {key, iv}), /whole AES blocks/)
    await fs.writeFile(file, '<html>')
    await assert.rejects(verifySegment(file, 6, 'ts', 'Test'), /damaged/)
  })

  it('keeps four keys, shares a load in flight and forgets a failed one', async () => {
    const cache = new KeyCache(4)
    let loads = 0
    const load = async (uri: string) => {
      loads++
      if (uri === 'bad') throw new Error('403')
      return new Uint8Array(16)
    }
    await Promise.all([cache.get('a', load), cache.get('a', load)])
    assert.equal(loads, 1)
    for (const uri of ['b', 'c', 'd', 'e']) await cache.get(uri, load)
    assert.equal(cache.size, 4)
    await cache.get('a', load)
    assert.equal(loads, 6, 'a was the least recently used: evicted')
    await assert.rejects(cache.get('bad', load))
    await assert.rejects(cache.get('bad', load))
    assert.equal(loads, 8, 'a failure is not cached')
  })
})
