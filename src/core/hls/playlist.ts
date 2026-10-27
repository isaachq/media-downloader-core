/**
 * HLS playlist grammar (RFC 8216 and its 2nd edition draft), as a downloader and a recorder meet it.
 * Pure: no Node APIs, `URL` only for the uris that need real resolution. One pass over the text.
 *
 * The parser keeps everything a sliding-window (live) playlist carries — EXT-X-MEDIA-SEQUENCE,
 * EXT-X-DISCONTINUITY-SEQUENCE, EXT-X-PROGRAM-DATE-TIME, EXT-X-DATERANGE, segment titles — and refuses
 * nothing for being live: whether an open-ended playlist may be downloaded is decided by the caller
 * (`downloadHls` refuses it as `live-now`; see `isOpenEnded`).
 */
import type {HttpSession} from '../../sources/http.js'
import {DownloadError} from '../errors.js'
import {HlsError} from './errors.js'

/** `EXT-X-BYTERANGE` / `BYTERANGE="n@o"`, resolved: the offset is always explicit after parsing. */
export type ByteRange = {readonly offset: number; readonly length: number}

/**
 * A segment's key. Only what the downloader can open survives parsing: anything else (SAMPLE-AES,
 * SAMPLE-AES-CTR, a KEYFORMAT other than "identity", skd://) makes `parsePlaylist` throw
 * `HlsError('drm' | 'unsupported')` before a single segment is requested.
 */
export type HlsKey = {
  readonly method: 'AES-128'
  /** Absolute key url; the 16 bytes it answers are cached (`KeyCache`) while segments use it. */
  readonly uri: string
  /** The tag's IV; absent → the segment's media sequence number, 16-byte big-endian. */
  readonly iv?: Uint8Array | undefined
}

/** `EXT-X-MAP`: the init segment of an fMP4 period. */
export type HlsInit = {readonly uri: string; readonly range?: ByteRange | undefined}

export type HlsSegment = {
  /** 0-based position in this playlist (progress; the window of a sliding playlist moves it). */
  readonly index: number
  /**
   * Media sequence number: EXT-X-MEDIA-SEQUENCE + index. The segment's identity — the resume cursor,
   * the file names on disk, the AES IV when the key has none — stable across reloads of a live window.
   */
  readonly sequence: number
  /** Absolute url (resolved against the playlist's final url, `mapSegmentUri` applied). */
  readonly uri: string
  /** EXTINF, seconds. */
  readonly duration: number
  /** EXTINF's title (after the comma), when there is one. */
  readonly title?: string | undefined
  readonly range?: ByteRange | undefined
  /** Discontinuity period in this playlist, 0-based; also advances when EXT-X-MAP changes. One output file per period. */
  readonly period: number
  /** Absolute discontinuity number: EXT-X-DISCONTINUITY-SEQUENCE + the discontinuities before it in this playlist. */
  readonly discontinuity: number
  /** Index into `HlsMediaPlaylist.keys`; -1 = clear. */
  readonly key: number
  /** EXT-X-GAP: listed but absent; never requested. */
  readonly gap: boolean
  /** EXT-X-PROGRAM-DATE-TIME of this segment (unix ms), given or carried from the previous one by its EXTINF. */
  readonly programDateTime?: number | undefined
}

/** EXT-X-DATERANGE (ad breaks, chapters, SCTE-35 cues), every attribute kept as written. */
export type HlsDateRange = {
  readonly id: string
  readonly class?: string | undefined
  /** START-DATE, unix ms (NaN-free: a range without a parseable one is dropped). */
  readonly startDate: number
  readonly endDate?: number | undefined
  readonly duration?: number | undefined
  readonly plannedDuration?: number | undefined
  /** All attributes, raw (quotes removed), including X-… client attributes and SCTE35-*. */
  readonly attributes: Readonly<Record<string, string>>
}

export type HlsSegmentFormat = 'ts' | 'fmp4' | 'packed-audio' | 'unknown'

export type HlsMediaPlaylist = {
  readonly kind: 'media'
  /** Final url after redirects: the base of every relative uri. */
  readonly url: string
  readonly segments: readonly HlsSegment[]
  /** Distinct keys in order of appearance (usually 0 or 1; key rotation makes more). */
  readonly keys: readonly HlsKey[]
  /** Init segment per period (undefined for TS / packed audio periods). Length = `periods`. */
  readonly inits: ReadonlyArray<HlsInit | undefined>
  readonly periods: number
  /** EXT-X-MEDIA-SEQUENCE (0 when absent): the sequence of the first segment. */
  readonly mediaSequence: number
  /** EXT-X-DISCONTINUITY-SEQUENCE (0 when absent). */
  readonly discontinuitySequence: number
  /** Σ EXTINF, seconds. */
  readonly duration: number
  readonly targetDuration: number
  /** EXT-X-ENDLIST seen. */
  readonly ended: boolean
  readonly playlistType?: 'VOD' | 'EVENT' | undefined
  /** Segment format, from EXT-X-MAP and the first uri's extension: decides the assemble step. */
  readonly format: HlsSegmentFormat
  /** Lower-case extension of the first segment's path ("ts", "aac", "mp3"…), "" when it has none. */
  readonly extension: string
  /** Exact Σ of byte ranges (+ inits) when every segment has one: the progress total needs no guess. */
  readonly byteLength?: number | undefined
  readonly dateRanges: readonly HlsDateRange[]
}

export type HlsVariant = {
  /** Absolute media playlist url. */
  readonly uri: string
  readonly bandwidth: number
  readonly averageBandwidth?: number | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly frameRate?: number | undefined
  /** CODECS split on commas, e.g. ["avc1.64002A", "mp4a.40.2"]; empty when absent. */
  readonly codecs: readonly string[]
  /** AUDIO="group": the EXT-X-MEDIA group whose track goes with this variant. */
  readonly audioGroup?: string | undefined
  /** Twitch names its variants (VIDEO="chunked" / NAME of the matching EXT-X-MEDIA TYPE=VIDEO). */
  readonly name?: string | undefined
}

/** EXT-X-MEDIA TYPE=AUDIO. Without `uri` the audio is muxed in the variant itself. */
export type HlsAudioTrack = {
  readonly groupId: string
  readonly name: string
  readonly language?: string | undefined
  readonly uri?: string | undefined
  readonly isDefault: boolean
  readonly channels?: number | undefined
}

export type HlsMasterPlaylist = {
  readonly kind: 'master'
  readonly url: string
  /** I-frame (trick-play) variants are dropped: never a download target. */
  readonly variants: readonly HlsVariant[]
  /** Audio tracks by GROUP-ID (one Map lookup per variant, not a scan). */
  readonly audio: ReadonlyMap<string, readonly HlsAudioTrack[]>
  /** EXT-X-SESSION-KEY present (AES-128): the media playlists are encrypted (checked again there). */
  readonly sessionKey: boolean
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist

export type ParseOptions = {
  /**
   * Rewrites each segment uri once, while parsing (Twitch: `-unmuted.ts` → `-muted.ts`, which answer
   * 403 / 200). Zero extra requests; O(1) per segment.
   */
  readonly mapSegmentUri?: ((uri: string) => string) | undefined
  /** Refuse a playlist with more segments than this (a malformed or hostile one). Default 200,000. */
  readonly maxSegments?: number | undefined
}

/** No ENDLIST and not a VOD playlist: still growing (live, or an EVENT not ended). */
export const isOpenEnded = (playlist: HlsMediaPlaylist): boolean => !playlist.ended && playlist.playlistType !== 'VOD'

export const MAX_SEGMENTS = 200_000

const DRM_KEYFORMATS: ReadonlySet<string> = new Set([
  'com.apple.streamingkeydelivery',
  'com.microsoft.playready',
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', // Widevine
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95', // PlayReady
  'urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2', // FairPlay
])

const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['aac', 'mp3', 'ac3', 'ec3', 'eac3', 'mp2', 'ogg', 'oga', 'opus'])
const FMP4_EXTENSIONS: ReadonlySet<string> = new Set(['m4s', 'mp4', 'm4a', 'm4v', 'cmfv', 'cmfa', 'fmp4'])
const TS_EXTENSIONS: ReadonlySet<string> = new Set(['ts', 'mts', 'm2ts', 'tsv', 'tsa'])

const VARIABLE = /\{\$([A-Za-z0-9_-]+)\}/g

/**
 * Attribute list of a tag (`BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2"`). One pass, quotes
 * respected and removed; names as written (upper case by the spec). O(len).
 */
export function parseAttributes(list: string): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  const n = list.length
  while (i < n) {
    while (i < n && (list[i] === ' ' || list[i] === ',')) i++
    const eq = list.indexOf('=', i)
    if (eq === -1) break
    const name = list.slice(i, eq).trim()
    let value: string
    if (list[eq + 1] === '"') {
      const close = list.indexOf('"', eq + 2)
      const end = close === -1 ? n : close
      value = list.slice(eq + 2, end)
      i = end + 1
    } else {
      const comma = list.indexOf(',', eq + 1)
      const end = comma === -1 ? n : comma
      value = list.slice(eq + 1, end).trim()
      i = end
    }
    if (name) out.set(name, value)
  }
  return out
}

/** "n[@o]" → its parts; undefined when not numbers. */
function byteRangeOf(text: string): {length: number; offset?: number} | undefined {
  const at = text.indexOf('@')
  const length = Number(at === -1 ? text : text.slice(0, at))
  if (!Number.isSafeInteger(length) || length < 0) return undefined
  if (at === -1) return {length}
  const offset = Number(text.slice(at + 1))
  return Number.isSafeInteger(offset) && offset >= 0 ? {length, offset} : undefined
}

/** "0x1A2B…" → 16 bytes, left-padded. */
function ivOf(text: string): Uint8Array | undefined {
  const hex = text.replace(/^0x/i, '')
  if (!/^[0-9a-f]{1,32}$/i.test(hex)) return undefined
  const padded = hex.padStart(32, '0')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** The url without its query and fragment: identity across re-signed links. O(len). */
export function pathOf(uri: string): string {
  const q = uri.indexOf('?')
  const h = uri.indexOf('#')
  const end = q === -1 ? h : h === -1 ? q : Math.min(q, h)
  return end === -1 ? uri : uri.slice(0, end)
}

function extensionOf(uri: string): string {
  const p = pathOf(uri)
  const slash = p.lastIndexOf('/')
  const dot = p.lastIndexOf('.')
  return dot > slash ? p.slice(dot + 1).toLowerCase() : ''
}

/**
 * Resolves uris against one base. Absolute uris and plain relative names ("seg1.ts", "a/b.ts") are
 * joined by string, O(1) after the base is cut once; anything else ("/x", "../x", "?q", "//host")
 * goes through `URL`.
 */
class Resolver {
  readonly #base: string
  readonly #dir: string
  readonly #https: boolean

  constructor(base: string) {
    this.#base = base
    const p = pathOf(base)
    this.#dir = p.slice(0, p.lastIndexOf('/') + 1)
    this.#https = base.startsWith('https:')
  }

  resolve(uri: string): string {
    let out: string
    if (uri.startsWith('https://') || uri.startsWith('http://')) out = uri
    else if (
      this.#dir.includes('://') &&
      uri.length > 0 &&
      uri[0] !== '/' &&
      uri[0] !== '?' &&
      uri[0] !== '#' &&
      !uri.startsWith('.') &&
      !uri.includes('/.') &&
      !uri.includes(':')
    )
      out = this.#dir + uri
    else {
      try {
        out = new URL(uri, this.#base).href
      } catch {
        throw new HlsError('not-hls', `Not a valid uri in the playlist: ${uri.slice(0, 200)}`)
      }
    }
    if (this.#https && out.startsWith('http:')) {
      throw new HlsError('unsupported', 'The playlist (https) points at an insecure http uri.')
    }
    return out
  }
}

/** Unix ms of an ISO date, or undefined. */
function dateOf(text: string | undefined): number | undefined {
  if (!text) return undefined
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : undefined
}

function numberOf(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Parse a playlist. One pass over the text with `indexOf` (no `split` into an array of lines): O(L) for
 * L characters, O(n) memory for n segments (~200 B each: 18,000 segments ≈ 4 MB). Handles CRLF, BOM,
 * comments between EXT-X-STREAM-INF and its uri, EXT-X-MAP before or after EXTINF, BYTERANGE offset
 * continuation (only from the immediately preceding segment of the same uri), EXT-X-DEFINE NAME/VALUE
 * substitution, EXT-X-GAP, EXT-X-PROGRAM-DATE-TIME, EXT-X-DATERANGE, sliding windows (MEDIA- and
 * DISCONTINUITY-SEQUENCE). Ignores LL-HLS parts, I-frame playlists.
 * Refuses (HlsError): text not starting with #EXTM3U ('not-hls'), no segments and no variants in a
 * finished playlist ('empty'), DRM ('drm'), SAMPLE-AES, DEFINE IMPORT/QUERYPARAM, an https → http
 * downgrade, more than `maxSegments` segments ('unsupported'). Open-ended playlists parse fully.
 * `url` must be the final url after redirects.
 */
export function parsePlaylist(text: string, url: string, opts: ParseOptions = {}): HlsPlaylist {
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (pos < text.length && (text[pos] === ' ' || text[pos] === '\n' || text[pos] === '\r' || text[pos] === '\t'))
    pos++
  if (!text.startsWith('#EXTM3U', pos)) {
    throw new HlsError('not-hls', 'The site answered something that is not an HLS playlist.')
  }
  const maxSegments = opts.maxSegments ?? MAX_SEGMENTS
  const resolver = new Resolver(url)
  const defines = new Map<string, string>()
  const sub = (value: string): string =>
    defines.size === 0 || !value.includes('{$') ? value : value.replace(VARIABLE, (m, name) => defines.get(name) ?? m)
  const attrs = (list: string): Map<string, string> => {
    const map = parseAttributes(list)
    if (defines.size > 0) for (const [k, v] of map) map.set(k, sub(v))
    return map
  }

  // master state
  const variants: HlsVariant[] = []
  const audio = new Map<string, HlsAudioTrack[]>()
  const videoNames = new Map<string, string>()
  let pendingVariant: Map<string, string> | undefined
  let sessionKey = false

  // media state
  const segments: HlsSegment[] = []
  const keys: HlsKey[] = []
  const keyIds = new Map<string, number>()
  const inits: Array<HlsInit | undefined> = []
  const dateRanges: HlsDateRange[] = []
  let isMedia = false
  let mediaSequence = 0
  let discontinuitySequence = 0
  let targetDuration = 0
  let ended = false
  let playlistType: 'VOD' | 'EVENT' | undefined
  let total = 0
  let byteLength: number | undefined = 0
  let currentKey = -1
  let currentInit: HlsInit | undefined
  let currentInitKey = ''
  let periodInitKey: string | undefined
  let period = 0
  let discontinuities = 0
  let pendingDuration: number | undefined
  let pendingTitle: string | undefined
  let pendingRange: {length: number; offset?: number} | undefined
  let pendingGap = false
  let pendingDiscontinuity = false
  let pendingDate: number | undefined
  let nextDate: number | undefined
  let lastRangeUri: string | undefined
  let lastRangeEnd = 0

  while (pos < text.length) {
    let end = text.indexOf('\n', pos)
    if (end === -1) end = text.length
    let line = text.slice(pos, end)
    pos = end + 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    line = line.trim()
    if (line === '') continue

    if (line[0] !== '#') {
      // a uri line
      const raw = sub(line)
      if (pendingVariant) {
        const v = pendingVariant
        pendingVariant = undefined
        const resolution = v.get('RESOLUTION')
        const x = resolution ? resolution.toLowerCase().indexOf('x') : -1
        const width = x > 0 && resolution ? Number(resolution.slice(0, x)) : undefined
        const height = x > 0 && resolution ? Number(resolution.slice(x + 1)) : undefined
        const codecs = v.get('CODECS')
        variants.push({
          uri: resolver.resolve(raw),
          bandwidth: numberOf(v.get('BANDWIDTH')) ?? 0,
          averageBandwidth: numberOf(v.get('AVERAGE-BANDWIDTH')),
          width: width !== undefined && Number.isFinite(width) ? width : undefined,
          height: height !== undefined && Number.isFinite(height) ? height : undefined,
          frameRate: numberOf(v.get('FRAME-RATE')),
          codecs: codecs
            ? codecs
                .split(',')
                .map(c => c.trim())
                .filter(Boolean)
            : [],
          audioGroup: v.get('AUDIO') || undefined,
          name: v.get('VIDEO') || undefined,
        })
        continue
      }
      if (pendingDuration === undefined) continue // a uri with no EXTINF: not a segment
      if (segments.length >= maxSegments) {
        throw new HlsError('unsupported', `The playlist lists more than ${maxSegments} segments.`)
      }
      let uri = resolver.resolve(raw)
      if (opts.mapSegmentUri) uri = opts.mapSegmentUri(uri)
      // a new period: a discontinuity or a different init segment, once the current one has media
      const initKey = currentInitKey
      if (segments.length > 0 && (pendingDiscontinuity || initKey !== periodInitKey)) period++
      if (segments.length === 0 || inits.length <= period) {
        inits[period] = currentInit
        periodInitKey = initKey
      }
      if (pendingDiscontinuity) discontinuities++
      let range: ByteRange | undefined
      if (pendingRange) {
        let offset = pendingRange.offset
        if (offset === undefined) {
          if (lastRangeUri !== uri) throw new HlsError('unsupported', 'A BYTERANGE without an offset follows no range.')
          offset = lastRangeEnd
        }
        range = {offset, length: pendingRange.length}
        lastRangeUri = uri
        lastRangeEnd = offset + pendingRange.length
      } else lastRangeUri = undefined
      if (byteLength !== undefined) byteLength = range ? byteLength + range.length : undefined
      const date = pendingDate ?? (pendingDiscontinuity ? undefined : nextDate)
      segments.push({
        index: segments.length,
        sequence: mediaSequence + segments.length,
        uri,
        duration: pendingDuration,
        title: pendingTitle,
        range,
        period,
        discontinuity: discontinuitySequence + discontinuities,
        key: currentKey,
        gap: pendingGap,
        programDateTime: date,
      })
      total += pendingDuration
      nextDate = date === undefined ? undefined : date + pendingDuration * 1000
      pendingDuration = undefined
      pendingTitle = undefined
      pendingRange = undefined
      pendingGap = false
      pendingDiscontinuity = false
      pendingDate = undefined
      continue
    }

    if (!line.startsWith('#EXT')) continue // a comment
    const colon = line.indexOf(':')
    const tag = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1)

    switch (tag) {
      case '#EXTINF': {
        isMedia = true
        const comma = value.indexOf(',')
        const duration = Number(comma === -1 ? value : value.slice(0, comma))
        pendingDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0
        const title = comma === -1 ? '' : value.slice(comma + 1).trim()
        pendingTitle = title || undefined
        break
      }
      case '#EXT-X-TARGETDURATION':
        isMedia = true
        targetDuration = numberOf(value) ?? 0
        break
      case '#EXT-X-MEDIA-SEQUENCE':
        mediaSequence = Math.max(0, Math.floor(numberOf(value) ?? 0))
        break
      case '#EXT-X-DISCONTINUITY-SEQUENCE':
        discontinuitySequence = Math.max(0, Math.floor(numberOf(value) ?? 0))
        break
      case '#EXT-X-DISCONTINUITY':
        pendingDiscontinuity = true
        break
      case '#EXT-X-ENDLIST':
        ended = true
        break
      case '#EXT-X-PLAYLIST-TYPE':
        playlistType = value === 'VOD' ? 'VOD' : value === 'EVENT' ? 'EVENT' : undefined
        break
      case '#EXT-X-GAP':
        pendingGap = true
        break
      case '#EXT-X-PROGRAM-DATE-TIME':
        pendingDate = dateOf(value)
        break
      case '#EXT-X-BYTERANGE': {
        const r = byteRangeOf(value)
        if (!r) throw new HlsError('not-hls', `A malformed EXT-X-BYTERANGE: ${value.slice(0, 50)}`)
        pendingRange = r
        break
      }
      case '#EXT-X-MAP': {
        const a = attrs(value)
        const uriAttr = a.get('URI')
        if (!uriAttr) break
        const r = a.get('BYTERANGE')
        const parsed = r ? byteRangeOf(r) : undefined
        if (r && !parsed) throw new HlsError('not-hls', `A malformed EXT-X-MAP BYTERANGE: ${r}`)
        const range = parsed ? {offset: parsed.offset ?? 0, length: parsed.length} : undefined
        currentInit = {uri: resolver.resolve(uriAttr), range}
        // a different map opens a new period at the next segment (the same one repeated after a
        // discontinuity, as Twitch writes it, does not by itself)
        currentInitKey = `${currentInit.uri}|${range?.offset ?? ''}|${range?.length ?? ''}`
        break
      }
      case '#EXT-X-KEY':
      case '#EXT-X-SESSION-KEY': {
        const a = attrs(value)
        const method = a.get('METHOD')
        if (!method) break // a key without METHOD is ignored (streamlink, hls.js)
        const keyUri = a.get('URI') ?? ''
        const format = a.get('KEYFORMAT') ?? 'identity'
        if (method === 'NONE') {
          if (tag === '#EXT-X-KEY') currentKey = -1
          break
        }
        if (DRM_KEYFORMATS.has(format) || keyUri.startsWith('skd:')) {
          throw new HlsError('drm', 'This media is DRM-protected (encrypted for a licensed player).')
        }
        if (format !== 'identity') {
          throw new HlsError('drm', `This media is DRM-protected (key format ${format.slice(0, 80)}).`)
        }
        if (method !== 'AES-128') {
          throw new HlsError('unsupported', `HLS encryption ${method.slice(0, 40)} is not supported.`)
        }
        if (tag === '#EXT-X-SESSION-KEY') {
          sessionKey = true
          break
        }
        if (!keyUri) throw new HlsError('not-hls', 'An AES-128 key without a URI.')
        const ivText = a.get('IV')
        const iv = ivText ? ivOf(ivText) : undefined
        if (ivText && !iv) throw new HlsError('not-hls', `A malformed key IV: ${ivText.slice(0, 40)}`)
        const resolved = resolver.resolve(keyUri)
        const id = `${resolved}|${ivText ?? ''}`
        let index = keyIds.get(id)
        if (index === undefined) {
          index = keys.length
          keys.push({method: 'AES-128', uri: resolved, iv})
          keyIds.set(id, index)
        }
        currentKey = index
        break
      }
      case '#EXT-X-FAXS-CM':
        throw new HlsError('drm', 'This media is DRM-protected (Adobe Access).')
      case '#EXT-X-DEFINE': {
        const a = parseAttributes(value)
        if (a.has('IMPORT') || a.has('QUERYPARAM')) {
          throw new HlsError('unsupported', 'EXT-X-DEFINE IMPORT / QUERYPARAM is not supported.')
        }
        const name = a.get('NAME')
        if (name) defines.set(name, a.get('VALUE') ?? '')
        break
      }
      case '#EXT-X-DATERANGE': {
        const a = attrs(value)
        const id = a.get('ID')
        const start = dateOf(a.get('START-DATE'))
        if (!id || start === undefined) break
        dateRanges.push({
          id,
          class: a.get('CLASS'),
          startDate: start,
          endDate: dateOf(a.get('END-DATE')),
          duration: numberOf(a.get('DURATION')),
          plannedDuration: numberOf(a.get('PLANNED-DURATION')),
          attributes: Object.fromEntries(a),
        })
        break
      }
      case '#EXT-X-STREAM-INF':
        pendingVariant = attrs(value)
        break
      case '#EXT-X-MEDIA': {
        const a = attrs(value)
        const type = a.get('TYPE')
        const groupId = a.get('GROUP-ID') ?? ''
        if (type === 'VIDEO') {
          const name = a.get('NAME')
          if (name && !videoNames.has(groupId)) videoNames.set(groupId, name)
        } else if (type === 'AUDIO') {
          const uriAttr = a.get('URI')
          const channels = a.get('CHANNELS')
          const track: HlsAudioTrack = {
            groupId,
            name: a.get('NAME') ?? groupId,
            language: a.get('LANGUAGE'),
            uri: uriAttr ? resolver.resolve(uriAttr) : undefined,
            isDefault: a.get('DEFAULT') === 'YES',
            channels: channels ? numberOf(channels.split('/', 1)[0]) : undefined,
          }
          const group = audio.get(groupId)
          if (group) group.push(track)
          else audio.set(groupId, [track])
        }
        break
      }
      default:
        // EXT-X-VERSION, EXT-X-INDEPENDENT-SEGMENTS, EXT-X-BITRATE, EXT-X-I-FRAME-STREAM-INF, LL-HLS
        // (PART, PRELOAD-HINT, SKIP, SERVER-CONTROL, PART-INF), EXT-X-START, vendor tags: nothing to keep
        break
    }
  }

  if (variants.length > 0) {
    const named = videoNames.size
      ? variants.map(v => (v.name && videoNames.has(v.name) ? {...v, name: videoNames.get(v.name)} : v))
      : variants
    return {kind: 'master', url, variants: named, audio, sessionKey}
  }
  if (!isMedia || (segments.length === 0 && (ended || playlistType === 'VOD'))) {
    throw new HlsError('empty', 'The playlist lists no media.')
  }
  for (let p = inits.length; p <= period; p++) inits[p] = undefined
  const first = segments[0]
  const extension = first ? extensionOf(first.uri) : ''
  const format: HlsSegmentFormat = inits.some(i => i !== undefined)
    ? 'fmp4'
    : TS_EXTENSIONS.has(extension)
      ? 'ts'
      : AUDIO_EXTENSIONS.has(extension)
        ? 'packed-audio'
        : FMP4_EXTENSIONS.has(extension)
          ? 'fmp4'
          : 'unknown'
  if (byteLength !== undefined && segments.length > 0) {
    for (const init of inits) {
      if (!init) continue
      if (!init.range) {
        byteLength = undefined
        break
      }
      byteLength += init.range.length
    }
  }
  return {
    kind: 'media',
    url,
    segments,
    keys,
    inits,
    periods: segments.length ? period + 1 : 0,
    mediaSequence,
    discontinuitySequence,
    duration: total,
    targetDuration,
    ended,
    playlistType,
    format,
    extension,
    byteLength: segments.length > 0 ? byteLength : undefined,
    dateRanges,
  }
}

/**
 * Fetch and parse a playlist through the Source's session (its cookies, user agent, Referer). Accepts any
 * Content-Type (Bluesky's CDN sends a wrong one) and decides by the #EXTM3U header; the parsed `url` is
 * the response's final url. One request.
 */
export async function fetchPlaylist(
  session: HttpSession,
  url: string,
  opts: {
    readonly site: string
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly signal: AbortSignal
    readonly parse?: ParseOptions | undefined
  },
): Promise<HlsPlaylist> {
  const response = await session.get(url, {headers: opts.headers, signal: opts.signal})
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {})
    throw new HlsError('refused', `The ${opts.site} playlist was refused (HTTP ${response.status}).`)
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => {})
    throw new DownloadError('unavailable', `${opts.site} playlist not found.`, undefined, undefined, 'removed')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new DownloadError('network', `The ${opts.site} playlist answered HTTP ${response.status}.`)
  }
  const text = await response.text()
  return parsePlaylist(text, response.url || url, opts.parse)
}

/** The playlist as a media playlist, or HlsError('empty') for a master one. */
export function asMedia(playlist: HlsPlaylist): HlsMediaPlaylist {
  if (playlist.kind !== 'media') throw new HlsError('empty', 'Expected a media playlist, got a master playlist.')
  return playlist
}

/** The playlist as a master playlist, or HlsError('empty') for a media one. */
export function asMaster(playlist: HlsPlaylist): HlsMasterPlaylist {
  if (playlist.kind !== 'master') throw new HlsError('empty', 'Expected a master playlist, got a media playlist.')
  return playlist
}
