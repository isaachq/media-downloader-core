import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {isYouTubeUrl} from '../src/core/analyze.js'
import {classifyYtDlpError, hintFor, isRetryable} from '../src/core/errors.js'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import type {DownloaderOptions} from '../src/types.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

let root = ''
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-youtube-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

function engine(name: string, extra: Partial<DownloaderOptions> = {}) {
  const dl = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    progressIntervalMs: 0,
    retryDelayMaxMs: 20,
    // the pause after a bot check, short for tests
    youtube: {pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 400, maxBackoffMs: 1000}},
    ...extra,
  })
  cleanups.push(() => dl.dispose())
  return dl
}

const audio = {kind: 'audio', container: 'm4a'} as const
const BOT =
  'ERROR: [youtube] MIXqIFY51P4: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies.'

describe('YouTube bot check: what it is', () => {
  it('is "blocked" (for a while), not "unavailable" (for good) — even though it says sign in and cookies', () => {
    const error = classifyYtDlpError(BOT, 1)
    assert.equal(error.code, 'blocked')
    assert.equal(error.hint, 'bot-check')
    assert.equal(isRetryable('blocked'), false, 'not by the quick retry loop: it waits for the pause')
    assert.equal(hintFor("Sign in to confirm you're not a bot"), 'bot-check')
    // a real sign-in requirement is still what it was
    assert.equal(classifyYtDlpError('ERROR: [youtube] x: Sign in to confirm your age', 1).hint, 'needs-sign-in')
  })

  it("tells when the browser's cookies can't be read (Safari's need Full Disk Access)", () => {
    const error = classifyYtDlpError(
      "ERROR: [Errno 1] Operation not permitted: '/Users/me/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'",
      1,
    )
    assert.equal(error.code, 'invalid-request')
    assert.equal(error.hint, 'cookies-unreadable')
  })

  it('knows YouTube urls', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=x',
      'https://youtu.be/x',
      'https://music.youtube.com/watch?v=x',
    ]) {
      assert.equal(isYouTubeUrl(url), true, url)
    }
    for (const url of ['https://fake.test/youtube.com', 'https://notyoutube.com/x', 'not a url']) {
      assert.equal(isYouTubeUrl(url), false, url)
    }
  })
})

describe('YouTube bot check: waiting it out (local fake)', () => {
  it('a blocked download waits for the pause, with every YouTube request, and then completes', async () => {
    const dl = engine('wait')
    const out = path.join(root, 'wait-out')
    const started = Date.now()
    const job = dl.add({url: 'https://youtu.be/bot1', profile: audio, outDir: out})
    await dl.whenIdle()
    const done = dl.job(job.id)!
    assert.equal(done.status, 'completed')
    assert.equal(done.attempts.length, 2)
    assert.equal(done.attempts[0]?.error?.code, 'blocked')
    assert.equal(done.attempts[0]?.error?.hint, 'bot-check')
    assert.ok((done.attempts[0]?.retryInMs ?? 0) >= 300, `waited ${done.attempts[0]?.retryInMs} ms`)
    assert.ok(Date.now() - started >= 350, 'the second attempt came after the pause')
    assert.equal(dl.youtubePausedUntil, undefined, 'the pause is over')
  })

  it('a checked batch does not call blocked items unavailable: they download after the pause', async () => {
    const dl = engine('preflight')
    const scheduler = new BatchScheduler(dl, {progressIntervalMs: 0})
    cleanups.push(() => scheduler.dispose())
    const entry = (index: number) => ({
      id: `bot${index}`,
      index,
      url: `https://youtu.be/bot${index}`,
      title: `Song ${index}`,
      extractor: 'Youtube',
      isLive: false,
    })
    const batch = scheduler.schedule({
      url: 'https://www.youtube.com/watch?v=bot1&list=RDbot1',
      profile: audio,
      outDir: path.join(root, 'preflight-out'),
      selection: {title: 'Mix - bot', entries: [1, 2, 3, 4].map(entry)},
    })
    await scheduler.whenIdle()
    const done = scheduler.batch(batch.id)!
    assert.equal(done.preflight.unavailable, 0, JSON.stringify(done.problems))
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.jobs.succeeded, 4)
  })

  it('a link pasted while YouTube blocks starts the pause too (the app shows it)', async () => {
    const dl = engine('analyze', {youtube: {pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 60_000}}})
    await assert.rejects(dl.analyze('https://youtu.be/bot9'), (error: {code?: string; hint?: string}) => {
      assert.equal(error.code, 'blocked')
      assert.equal(error.hint, 'bot-check')
      return true
    })
    assert.ok((dl.youtubePausedUntil ?? 0) > Date.now() + 50_000, 'YouTube requests pause')
    // with a signed-in session it reads at once
    dl.setCookiesFromBrowser('firefox')
    assert.equal(dl.youtubePausedUntil, undefined)
    const analysis = await dl.analyze('https://youtu.be/bot9')
    assert.equal(analysis.kind, 'video')
  })

  it("a browser's signed-in session ends the pause at once", async () => {
    // a pause far longer than the test: only the cookies can end it
    const dl = engine('cookies', {youtube: {pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 60_000}}})
    const job = dl.add({url: 'https://youtu.be/bot2', profile: audio, outDir: path.join(root, 'cookies-out')})
    for (let i = 0; i < 200 && dl.youtubePausedUntil === undefined; i++) await new Promise(r => setTimeout(r, 10))
    assert.ok(dl.youtubePausedUntil, 'YouTube requests are paused')
    const started = Date.now()
    dl.setCookiesFromBrowser('firefox')
    await dl.whenIdle()
    assert.equal(dl.job(job.id)?.status, 'completed')
    assert.ok(Date.now() - started < 10_000, 'it did not wait the minute out')
    assert.throws(() => dl.setCookiesFromBrowser('chrome; rm -rf /'), /Not a browser name/)
  })
})
