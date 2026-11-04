import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, describe, it} from 'node:test'
import {countSetItems, finishedItemCount, finishedState, resultMark} from '../src/core/result-mark.js'
import * as pure from '../src/mark.js'

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

  it('one stat per row: a folder is ok with its count, a file is ok or changed, nothing is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-state-'))
    dirs.push(dir)
    for (const name of ['1.jpg', '2.jpg', '3.mp4', 'meta.json']) await fs.writeFile(path.join(dir, name), 'abc')
    const file = path.join(dir, '3.mp4')
    assert.deepEqual(await finishedState({filepath: dir, sizeBytes: 9}), {file: 'ok', items: 3})
    assert.deepEqual(await finishedState({filepath: file, sizeBytes: 3}), {file: 'ok'})
    assert.deepEqual(await finishedState({filepath: file, sizeBytes: 4}), {file: 'changed'})
    assert.deepEqual(await finishedState({filepath: file}), {file: 'ok'})
    assert.deepEqual(await finishedState({filepath: path.join(dir, 'gone.mp4'), sizeBytes: 3}), {file: 'missing'})
  })

  it('the renderer entry is pure: no import at all, the same rule as the engine', async () => {
    const source = await fs.readFile(new URL('../src/mark.ts', import.meta.url), 'utf8')
    assert.equal(/^\s*(import|export .* from)\s/m.test(source), false)
    assert.equal(pure.resultMark, resultMark)
    assert.equal(pure.countSetItems, countSetItems)
  })
})
