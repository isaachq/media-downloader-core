import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, it} from 'node:test'
import {compareVersions} from '../src/binaries/manager.js'
import {parseChecksums, ytDlpBuildFor} from '../src/binaries/sources.js'
import {archiveKey, DownloadArchive} from '../src/core/archive.js'
import {ProgressTracker} from '../src/core/download.js'
import {classifyYtDlpError, isRetryable} from '../src/core/errors.js'
import {sanitizeFilename, uniquePath} from '../src/core/files.js'
import {
  catalogFormats,
  normalizeCodec,
  planChoices,
  profileArgs,
  type RawFormat,
  videoSelector,
} from '../src/core/formats.js'
import {clampConcurrency, maxConcurrency, TaskPool} from '../src/core/pool.js'

describe('concurrency limit = ⌊CPUs/2⌋', () => {
  it('halves the logical processors, never below 1', () => {
    assert.equal(maxConcurrency(1), 1)
    assert.equal(maxConcurrency(2), 1)
    assert.equal(maxConcurrency(8), 4)
    assert.equal(maxConcurrency(12), 6)
    assert.equal(maxConcurrency(13), 6)
  })

  it('clamps requested values into [1, max]', () => {
    assert.equal(clampConcurrency(undefined, 12), 6)
    assert.equal(clampConcurrency(64, 12), 6)
    assert.equal(clampConcurrency(0, 12), 1)
    assert.equal(clampConcurrency(3, 12), 3)
  })
})

describe('TaskPool', () => {
  it('never runs more than the limit at once and runs everything', async () => {
    const pool = new TaskPool(3)
    let running = 0
    let peak = 0
    let done = 0
    for (let i = 0; i < 20; i++) {
      pool.add(String(i), async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise(r => setTimeout(r, 5 + (i % 4)))
        running--
        done++
      })
    }
    await pool.whenIdle()
    assert.equal(peak, 3)
    assert.equal(done, 20)
  })

  it('pause stops new tasks, resume continues, remove drops queued ones', async () => {
    const pool = new TaskPool(1)
    const order: string[] = []
    pool.pause()
    for (const id of ['a', 'b', 'c']) pool.add(id, async () => void order.push(id))
    assert.equal(pool.pending, 3)
    assert.equal(pool.remove('b'), true)
    pool.prioritize('c')
    pool.resume()
    await pool.whenIdle()
    assert.deepEqual(order, ['c', 'a'])
  })

  it('a throwing task does not break the pool', async () => {
    const pool = new TaskPool(2)
    let ok = false
    pool.add('bad', async () => {
      throw new Error('boom')
    })
    pool.add('good', async () => {
      ok = true
    })
    await pool.whenIdle()
    assert.equal(ok, true)
  })
})

describe('format profiles', () => {
  it('mp4 asks for H.264 + AAC first and caps the height', () => {
    const sel = videoSelector({kind: 'video', container: 'mp4', maxHeight: 720})
    assert.match(sel.split('/')[0]!, /^bv\*\[vcodec\^=avc1\]\[height<=720\]\+ba\[acodec\^=mp4a\]$/)
    const args = profileArgs({kind: 'video', container: 'mp4', maxHeight: 720})
    assert.deepEqual(args.slice(-2), ['--merge-output-format', 'mp4/mkv'])
  })

  it('audio profiles extract with the right codec', () => {
    assert.deepEqual(profileArgs({kind: 'audio', container: 'm4a'}), [
      '--format',
      'ba[acodec^=mp4a]/ba/b',
      '--extract-audio',
      '--audio-format',
      'm4a',
      '--audio-quality',
      '0',
    ])
  })

  it('normalizes yt-dlp codec strings to ffprobe names', () => {
    assert.equal(normalizeCodec('avc1.640028'), 'h264')
    assert.equal(normalizeCodec('vp09.00.40.08'), 'vp9')
    assert.equal(normalizeCodec('av01.0.08M.08'), 'av1')
    assert.equal(normalizeCodec('mp4a.40.2'), 'aac')
    assert.equal(normalizeCodec('opus'), 'opus')
    assert.equal(normalizeCodec('none'), undefined)
  })

  // typical YouTube set: H.264 only up to 1080p, VP9/AV1 above
  const youtube: RawFormat[] = [
    {format_id: 'sb0', ext: 'mhtml', vcodec: 'none', acodec: 'none'},
    {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, filesize: 3_000_000},
    {format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 135, filesize: 3_100_000},
    {
      format_id: '137',
      ext: 'mp4',
      vcodec: 'avc1.640028',
      acodec: 'none',
      height: 1080,
      tbr: 4000,
      filesize: 60_000_000,
    },
    {format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, tbr: 2500, filesize: 40_000_000},
    {format_id: '313', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 2160, tbr: 18000, filesize: 300_000_000},
  ]

  it('flags 4K MP4 as requiring conversion, 1080p MP4 as native', () => {
    const choices = planChoices(youtube)
    const mp4 = choices.filter(c => c.profile.kind === 'video' && c.profile.container === 'mp4')
    const find = (height: number) => mp4.find(c => c.profile.kind === 'video' && c.profile.maxHeight === height)!
    assert.equal(find(2160).requiresConversion, true)
    assert.equal(find(1080).requiresConversion, false)
    assert.equal(find(1080).estimatedBytes, 63_000_000) // H.264 video + AAC audio
    const webm4k = choices.find(
      c => c.profile.kind === 'video' && c.profile.container === 'webm' && c.profile.maxHeight === 2160,
    )!
    assert.equal(webm4k.requiresConversion, false)
  })

  it('indexes formats once: best stream per height and codec', () => {
    const catalog = catalogFormats(youtube)
    assert.deepEqual(
      [...catalog.video.keys()].sort((a, b) => a - b),
      [1080, 2160],
    )
    assert.deepEqual([...catalog.video.get(1080)!.keys()].sort(), ['h264', 'vp9'])
    assert.equal(catalog.audio.get('aac')?.format_id, '140')
    assert.equal(catalog.hasAudio, true)
  })

  it('uses the audio of a muxed stream instead of pairing another one', () => {
    const muxed: RawFormat[] = [
      {
        format_id: '18',
        ext: 'mp4',
        vcodec: 'avc1.42001E',
        acodec: 'mp4a.40.2',
        height: 360,
        tbr: 500,
        filesize: 5_000_000,
      },
    ]
    const [mp4] = planChoices(muxed)
    assert.equal(mp4?.requiresConversion, false)
    assert.equal(mp4?.estimatedBytes, 5_000_000)
  })

  it('offers only audio for audio-only sources, and defaults when there is no metadata', () => {
    const podcast = planChoices([{format_id: 'mp3', ext: 'mp3', vcodec: 'none', acodec: 'mp3', abr: 128}])
    assert.ok(podcast.every(c => c.profile.kind === 'audio'))
    assert.equal(
      podcast.find(c => c.profile.kind === 'audio' && c.profile.container === 'm4a')?.requiresConversion,
      true,
    )
    const unknown = planChoices([])
    assert.equal(unknown[0]?.profile.kind, 'video')
  })

  it('offers every audio container', () => {
    const audio = planChoices(youtube).filter(c => c.profile.kind === 'audio')
    assert.deepEqual(
      audio.map(c => c.profile.kind === 'audio' && c.profile.container),
      ['m4a', 'mp3', 'opus', 'flac', 'wav'],
    )
    assert.ok(audio.every(c => !c.requiresConversion))
  })
})

describe('error classification', () => {
  const cases: Array<[string, string]> = [
    ["ERROR: [youtube] abc123def45: Private video. Sign in if you've been granted access", 'unavailable'],
    ['ERROR: [youtube] abc123def45: Video unavailable', 'unavailable'],
    ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'expired'],
    [
      'ERROR: [youtube] x: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>',
      'network',
    ],
    ['ERROR: unable to download video data: HTTP Error 503: Service Unavailable', 'network'],
    ['ERROR: [Errno 28] No space left on device', 'disk-full'],
    ['ERROR: something new and strange', 'unknown'],
  ]
  for (const [stderr, code] of cases) {
    it(`${code}: ${stderr.slice(7, 60)}`, () => {
      assert.equal(classifyYtDlpError(stderr, 1).code, code)
    })
  }

  it('only transient errors are retryable', () => {
    assert.equal(isRetryable('network'), true)
    assert.equal(isRetryable('expired'), true)
    assert.equal(isRetryable('validation'), true)
    assert.equal(isRetryable('unavailable'), false)
    assert.equal(isRetryable('disk-full'), false)
  })
})

describe('progress across video + audio parts', () => {
  it('weights by bytes so the bar never goes backwards', () => {
    const t = new ProgressTracker()
    t.setEstimates({formatId: '137+140', partSizes: [900, 100]})
    const a = t.update({file: 'v.mp4', downloaded: 450, total: 900})
    assert.equal(a.fraction, 0.45)
    assert.equal(a.part, 1)
    assert.equal(a.totalParts, 2)
    const b = t.update({file: 'v.mp4', downloaded: 900, total: 900})
    const c = t.update({file: 'a.m4a', downloaded: 50, total: 100})
    assert.equal(b.fraction, 0.9)
    assert.equal(c.fraction, 0.95)
    assert.equal(c.part, 2)
  })
})

describe('binaries', () => {
  it('uses the fast-starting onedir builds', () => {
    assert.equal(ytDlpBuildFor('darwin', 'arm64'), 'yt-dlp_macos.zip')
    assert.equal(ytDlpBuildFor('darwin', 'x64'), 'yt-dlp_macos.zip')
    assert.equal(ytDlpBuildFor('win32', 'x64'), 'yt-dlp_win.zip')
    assert.equal(ytDlpBuildFor('win32', 'arm64'), 'yt-dlp_win_arm64.zip')
    assert.throws(() => ytDlpBuildFor('aix', 'ppc64'), /no build/)
  })

  it('parses SHA2-256SUMS and compares versions', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  yt-dlp_macos.zip\n${'b'.repeat(64)} *yt-dlp_win.zip\n`)
    assert.equal(sums.get('yt-dlp_macos.zip'), 'a'.repeat(64))
    assert.equal(sums.get('yt-dlp_win.zip'), 'b'.repeat(64))
    assert.ok(compareVersions('2025.10.22', '2025.9.30') > 0)
    assert.ok(compareVersions('2025.10.22', '2025.10.22.1') < 0)
    assert.equal(compareVersions('2025.10.22', '2025.10.22'), 0)
  })
})

describe('files', () => {
  it('sanitizes names for both macOS and Windows', () => {
    assert.equal(sanitizeFilename('a/b\\c:d*e?"f"<g>|h'), 'a_b_c_d_e__f__g__h')
    assert.equal(sanitizeFilename('CON'), '_CON')
    assert.equal(sanitizeFilename('trailing dots...  '), 'trailing dots')
    assert.equal(sanitizeFilename('   '), 'untitled')
    assert.equal(sanitizeFilename('Canción ñandú 🎵'), 'Canción ñandú 🎵')
  })

  it('uniquePath appends (2), (3)…', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-'))
    const target = path.join(dir, 'x.mp4')
    await fs.writeFile(target, '')
    await fs.writeFile(path.join(dir, 'x (2).mp4'), '')
    assert.equal(await uniquePath(target), path.join(dir, 'x (3).mp4'))
    await fs.rm(dir, {recursive: true})
  })
})

describe('download archive', () => {
  it('finds entries only while the file still exists with the same size', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-'))
    const file = path.join(dir, 'song.m4a')
    await fs.writeFile(file, 'audio-bytes')
    const profile = {kind: 'audio', container: 'm4a'} as const
    const key = archiveKey('Youtube', 'abc', profile)
    const archive = new DownloadArchive(path.join(dir, 'archive.json'))
    await archive.add({
      key,
      extractor: 'Youtube',
      mediaId: 'abc',
      profile: 'audio:m4a:0',
      url: 'u',
      filepath: file,
      sizeBytes: 11,
    })

    const reopened = new DownloadArchive(path.join(dir, 'archive.json'))
    assert.ok(await reopened.find(key))
    assert.equal(await reopened.find(archiveKey('Youtube', 'abc', {kind: 'audio', container: 'mp3'})), undefined)
    await fs.writeFile(file, 'truncated')
    assert.equal(await reopened.find(key), undefined)
    await Promise.all([archive.close(), reopened.close()])
    await fs.rm(dir, {recursive: true})
  })
})
