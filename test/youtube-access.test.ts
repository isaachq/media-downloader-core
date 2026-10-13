import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {BrowserCookies, jarCopy, keepDomains, toNetscape, YOUTUBE_COOKIE_DOMAINS} from '../src/core/cookies.js'
import {MediaDownloader} from '../src/downloader.js'
import type {DownloaderOptions} from '../src/types.js'
import {
  AttestationError,
  type AttestationStrategy,
  type MintSession,
  PoTokenService,
} from '../src/youtube/attestation.js'
import {PoTokenBroker} from '../src/youtube/broker.js'
import {type YouTubeAccess, YouTubeGate} from '../src/youtube/gate.js'
import {installPlugin, PLUGIN_SOURCE} from '../src/youtube/plugin.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

let root = ''
let bins: FakeBinaries
const cleanups: Array<() => Promise<void> | void> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-yt-access-'))
  bins = await writeFakes(path.join(root, 'bin'))
})
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

/** A strategy whose sessions mint "pot-<binding>"; counts what it was asked. */
function strategy(
  name: string,
  opts: {
    fail?: () => boolean
    expiresInMs?: number
    maxMints?: number
    mintFails?: () => boolean
    now?: () => number
  } = {},
) {
  const seen = {opened: 0, closed: 0, minted: 0}
  const now = opts.now ?? Date.now
  const it: AttestationStrategy = {
    name,
    open: async () => {
      if (opts.fail?.()) throw new Error(`${name} is broken`)
      seen.opened++
      const session: MintSession = {
        expiresAt: now() + (opts.expiresInMs ?? 3_600_000),
        ...(opts.maxMints !== undefined && {maxMints: opts.maxMints}),
        mint: async binding => {
          if (opts.mintFails?.()) throw new Error('mint broke')
          seen.minted++
          return `pot-${binding}`
        },
        close: () => {
          seen.closed++
        },
      }
      return session
    },
  }
  return {it, seen}
}

describe('PoTokenService', () => {
  it('opens one session for any number of callers, and mints each binding once', async () => {
    const {it: s, seen} = strategy('a')
    const service = new PoTokenService([s])
    const bindings = Array.from({length: 50}, (_, i) => `video${i}`)
    // every binding asked three times at once: 150 calls, one session, 50 mints
    const tokens = await Promise.all([...bindings, ...bindings, ...bindings].map(b => service.token(b)))
    assert.equal(seen.opened, 1)
    assert.equal(seen.minted, 50)
    assert.deepEqual(new Set(tokens.map(t => t.token)), new Set(bindings.map(b => `pot-${b}`)))
    assert.equal(service.status().cached, 50)
    service.close()
  })

  it('keeps at most cacheSize tokens, dropping the least recently used', async () => {
    const {it: s, seen} = strategy('a')
    const service = new PoTokenService([s], {cacheSize: 2})
    await service.token('x')
    await service.token('y')
    await service.token('x') // x is now the most recent
    await service.token('z') // evicts y
    assert.equal(seen.minted, 3)
    await service.token('x')
    assert.equal(seen.minted, 3, 'x stayed')
    await service.token('y')
    assert.equal(seen.minted, 4, 'y was evicted')
    service.close()
  })

  it('opens a fresh session before the current one expires, or after the mints the site allows', async () => {
    let clock = 1_000_000
    const now = () => clock
    const {it: s, seen} = strategy('a', {expiresInMs: 60 * 60_000, maxMints: 10, now})
    const service = new PoTokenService([s], {now, refreshBeforeMs: 10 * 60_000, tokenTtlMs: 1000})
    for (let i = 0; i < 9; i++) await service.token(`b${i}`)
    assert.equal(seen.opened, 1)
    await service.token('b9') // 9 mints = 90 % of the site's 10: a fresh session
    assert.equal(seen.opened, 2)
    clock += 51 * 60_000 // within 10 min of the expiry
    await service.token('late')
    assert.equal(seen.opened, 3)
    assert.ok(seen.closed >= 1, 'retired sessions are closed')
    service.close()
  })

  it('falls over to the next strategy, cools the broken one down, and keeps using the one that works', async () => {
    let clock = 5_000_000
    const now = () => clock
    const broken = strategy('broken', {fail: () => true, now})
    const good = strategy('good', {now})
    const service = new PoTokenService([broken.it, good.it], {now, cooldownMs: 60_000, maxMintsPerSession: 1})
    assert.equal((await service.token('a')).token, 'pot-a')
    const status = service.status()
    assert.equal(status.active, 'good')
    const failing = status.strategies.find(x => x.name === 'broken')!
    assert.equal(failing.healthy, false)
    assert.match(failing.lastError ?? '', /broken is broken/)
    // one mint per session here: the next token needs a new session — the good one is tried first
    await service.token('b')
    assert.equal(good.seen.opened, 2)
    clock += 61_000
    assert.equal(service.status().strategies.find(x => x.name === 'broken')!.healthy, true, 'cool-down over')
    service.close()
  })

  it('a session that fails to mint is retired and a fresh one tried once; all broken → AttestationError', async () => {
    let mints = 0
    // the first session's mint fails; the fresh one works
    const flaky = strategy('flaky', {mintFails: () => ++mints === 1})
    const service = new PoTokenService([flaky.it])
    assert.equal((await service.token('v')).token, 'pot-v')
    assert.equal(flaky.seen.opened, 2)
    service.close()

    const dead = new PoTokenService([strategy('one', {fail: () => true}).it, strategy('two', {fail: () => true}).it])
    await assert.rejects(dead.token('v'), (error: unknown) => {
      assert.ok(error instanceof AttestationError)
      assert.deepEqual(
        error.attempts.map(a => a.strategy),
        ['one', 'two'],
      )
      return true
    })
    dead.close()
  })

  it('a token YouTube refused retires its session; reset() starts over for a new identity', async () => {
    const {it: s, seen} = strategy('a')
    const service = new PoTokenService([s], {cooldownMs: 0})
    await service.token('v')
    service.reject('v')
    await service.token('v')
    assert.equal(seen.opened, 2)
    assert.equal(seen.minted, 2, 'the refused token was not reused')
    service.reset()
    await service.token('v')
    assert.equal(seen.opened, 3)
    service.close()
  })

  it('one caller giving up does not cancel the token for the others', async () => {
    let release = () => {}
    const slow: AttestationStrategy = {
      name: 'slow',
      open: async () => {
        await new Promise<void>(resolve => {
          release = resolve
        })
        return {expiresAt: Date.now() + 3_600_000, mint: async b => `pot-${b}`, close: () => {}}
      },
    }
    const service = new PoTokenService([slow])
    const stop = new AbortController()
    const first = service.token('v', stop.signal)
    const second = service.token('v')
    stop.abort(new Error('gone'))
    await assert.rejects(first, /gone/)
    release()
    assert.equal((await second).token, 'pot-v')
    service.close()
    await assert.rejects(service.token('w'), /closed/)
  })
})

describe('YouTubeGate: the ladder', () => {
  const gate = (options: Partial<ConstructorParameters<typeof YouTubeGate>[0]> = {}) => {
    const changes: YouTubeAccess[] = []
    const g = new YouTubeGate({
      attestation: true,
      canHold: true,
      pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 1000, maxBackoffMs: 4000},
      attestedDelaysMs: [10, 20, 30],
      onChange: access => changes.push(access),
      ...options,
    })
    return {g, changes}
  }

  it('without tokens: pauses that double, counted against the job', () => {
    const {g} = gate({attestation: false, canHold: false})
    assert.deepEqual(g.refused(), {waitMs: 1000, free: false})
    assert.equal(g.access.level, 'open')
    assert.equal(g.access.tokens, false)
  })

  it('tokens on the first refusal, three retries, then held for the user — none counted against the job', async () => {
    // a clock of the test's own: the pauses are measured in it, whatever the machine's load
    let clock = 0
    const {g, changes} = gate({now: () => clock})
    const first = g.refused()
    assert.deepEqual(first, {waitMs: 10, free: true})
    assert.equal(g.access.level, 'attested')
    assert.equal(g.access.tokens, true)
    // the other requests refused by the same block join the pause: no extra rung
    assert.equal(g.refused().free, true)
    assert.equal(g.access.refusals, 0)
    clock += 15
    assert.deepEqual(g.refused(), {waitMs: 20, free: true})
    clock += 25
    assert.deepEqual(g.refused(), {waitMs: 30, free: true})
    clock += 35
    assert.deepEqual(g.refused(), {waitMs: undefined, free: true})
    assert.equal(g.access.level, 'held')
    assert.equal(g.blocked, true)
    assert.deepEqual(
      changes.map(c => c.level),
      ['attested', 'attested', 'attested', 'held'],
    )

    // held: a request waits — until the user signs in
    let through = false
    const waiting = g.turn().then(() => {
      through = true
    })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(through, false, 'held until the user decides')
    g.enterAccount()
    await waiting
    assert.equal(g.access.level, 'account')
    g.leaveAccount()
    assert.equal(g.access.level, 'attested')
  })

  it('choosing to wait releases the hold into a long pause, with tokens', () => {
    const {g} = gate({attestedDelaysMs: [0], waitItOutMs: 50_000})
    g.refused()
    g.refused()
    assert.equal(g.access.level, 'held')
    g.waitItOut()
    assert.equal(g.access.level, 'attested')
    assert.ok((g.access.pausedUntil ?? 0) > Date.now() + 40_000)
  })

  it('a host that cannot ask the user gets growing pauses instead of a hold', () => {
    const {g} = gate({canHold: false, attestedDelaysMs: [0]})
    g.refused()
    assert.deepEqual(g.refused(), {waitMs: 1000, free: false})
    assert.equal(g.access.level, 'attested')
  })

  it('a cancelled request stops waiting on a hold', async () => {
    const {g} = gate({attestedDelaysMs: [0]})
    g.refused()
    g.refused()
    const stop = new AbortController()
    const waiting = g.turn(stop.signal)
    stop.abort(new Error('cancelled'))
    await assert.rejects(waiting, /cancelled/)
  })
})

describe('PoTokenBroker', () => {
  it('answers only its key, on loopback, one path; tokens from the service', async () => {
    const service = new PoTokenService([strategy('a').it])
    const broker = new PoTokenBroker(service)
    cleanups.push(
      () => broker.close(),
      () => service.close(),
    )
    const env = await broker.env()
    assert.match(env['MDC_POT_URL']!, /^http:\/\/127\.0\.0\.1:\d+\/mdc\/pot\/v1$/)
    const ask = (body: unknown, headers: Record<string, string> = {}, url = env['MDC_POT_URL']!) =>
      fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${env['MDC_POT_KEY']}`, ...headers},
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    const ok = await ask({binding: 'jNQXAC9IVRw', context: 'gvs'})
    assert.equal(ok.status, 200)
    const answer = (await ok.json()) as {po_token: string; expires_at: number}
    // websafe base64 keeps its padding: yt-dlp refuses a token without it
    assert.equal(answer.po_token, 'pot-jNQXAC9IVRw=')
    assert.ok(answer.expires_at > Date.now() / 1000)
    assert.equal((await ask({binding: 'x'}, {Authorization: 'Bearer wrong'})).status, 401)
    assert.equal((await ask({binding: 'x'}, {Authorization: ''})).status, 401)
    assert.equal((await ask({binding: 'x'}, {}, env['MDC_POT_URL']!.replace('/v1', '/v2'))).status, 404)
    assert.equal((await ask('not json')).status, 400)
    assert.equal((await ask({context: 'gvs'})).status, 400)
  })

  it('says why when no token can be made', async () => {
    const service = new PoTokenService([strategy('down', {fail: () => true}).it])
    const broker = new PoTokenBroker(service)
    cleanups.push(
      () => broker.close(),
      () => service.close(),
    )
    const env = await broker.env()
    const response = await fetch(env['MDC_POT_URL']!, {
      method: 'POST',
      headers: {Authorization: `Bearer ${env['MDC_POT_KEY']}`},
      body: JSON.stringify({binding: 'v'}),
    })
    assert.equal(response.status, 503)
    assert.match(((await response.json()) as {error: string}).error, /down is broken/)
  })
})

describe('yt-dlp plugin', () => {
  it('is written once per version, where --plugin-dirs finds it', async () => {
    const dir = path.join(root, 'plugins')
    assert.equal(await installPlugin(dir), dir)
    const file = path.join(dir, 'mdc-pot', 'yt_dlp_plugins', 'extractor', 'mdc_pot.py')
    assert.equal(await fs.readFile(file, 'utf8'), PLUGIN_SOURCE)
    const written = (await fs.stat(file)).mtimeMs
    await new Promise(r => setTimeout(r, 20))
    await installPlugin(dir)
    assert.equal((await fs.stat(file)).mtimeMs, written, 'unchanged: not written again')
    // the provider: a class ending in PTP, reading where to ask from the environment only
    assert.match(PLUGIN_SOURCE, /class MdcPTP\(PoTokenProvider\)/)
    assert.match(PLUGIN_SOURCE, /os\.environ\['MDC_POT_URL'\]/)
  })
})

describe('cookies', () => {
  it('writes and filters cookies.txt (YouTube and Google only), leaving out what yt-dlp could not read', () => {
    const jar = toNetscape([
      {name: 'SID', value: 'a', domain: '.youtube.com', secure: true, httpOnly: true, expirationDate: 2_000_000_000},
      {name: 'x', value: 'b', domain: 'accounts.google.com', hostOnly: true},
      {name: 'bad', value: 'tab\there', domain: '.youtube.com'},
      {name: 'other', value: 'c', domain: '.example.org'},
    ])
    assert.match(jar, /^# Netscape HTTP Cookie File/)
    assert.match(jar, /#HttpOnly_\.youtube\.com\tTRUE\t\/\tTRUE\t2000000000\tSID\ta/)
    assert.match(jar, /accounts\.google\.com\tFALSE\t\/\tFALSE\t0\tx\tb/)
    assert.doesNotMatch(jar, /bad/)
    const youtube = keepDomains(jar, YOUTUBE_COOKIE_DOMAINS)
    assert.match(youtube, /SID/)
    assert.match(youtube, /accounts\.google\.com/)
    assert.doesNotMatch(youtube, /example\.org/)
  })

  it("a browser's cookies are read once for every caller, again when old or another browser", async () => {
    let clock = 0
    let reads = 0
    const jar = new BrowserCookies(path.join(root, 'bc', 'jar.txt'), {maxAgeMs: 1000, now: () => clock})
    const read = async (_browser: string, dest: string) => {
      reads++
      await new Promise(r => setTimeout(r, 10))
      await fs.mkdir(path.dirname(dest), {recursive: true})
      await fs.writeFile(dest, '# Netscape HTTP Cookie File\n')
    }
    assert.equal(await jar.jar(read), undefined, 'no browser, nothing read')
    jar.browser = 'firefox'
    await Promise.all(Array.from({length: 20}, () => jar.jar(read)))
    assert.equal(reads, 1)
    clock += 500
    await jar.jar(read)
    assert.equal(reads, 1)
    clock += 600
    await jar.jar(read)
    assert.equal(reads, 2, 'older than maxAge')
    jar.browser = 'chrome'
    await jar.jar(read)
    assert.equal(reads, 3, 'another browser')
    const copy = await jarCopy(path.join(root, 'bc', 'jar.txt'), path.join(root, 'bc', 'run1'))
    assert.equal(path.basename(copy), 'cookies.txt')
  })
})

// ─── the engine, end to end with the fake yt-dlp ─────────────────────────────

function engine(name: string, extra: Partial<DownloaderOptions> = {}) {
  const dl = new MediaDownloader({
    dataDir: path.join(root, name),
    binaries: bins,
    validation: 'none',
    progressIntervalMs: 0,
    retryDelayMaxMs: 20,
    maxRetries: 1,
    ...extra,
    youtube: {pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 400, maxBackoffMs: 1000}, ...extra.youtube},
  })
  cleanups.push(() => dl.dispose())
  return dl
}
const audio = {kind: 'audio', container: 'm4a'} as const
const signedInJar = async (name: string) => {
  const file = path.join(root, name, 'account.txt')
  await fs.mkdir(path.dirname(file), {recursive: true})
  await fs.writeFile(file, toNetscape([{name: 'SID', value: 'account', domain: '.youtube.com'}]))
  return file
}

describe('YouTube access, end to end (fake yt-dlp)', () => {
  it("reads a browser's cookies once for a whole batch, not once per yt-dlp run", async () => {
    const dl = engine('cookies-once', {cookiesFromBrowser: 'firefox', concurrency: 4})
    const out = path.join(root, 'cookies-once-out')
    for (let i = 0; i < 6; i++) dl.add({url: `https://fake/c${i}`, profile: audio, outDir: out})
    await dl.whenIdle()
    const exports = await fs.readFile(path.join(root, 'cookies-once', 'cookies', 'exports.log'), 'utf8')
    assert.equal(exports.trim().split('\n').length, 1, 'one read of the browser for six downloads')
    assert.equal((await fs.readdir(out)).length, 6)
  })

  it("a browser whose cookies can't be read fails as cookies-unreadable", async () => {
    const dl = engine('cookies-bad', {cookiesFromBrowser: 'unreadable-safari'})
    const job = dl.add({url: 'https://fake/u1', profile: audio, outDir: path.join(root, 'cookies-bad-out')})
    await dl.whenIdle()
    assert.equal(dl.job(job.id)?.status, 'failed')
    assert.equal(dl.job(job.id)?.error?.hint, 'cookies-unreadable')
  })

  it('a bot check turns PO tokens on: the retry carries one and goes through, without using up a retry', async () => {
    const tokens = strategy('fake')
    const dl = engine('tokens', {youtube: {attestation: [tokens.it], attestedDelaysMs: [30, 30, 30]}})
    const seen: YouTubeAccess[] = []
    dl.on('youtube', access => seen.push(access))
    const job = dl.add({url: 'https://youtu.be/pot1', profile: audio, outDir: path.join(root, 'tokens-out')})
    await dl.whenIdle()
    const done = dl.job(job.id)!
    assert.equal(done.status, 'completed', JSON.stringify(done.error))
    assert.equal(done.attempts.length, 2, 'refused once without a token, then through with one')
    assert.equal(dl.youtube.tokens, true)
    assert.equal(seen[0]?.level, 'attested')
    assert.equal(tokens.seen.opened, 1)
    assert.ok(tokens.seen.minted >= 1)
    assert.equal(dl.attestation?.active, 'fake')
  })

  it('still refused after the token retries: held — not failed — until the user signs in, then it goes on', async () => {
    const dl = engine('held', {
      youtube: {attestation: [strategy('fake').it], attestedDelaysMs: [20, 20, 20], askUser: true},
    })
    const job = dl.add({url: 'https://youtu.be/wall1', profile: audio, outDir: path.join(root, 'held-out')})
    await new Promise<void>(resolve => {
      const check = (access: YouTubeAccess) => {
        if (access.level === 'held') resolve()
      }
      dl.on('youtube', check)
    })
    await new Promise(r => setTimeout(r, 50))
    assert.equal(dl.job(job.id)?.status, 'queued', 'waiting for the user, not failed')
    assert.ok(dl.job(job.id)!.attempts.length > 2, 'more refusals than retries: none were counted')
    await assert.rejects(dl.analyze('https://youtu.be/wall2'), (e: {code?: string}) => e.code === 'blocked')
    dl.setYouTubeAccount(await signedInJar('held'))
    await dl.whenIdle()
    assert.equal(dl.job(job.id)?.status, 'completed')
    assert.equal(dl.youtube.level, 'account')
  })

  it('the signed-in session is for YouTube only', async () => {
    const dl = engine('account-scope')
    dl.setYouTubeAccount(await signedInJar('account-scope'))
    const youtube = dl.add({url: 'https://youtu.be/wall3', profile: audio, outDir: path.join(root, 'scope-out')})
    // a site with the same refusal but not YouTube: no account for it, so it fails like before
    const other = dl.add({url: 'https://fake/wall4', profile: audio, outDir: path.join(root, 'scope-out')})
    await dl.whenIdle()
    assert.equal(dl.job(youtube.id)?.status, 'completed')
    assert.equal(dl.job(other.id)?.status, 'failed')
  })
})
