import {strict as assert} from 'node:assert'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {assertHttpUrl} from '../src/core/analyze.js'
import {archiveKey, DownloadArchive} from '../src/core/archive.js'
import {buildYtDlpArgs, type YtDlpRunOptions} from '../src/core/download.js'
import {DownloadError} from '../src/core/errors.js'
import {isInside, sha256File} from '../src/core/files.js'
import {profileProblem} from '../src/core/formats.js'
import {HashPool} from '../src/core/hash-pool.js'
import {LineSplitter, lastLines, TailBuffer} from '../src/core/process.js'
import {QueueStore} from '../src/core/queue-store.js'

let dir = ''
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-internals-'))
})
after(async () => {
  await fs.rm(dir, {recursive: true, force: true})
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
      ytDlp: 'yt-dlp',
      ffmpeg: '/usr/bin/ffmpeg',
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
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(snapshots, 1)
    assert.equal((await store.load()).length, 1)

    await store.freeze()
    requests = []
    store.touch()
    await store.flush()
    assert.equal((await store.load()).length, 1, 'frozen store must keep the pre-shutdown queue')
  })
})
