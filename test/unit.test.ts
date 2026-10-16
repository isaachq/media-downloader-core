import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, it} from 'node:test'
import {gzipSync} from 'node:zlib'
import {compareVersions} from '../src/binaries/manager.js'
import {parseChecksums, ytDlpBuildFor} from '../src/binaries/sources.js'
import {isYouTubeMix} from '../src/core/analyze.js'
import {archiveKey, DownloadArchive} from '../src/core/archive.js'
import {estimateBytes, jobTier, peakBytes, TIER_WEIGHT} from '../src/core/cost.js'
import {ProgressTracker} from '../src/core/download.js'
import {classifyYtDlpError, isRetryable} from '../src/core/errors.js'
import {WorkMeter} from '../src/core/eta.js'
import {
  folderName,
  mediaFileStem,
  portableName,
  renameRetrying,
  sanitizeFilename,
  uniquePath,
} from '../src/core/files.js'
import {
  catalogFormats,
  normalizeCodec,
  planChoices,
  profileArgs,
  type RawFormat,
  videoSelector,
} from '../src/core/formats.js'
import {clampConcurrency, maxConcurrency, TaskPool} from '../src/core/pool.js'
import {navigationFetch} from '../src/sources/http.js'

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

describe('weighted pool (long and heavy jobs)', () => {
  const run = async (limit: number, weights: number[]) => {
    const pool = new TaskPool(limit)
    let used = 0
    let peakUsed = 0
    let peakCount = 0
    let running = 0
    const order: number[] = []
    weights.forEach((weight, i) => {
      pool.add(
        String(i),
        async () => {
          order.push(i)
          used += weight
          running++
          peakUsed = Math.max(peakUsed, used)
          peakCount = Math.max(peakCount, running)
          await new Promise(resolve => setTimeout(resolve, 15))
          used -= weight
          running--
        },
        weight,
      )
    })
    await pool.whenIdle()
    return {peakUsed, peakCount, order}
  }

  it('runs N/3 long jobs (weight 1.5) where N/2 normal ones would fit', async () => {
    assert.equal((await run(6, Array(12).fill(1))).peakCount, 6)
    assert.equal((await run(6, Array(12).fill(1.5))).peakCount, 4)
    assert.equal((await run(6, Array(12).fill(2))).peakCount, 3)
  })

  it('mixes weights without exceeding the capacity and keeps FIFO order', async () => {
    const result = await run(6, [2, 1, 1, 1.5, 1, 2, 1, 1.5])
    assert.ok(result.peakUsed <= 6)
    assert.deepEqual(result.order, [0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('a task heavier than the whole capacity still runs, alone', async () => {
    const result = await run(1, [2, 2])
    assert.equal(result.peakCount, 1)
  })
})

describe('job cost', () => {
  const video = (maxHeight?: number) => ({kind: 'video', container: 'mp4', maxHeight}) as const
  it('classifies by duration, resolution and conversion', () => {
    assert.equal(jobTier({profile: video(1080), duration: 600}), 'normal')
    assert.equal(jobTier({profile: video(1080), duration: 3600}), 'long')
    assert.equal(jobTier({profile: video(2160), duration: 3600}), 'heavy')
    assert.equal(jobTier({profile: video(), duration: 3600}), 'heavy', 'uncapped may be 4K')
    assert.equal(jobTier({profile: video(720), duration: 3600, requiresConversion: true}), 'heavy')
    assert.equal(jobTier({profile: {kind: 'audio', container: 'mp3'}, duration: 7200}), 'normal')
    assert.equal(jobTier({profile: video(1080), duration: 1200}, 15), 'long', 'threshold is configurable')
    assert.deepEqual(TIER_WEIGHT, {normal: 1, long: 1.5, heavy: 2})
  })

  it('estimates size from the site, or from duration × a typical bitrate', () => {
    const choices = buildChoicesFixture()
    assert.equal(estimateBytes(video(1080), choices, 600), 63_000_000)
    // no size reported: 1 h of 1080p ≈ (6 Mb/s + 320 kb/s) × 3600 / 8
    assert.equal(estimateBytes(video(1080), [], 3600), Math.ceil((3600 * 6_320_000) / 8))
    assert.equal(estimateBytes(video(1080), [], undefined), undefined)
    assert.equal(peakBytes(100, false), 200)
    assert.equal(peakBytes(100, true), 300)
  })

  it('turns bitrates into sizes when the site reports none, and uses the encoder rate for mp3/flac/wav', () => {
    // a 213 s video: YouTube reports tbr (kbit/s) but no filesize — as for the 1080p stream measured in a real run
    const choices = planChoices(
      [
        {format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 330},
        {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, tbr: 129},
      ],
      213,
    )
    const size = (container: string) => choices.find(c => c.profile.container === container)?.estimatedBytes
    assert.equal(size('mp4'), Math.ceil((330_000 * 213) / 8) + Math.ceil((129_000 * 213) / 8)) // ≈ 12.2 MB, as measured
    assert.equal(size('m4a'), Math.ceil((129_000 * 213) / 8), 'stream copy: the source size')
    assert.equal(size('mp3'), Math.ceil((260_000 * 213) / 8), 'encoded: the encoder bitrate (measured 7.0 MB)')
    assert.equal(size('wav'), Math.ceil((1_536_000 * 213) / 8))
    assert.equal(
      planChoices([{format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, tbr: 330}])[0]
        ?.estimatedBytes,
      undefined,
      'no duration, no guess',
    )
  })

  it('recognizes a YouTube Mix', () => {
    assert.equal(isYouTubeMix('https://www.youtube.com/watch?v=k1gsZ-OsGpI&list=RDk1gsZ-OsGpI&start_radio=1'), true)
    assert.equal(isYouTubeMix('https://music.youtube.com/watch?v=x&list=RDAMVMx'), true)
    assert.equal(isYouTubeMix('https://www.youtube.com/playlist?list=PL0123'), false)
    assert.equal(isYouTubeMix('https://example.com/watch?list=RD1'), false)
    assert.equal(isYouTubeMix('not a url'), false)
  })
})

describe('renames on Windows (antivirus locks)', () => {
  const locked = (times: number, code = 'EPERM') => {
    let calls = 0
    return {
      calls: () => calls,
      rename: async () => {
        calls++
        if (calls <= times) throw Object.assign(new Error(code), {code})
      },
    }
  }
  const noWait = async () => {}

  it('retries a briefly locked file on Windows until it is released', async () => {
    const fake = locked(3)
    await renameRetrying('a', 'b', {platform: 'win32', rename: fake.rename, sleep: noWait})
    assert.equal(fake.calls(), 4)
  })

  it('fails at once elsewhere: there EPERM is a real permission problem', async () => {
    const fake = locked(1)
    await assert.rejects(renameRetrying('a', 'b', {platform: 'darwin', rename: fake.rename, sleep: noWait}), /EPERM/)
    assert.equal(fake.calls(), 1)
  })

  it('gives up after ~9 s of waits, and never retries other errors', async () => {
    const waits: number[] = []
    const forever = locked(Number.POSITIVE_INFINITY, 'EBUSY')
    await assert.rejects(
      renameRetrying('a', 'b', {platform: 'win32', rename: forever.rename, sleep: async ms => waits.push(ms)}),
      /EBUSY/,
    )
    assert.equal(forever.calls(), 12)
    assert.ok(waits.reduce((a, b) => a + b, 0) < 10_000)
    const missing = locked(1, 'ENOENT')
    await assert.rejects(renameRetrying('a', 'b', {platform: 'win32', rename: missing.rename, sleep: noWait}), /ENOENT/)
    assert.equal(missing.calls(), 1)
  })
})

describe('portable file names (car stereos, TVs, USB sticks)', () => {
  it('keeps only ASCII letters, digits and hyphens', () => {
    assert.equal(
      portableName('Coldplay - Hymn For The Weekend [Seeb Remix] (Official Audio)'),
      'Coldplay-Hymn-For-The-Weekend-Seeb-Remix-Official-Audio',
    )
    assert.equal(portableName('Canción Ñandú — ¡En vivo! 🎸 (2024)'), 'Cancion-Nandu-En-vivo-2024')
    assert.equal(portableName("Don't Stop Me Now"), 'Dont-Stop-Me-Now')
    assert.equal(portableName('Straße · Æther · Øresund · Łódź'), 'Strasse-AEther-Oresund-Lodz')
    assert.equal(portableName('ｆｕｌｌ　ｗｉｄｔｈ ①②'), 'full-width-12', 'compatibility forms become ASCII')
    assert.match(portableName('a'.repeat(300), 120), /^a{120}$/)
    assert.equal(portableName('CON'), 'CON-file', 'Windows reserved names')
  })

  it('falls back to the id when a title has no ASCII form', () => {
    assert.equal(portableName('東京 🎌 Москва'), '')
    assert.equal(mediaFileStem('portable', {title: '東京', id: 'abc_123', index: 7}), '007-abc-123')
    assert.equal(mediaFileStem('portable', {title: '🎵'}), 'media')
    assert.equal(folderName('🎵🎵', 'portable'), 'Playlist')
  })

  it("'original' keeps the title as is, safe for macOS and Windows", () => {
    assert.equal(
      mediaFileStem('original', {title: 'Canción: ¿Live?', id: 'x1', index: 2}),
      '002 - Canción_ ¿Live_ [x1]',
    )
    assert.equal(folderName('Mix: 🎸', 'original'), 'Mix_ 🎸')
  })
})

describe('time left (WorkMeter)', () => {
  it('measures throughput from work done, weighted by size, and projects the rest', () => {
    let now = 0
    const meter = new WorkMeter(() => now)
    meter.add('a', 100)
    meter.add('b', 100)
    meter.add('c', 200)
    assert.deepEqual(meter.estimate(), {fraction: 0}, 'nothing measured yet')
    now = 10_000
    meter.progress('a', 1)
    meter.finish('a', true) // 100 of 400 in 10 s → 10/s
    meter.progress('b', 0.5) // +50
    const e = meter.estimate()
    assert.equal(e.fraction, 150 / 400)
    assert.equal(e.etaSeconds, Math.ceil(250 / (150 / 10)), '250 left at 15/s')
  })

  it('waits for the warm-up and ignores jobs that took no time', () => {
    let now = 0
    const meter = new WorkMeter(() => now)
    meter.add('done-before', 100)
    meter.add('real', 100)
    now = 1000
    meter.finish('done-before', false) // already downloaded: out of the total
    meter.progress('real', 0.5)
    assert.equal(meter.estimate().etaSeconds, undefined, 'under 3 s')
    now = 5000
    assert.deepEqual(meter.estimate(), {fraction: 0.5, etaSeconds: 5})
  })

  it('follows the recent pace: a slow start does not weigh on the whole batch', () => {
    let now = 0
    const meter = new WorkMeter(() => now)
    meter.add('a', 1000)
    // first 20 s: start-up, 1 unit/s
    for (now = 0; now <= 20_000; now += 1000) {
      meter.progress('a', now / 1000 / 1000)
      meter.estimate()
    }
    // next 40 s: full speed, 10 units/s
    for (; now <= 60_000; now += 1000) {
      meter.progress('a', (20 + ((now - 20_000) / 1000) * 10) / 1000)
      meter.estimate()
    }
    now -= 1000
    const {fraction, etaSeconds} = meter.estimate()
    assert.equal(fraction, 0.42) // 420 of 1000
    // since-start average would say 580 / 7 ≈ 83 s; the last 30 s say 580 / 10 = 58 s
    assert.equal(etaSeconds, 58)
  })

  it('gives unknown sizes the average of the known ones', () => {
    const meter = new WorkMeter(() => 0)
    meter.add('known', 300)
    meter.add('unknown', undefined)
    meter.finish('known', true)
    assert.equal(meter.estimate().fraction, 0.5)
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

function buildChoicesFixture() {
  return planChoices([
    {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, filesize: 3_000_000},
    {
      format_id: '137',
      ext: 'mp4',
      vcodec: 'avc1.640028',
      acodec: 'none',
      height: 1080,
      tbr: 4000,
      filesize: 60_000_000,
    },
  ])
}

describe('navigationFetch (headers as given)', () => {
  it('sends Sec-Fetch-Mode as set (Node fetch forces cors), follows redirects, decodes gzip, keeps every cookie', async () => {
    const seen: http.IncomingHttpHeaders[] = []
    const server = http.createServer((req, res) => {
      seen.push(req.headers)
      if (req.url === '/hop') {
        res.writeHead(302, {Location: '/page'}).end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Encoding': 'gzip',
        'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'],
      })
      res.end(gzipSync('<html>page</html>'))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const {port} = server.address() as {port: number}
      const response = await navigationFetch(`http://127.0.0.1:${port}/hop`, {
        headers: {'Sec-Fetch-Mode': 'navigate', 'User-Agent': 'test'},
      })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '<html>page</html>')
      assert.equal(response.url, `http://127.0.0.1:${port}/page`)
      assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/'])
      assert.deepEqual(
        seen.map(h => h['sec-fetch-mode']),
        ['navigate', 'navigate'],
      )
      const manual = await navigationFetch(`http://127.0.0.1:${port}/hop`, {redirect: 'manual'})
      assert.equal(manual.status, 302)
      const controller = new AbortController()
      controller.abort(new Error('stop'))
      await assert.rejects(navigationFetch(`http://127.0.0.1:${port}/page`, {signal: controller.signal}), /stop/)
    } finally {
      server.close()
    }
  })
})
