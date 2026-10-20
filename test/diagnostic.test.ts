import {strict as assert} from 'node:assert'
import {describe, it} from 'node:test'
import {tarCommand} from '../src/binaries/extract.js'
import {diagnoseFailure, mediaTypeOf, platformOf} from '../src/core/diagnostic.js'
import {HttpSession, withCause} from '../src/sources/http.js'
import {followShortLink, MAX_HOPS, returnUrlOf} from '../src/sources/redirects.js'
import type {AnalysisResult, JobError} from '../src/types.js'

describe('failure diagnostics', () => {
  it('names the site of every host shape: www, m, web, vm, vt, short domains', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['https://www.facebook.com/watch/?v=1', 'facebook'],
      ['https://m.facebook.com/story.php?story_fbid=1&id=2', 'facebook'],
      ['https://web.facebook.com/watch/?v=1', 'facebook'],
      ['https://fb.watch/abc/', 'facebook'],
      ['https://www.instagram.com/reel/abc/', 'instagram'],
      ['https://instagr.am/p/abc/', 'instagram'],
      ['https://vm.tiktok.com/ZMabc/', 'tiktok'],
      ['https://vt.tiktok.com/ZSabc/', 'tiktok'],
      ['https://m.tiktok.com/v/123.html', 'tiktok'],
      ['https://youtu.be/x', 'youtube'],
      ['https://notfacebook.com/watch', 'unknown'],
      ['https://facebook.com.evil.test/watch', 'unknown'],
      ['not a url', 'unknown'],
    ]
    for (const [url, platform] of cases) assert.equal(platformOf(url), platform, url)
  })

  it('tells the media type from the url, and from the analysis when there is one', () => {
    assert.equal(mediaTypeOf('https://www.facebook.com/share/r/abc/'), 'short_link')
    assert.equal(mediaTypeOf('https://vm.tiktok.com/ZMabc/'), 'short_link')
    assert.equal(mediaTypeOf('https://www.tiktok.com/t/ZTabc/'), 'short_link')
    assert.equal(mediaTypeOf('https://www.instagram.com/nasa/reel/abc/'), 'reel')
    assert.equal(mediaTypeOf('https://www.instagram.com/reels/abc/'), 'reel')
    assert.equal(mediaTypeOf('https://www.tiktok.com/@a/photo/123'), 'photo_with_audio')
    assert.equal(mediaTypeOf('https://www.facebook.com/watch/?v=1'), 'video')
    const photo = {
      kind: 'video',
      media: {id: '1', url: 'u', title: 't', extractor: 'TikTok', isLive: false, slideshow: {images: 4, audio: true}},
      choices: [],
    } satisfies AnalysisResult
    assert.equal(mediaTypeOf('https://www.tiktok.com/@a/video/123', photo), 'photo_with_audio')
    const mixed = {...photo, media: {...photo.media, slideshow: {images: 3, audio: true, videos: true}}}
    assert.equal(mediaTypeOf('https://www.instagram.com/p/abc/', mixed), 'carousel')
  })

  it('maps the engine’s errors to stable codes and stages', () => {
    const diagnose = (error: JobError, stage: 'analyze' | 'download' = 'analyze') =>
      diagnoseFailure({url: 'https://www.facebook.com/share/r/abc/', error, stage, elapsedMs: 12.4})
    const wall = diagnose({code: 'unavailable', hint: 'needs-sign-in', message: 'Instagram asks to sign in for this.'})
    assert.equal(wall.error_code, 'LOGIN_WALL_DETECTED')
    assert.equal(wall.failure_stage, 'METADATA_PARSE')
    assert.equal(wall.platform, 'facebook')
    assert.equal(wall.detected_media_type, 'short_link')
    assert.equal(wall.execution_time_ms, 12)
    const dead = diagnose({code: 'unavailable', hint: 'removed', message: 'This short link leads nowhere.'})
    assert.deepEqual([dead.error_code, dead.failure_stage], ['REDIRECT_DEAD_END', 'REDIRECT_RESOLUTION'])
    const loop = diagnose({code: 'network', message: 'Facebook: too many redirects (a redirect loop).'})
    assert.deepEqual([loop.error_code, loop.failure_stage], ['REDIRECT_LOOP', 'REDIRECT_RESOLUTION'])
    const limited = diagnose({code: 'network', hint: 'retry-later', message: 'TikTok answered HTTP 429.'})
    assert.deepEqual(
      [limited.error_code, limited.http_status, limited.failure_stage],
      ['RATE_LIMITED', 429, 'NETWORK_IO'],
    )
    const muxing = diagnose({code: 'conversion', message: 'ffmpeg failed'}, 'download')
    assert.deepEqual([muxing.error_code, muxing.failure_stage], ['MUXING_FAILED', 'MUXING'])
    const silent = diagnose({code: 'validation', message: 'The file has no audio stream.'}, 'download')
    assert.equal(silent.error_code, 'DASH_AUDIO_MISSING')
    const unsupported = diagnose({code: 'invalid-request', hint: 'unsupported-url', message: 'Not a Facebook url.'})
    assert.deepEqual([unsupported.error_code, unsupported.failure_stage], ['UNSUPPORTED_URL', 'URL_VALIDATION'])
    const listing = diagnose({
      code: 'unknown',
      message:
        'Facebook no longer accepts this request (HTTP 400) — without a signed-in session it may not show this list.',
      details: 'source:format-changed',
    })
    assert.deepEqual([listing.error_code, listing.http_status], ['LOGIN_WALL_DETECTED', 400])
    const check = diagnose({code: 'unavailable', message: 'TikTok answered with a verification page.'})
    assert.equal(check.error_code, 'BOT_CHECK')
    const timeout = diagnose({code: 'network', message: 'The operation was aborted due to timeout'}, 'download')
    assert.deepEqual([timeout.error_code, timeout.failure_stage], ['TIMEOUT', 'NETWORK_IO'])
  })

  it('keeps no signed query string in the stack snippet, and caps it', () => {
    const details = `${'x\n'.repeat(20)}GET https://cdn.test/v.mp4?oh=SECRET&oe=123 failed`
    const report = diagnoseFailure({
      url: 'https://www.tiktok.com/@a/video/1',
      error: {code: 'network', message: 'failed', details},
      stage: 'download',
      elapsedMs: 1,
    })
    assert.ok(report.stack_snippet)
    assert.doesNotMatch(report.stack_snippet, /SECRET|123/)
    assert.ok(report.stack_snippet.length <= 1024)
    assert.ok(report.stack_snippet.split('\n').length <= 8)
  })
})

describe('archive extraction', () => {
  it('uses Windows’ own tar by its full path, whatever GNU tar comes first on the PATH', () => {
    assert.equal(tarCommand('win32', {SystemRoot: 'C:\\Windows'}), 'C:\\Windows\\System32\\tar.exe')
    assert.equal(tarCommand('win32', {}), 'tar')
    assert.equal(tarCommand('darwin', {SystemRoot: 'C:\\Windows'}), 'tar')
    assert.equal(tarCommand('linux', {}), 'tar')
  })
})

describe('short links', () => {
  const parse = (url: string) => {
    const id = /\/reel\/(\d+)/.exec(url)?.[1]
    return id ? {kind: 'video' as const, id} : undefined
  }
  const chain =
    (hops: Record<string, string>) =>
    async (url: string): Promise<string | undefined> =>
      hops[url]

  it('follow several hops to the post (a tracker in between)', async () => {
    const followed = await followShortLink(
      'https://fb.test/share/r/abc/',
      chain({
        'https://fb.test/share/r/abc/': 'https://l.fb.test/track?x=1',
        'https://l.fb.test/track?x=1': '/reel/123/?mibextid=9',
      }),
      parse,
    )
    assert.deepEqual(followed, {
      ok: true,
      link: {kind: 'video', id: '123'},
      resolvedUrl: 'https://l.fb.test/reel/123/?mibextid=9',
      hops: 2,
    })
  })

  it('read the page a login redirect was asked for (next=…)', async () => {
    const followed = await followShortLink(
      'https://fb.test/share/r/abc/',
      chain({'https://fb.test/share/r/abc/': '/login/?next=https%3A%2F%2Ffb.test%2Freel%2F77%2F'}),
      parse,
    )
    assert.equal(followed.ok && followed.link.id, '77')
    assert.equal(returnUrlOf('https://fb.test/login/?next=%2Freel%2F5%2F'), 'https://fb.test/reel/5/')
    assert.equal(returnUrlOf('https://fb.test/login/?next=javascript%3Aalert(1)'), undefined)
  })

  it('name a loop and a dead end, and give up after MAX_HOPS', async () => {
    const loop = await followShortLink(
      'https://t.test/a',
      chain({'https://t.test/a': 'https://t.test/b', 'https://t.test/b': 'https://t.test/a'}),
      parse,
    )
    assert.deepEqual([loop.ok, !loop.ok && loop.reason], [false, 'loop'])
    const dead = await followShortLink('https://t.test/a', chain({'https://t.test/a': 'https://t.test/home'}), parse)
    assert.deepEqual([dead.ok, !dead.ok && dead.reason, dead.resolvedUrl], [false, 'dead-end', 'https://t.test/home'])
    let requests = 0
    const endless = await followShortLink(
      'https://t.test/0',
      async url => {
        requests++
        return `${url}0`
      },
      parse,
    )
    assert.equal(endless.ok, false)
    assert.equal(requests, MAX_HOPS)
  })
})

describe('network errors', () => {
  it('say why a request failed: Node’s fetch keeps the reason in its cause', async () => {
    const lookup = Object.assign(new Error('getaddrinfo ENOTFOUND www.tiktok.com'), {
      code: 'ENOTFOUND',
      hostname: 'www.tiktok.com',
    })
    const failed = new TypeError('fetch failed', {cause: lookup})
    const session = new HttpSession({
      fetch: async () => {
        throw failed
      },
    })
    await assert.rejects(session.get('https://www.tiktok.com/@a'), (e: Error) => {
      assert.equal(e.message, 'fetch failed (ENOTFOUND www.tiktok.com)')
      assert.equal((e as Error & {cause?: unknown}).cause, lookup)
      return true
    })
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}),
    })
    assert.equal((withCause(reset) as Error).message, 'fetch failed (ECONNRESET)')
    const aborted = Object.assign(new Error('This operation was aborted'), {name: 'AbortError'})
    assert.equal(withCause(aborted), aborted, 'an abort stays an abort')
    const plain = new TypeError('fetch failed')
    assert.equal(withCause(plain), plain)
  })
})
