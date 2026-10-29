// Scenario gate row: a song served as video/mp4 stays sound in every format (heavy: the real
// ffmpeg and ffprobe). Instagram's CDN serves a photo post's song as video/mp4 (AAC in an MP4
// container); a downstream integration got it back as a .mp4 clip next to the pictures when
// a video format was chosen. Every output format of the picker, each probed.
//
// Skipped automatically when ffmpeg/ffprobe aren't installed.
import {strict as assert} from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {after, before, describe, it} from 'node:test'
import {run} from '../src/core/process.js'
import {ffprobe, summarizeProbe} from '../src/core/validate.js'
import {MediaDownloader} from '../src/downloader.js'
import type {AudioContainer, FormatProfile, VideoContainer} from '../src/types.js'
import {SESSION_COOKIE, startFakeInstagram} from './helpers/fake-instagram.js'
import {type FakeBinaries, writeFakes} from './helpers/fakes.js'
import {MediaLab} from './helpers/media-lab.js'

const available = await run('ffmpeg', ['-version']).then(
  result => result.code === 0,
  () => false,
)

const REAL = {command: 'ffmpeg', args: []}
const PROBE = {command: 'ffprobe', args: []}
const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp3', '.opus', '.flac', '.wav'])
const VIDEOS: readonly VideoContainer[] = ['mp4', 'mkv', 'webm']
const AUDIOS: readonly AudioContainer[] = ['m4a', 'mp3', 'opus', 'flac', 'wav']

let root: string
let fakes: FakeBinaries
let lab: MediaLab

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-audio-as-video-'))
  if (!available) return
  fakes = await writeFakes(path.join(root, 'bin'))
  lab = new MediaLab(path.join(root, 'lab'))
})

after(async () => {
  await fs.rm(root, {recursive: true, force: true})
})

/** The song is sound: an audio stream and no video stream. */
async function assertSound(file: string, what: string): Promise<void> {
  const summary = summarizeProbe(await ffprobe(PROBE, file))
  assert.ok(summary.audio, `${what}: an audio stream`)
  assert.equal(summary.video, undefined, `${what}: no video stream`)
}

describe('a song served as video/mp4 stays sound (real ffmpeg)', {skip: !available && 'ffmpeg not installed'}, () => {
  it('every format of the picker: a folder with the song as audio, or the song alone', {timeout: 120_000}, async () => {
    const site = await startFakeInstagram({
      photos: [0],
      carousels: [1],
      music: [0, 1],
      posts: 2,
      media: {
        image: await lab.fixture('image-portrait-jpg'),
        // AAC in an MP4 container, served as video/mp4 as Instagram's CDN does
        sound: await lab.fixture('audio-aac-m4a'),
        soundDuration: 1,
      },
    })
    const host = new URL(site.origin).hostname
    const [name, value] = SESSION_COOKIE.split('=') as [string, string]
    const engine = new MediaDownloader({
      dataDir: path.join(root, 'engine'),
      binaries: {ytDlp: fakes.ytDlp, ffmpeg: REAL, ffprobe: PROBE},
      validation: 'none',
      maxRetries: 1,
      retryDelayMaxMs: 20,
      progressIntervalMs: 0,
      tiktok: false,
      facebook: false,
      instagram: {
        origin: site.origin,
        pacing: {spacingMs: 0, jitterMs: 0, backoffMs: 20, maxBackoffMs: 60},
        retryPauseMs: 0,
        cookies: async () => [{name, value, domain: host}],
      },
    })
    try {
      const out = path.join(root, 'out')
      // a video format: the pictures and the song, kept as they are
      for (const container of VIDEOS) {
        const profile: FormatProfile = {kind: 'video', container}
        const job = engine.add({
          url: `${site.origin}/p/${site.codes[1]}/`,
          profile,
          outDir: path.join(out, `video-${container}`),
          slideshow: {mode: 'images-audio', secondsPerImage: 3},
          photoPost: true,
        })
        await engine.whenIdle()
        const done = engine.job(job.id)!
        assert.equal(done.status, 'completed', `${container}: ${JSON.stringify(done.error)}`)
        const files = (await fs.readdir(done.filepath!)).sort()
        assert.deepEqual(
          files.filter(file => file.endsWith('.jpg')),
          ['01.jpg', '02.jpg', '03.jpg'],
          `${container}: the pictures`,
        )
        const songs = files.filter(file => !file.endsWith('.jpg'))
        assert.equal(songs.length, 1, `${container}: one song, got ${songs.join(', ')}`)
        const song = songs[0]!
        assert.ok(AUDIO_EXTENSIONS.has(path.extname(song)), `${container}: ${song} has an audio extension`)
        await assertSound(path.join(done.filepath!, song), `${container}: ${song}`)
      }
      // an audio format: the song alone
      for (const container of AUDIOS) {
        const job = engine.add({
          url: `${site.origin}/p/${site.codes[0]}/`,
          profile: {kind: 'audio', container},
          outDir: path.join(out, `audio-${container}`),
        })
        await engine.whenIdle()
        const done = engine.job(job.id)!
        assert.equal(done.status, 'completed', `${container}: ${JSON.stringify(done.error)}`)
        assert.equal(path.extname(done.filepath ?? ''), `.${container}`, `${container}: the extension`)
        await assertSound(done.filepath!, container)
      }
    } finally {
      await engine.dispose()
      await site.close()
    }
  })
})
