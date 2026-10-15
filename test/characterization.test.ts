import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {ensureContainer} from '../src/core/convert.js'
import {genericChoices} from '../src/core/formats.js'
import {run} from '../src/core/process.js'
import {ffprobe, summarizeProbe} from '../src/core/validate.js'
import {playerChoices} from '../src/sources/player-page/source.js'
import {renditionChoices} from '../src/sources/renditions.js'

let dir = ''
const ffmpegExe = {command: 'ffmpeg', args: []}
const ffprobeExe = {command: 'ffprobe', args: []}
// real media only: without ffmpeg on the PATH the suite is skipped, as the integrity suite is
const available = await run('ffmpeg', ['-version']).then(
  result => result.code === 0,
  () => false,
)

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-char-'))
})

after(async () => {
  await fs.rm(dir, {recursive: true, force: true})
})

describe('Phase C0 Characterization', {skip: !available && 'ffmpeg not installed'}, () => {
  it('characterizes MKV conversion bug: ensureContainer currently returns input MP4 unchanged', async () => {
    // Create a real MP4 clip
    const mp4Input = path.join(dir, 'source.mp4')
    const {spawnSync} = await import('node:child_process')
    const gen = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=320x240:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        mp4Input,
      ],
      {encoding: 'utf8'},
    )
    assert.equal(gen.status, 0)

    // Call ensureContainer for mkv
    const output = await ensureContainer({
      ffmpeg: ffmpegExe,
      ffprobe: ffprobeExe,
      input: mp4Input,
      container: 'mkv',
      expectAudio: true,
      threads: 2,
    })

    // Currently, it returns input as-is without remuxing to MKV!
    // This confirms the bug described in Section 1 of FORMAT-REGRESSION-PLAN.md.
    const probe = summarizeProbe(await ffprobe(ffprobeExe, output))
    const isMatroska = probe.container.split(',').includes('matroska')
    // We document whether current code produces Matroska or leaves it as MP4:
    // If output is still MP4, isMatroska is false and ext is .mp4!
    const ext = path.extname(output).toLowerCase()
    assert.equal(isMatroska, true, 'MKV output must be Matroska container')
    assert.equal(ext, '.mkv', 'MKV output must have .mkv extension')
  })

  it('characterizes choices: native renditions and player-page declare MKV and Audio requiresConversion', () => {
    const renditions = [
      {
        codec: 'h264' as const,
        width: 1280,
        height: 720,
        resolution: 720,
        bitrate: 1000,
        bytes: 1000,
        urls: ['http://example.com/720.mp4'],
      },
    ]
    const choices = renditionChoices(renditions, 60)
    const mkvChoice = choices.find(c => c.profile.kind === 'video' && c.profile.container === 'mkv')
    const audioChoicesList = choices.filter(c => c.profile.kind === 'audio')
    const ppChoices = playerChoices({heights: [720], duration: 60})
    const ppMkv = ppChoices.find(c => c.profile.kind === 'video' && c.profile.container === 'mkv')

    // Must declare requiresConversion: true because native sources deliver MP4 video files!
    assert.equal(mkvChoice?.requiresConversion, true, 'MKV choice from MP4 source must require conversion')
    assert.equal(audioChoicesList[0]?.requiresConversion, true, 'Audio choice from MP4 source must require conversion')
    assert.equal(ppMkv?.requiresConversion, true, 'Player-page MKV choice must require conversion')
  })

  it('characterizes genericChoices: check if 26 profiles are represented', () => {
    const generic = genericChoices()
    // Must contain 26 base profiles:
    // MP4: Best + 6 heights = 7
    // WebM: Best + 6 heights = 7
    // MKV: Best + 6 heights = 7
    // Audio: 5 containers = 5
    // Total = 26
    assert.equal(generic.length, 26, 'genericChoices must offer 26 profiles')
  })

  it('characterizes 360 requested with single 720 source: ensureContainer must scale down', async () => {
    // Generate a 1280x720 clip
    const input720 = path.join(dir, 'source_720.mp4')
    const {spawnSync} = await import('node:child_process')
    const gen = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=1280x720:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=duration=1:frequency=440',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        input720,
      ],
      {encoding: 'utf8'},
    )
    assert.equal(gen.status, 0)

    // Call ensureContainer with maxHeight 360
    const converted = await ensureContainer({
      ffmpeg: ffmpegExe,
      ffprobe: ffprobeExe,
      input: input720,
      container: 'mp4',
      maxHeight: 360,
      expectAudio: true,
      threads: 2,
    })

    const probe = summarizeProbe(await ffprobe(ffprobeExe, converted))
    assert.ok(probe.video)
    // Currently, ensureContainer does not downscale, so height remains 720!
    // With the fix, height must be <= 360!
    assert.ok((probe.video?.height ?? 0) <= 360, `Output height (${probe.video?.height}) must be <= 360`)
  })
})
