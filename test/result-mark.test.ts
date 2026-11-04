import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, describe, it} from 'node:test'
import {countSetItems, finishedItemCount, resultMark} from '../src/core/result-mark.js'

describe('result: a set replaces a duration', () => {
  it('a set of 6 with a duration → the count; one video → its duration', () => {
    assert.deepEqual(resultMark({count: 6, duration: 24}), {kind: 'count', count: 6})
    assert.deepEqual(resultMark({count: 5, duration: 24}), {kind: 'count', count: 5})
    assert.deepEqual(resultMark({duration: 24}), {kind: 'duration', seconds: 24})
    assert.deepEqual(resultMark({count: 1, duration: 24}), {kind: 'duration', seconds: 24})
    assert.equal(resultMark({}), undefined)
    assert.equal(resultMark({duration: 0}), undefined)
    assert.deepEqual(resultMark({count: 0, duration: 15}), {kind: 'duration', seconds: 15})
  })

  it('counts media names in one folder and ignores the rest', () => {
    assert.equal(countSetItems(['01.mp4', '02.MP4', '03.mov', 'note.txt', 'cover.jpg']), 4)
    assert.equal(countSetItems(['song.mp3']), 1)
    assert.equal(countSetItems(['readme']), 0)
  })

  const dirs: string[] = []
  after(async () => {
    await Promise.all(dirs.map(dir => fs.rm(dir, {recursive: true, force: true})))
  })

  it('a folder of 6 videos is 6; one file is not a set', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-set-'))
    dirs.push(dir)
    for (const name of ['01.mp4', '02.mp4', '03.mp4', '04.mp4', '05.mp4', '06.mp4', 'note.txt']) {
      await fs.writeFile(path.join(dir, name), '')
    }
    const lone = path.join(dir, '01.mp4')
    assert.equal(await finishedItemCount(dir), 6)
    assert.equal(await finishedItemCount(lone), undefined)
    assert.equal(await finishedItemCount(path.join(dir, 'missing')), undefined)
  })
})
