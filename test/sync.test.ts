import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {MediaDownloader} from '../src/downloader.js'
import {BatchScheduler} from '../src/scheduler.js'
import {folderFormat, scanFolder} from '../src/sync/folder.js'
import {SyncManager} from '../src/sync/manager.js'
import {isDue, nextRunAt, type Subscription, syncSchedule} from '../src/sync/subscriptions.js'
import {type FakeTikTok, startFakeTikTok} from './helpers/fake-tiktok.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'

let root = ''
let bins: FakeBinaries
const cleanups: Array<() => Promise<void>> = []

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-sync-'))
  bins = await writeFakes(path.join(root, 'bin'))
})

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  await fs.rm(root, {recursive: true, force: true})
})

const mp4 = {kind: 'video', container: 'mp4'} as const

async function setup(name: string, config: Parameters<typeof startFakeTikTok>[0] = {}) {
  const site = await startFakeTikTok(config)
  const dataDir = path.join(root, name, 'data')
  const engine = new MediaDownloader({
    dataDir,
    binaries: bins,
    validation: 'none',
    maxRetries: 1,
    retryDelayMaxMs: 20,
    progressIntervalMs: 0,
    tiktok: {origin: site.origin, pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 50}},
  })
  const scheduler = new BatchScheduler(engine, {progressIntervalMs: 0})
  const sync = new SyncManager(engine, scheduler)
  cleanups.push(async () => {
    sync.dispose()
    await scheduler.dispose()
    await engine.dispose()
    await site.close()
  })
  const folder = path.join(root, name, 'TikTok-account')
  return {site, engine, scheduler, sync, dataDir, folder}
}

/** A folder already holding the oldest `count` posts, named as the app names them. */
async function holding(site: FakeTikTok, folder: string, count: number): Promise<void> {
  await fs.mkdir(folder, {recursive: true})
  const oldest = site.ids.slice(-count)
  await Promise.all(
    oldest.map((id, i) => fs.writeFile(path.join(folder, `${String(i + 1).padStart(3, '0')}-Post-${id}.mp4`), 'x')),
  )
}

describe('sync: what a folder holds', () => {
  it('finds post ids in names of both naming styles, and in tags of renamed files', async () => {
    const folder = path.join(root, 'scan')
    await fs.mkdir(folder, {recursive: true})
    await fs.writeFile(path.join(folder, '001-Fragmento-7691525652956073237.mp4'), 'x')
    await fs.writeFile(path.join(folder, 'Mi video [7400000000000000099].mp4'), 'x')
    await fs.writeFile(path.join(folder, 'renamed by hand.mp4'), 'x')
    await fs.writeFile(path.join(folder, 'notes.txt'), 'no media')
    await fs.writeFile(path.join(folder, '.hidden-7400000000000000098.mp4'), 'x')
    const scan = await scanFolder(folder)
    assert.deepEqual([...scan.ids.keys()].sort(), ['7400000000000000099', '7691525652956073237'])
    assert.equal(scan.byName, 2)
    assert.deepEqual(
      scan.unknown.map(file => path.basename(file)),
      ['renamed by hand.mp4'],
    )
    assert.equal((await scanFolder(path.join(root, 'no-such-folder'))).ids.size, 0, 'a missing folder holds nothing')

    // a renamed file: its post link in the tags still tells which post it is
    await fs.writeFile(
      path.join(folder, 'renamed by hand.mp4'),
      'comment:https://www.tiktok.com/@u/video/7400000000000000097',
    )
    const deep = await scanFolder(folder, {ffprobe: bins.ffprobe})
    assert.equal(deep.byTags, 1)
    assert.equal(deep.ids.get('7400000000000000097'), path.join(folder, 'renamed by hand.mp4'))
    assert.deepEqual(deep.unknown, [])
  })
})

describe('sync: schedules', () => {
  const sub = (schedule: Subscription['schedule'], runs: Subscription['runs'] = []): Subscription => ({
    id: 's',
    site: 'tiktok',
    user: 'u',
    url: 'https://www.tiktok.com/@u',
    folder: '/f',
    profile: mp4,
    schedule,
    createdAt: new Date(2026, 9, 11, 10, 0).getTime(),
    runs,
  })
  const run = (at: Date) => ({
    id: 'r',
    trigger: 'manual' as const,
    deep: false,
    status: 'done' as const,
    startedAt: at.getTime(),
    listed: 0,
    inFolder: 0,
    new: 0,
    downloaded: 0,
    failed: 0,
  })

  it('daily at HH:MM: the next one after the last start; a manual sync counts', () => {
    // created at 10:00, daily at 08:00 → tomorrow 08:00
    assert.equal(nextRunAt(sub({every: 'day', at: '08:00'})), new Date(2026, 9, 12, 8, 0).getTime())
    // created at 10:00, daily at 21:30 → today 21:30
    assert.equal(nextRunAt(sub({every: 'day', at: '21:30'})), new Date(2026, 9, 11, 21, 30).getTime())
    // synced by hand at 09:00 on the 12th → the 08:00 of that day is past: the 13th
    const later = sub({every: 'day', at: '08:00'}, [run(new Date(2026, 9, 12, 9, 0))])
    assert.equal(nextRunAt(later), new Date(2026, 9, 13, 8, 0).getTime())
    assert.equal(isDue(later, new Date(2026, 9, 13, 8, 1).getTime()), true)
    assert.equal(isDue(later, new Date(2026, 9, 13, 7, 59).getTime()), false)
  })

  it('every N hours: N hours after the last start, at once when never run; manual never', () => {
    const now = new Date(2026, 9, 11, 12, 0).getTime()
    assert.equal(nextRunAt(sub({every: 'hours', hours: 6}), now), now)
    assert.equal(
      nextRunAt(sub({every: 'hours', hours: 6}, [run(new Date(2026, 9, 11, 9, 0))])),
      new Date(2026, 9, 11, 15, 0).getTime(),
    )
    assert.equal(nextRunAt(sub({every: 'manual'})), undefined)
    assert.equal(isDue(sub({every: 'manual'})), false)
  })

  it('accepts only valid schedules', () => {
    assert.deepEqual(syncSchedule({every: 'day', at: '07:05'}), {every: 'day', at: '07:05'})
    assert.equal(syncSchedule({every: 'day', at: '24:00'}), undefined)
    assert.equal(syncSchedule({every: 'hours', hours: 0}), undefined)
    assert.equal(syncSchedule({every: 'hours', hours: 200}), undefined)
    assert.equal(syncSchedule({every: 'weekly'}), undefined)
  })
})

describe('sync: a TikTok account into a folder (local fake)', () => {
  it('lists only what is newer than the folder, downloads it flat into the folder, and records the run', async () => {
    const {site, sync, folder, engine} = await setup('incremental', {posts: 60})
    await holding(site, folder, 45)
    const sub = await sync.add({
      url: `${site.origin.replace(/^http:\/\/[^/]+/, 'https://www.tiktok.com')}/@${site.user}`,
      folder,
      profile: mp4,
    })
    assert.equal(sub.schedule.every, 'manual')

    // the first sync is a full check: a folder can have gaps anywhere, not only at the top
    const first = await sync.check(sub.id)
    assert.equal(first.inFolder, 45)
    assert.equal(first.listed, 60)
    assert.deepEqual(
      first.entries.map(entry => entry.id),
      site.ids.slice(0, 15),
      'the 15 newest posts',
    )
    assert.equal(first.caughtUp, false)

    const run = await sync.run(sub.id)
    assert.equal(run.new, 15)
    assert.equal(run.deep, true)
    assert.ok(run.batchId)
    const done = await sync.whenDone(sub.id, run.id)
    assert.equal(done?.status, 'done')
    assert.equal(done?.downloaded, 15)
    const files = await fs.readdir(folder)
    assert.equal(files.length, 60)
    const added = files.filter(name => !/^\d{3}-Post-/.test(name))
    assert.equal(added.length, 15)
    assert.ok(
      added.every(name => !/^\d{3}-/.test(name)),
      'no position prefix in an existing folder',
    )
    assert.ok(
      added.every(name => site.ids.some(id => name.includes(id))),
      'each name ends with its post id',
    )

    const history = await engine.archive.list({batchId: run.batchId})
    assert.equal(history.total, 15)
    assert.ok(history.entries.every(entry => entry.batchTitle === `Sync @${site.user}`))

    // later syncs list only what is newer than the folder
    const newest = site.ids.slice(0, 2)
    for (const name of added) if (newest.some(id => name.includes(id))) await fs.rm(path.join(folder, name))
    const before = site.hits.list
    const plan = await sync.check(sub.id)
    assert.deepEqual(
      plan.entries.map(entry => entry.id),
      newest,
    )
    assert.equal(plan.caughtUp, true)
    assert.ok(plan.listed < 60, `incremental: ${plan.listed} of 60 listed`)
    assert.ok(site.hits.list - before <= 3, `${site.hits.list - before} listing pages`)
    const refill = await sync.run(sub.id)
    assert.equal(refill.deep, false)
    assert.equal((await sync.whenDone(sub.id, refill.id))?.downloaded, 2)

    // nothing new: nothing scheduled, the run says so
    const again = await sync.run(sub.id)
    assert.equal(again.new, 0)
    assert.equal(again.status, 'done')
    assert.equal(again.batchId, undefined)
    const [latest] = (await sync.get(sub.id))!.runs
    assert.equal(latest?.id, again.id)
    assert.equal((await sync.get(sub.id))!.runs.length, 3)
  })

  it('an empty folder lists the whole profile; a full check tells what TikTok no longer has', async () => {
    const {site, sync, folder} = await setup('deep', {posts: 20})
    await fs.mkdir(folder, {recursive: true})
    await fs.writeFile(path.join(folder, 'Gone-7399999999999999999.mp4'), 'x') // a post TikTok doesn't list
    const sub = await sync.add({url: `https://www.tiktok.com/@${site.user}`, folder})
    const plan = await sync.check(sub.id, {deep: true})
    assert.equal(plan.entries.length, 20)
    assert.deepEqual(
      plan.gone.map(file => path.basename(file)),
      ['Gone-7399999999999999999.mp4'],
    )
    assert.equal(plan.caughtUp, false)
  })

  it('one format per folder: a folder with files decides it, and a sync never mixes formats', async () => {
    const {site, sync, folder} = await setup('formats', {posts: 4})
    const url = `https://www.tiktok.com/@${site.user}`
    await holding(site, folder, 2) // two MP4 files
    assert.deepEqual(await folderFormat(folder), {files: 2, formats: ['mp4']})
    await assert.rejects(sync.add({url, folder, profile: {kind: 'audio', container: 'mp3'}}), /holds MP4 files/)
    const sub = await sync.add({url, folder})
    assert.deepEqual(sub.profile, {kind: 'video', container: 'mp4'}, 'taken from the folder')
    assert.equal(sub.slideshow?.mode, 'video', 'photo posts become videos in a video folder')

    // an empty folder takes the format asked for
    const audio = await sync.add({
      url,
      folder: path.join(folder, '..', 'audio'),
      profile: {kind: 'audio', container: 'mp3'},
    })
    assert.equal(audio.profile.container, 'mp3')

    // a folder mixing formats can't be synced; a file in another format stops a run before it downloads
    const mixed = path.join(folder, '..', 'mixed')
    await fs.mkdir(mixed)
    await fs.writeFile(path.join(mixed, 'a-7400000000000000001.mp4'), 'x')
    await fs.writeFile(path.join(mixed, 'b-7400000000000000002.mp3'), 'x')
    await assert.rejects(sync.add({url, folder: mixed}), /mixes MP4, MP3/)
    await fs.writeFile(path.join(folder, 'added-by-hand.mp3'), 'x')
    await assert.rejects(sync.run(sub.id), /mixes MP4, MP3/)
    assert.equal((await sync.get(sub.id))!.runs[0]?.status, 'failed')
    assert.equal((await fs.readdir(folder)).length, 3, 'nothing downloaded')
    // moving it is checked the same way
    await assert.rejects(sync.update(audio.id, {folder}), /mixes/)
  })

  it("keeps one sync per account at a time, takes over a crashed one's lock, and validates what it is given", async () => {
    const {site, sync, dataDir, folder} = await setup('locks', {posts: 5})
    await assert.rejects(sync.add({url: 'https://www.youtube.com/@someone', folder}), /TikTok profile/)
    await assert.rejects(sync.add({url: `https://www.tiktok.com/@${site.user}`, folder: 'relative/folder'}), /absolute/)
    const sub = await sync.add({
      url: `https://www.tiktok.com/@${site.user}`,
      folder,
      schedule: {every: 'day', at: '08:00'},
    })
    await assert.rejects(sync.add({url: `https://www.tiktok.com/@${site.user}`, folder}), /already synced/)

    // a lock left by a process that is gone is taken over
    await fs.writeFile(path.join(dataDir, `sync-${sub.id}.lock`), JSON.stringify({pid: 999_999_999, at: Date.now()}))
    const run = await sync.run(sub.id)
    assert.equal(run.status, 'running')
    // while its downloads run, the account doesn't sync again
    await assert.rejects(sync.run(sub.id), /already syncing/)
    assert.equal((await sync.whenDone(sub.id, run.id))?.status, 'done')
    await assert.rejects(fs.access(path.join(dataDir, `sync-${sub.id}.lock`)), 'the lock is released at the end')
  })

  it('a run left "running" by a process that is gone reads as interrupted', async () => {
    const {site, sync, dataDir, folder} = await setup('interrupted', {posts: 3})
    const sub = await sync.add({url: `https://www.tiktok.com/@${site.user}`, folder})
    const file = path.join(dataDir, 'subscriptions.json')
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    saved.subscriptions[0].runs = [
      {
        id: 'r1',
        trigger: 'schedule',
        deep: false,
        status: 'running',
        startedAt: 1,
        listed: 0,
        inFolder: 0,
        new: 3,
        downloaded: 0,
        failed: 0,
      },
    ]
    await fs.writeFile(file, JSON.stringify(saved))
    const [view] = await sync.list()
    assert.equal(view?.id, sub.id)
    assert.equal(view?.runs[0]?.status, 'interrupted')
  })

  it('runs the subscriptions that are due, and only those', async () => {
    const {site, sync, folder} = await setup('due', {posts: 4})
    const manual = await sync.add({url: `https://www.tiktok.com/@${site.user}`, folder: path.join(folder, 'a')})
    const hourly = await sync.add({
      url: `https://www.tiktok.com/@${site.user}`,
      folder: path.join(folder, 'b'),
      schedule: {every: 'hours', hours: 6},
    })
    const runs = await sync.runDue('schedule')
    assert.equal(runs.length, 1)
    await sync.whenDone(hourly.id, runs[0]!.id)
    assert.equal((await sync.get(manual.id))?.runs.length, 0)
    assert.equal((await sync.get(hourly.id))?.runs[0]?.trigger, 'schedule')
    assert.equal((await fs.readdir(path.join(folder, 'b'))).length, 4)
    assert.equal((await sync.runDue('schedule')).length, 0, 'not due again for 6 hours')
  })
})
