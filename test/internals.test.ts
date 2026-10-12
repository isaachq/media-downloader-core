import {strict as assert} from 'node:assert'
import {createHash} from 'node:crypto'
import {rmSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {pathToFileURL} from 'node:url'
import {assertHttpUrl, extractMany} from '../src/core/analyze.js'
import {archiveKey, DownloadArchive} from '../src/core/archive.js'
import {buildYtDlpArgs, type YtDlpRunOptions} from '../src/core/download.js'
import {DownloadError} from '../src/core/errors.js'
import {isInside, sha256File} from '../src/core/files.js'
import {profileProblem} from '../src/core/formats.js'
import {HashPool} from '../src/core/hash-pool.js'
import {ID_PATTERN, newId} from '../src/core/ids.js'
import {LineSplitter, lastLines, run, TailBuffer} from '../src/core/process.js'
import {PendingJournal, QueueStore} from '../src/core/queue-store.js'

import {writeFakes} from './helpers/fakes.js'

let dir = ''
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-internals-'))
})
after(async () => {
  await fs.rm(dir, {recursive: true, force: true})
})

describe('extractMany', () => {
  it('keeps its results when the metadata cache disappears mid-run (a shutdown removing it)', async () => {
    const fakes = await writeFakes(path.join(dir, 'extract-fakes'))
    const cacheDir = path.join(dir, 'extract-cache')
    const urls = ['https://fake.test/a1', 'https://fake.test/a2', 'https://fake.test/a3']
    const results = await extractMany(
      urls.map(url => ({url})),
      {
        ytDlp: fakes.ytDlp,
        env: process.env,
        cacheDir,
        commonArgs: [],
        // removed as soon as the first result arrives: the writes still pending find no folder
        onResult: () => rmSync(cacheDir, {recursive: true, force: true}),
      },
    )
    assert.equal(results.size, 3)
    for (const url of urls) assert.equal(results.get(url)?.ok, true)
  })
})

describe('LineSplitter', () => {
  it('reassembles lines split across chunks and strips \\r', () => {
    const received: string[] = []
    const splitter = new LineSplitter(line => received.push(line))
    for (const chunk of ['he', 'llo\r\nwor', 'ld\n\npartial', ' end']) splitter.push(chunk)
    assert.deepEqual(received, ['hello', 'world'])
    splitter.flush()
    assert.deepEqual(received, ['hello', 'world', 'partial end'])
  })
})

describe('TailBuffer', () => {
  it('keeps only the last N characters', () => {
    const tail = new TailBuffer(10)
    let full = ''
    for (let i = 0; i < 100; i++) {
      tail.push(`line${i}\n`)
      full += `line${i}\n`
    }
    assert.equal(tail.toString(), full.slice(-10))
  })

  it('lastLines returns the trailing non-empty lines', () => {
    assert.equal(lastLines('a\n\nb\nc\n\n', 2), 'b\nc')
  })
})

describe('input validation', () => {
  it('accepts only http(s) urls', () => {
    assert.equal(assertHttpUrl(' https://youtu.be/x '), 'https://youtu.be/x')
    for (const bad of ['--exec rm -rf ~', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      assert.throws(
        () => assertHttpUrl(bad),
        (e: unknown) => e instanceof DownloadError && e.code === 'invalid-request',
      )
    }
  })

  it('validates profiles coming from untrusted callers', () => {
    assert.equal(profileProblem({kind: 'video', container: 'mp4', maxHeight: 1080}), undefined)
    assert.equal(profileProblem({kind: 'audio', container: 'mp3', quality: '192K'}), undefined)
    assert.ok(profileProblem({kind: 'video', container: 'avi'}))
    assert.ok(profileProblem({kind: 'video', container: 'mp4', maxHeight: -1}))
    assert.ok(profileProblem({kind: 'audio', container: 'mp3', quality: '; rm -rf'}))
    assert.ok(profileProblem(null))
    assert.ok(profileProblem({kind: 'image'}))
  })

  it('isInside rejects path traversal', () => {
    assert.equal(isInside('/data/cache', '/data/cache/info.json'), true)
    assert.equal(isInside('/data/cache', '/data/cache/../secrets.json'), false)
    assert.equal(isInside('/data/cache', '/data/cache'), false)
  })

  it('puts the url last, after "--", so it can never be read as an option', () => {
    const opts: YtDlpRunOptions = {
      ytDlp: {command: 'yt-dlp', args: []},
      ffmpeg: {command: '/usr/bin/ffmpeg', args: []},
      env: {},
      url: 'https://example.com/v',
      profile: {kind: 'audio', container: 'm4a'},
      workDir: '/tmp/w',
      fragments: 3,
      commonArgs: ['--js-runtimes', 'node:/usr/bin/node'],
      embedMetadata: true,
      embedThumbnail: false,
      extraArgs: [],
    }
    const args = buildYtDlpArgs(opts)
    assert.deepEqual(args.slice(-2), ['--', 'https://example.com/v'])
    assert.ok(args.includes('--progress-delta'))
    const withInfo = buildYtDlpArgs({...opts, infoJsonPath: '/tmp/info.json'})
    assert.deepEqual(withInfo.slice(-2), ['--load-info-json', '/tmp/info.json'])
    assert.ok(!withInfo.includes('https://example.com/v'))
  })
})

describe('newId', () => {
  it('produces 32-char base62 ids, unique and uniformly distributed', () => {
    const ids = Array.from({length: 20_000}, () => newId())
    assert.ok(ids.every(id => ID_PATTERN.test(id)))
    assert.equal(new Set(ids).size, ids.length)
    const counts = new Map<string, number>()
    for (const id of ids) for (const char of id) counts.set(char, (counts.get(char) ?? 0) + 1)
    assert.equal(counts.size, 62)
    const expected = (ids.length * 32) / 62
    // a modulo-biased generator would put 'A'–'H' ~25% above the rest
    for (const [char, count] of counts) assert.ok(Math.abs(count - expected) / expected < 0.06, `${char}: ${count}`)
  })
})

describe('HashPool', () => {
  it('matches a reference SHA-256 using worker threads, and frees workers when idle', async () => {
    const files = await Promise.all(
      [1, 2, 3].map(async n => {
        const file = path.join(dir, `blob${n}.bin`)
        const data = Buffer.alloc(3 * 1024 * 1024 + n, n)
        await fs.writeFile(file, data)
        return {file, expected: createHash('sha256').update(data).digest('hex')}
      }),
    )
    const pool = new HashPool(2, 50)
    const digests = await Promise.all(files.map(f => pool.sha256(f.file)))
    assert.deepEqual(
      digests,
      files.map(f => f.expected),
    )
    assert.ok(pool.workerCount <= 2)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(pool.workerCount, 0, 'idle workers should exit')
    assert.equal(await sha256File(files[0]!.file), files[0]!.expected)
    await pool.close()
  })

  it('waits for a running hash, but never keeps the process alive once idle', async () => {
    const blob = path.join(dir, 'alive.bin')
    await fs.writeFile(blob, Buffer.alloc(1024 * 1024, 7))
    const script = path.join(dir, 'hash-exit.mts')
    const pool = path.resolve('src/core/hash-pool.ts')
    await fs.writeFile(
      script,
      `import {HashPool} from ${JSON.stringify(pathToFileURL(pool).href)}\n` +
        `console.log(await new HashPool(2, 60_000).sha256(${JSON.stringify(blob)}))\n`,
    )
    const started = Date.now()
    const result = await run(process.execPath, ['--import', 'tsx', script])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout.trim(), /^[a-f0-9]{64}$/)
    assert.ok(Date.now() - started < 15_000, 'process waited for the idle worker timeout')
  })

  it('rejects missing files and aborted requests', async () => {
    const pool = new HashPool(1)
    await assert.rejects(pool.sha256(path.join(dir, 'nope')))
    const cancelled = AbortSignal.abort()
    await assert.rejects(pool.sha256(path.join(dir, 'blob1.bin'), cancelled), (e: unknown) => {
      return e instanceof DownloadError && e.code === 'cancelled'
    })
    await pool.close()
  })
})

describe('DownloadArchive (append-only log)', () => {
  const profile = {kind: 'audio', container: 'm4a'} as const

  it('survives a torn last line and compacts superseded records', async () => {
    const file = path.join(dir, 'archive.jsonl')
    const media = path.join(dir, 'song.m4a')
    await fs.writeFile(media, 'x'.repeat(10))
    const key = archiveKey('Youtube', 'a', profile)

    const archive = new DownloadArchive(file)
    for (let i = 0; i < 1200; i++) {
      await archive.add({
        key,
        extractor: 'Youtube',
        mediaId: 'a',
        profile: 'audio:m4a:0',
        url: 'u',
        filepath: media,
        sizeBytes: 10,
      })
    }
    await archive.close()
    await fs.appendFile(file, '{"op":"put","entry":{"key":"tor') // crash mid-write

    const reopened = new DownloadArchive(file)
    assert.ok(await reopened.find(key))
    assert.equal(reopened.size, 1)
    await reopened.close()
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1, 'log should be compacted to one record')
  })

  it('removal is persisted', async () => {
    const file = path.join(dir, 'archive2.jsonl')
    const media = path.join(dir, 'song2.m4a')
    await fs.writeFile(media, 'abc')
    const key = archiveKey('Youtube', 'b', profile)
    const archive = new DownloadArchive(file)
    await archive.add({
      key,
      extractor: 'Youtube',
      mediaId: 'b',
      profile: 'audio:m4a:0',
      url: 'u',
      filepath: media,
      sizeBytes: 3,
    })
    await archive.remove(key)
    await archive.close()
    const reopened = new DownloadArchive(file)
    assert.equal(await reopened.find(key), undefined)
    await reopened.close()
  })
})

describe('download archive listing', () => {
  const record = (i: number, title: string, filepath = `/media/file-${i}.mp4`) => ({
    key: `fake:${i}:video:mp4:0`,
    extractor: 'Fake',
    mediaId: String(i),
    profile: 'video:mp4:0',
    url: `https://fake.test/${i}`,
    filepath,
    sizeBytes: 100 + i,
    title,
  })

  it('pages newest first, searches title and file name without case or accents, and follows writes', async () => {
    const file = path.join(dir, 'archive-list.jsonl')
    const archive = new DownloadArchive(file)
    for (let i = 0; i < 120; i++) await archive.add(record(i, i === 7 ? 'Canción del Año' : `Clip ${i}`))
    await archive.close()

    const reopened = new DownloadArchive(file)
    const first = await reopened.list({limit: 50})
    assert.equal(first.total, 120)
    assert.equal(first.entries.length, 50)
    assert.deepEqual(
      first.entries.slice(0, 3).map(e => e.mediaId),
      ['119', '118', '117'],
      'newest first',
    )
    assert.equal(
      first.bytes,
      Array.from({length: 120}, (_, i) => 100 + i).reduce((a, b) => a + b),
    )
    const last = await reopened.list({offset: 100, limit: 50})
    assert.deepEqual(last.entries.map(e => e.mediaId).at(-1), '0')
    assert.equal(last.entries.length, 20)

    // accents and case ignored; every word must match; the file name counts too
    assert.deepEqual(
      (await reopened.list({search: 'CANCION año'})).entries.map(e => e.mediaId),
      ['7'],
    )
    assert.equal((await reopened.list({search: 'file-11'})).total, 11, 'file-11, file-110…119')
    assert.equal((await reopened.list({search: 'nothing like this'})).total, 0)

    // later writes are followed without re-reading the log
    await reopened.add(record(500, 'Brand new'))
    const fresh = await reopened.list({limit: 1})
    assert.equal(fresh.entries[0]?.mediaId, '500')
    assert.equal(fresh.total, 121)
    // a re-download of the same key moves to the top, once
    await reopened.add(record(3, 'Clip 3 again'))
    const again = await reopened.list({limit: 2})
    assert.deepEqual(
      again.entries.map(e => e.title),
      ['Clip 3 again', 'Brand new'],
    )
    assert.equal(again.total, 121)
    await reopened.remove(record(500, '').key)
    assert.equal((await reopened.list()).total, 120)
    assert.equal((await reopened.list({search: 'brand'})).total, 0)
    await reopened.close()
  })

  it('a record written while the list loads is in it exactly once', async () => {
    const file = path.join(dir, 'archive-race.jsonl')
    const archive = new DownloadArchive(file)
    for (let i = 0; i < 300; i++) await archive.add(record(i, `Clip ${i}`))
    await archive.close()
    const reopened = new DownloadArchive(file)
    const [page] = await Promise.all([reopened.list({limit: 500}), reopened.add(record(999, 'During load'))])
    const after = await reopened.list({limit: 500})
    assert.equal(after.total, 301)
    assert.equal(after.entries.filter(e => e.mediaId === '999').length, 1)
    assert.ok(page.total === 300 || page.total === 301)
    await reopened.close()
  })
})

describe('PendingJournal', () => {
  it('appends O(1) per change, compacts past the slack and never deadlocks', async () => {
    const file = path.join(dir, 'pending.jsonl')
    const live = new Map<string, number>()
    const journal = new PendingJournal<number>(file, () => [...live.entries()])
    for (let i = 0; i < 3000; i++) {
      live.set(`j${i}`, i)
      journal.put(`j${i}`, i)
      if (i >= 10) {
        live.delete(`j${i - 10}`)
        journal.delete(`j${i - 10}`)
      }
    }
    // regression: compaction used to wait on the write chain it was part of
    await Promise.race([
      journal.freeze(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 5000)),
    ])
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').length
    assert.ok(lines < 2100, `journal should have been compacted (${lines} lines)`)
    const replayed = await new PendingJournal<number>(file, () => []).load()
    assert.deepEqual(replayed, [...live.values()])
  })

  it('ignores a torn last line after a crash', async () => {
    const file = path.join(dir, 'torn.jsonl')
    await fs.writeFile(file, '{"op":"put","id":"a","value":1}\n{"op":"put","id":"b","va')
    assert.deepEqual(await new PendingJournal<number>(file, () => []).load(), [1])
  })
})

describe('QueueStore', () => {
  it('coalesces many changes into one write and stops writing once frozen', async () => {
    const file = path.join(dir, 'queue.json')
    let snapshots = 0
    let requests = [{url: 'https://a/1', profile: {kind: 'audio', container: 'm4a'} as const, outDir: '/x'}]
    const store = new QueueStore(
      file,
      () => {
        snapshots++
        return requests
      },
      30,
    )
    for (let i = 0; i < 100; i++) store.touch()
    assert.equal(snapshots, 0, 'debounced: nothing written yet')
    // wait for the write itself rather than a fixed time (a loaded machine fires timers late)
    for (const deadline = Date.now() + 5000; snapshots === 0 && Date.now() < deadline; ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await new Promise(resolve => setTimeout(resolve, 60)) // a second write would have come by now
    assert.equal(snapshots, 1, '100 changes, one write')
    assert.equal((await store.load()).length, 1)

    await store.freeze()
    requests = []
    store.touch()
    await store.flush()
    assert.equal((await store.load()).length, 1, 'frozen store must keep the pre-shutdown queue')
  })
})
