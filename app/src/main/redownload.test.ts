import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {positionOf, profileFromKey, redownloadRequest} from './redownload'

describe('profileFromKey', () => {
  it('reads back the video and audio keys the archive writes', () => {
    expect(profileFromKey('video:mp4:best')).toEqual({kind: 'video', container: 'mp4'})
    expect(profileFromKey('video:webm:1080')).toEqual({kind: 'video', container: 'webm', maxHeight: 1080})
    expect(profileFromKey('audio:mp3:0')).toEqual({kind: 'audio', container: 'mp3', quality: '0'})
    expect(profileFromKey('audio:m4a:192K')).toEqual({kind: 'audio', container: 'm4a', quality: '192K'})
  })

  it('refuses keys it does not know', () => {
    for (const key of ['', 'video', 'video:avi:best', 'video:mp4:-1', 'video:mp4:abc', 'audio:mp3:', 'image:png:1']) {
      expect(profileFromKey(key)).toBeUndefined()
    }
  })
})

describe('redownloadRequest', () => {
  const record = (i: number, profile = 'video:mp4:best') => ({
    url: `https://example.com/v/${i}`,
    title: `Clip ${i}`,
    mediaId: String(i),
    extractor: 'Example',
    profile,
    filepath: path.join(path.sep, 'media', `set-${i}`, `Clip ${i}.mp4`),
    duration: 30,
  })

  it('puts each file back into its old folder and format, numbered in order', () => {
    const request = redownloadRequest([record(1), record(2, 'audio:flac:0')], 'Again')!
    expect(request.selection.title).toBe('Again')
    expect(request.selection.entries.map(entry => [entry.index, entry.id, entry.url])).toEqual([
      [1, '1', 'https://example.com/v/1'],
      [2, '2', 'https://example.com/v/2'],
    ])
    expect(request.targets).toEqual([
      {index: 1, outDir: path.join(path.sep, 'media', 'set-1'), profile: {kind: 'video', container: 'mp4'}},
      {
        index: 2,
        outDir: path.join(path.sep, 'media', 'set-2'),
        profile: {kind: 'audio', container: 'flac', quality: '0'},
      },
    ])
    expect(request.url).toBe('https://example.com/v/1')
  })

  it('skips records whose format is unknown; nothing left is no request', () => {
    const request = redownloadRequest([record(1, 'video:avi:best'), record(2)], 'Again')!
    expect(request.targets.map(target => target.index)).toEqual([1])
    expect(request.selection.entries[0]!.id).toBe('2')
    expect(redownloadRequest([record(1, 'nope')], 'Again')).toBeUndefined()
    expect(redownloadRequest([], 'Again')).toBeUndefined()
  })
})

describe('positionOf', () => {
  const at = (file: string, title = 'Title b2', mediaId = 'b2') => ({title, mediaId, filepath: path.join('list', file)})

  it('reads the list position back from either naming style', () => {
    expect(positionOf(at('002-Title-b2-b2.m4a'))).toBe(2)
    expect(positionOf(at('012 - Title b2 [b2].mp4'))).toBe(12)
    expect(positionOf(at('1234 - Title b2 [b2].mp4'))).toBe(1234)
  })

  it('a title that starts with digits is not a position', () => {
    expect(positionOf(at('2024 - recap [x].mp4', '2024 - recap', 'x'))).toBeUndefined()
    expect(positionOf(at('Title b2 [b2].mp4'))).toBeUndefined()
    expect(positionOf(at('002 - Other [b2].mp4'))).toBeUndefined()
    expect(positionOf({mediaId: 'b2', filepath: '002 - Title b2 [b2].mp4', title: undefined})).toBeUndefined()
  })
})
