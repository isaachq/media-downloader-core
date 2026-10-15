import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {ensureContainer, extractAudio} from '../src/core/convert.js'
import {rulesFor} from '../src/core/formats.js'
import {run} from '../src/core/process.js'
import {ffprobe, summarizeProbe, validateFile} from '../src/core/validate.js'
import type {FormatProfile, ProcessingKind, VideoContainer} from '../src/types.js'
import {type FixtureName, MediaLab} from './helpers/media-lab.js'

let tmpDir = ''
let lab: MediaLab
const ffmpegExe = {command: 'ffmpeg', args: []}
const ffprobeExe = {command: 'ffprobe', args: []}
// real media only: without ffmpeg on the PATH the suite is skipped, as the integrity suite is
const available = await run('ffmpeg', ['-version']).then(
  result => result.code === 0,
  () => false,
)

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-conformance-'))
  lab = new MediaLab(path.join(tmpDir, 'fixtures'))
})

after(async () => {
  await fs.rm(tmpDir, {recursive: true, force: true})
})

type ConformanceCase = {
  readonly id: string
  readonly profile: FormatProfile
  readonly expectedExt: string
  readonly expectedContainer: string
  readonly expectedVideoCodec?: string | undefined
  readonly expectedAudioCodec?: string | undefined
}

const CASES: readonly ConformanceCase[] = [
  // MP4
  {
    id: 'CORE-MP4-BEST',
    profile: {kind: 'video', container: 'mp4'},
    expectedExt: 'mp4',
    expectedContainer: 'mp4',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MP4-2160',
    profile: {kind: 'video', container: 'mp4', maxHeight: 2160},
    expectedExt: 'mp4',
    expectedContainer: 'mp4',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MP4-1440',
    profile: {kind: 'video', container: 'mp4', maxHeight: 1440},
    expectedExt: 'mp4',
    expectedContainer: 'mp4',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MP4-1080',
    profile: {kind: 'video', container: 'mp4', maxHeight: 1080},
    expectedExt: 'mp4',
    expectedContainer: 'mp4',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MP4-720',
    profile: {kind: 'video', container: 'mp4', maxHeight: 720},
    expectedExt: 'mp4',
    expectedContainer: 'mp4',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MP4-480',
    profile: {kind: 'video', container: 'mp4', maxHeight: 480},
    expectedExt: 'mp4',
    expectedContainer: 'mp4',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MP4-360',
    profile: {kind: 'video', container: 'mp4', maxHeight: 360},
    expectedExt: 'mp4',
    expectedContainer: 'mp4',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },

  // WebM
  {
    id: 'CORE-WEBM-BEST',
    profile: {kind: 'video', container: 'webm'},
    expectedExt: 'webm',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'vp9',
    expectedAudioCodec: 'opus',
  },
  {
    id: 'CORE-WEBM-2160',
    profile: {kind: 'video', container: 'webm', maxHeight: 2160},
    expectedExt: 'webm',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'vp9',
    expectedAudioCodec: 'opus',
  },
  {
    id: 'CORE-WEBM-1440',
    profile: {kind: 'video', container: 'webm', maxHeight: 1440},
    expectedExt: 'webm',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'vp9',
    expectedAudioCodec: 'opus',
  },
  {
    id: 'CORE-WEBM-1080',
    profile: {kind: 'video', container: 'webm', maxHeight: 1080},
    expectedExt: 'webm',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'vp9',
    expectedAudioCodec: 'opus',
  },
  {
    id: 'CORE-WEBM-720',
    profile: {kind: 'video', container: 'webm', maxHeight: 720},
    expectedExt: 'webm',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'vp9',
    expectedAudioCodec: 'opus',
  },
  {
    id: 'CORE-WEBM-480',
    profile: {kind: 'video', container: 'webm', maxHeight: 480},
    expectedExt: 'webm',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'vp9',
    expectedAudioCodec: 'opus',
  },
  {
    id: 'CORE-WEBM-360',
    profile: {kind: 'video', container: 'webm', maxHeight: 360},
    expectedExt: 'webm',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'vp9',
    expectedAudioCodec: 'opus',
  },

  // MKV
  {
    id: 'CORE-MKV-BEST',
    profile: {kind: 'video', container: 'mkv'},
    expectedExt: 'mkv',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MKV-2160',
    profile: {kind: 'video', container: 'mkv', maxHeight: 2160},
    expectedExt: 'mkv',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MKV-1440',
    profile: {kind: 'video', container: 'mkv', maxHeight: 1440},
    expectedExt: 'mkv',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MKV-1080',
    profile: {kind: 'video', container: 'mkv', maxHeight: 1080},
    expectedExt: 'mkv',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MKV-720',
    profile: {kind: 'video', container: 'mkv', maxHeight: 720},
    expectedExt: 'mkv',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MKV-480',
    profile: {kind: 'video', container: 'mkv', maxHeight: 480},
    expectedExt: 'mkv',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-MKV-360',
    profile: {kind: 'video', container: 'mkv', maxHeight: 360},
    expectedExt: 'mkv',
    expectedContainer: 'matroska,webm',
    expectedVideoCodec: 'h264',
    expectedAudioCodec: 'aac',
  },

  // Audio
  {
    id: 'CORE-AUDIO-M4A',
    profile: {kind: 'audio', container: 'm4a'},
    expectedExt: 'm4a',
    expectedContainer: 'mov,mp4,m4a,3gp,3g2,mj2',
    expectedAudioCodec: 'aac',
  },
  {
    id: 'CORE-AUDIO-MP3',
    profile: {kind: 'audio', container: 'mp3'},
    expectedExt: 'mp3',
    expectedContainer: 'mp3',
    expectedAudioCodec: 'mp3',
  },
  {
    id: 'CORE-AUDIO-OPUS',
    profile: {kind: 'audio', container: 'opus'},
    expectedExt: 'opus',
    expectedContainer: 'ogg',
    expectedAudioCodec: 'opus',
  },
  {
    id: 'CORE-AUDIO-FLAC',
    profile: {kind: 'audio', container: 'flac'},
    expectedExt: 'flac',
    expectedContainer: 'flac',
    expectedAudioCodec: 'flac',
  },
  {
    id: 'CORE-AUDIO-WAV',
    profile: {kind: 'audio', container: 'wav'},
    expectedExt: 'wav',
    expectedContainer: 'wav',
    expectedAudioCodec: 'pcm_s16le',
  },
]

describe('26-Profile Conformance Suite', {skip: !available && 'ffmpeg not installed'}, () => {
  for (const c of CASES) {
    it(`validates ${c.id}: container, codecs, resolution cap and full integrity`, async () => {
      const caseDir = path.join(tmpDir, c.id)
      await fs.mkdir(caseDir, {recursive: true})

      // Use a standard 1080p MP4 input fixture
      const fixturePath = await lab.fixture('mp4-h264-aac-1080')
      const inputCopy = path.join(caseDir, `input.mp4`)
      await fs.copyFile(fixturePath, inputCopy)

      let resultFile: string
      let detectedKind: ProcessingKind | undefined

      if (c.profile.kind === 'video') {
        resultFile = await ensureContainer({
          ffmpeg: ffmpegExe,
          ffprobe: ffprobeExe,
          input: inputCopy,
          container: c.profile.container,
          maxHeight: c.profile.maxHeight,
          expectAudio: true,
          threads: 2,
          onKind: k => {
            detectedKind = k
          },
        })
      } else {
        resultFile = await extractAudio({
          ffmpeg: ffmpegExe,
          ffprobe: ffprobeExe,
          input: inputCopy,
          container: c.profile.container,
          threads: 2,
        })
        detectedKind = 'extract'
      }

      assert.ok(detectedKind, `${c.id}: detectedKind must be reported`)

      // Check extension
      const ext = path.extname(resultFile).slice(1).toLowerCase()
      assert.equal(ext, c.expectedExt, `${c.id}: extension must be .${c.expectedExt}`)

      // Validate with validateFile
      const report = await validateFile({
        ffmpeg: ffmpegExe,
        ffprobe: ffprobeExe,
        file: resultFile,
        rules: rulesFor(c.profile),
        level: 'full',
        maxHeight: c.profile.kind === 'video' ? c.profile.maxHeight : undefined,
        expectAudio: true,
        threads: 2,
      })

      assert.equal(report.ok, true, `${c.id} validation failed: ${report.issues.map(i => i.message).join('; ')}`)
      assert.ok(report.sizeBytes > 0, `${c.id}: file must be non-empty`)

      // Check audio track presence/absence
      if (c.profile.kind === 'audio') {
        assert.equal(report.video, undefined, `${c.id}: audio profile must not contain video track`)
        assert.ok(report.audio, `${c.id}: audio track must be present`)
        assert.equal(report.audio?.codec, c.expectedAudioCodec, `${c.id}: audio codec must be ${c.expectedAudioCodec}`)
      } else {
        assert.ok(report.video, `${c.id}: video track must be present`)
        assert.equal(report.video?.codec, c.expectedVideoCodec, `${c.id}: video codec must be ${c.expectedVideoCodec}`)
        assert.ok(report.audio, `${c.id}: audio track must be present`)

        if (c.profile.maxHeight !== undefined) {
          const res = Math.min(report.video?.width ?? 0, report.video?.height ?? 0)
          assert.ok(
            res <= c.profile.maxHeight,
            `${c.id}: resolution ${res}p must satisfy height <= ${c.profile.maxHeight}`,
          )
        }
      }

      // Clean up case file
      await fs.rm(caseDir, {recursive: true, force: true})
    })
  }

  it('runs all 5 audio profiles from an Opus source without generation loss or failure', async () => {
    const audioDir = path.join(tmpDir, 'audio-from-opus')
    await fs.mkdir(audioDir, {recursive: true})

    // WebM fixture with Opus audio
    const webmFixture = await lab.fixture('webm-vp9-opus-720')

    const audioContainers = ['m4a', 'mp3', 'opus', 'flac', 'wav'] as const
    for (const container of audioContainers) {
      const inputCopy = path.join(audioDir, `input-${container}.webm`)
      await fs.copyFile(webmFixture, inputCopy)

      const output = await extractAudio({
        ffmpeg: ffmpegExe,
        ffprobe: ffprobeExe,
        input: inputCopy,
        container,
        threads: 2,
      })

      const report = await validateFile({
        ffmpeg: ffmpegExe,
        ffprobe: ffprobeExe,
        file: output,
        rules: rulesFor({kind: 'audio', container}),
        level: 'full',
        expectAudio: true,
        threads: 2,
      })

      assert.equal(
        report.ok,
        true,
        `Audio ${container} from Opus failed: ${report.issues.map(i => i.message).join(';')}`,
      )
      assert.equal(report.video, undefined)
      assert.ok(report.audio)
      await fs.rm(output, {force: true})
    }
  })
})

// Plan §6: the transformation paths a real site exercises, by the shape of what it serves —
// an H.265 phone upload, 10-bit HEVC, VP9 and AV1 WebM, a silent clip, a portrait video, one
// rotated by metadata, variable frame rate — each asked as the three containers under a cap.
const SOURCES: readonly FixtureName[] = [
  'mp4-h265-aac-720',
  'mp4-h265-10bit-720',
  'webm-vp9-opus-720',
  'webm-av1-opus-720',
  'video-silent-720',
  'video-vertical-9-16',
  'video-metadata-rotated',
  'video-vfr',
]
const CONTAINERS: readonly VideoContainer[] = ['mp4', 'webm', 'mkv']
const CAP = 480

describe('source shapes × containers', {skip: !available && 'ffmpeg not installed'}, () => {
  for (const source of SOURCES) {
    for (const container of CONTAINERS) {
      it(`${source} → ${container} ≤ ${CAP}p: the promised container, codecs and cap, fully decodable`, async () => {
        const caseDir = path.join(tmpDir, `${source}-${container}`)
        await fs.mkdir(caseDir, {recursive: true})
        const fixture = await lab.fixture(source)
        const input = path.join(caseDir, `input${path.extname(fixture)}`)
        await fs.copyFile(fixture, input)
        const before = summarizeProbe(await ffprobe(ffprobeExe, input))
        const hasAudio = before.audio !== undefined
        let kind: ProcessingKind | undefined
        const out = await ensureContainer({
          ffmpeg: ffmpegExe,
          ffprobe: ffprobeExe,
          input,
          container,
          maxHeight: CAP,
          expectAudio: hasAudio,
          threads: 2,
          onKind: k => {
            kind = k
          },
        })
        assert.ok(kind, 'the processing kind is reported')
        assert.equal(path.extname(out).slice(1), rulesFor({kind: 'video', container}).ext)
        const report = await validateFile({
          ffmpeg: ffmpegExe,
          ffprobe: ffprobeExe,
          file: out,
          rules: rulesFor({kind: 'video', container}),
          level: 'full',
          maxHeight: CAP,
          expectAudio: hasAudio,
          threads: 2,
        })
        assert.equal(report.ok, true, `${source} → ${container}: ${report.issues.map(i => i.message).join('; ')}`)
        assert.ok(report.video, 'a video track')
        assert.equal(report.audio !== undefined, hasAudio, 'audio only where the source had it')
        const short = Math.min(report.video?.width ?? 0, report.video?.height ?? 0)
        assert.ok(short > 0 && short <= CAP, `short side ${short} within ${CAP}`)
        // a source already under the cap is never upscaled
        const sourceShort = Math.min(before.video?.width ?? 0, before.video?.height ?? 0)
        if (sourceShort <= CAP) assert.equal(short, sourceShort, 'no upscaling')
        await fs.rm(caseDir, {recursive: true, force: true})
      })
    }
  }

  it('the five audio profiles from an H.265 phone upload (AAC soundtrack)', async () => {
    const audioDir = path.join(tmpDir, 'audio-from-hevc')
    await fs.mkdir(audioDir, {recursive: true})
    const fixture = await lab.fixture('mp4-h265-aac-720')
    for (const container of ['m4a', 'mp3', 'opus', 'flac', 'wav'] as const) {
      const input = path.join(audioDir, `input-${container}.mp4`)
      await fs.copyFile(fixture, input)
      const out = await extractAudio({ffmpeg: ffmpegExe, ffprobe: ffprobeExe, input, container, threads: 2})
      const report = await validateFile({
        ffmpeg: ffmpegExe,
        ffprobe: ffprobeExe,
        file: out,
        rules: rulesFor({kind: 'audio', container}),
        level: 'full',
        expectAudio: true,
        threads: 2,
      })
      assert.equal(report.ok, true, `${container}: ${report.issues.map(i => i.message).join('; ')}`)
      assert.equal(report.video, undefined)
    }
  })
})
