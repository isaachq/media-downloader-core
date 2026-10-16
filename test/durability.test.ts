// Durability of the JSON-lines stores (history archive, pending journal) and the JSON state files
// (pending queue, damaged list): what a crash, a full disk or a power cut leaves behind, records
// of older and newer versions, and that nothing the user had is silently dropped.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {DownloadArchive, parseArchiveLine} from '../src/core/archive.js'
import {DamagedRegistry} from '../src/core/damaged.js'
import {endsMidLine, removeLeftovers, writeAtomic} from '../src/core/files.js'
import {PendingJournal, parseJournalLine, QueueStore} from '../src/core/queue-store.js'

let dir = ''
let seq = 0
/** A fresh folder per test: nothing leaks between cases. */
const fresh = async () => fs.mkdtemp(path.join(dir, `case-${++seq}-`))

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-durability-'))
})
after(async () => {
  await fs.rm(dir, {recursive: true, force: true})
})

const record = (i: number, extra: Record<string, unknown> = {}) => ({
  key: `fake:${i}:video:mp4:best`,
  extractor: 'Fake',
  mediaId: String(i),
  profile: 'video:mp4:best',
  url: `https://fake.test/${i}`,
  filepath: `/media/clip-${i}.mp4`,
  sizeBytes: 100 + i,
  title: `Clip ${i}`,
  ...extra,
})
const put = (entry: object) => `${JSON.stringify({op: 'put', entry})}\n`
const lines = async (file: string) => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
const keys = async (archive: DownloadArchive) => (await archive.list({limit: 500})).entries.map(entry => entry.key)

describe('archive: interrupted writes', () => {
  it('a record written after a torn line is kept (it used to be glued to the torn one and lost)', async () => {
    const file = path.join(await fresh(), 'archive.jsonl')
    await fs.writeFile(file, `${put({...record(1), completedAt: 1})}{"op":"put","entry":{"key":"fake:2`)
    const archive = new DownloadArchive(file)
    await archive.add(record(3))
    await archive.close()

    const reopened = new DownloadArchive(file)
    assert.deepEqual((await keys(reopened)).sort(), ['fake:1:video:mp4:best', 'fake:3:video:mp4:best'])
    await reopened.close()
    // the torn bytes stay on their own line: nothing valid shares it
    const text = await fs.readFile(file, 'utf8')
    assert.ok(text.includes('"key":"fake:2\n{"op":"put"'))
  })

  it('a log cut by a power cut (NUL bytes at the end) still takes new records', async () => {
    const file = path.join(await fresh(), 'archive.jsonl')
    await fs.writeFile(file, `${put({...record(1), completedAt: 1})}\0\0\0\0`)
    const archive = new DownloadArchive(file)
    await archive.add(record(2))
    await archive.close()
    const reopened = new DownloadArchive(file)
    assert.deepEqual((await keys(reopened)).sort(), ['fake:1:video:mp4:best', 'fake:2:video:mp4:best'])
    await reopened.close()
  })

  it('a compaction cut short leaves the log whole, and its leftover is cleaned once stale', async () => {
    const folder = await fresh()
    const file = path.join(folder, 'archive.jsonl')
    await fs.writeFile(file, put({...record(1), completedAt: 1}) + put({...record(2), completedAt: 2}))
    const stale = `${file}.4242.compact`
    const recent = `${file}.4343.compact`
    await fs.writeFile(stale, put({...record(1), completedAt: 1})) // half a compaction, never renamed
    await fs.writeFile(recent, '')
    const old = new Date(Date.now() - 60 * 60_000)
    await fs.utimes(stale, old, old)

    const archive = new DownloadArchive(file)
    assert.equal((await keys(archive)).length, 2)
    await archive.close()
    await assert.rejects(fs.access(stale), 'a stale leftover is removed')
    await fs.access(recent) // a young one may be another process's compaction in progress
  })
})

describe('archive: records of other shapes and versions', () => {
  it('lines that are not records never stop the archive from opening', async () => {
    const file = path.join(await fresh(), 'archive.jsonl')
    const junk = [
      'null',
      '[]',
      '42',
      '"text"',
      '{}',
      '{"op":"put"}',
      '{"op":"put","entry":null}',
      '{"op":"put","entry":{"key":7,"filepath":"/x"}}',
      '{"op":"put","entry":{"key":"k"}}',
      '{"op":"del"}',
      '{"op":"patch","key":"fake:1:video:mp4:best"}',
      'not json at all',
      '   ',
    ]
    await fs.writeFile(file, `${junk.join('\n')}\n${put({...record(1), completedAt: 1})}`)
    const archive = new DownloadArchive(file)
    assert.deepEqual(await keys(archive), ['fake:1:video:mp4:best'])
    assert.equal((await archive.entries()).length, 1)
    await archive.close()
  })

  it('records of older versions load: fields added since are optional, a missing size or time is 0', async () => {
    const file = path.join(await fresh(), 'archive.jsonl')
    const oldest = {key: 'old:1:audio:m4a:0', extractor: 'Old', mediaId: '1', profile: 'audio:m4a:0', url: 'u', filepath: '/a.m4a'}
    const older = {...record(2), completedAt: 2000} // no validation / batch / damaged / sha256
    const current = {...record(3), completedAt: 3000, validation: 'full', batchId: 'B', batchTitle: 'Trip', sha256: 'ab'}
    await fs.writeFile(file, put(oldest) + put(older) + put(current))
    const archive = new DownloadArchive(file)
    const page = await archive.list({limit: 10})
    assert.deepEqual(
      page.entries.map(entry => entry.key),
      ['fake:3:video:mp4:best', 'fake:2:video:mp4:best', 'old:1:audio:m4a:0'],
    )
    const restored = page.entries.at(-1)!
    assert.equal(restored.sizeBytes, 0)
    assert.equal(restored.completedAt, 0)
    assert.equal(page.bytes, 102 + 103)
    assert.deepEqual(
      (await archive.groups()).map(group => group.batchId),
      ['B'],
    )
    await archive.close()
  })

  it('fields of a newer version survive an update and a compaction', async () => {
    const file = path.join(await fresh(), 'archive.jsonl')
    const future = {...record(1), completedAt: 1, origin: {app: '9.0', device: 'phone'}}
    // 1,100 superseded records of another key: past the slack, the next open compacts
    let text = put(future)
    for (let i = 0; i < 1100; i++) text += put({...record(2), completedAt: 2 + i})
    await fs.writeFile(file, text)

    const archive = new DownloadArchive(file)
    await archive.open()
    assert.equal((await lines(file)).length, 2, 'compacted on open')
    await archive.update('fake:1:video:mp4:best', {validation: 'full'})
    await archive.close()
    const raw = (await lines(file)).map(line => JSON.parse(line) as {entry: {origin?: unknown; validation?: string}})
    assert.ok(raw.every(line => line.entry.origin === undefined || (line.entry.origin as {app: string}).app === '9.0'))
    assert.equal(raw.at(-1)!.entry.validation, 'full')
    assert.deepEqual(raw.at(-1)!.entry.origin, {app: '9.0', device: 'phone'})
  })

  it('a compaction keeps the lines it can not read (in .rejected) instead of dropping them', async () => {
    const file = path.join(await fresh(), 'archive.jsonl')
    let text = `{"op":"patch","key":"from-a-newer-version"}\n${put({...record(1), completedAt: 1})}{"op":"put","entry":{"key":"to\n`
    for (let i = 0; i < 1100; i++) text += put({...record(2), completedAt: 2 + i})
    await fs.writeFile(file, text)
    const archive = new DownloadArchive(file)
    await archive.open()
    assert.equal(archive.size, 2)
    await archive.close()
    assert.deepEqual(await lines(archive.rejectedFile), [
      '{"op":"patch","key":"from-a-newer-version"}',
      '{"op":"put","entry":{"key":"to',
    ])
    assert.equal((await lines(file)).length, 2)
  })

  it('parseArchiveLine reuses a complete record as is', () => {
    const raw = put({...record(1), completedAt: 5}).trim()
    const parsed = parseArchiveLine(raw)
    assert.equal(parsed?.op, 'put')
    assert.equal(parseArchiveLine('{"op":"del","key":"a"}')?.op, 'del')
    assert.equal(parseArchiveLine('{"op":"del","key":1}'), undefined)
  })
})

describe('archive: removing many', () => {
  it('forgets them in one write, ignoring repeats and unknown keys, and the removal persists', async () => {
    const file = path.join(await fresh(), 'archive.jsonl')
    const archive = new DownloadArchive(file)
    for (let i = 0; i < 5; i++) await archive.add(record(i))
    const before = (await lines(file)).length
    const removed = await archive.removeMany([
      'fake:1:video:mp4:best',
      'fake:3:video:mp4:best',
      'fake:3:video:mp4:best',
      'nope',
    ])
    assert.equal(removed, 2)
    assert.equal((await lines(file)).length, before + 2)
    assert.equal(await archive.removeMany([]), 0)
    await archive.close()
    const reopened = new DownloadArchive(file)
    assert.deepEqual((await keys(reopened)).sort(), [0, 2, 4].map(i => `fake:${i}:video:mp4:best`))
    await reopened.close()
  })
})

describe('pending journal: interrupted writes and other shapes', () => {
  it('an item queued after a torn line is restored', async () => {
    const file = path.join(await fresh(), 'pending.jsonl')
    await fs.writeFile(file, '{"op":"put","id":"a","value":1}\n{"op":"put","id":"b","va')
    const live = new Map([['a', 1]])
    const journal = new PendingJournal<number>(file, () => [...live])
    live.set('c', 3)
    journal.put('c', 3)
    await journal.freeze()
    assert.deepEqual(await new PendingJournal<number>(file, () => []).load(), [1, 3])
  })

  it('lines of another shape are ignored, and a stale compaction leftover removed', async () => {
    const file = path.join(await fresh(), 'pending.jsonl')
    await fs.writeFile(
      file,
      [
        'null',
        '{"op":"put","value":1}',
        '{"op":"put","id":"x"}',
        '{"op":"put","id":"y","value":null}',
        '{"op":"del"}',
        '{"op":"put","id":"a","value":{"url":"u"}}',
        '{"op":"move","id":"a"}',
      ].join('\n'),
    )
    const stale = `${file}.99.1.compact`
    await fs.writeFile(stale, '')
    const old = new Date(Date.now() - 60 * 60_000)
    await fs.utimes(stale, old, old)
    assert.deepEqual(await new PendingJournal<{url: string}>(file, () => []).load(), [{url: 'u'}])
    await assert.rejects(fs.access(stale))
    assert.equal(parseJournalLine('{"op":"del","id":"a"}')?.op, 'del')
  })
})

describe('state files: an unreadable one is kept aside, never overwritten', () => {
  const corrupt = async (folder: string) => (await fs.readdir(folder)).filter(name => name.includes('.corrupt-'))

  for (const [name, text] of [
    ['empty (a power cut)', ''],
    ['cut short', '{"version":1,"requests":[{"url":"https://a'],
    ['another shape', 'null'],
  ] as const) {
    it(`pending queue: ${name}`, async () => {
      const folder = await fresh()
      const file = path.join(folder, 'queue.json')
      await fs.writeFile(file, text)
      const store = new QueueStore<{url: string}>(file, () => [{url: 'https://new'}])
      assert.deepEqual(await store.load(), [])
      const aside = await corrupt(folder)
      assert.equal(aside.length, 1)
      assert.equal(await fs.readFile(path.join(folder, aside[0]!), 'utf8'), text)
      await store.flush()
      assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).requests, [{url: 'https://new'}])
    })
  }

  it('pending queue: a missing file is a first launch, nothing moved', async () => {
    const folder = await fresh()
    const store = new QueueStore(path.join(folder, 'queue.json'), () => [])
    assert.deepEqual(await store.load(), [])
    assert.deepEqual(await corrupt(folder), [])
  })

  it('damaged list: kept aside, and the list goes on working', async () => {
    const folder = await fresh()
    const file = path.join(folder, 'damaged.json')
    await fs.writeFile(file, '[{"key":"a","url":"https://a"')
    const registry = new DamagedRegistry(file)
    assert.deepEqual(await registry.list(), [])
    await registry.add({url: 'https://b', extractor: 'Fake', mediaId: 'b', reason: 'broken', issues: []})
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).length, 1)
    const aside = await corrupt(folder)
    assert.equal(aside.length, 1)
    assert.equal(await fs.readFile(path.join(folder, aside[0]!), 'utf8'), '[{"key":"a","url":"https://a"')
  })
})

describe('file helpers', () => {
  it('writeAtomic: many writes to one file at once all land whole, with no temp file left', async () => {
    const folder = await fresh()
    const file = path.join(folder, 'state.json')
    const bodies = Array.from({length: 20}, (_, i) => JSON.stringify({i, pad: 'x'.repeat(10_000)}))
    await Promise.all(bodies.map(body => writeAtomic(file, body)))
    assert.ok(bodies.includes(await fs.readFile(file, 'utf8')))
    assert.deepEqual(await fs.readdir(folder), ['state.json'])
  })

  it('endsMidLine reads only the last byte', async () => {
    const folder = await fresh()
    const file = path.join(folder, 'log.jsonl')
    assert.equal(await endsMidLine(file), false) // no file
    await fs.writeFile(file, '')
    assert.equal(await endsMidLine(file), false)
    await fs.writeFile(file, '{"a":1}\n')
    assert.equal(await endsMidLine(file), false)
    await fs.appendFile(file, '{"a":')
    assert.equal(await endsMidLine(file), true)
  })

  it('removeLeftovers removes only stale temp files of that file', async () => {
    const folder = await fresh()
    const file = path.join(folder, 'archive.jsonl')
    const old = new Date(Date.now() - 60 * 60_000)
    for (const name of ['archive.jsonl.1.compact', 'archive.jsonl.rejected', 'other.jsonl.1.compact']) {
      await fs.writeFile(path.join(folder, name), '')
      await fs.utimes(path.join(folder, name), old, old)
    }
    await removeLeftovers(file, '.compact')
    assert.deepEqual((await fs.readdir(folder)).sort(), ['archive.jsonl.rejected', 'other.jsonl.1.compact'])
  })
})
