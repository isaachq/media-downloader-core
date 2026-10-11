// Orchestration tests with fake binaries: no network, no ffmpeg needed.
// The fake yt-dlp speaks the same machine-readable protocol as the real one.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {MediaDownloader} from '../src/downloader.js'
import type {JobSnapshot, JobStatus} from '../src/types.js'

const FAKE_YTDLP = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('2099.01.01'); process.exit(0) }
const home = args[args.indexOf('--paths') + 1].slice('home:'.length)
const url = args[args.length - 1]
const id = url.split('/').pop()
const delay = url.includes('slow') ? 400 : 60
if (url.includes('unavailable')) { console.error('ERROR: [youtube] ' + id + ': Video unavailable'); process.exit(1) }
const counter = path.join(home, '..', '..', 'attempts-' + id)
const attempts = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1
fs.writeFileSync(counter, String(attempts))
if (url.includes('flaky') && attempts === 1) { console.error('ERROR: Unable to download webpage: timed out'); process.exit(1) }
console.log('__MDC_INFO__' + JSON.stringify({id, title: 'Title ' + id, duration: 10, extractor: 'Fake', formatId: '140', acodec: 'mp4a.40.2', filesize: 1000}))
let sent = 0
const timer = setInterval(() => {
  sent += 250
  console.log('__MDC_PROGRESS__' + JSON.stringify({status: 'downloading', downloaded: sent, total: 1000, file: 'x.m4a'}))
  if (sent >= 1000) {
    clearInterval(timer)
    const file = path.join(home, 'Title ' + id + ' [' + id + '].m4a')
    fs.writeFileSync(file, 'fake audio ' + id)
    console.log('__MDC_DONE__' + JSON.stringify({filepath: file}))
  }
}, delay / 4)
`

const FAKE_FF = `#!/usr/bin/env node
process.exit(process.argv[2] === '-version' ? 0 : 1)
`

let root = ''
const bins: {ytDlp: string; ffmpeg: string; ffprobe: string} = {ytDlp: '', ffmpeg: '', ffprobe: ''}

async function makeDownloader(sub: string, extra: Partial<ConstructorParameters<typeof MediaDownloader>[0]> = {}) {
  return new MediaDownloader({
    dataDir: path.join(root, sub),
    binaries: bins,
    validation: 'none',
    checksums: true,
    maxRetries: 1,
    progressIntervalMs: 0,
    ...extra,
  })
}

const audio = {kind: 'audio', container: 'm4a'} as const

describe('MediaDownloader orchestration', {skip: process.platform === 'win32' && 'POSIX shebang scripts'}, () => {
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-dl-'))
    for (const [name, body] of [
      ['yt-dlp', FAKE_YTDLP],
      ['ffmpeg', FAKE_FF],
      ['ffprobe', FAKE_FF],
    ] as const) {
      const file = path.join(root, name)
      await fs.writeFile(file, body, {mode: 0o755})
      bins[name === 'yt-dlp' ? 'ytDlp' : name] = file
    }
  })

  after(async () => {
    await fs.rm(root, {recursive: true, force: true})
  })

  it('never runs more than the configured jobs at once and completes all of them', async () => {
    const dl = await makeDownloader('concurrency', {concurrency: 2})
    const active = new Set<string>()
    let peak = 0
    const busy: JobStatus[] = ['downloading', 'processing', 'converting', 'validating', 'finalizing']
    dl.on('job', s => {
      if (busy.includes(s.status)) active.add(s.id)
      else active.delete(s.id)
      peak = Math.max(peak, active.size)
    })
    const outDir = path.join(root, 'out-concurrency')
    for (let i = 0; i < 6; i++)
      dl.add({url: `https://fake/slow${i}`, profile: audio, outDir, mediaId: `slow${i}`, extractor: 'Fake'})
    await dl.whenIdle()
    // 2 requested, but never above ⌊CPUs/2⌋ (a 3-CPU CI runner allows only 1)
    assert.equal(dl.concurrency, Math.min(2, MediaDownloader.maxConcurrency()))
    assert.equal(peak, dl.concurrency)
    const jobs = dl.jobs()
    assert.equal(jobs.filter(j => j.status === 'completed').length, 6)
    assert.equal((await fs.readdir(outDir)).length, 6)
    assert.ok(jobs.every(j => j.validation?.sha256?.length === 64))
  })

  it('clamps concurrency to half the CPUs', async () => {
    const dl = await makeDownloader('clamp', {concurrency: 10_000})
    assert.equal(dl.concurrency, MediaDownloader.maxConcurrency())
    assert.equal(dl.setConcurrency(0), 1)
  })

  it('skips media already in the archive', async () => {
    const dl = await makeDownloader('archive')
    const outDir = path.join(root, 'out-archive')
    const req = {url: 'https://fake/a1', profile: audio, outDir, mediaId: 'a1', extractor: 'Fake'}
    dl.add(req)
    await dl.whenIdle()
    const second = dl.add(req)
    await dl.whenIdle()
    assert.equal(dl.job(second.id)?.status, 'skipped')
    // a different profile is a different file
    const mp3 = dl.add({...req, profile: {kind: 'audio', container: 'mp3'}})
    await dl.whenIdle()
    assert.notEqual(dl.job(mp3.id)?.status, 'skipped')
  })

  it('retries transient errors and gives up immediately on unavailable media', async () => {
    const dl = await makeDownloader('retry')
    const outDir = path.join(root, 'out-retry')
    const flaky = dl.add({url: 'https://fake/flaky1', profile: audio, outDir})
    const gone = dl.add({url: 'https://fake/unavailable1', profile: audio, outDir})
    await dl.whenIdle()
    const f = dl.job(flaky.id)!
    const g = dl.job(gone.id)!
    assert.equal(f.status, 'completed')
    assert.equal(f.attempt, 2)
    assert.equal(g.status, 'failed')
    assert.equal(g.error?.code, 'unavailable')
    assert.equal(g.attempt, 1)
  })

  it('cancels queued and running jobs', async () => {
    const dl = await makeDownloader('cancel', {concurrency: 1})
    const outDir = path.join(root, 'out-cancel')
    const running = dl.add({url: 'https://fake/slowc1', profile: audio, outDir})
    const queued = dl.add({url: 'https://fake/slowc2', profile: audio, outDir})
    await new Promise<void>(resolve => {
      const onJob = (s: JobSnapshot) => {
        if (s.id === running.id && s.status === 'downloading') {
          dl.off('job', onJob)
          resolve()
        }
      }
      dl.on('job', onJob)
    })
    dl.cancel(queued.id)
    dl.cancel(running.id)
    await dl.whenIdle()
    assert.equal(dl.job(running.id)?.status, 'cancelled')
    assert.equal(dl.job(queued.id)?.status, 'cancelled')
    assert.deepEqual(await fs.readdir(outDir).catch(() => []), [])
  })

  it('saves pending jobs on dispose and restores them on the next launch', async () => {
    const dl = await makeDownloader('restore', {concurrency: 1})
    const outDir = path.join(root, 'out-restore')
    dl.pause()
    for (const n of [1, 2, 3]) dl.add({url: `https://fake/r${n}`, profile: audio, outDir, title: `r${n}`})
    await dl.dispose()

    const next = await makeDownloader('restore', {concurrency: 1})
    const restored = await next.restoreQueue()
    assert.deepEqual(
      restored.map(j => j.title),
      ['r1', 'r2', 'r3'],
    )
    await next.whenIdle()
    assert.equal(next.jobs().filter(j => j.status === 'completed').length, 3)
  })

  it('puts playlist items in a numbered sub-folder', async () => {
    const dl = await makeDownloader('playlist')
    const outDir = path.join(root, 'out-playlist')
    const entry = (index: number) => ({
      id: `p${index}`,
      url: `https://fake/p${index}`,
      title: `Song ${index}`,
      extractor: 'Fake',
      isLive: false,
      index,
    })
    dl.addPlaylist(
      {
        kind: 'playlist',
        id: 'PL1',
        url: 'https://fake/list',
        title: 'My: Mix?',
        extractor: 'Fake',
        entries: [1, 2, 3].map(entry),
        choices: [],
      },
      audio,
      outDir,
      {indexes: [1, 3]},
    )
    await dl.whenIdle()
    const files = (await fs.readdir(path.join(outDir, 'My_ Mix_'))).sort()
    assert.deepEqual(files, ['001 - Title p1 [p1].m4a', '003 - Title p3 [p3].m4a'])
  })
})
