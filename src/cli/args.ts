import {parseArgs} from 'node:util'
import {AUDIO_CONTAINERS, VIDEO_CONTAINERS} from '../core/formats.js'
import type {AudioContainer, FormatProfile, ValidationLevel, VideoContainer} from '../types.js'

export type GlobalOptions = {
  readonly dataDir?: string | undefined
  readonly json: boolean
  readonly color?: boolean | undefined
  readonly quiet: boolean
  readonly verbose: boolean
}

export type GetOptions = {
  readonly url: string
  readonly profile: FormatProfile
  readonly out?: string | undefined
  readonly items?: readonly number[] | undefined
  readonly threads?: number | undefined
  readonly validation?: ValidationLevel | undefined
}

export type Command =
  | {readonly name: 'help'}
  | {readonly name: 'version'}
  | {readonly name: 'doctor'}
  | {readonly name: 'setup'; readonly force: boolean}
  | {readonly name: 'update'}
  | {readonly name: 'info'; readonly url: string}
  | ({readonly name: 'get'} & GetOptions)
  | {readonly name: 'verify'}
  | {readonly name: 'logs'; readonly id: string; readonly limit?: number | undefined}

export type ParsedCli =
  | {readonly ok: true; readonly command: Command; readonly global: GlobalOptions}
  | {readonly ok: false; readonly error: string}

const OPTIONS = {
  // global
  'data-dir': {type: 'string'},
  json: {type: 'boolean', default: false},
  color: {type: 'boolean'},
  'no-color': {type: 'boolean'},
  quiet: {type: 'boolean', short: 'Q', default: false},
  verbose: {type: 'boolean', short: 'V', default: false},
  help: {type: 'boolean', short: 'h', default: false},
  version: {type: 'boolean', short: 'v', default: false},
  // get
  format: {type: 'string', short: 'f'},
  quality: {type: 'string', short: 'q'},
  out: {type: 'string', short: 'o'},
  items: {type: 'string', short: 'i'},
  threads: {type: 'string', short: 't'},
  validation: {type: 'string'},
  'audio-quality': {type: 'string'},
  // setup / logs
  force: {type: 'boolean', default: false},
  limit: {type: 'string', short: 'n'},
} as const

const COMMANDS = ['help', 'version', 'doctor', 'setup', 'update', 'info', 'get', 'verify', 'logs'] as const
const VALIDATION: readonly ValidationLevel[] = ['full', 'quick', 'none']

/** "1-5,8,10-12" → [1,2,3,4,5,8,10,11,12]; sorted, unique, 1-based. */
export function parseItems(spec: string): number[] | string {
  const items = new Set<number>()
  for (const part of spec.split(',').map(p => p.trim())) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!match) return `invalid item range "${part}" (use e.g. 1-5,8)`
    const from = Number(match[1])
    const to = Number(match[2] ?? match[1])
    if (from < 1 || to < from) return `invalid item range "${part}"`
    if (to - from > 10_000) return `item range "${part}" is too large`
    for (let i = from; i <= to; i++) items.add(i)
  }
  return [...items].sort((a, b) => a - b)
}

/** -f / -q / --audio-quality → a validated profile. */
export function parseProfile(format = 'mp4', quality?: string, audioQuality?: string): FormatProfile | string {
  if ((VIDEO_CONTAINERS as readonly string[]).includes(format)) {
    if (audioQuality) return '--audio-quality applies to audio formats only'
    if (!quality || quality === 'best') return {kind: 'video', container: format as VideoContainer}
    const height = Number(quality.replace(/p$/i, ''))
    if (!Number.isInteger(height) || height < 144 || height > 4320)
      return `invalid quality "${quality}" (best, 2160, 1440, 1080, 720…)`
    return {kind: 'video', container: format as VideoContainer, maxHeight: height}
  }
  if ((AUDIO_CONTAINERS as readonly string[]).includes(format)) {
    if (quality && quality !== 'best') return '-q applies to video formats; use --audio-quality for audio'
    if (audioQuality && !/^(?:10|\d|\d{2,4}[kK])$/.test(audioQuality))
      return `invalid audio quality "${audioQuality}" (0-10 or e.g. 192K)`
    return {kind: 'audio', container: format as AudioContainer, ...(audioQuality && {quality: audioQuality})}
  }
  return `unknown format "${format}" (video: ${VIDEO_CONTAINERS.join(', ')}; audio: ${AUDIO_CONTAINERS.join(', ')})`
}

function positiveInt(value: string | undefined, name: string): number | string | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : `${name} must be a positive integer`
}

export function parseCli(argv: readonly string[]): ParsedCli {
  let parsed: ReturnType<typeof parseArgs<{options: typeof OPTIONS; allowPositionals: true; strict: true}>>
  try {
    parsed = parseArgs({args: [...argv], options: OPTIONS, allowPositionals: true, strict: true})
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)}
  }
  const {values: v, positionals} = parsed
  const global: GlobalOptions = {
    dataDir: v['data-dir'],
    json: v.json,
    color: v['no-color'] ? false : v.color,
    quiet: v.quiet,
    verbose: v.verbose,
  }
  const done = (command: Command): ParsedCli => ({ok: true, command, global})
  const fail = (error: string): ParsedCli => ({ok: false, error})

  if (v.version) return done({name: 'version'})
  const [name = 'help', ...rest] = positionals
  if (v.help || name === 'help') return done({name: 'help'})
  if (!(COMMANDS as readonly string[]).includes(name)) return fail(`unknown command "${name}"`)

  const takesUrl = name === 'info' || name === 'get' || name === 'logs'
  if (takesUrl && rest.length !== 1) return fail(`"${name}" expects exactly one ${name === 'logs' ? 'id' : 'url'}`)
  if (!takesUrl && rest.length > 0) return fail(`"${name}" takes no arguments`)

  switch (name) {
    case 'version':
      return done({name: 'version'})
    case 'doctor':
    case 'update':
    case 'verify':
      return done({name})
    case 'setup':
      return done({name: 'setup', force: v.force})
    case 'info':
      return done({name: 'info', url: rest[0]!})
    case 'logs': {
      const id = rest[0]!
      if (!/^[A-Za-z0-9]{6,32}$/.test(id)) return fail('the id must be 6–32 letters/digits (a prefix works)')
      const limit = positiveInt(v.limit, '--limit')
      if (typeof limit === 'string') return fail(limit)
      return done({name: 'logs', id, limit})
    }
    default: {
      const profile = parseProfile(v.format, v.quality, v['audio-quality'])
      if (typeof profile === 'string') return fail(profile)
      const items = v.items === undefined ? undefined : parseItems(v.items)
      if (typeof items === 'string') return fail(items)
      const threads = positiveInt(v.threads, '--threads')
      if (typeof threads === 'string') return fail(threads)
      if (v.validation !== undefined && !(VALIDATION as readonly string[]).includes(v.validation)) {
        return fail(`--validation must be one of ${VALIDATION.join(', ')}`)
      }
      return done({
        name: 'get',
        url: rest[0]!,
        profile,
        out: v.out,
        items,
        threads,
        validation: v.validation as ValidationLevel | undefined,
      })
    }
  }
}

export const HELP = `usage: mdc <command> [options]

commands
  get <url>        download a video or playlist (validated, archived)
  info <url>       show title, playlist items and available formats
  doctor           check yt-dlp, ffmpeg (codecs), data folder and space
  setup            install / repair yt-dlp and ffmpeg (checksum-verified)
  update           update yt-dlp to the latest release
  verify           re-hash every archived file against its SHA-256
  logs <id>        replay a session / job / attempt / step from the trace logs

get options
  -f, --format <f>        mp4 (default) webm mkv | m4a mp3 opus flac wav
  -q, --quality <q>       best (default) 2160 1440 1080 720 480 360 — video only
      --audio-quality <a> 0 (best VBR) … 10, or a bitrate like 192K — audio only
  -o, --out <dir>         destination folder (default: your Downloads folder)
  -i, --items <list>      playlist items, e.g. 1-5,8
  -t, --threads <n>       simultaneous downloads (capped at CPUs/2)
      --validation <v>    full (default) quick none

other options
      --force             setup: reinstall even if everything looks fine
  -n, --limit <n>         logs: show only the last n lines
      --data-dir <dir>    engine data (tools, archive, logs) — default per OS
      --json              machine-readable output (NDJSON for get)
      --no-color          disable colors (NO_COLOR is honored too)
  -Q, --quiet             no banner
  -V, --verbose           show debug log lines
  -h, --help · -v, --version

exit codes: 0 ok · 1 some downloads failed · 2 usage error · 3 environment not ready · 130 interrupted`
