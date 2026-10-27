import {DownloadError} from '../../core/errors.js'
import type {AudioContainer} from '../../types.js'
import {MetaError} from '../meta/errors.js'
import type {CursorPage} from '../meta/listing.js'
import {dig, isObject, list, num, text} from '../meta/relay.js'
import {PRESET_ORDER} from './endpoints.js'
import {keyOf, parseSoundcloudLink} from './links.js'

/**
 * SoundCloud's api-v2 answers, reduced to what a download needs: a track's
 * transcodings (each a url that mints the signed media url), its policy
 * (ALLOW, MONETIZE, BLOCK for a region, SNIP for a Go+ preview) and what the
 * file is tagged with. Every reader is O(size of its answer).
 */

export type Transcoding = {
  /** The API url that mints the signed media url (`{url}`). */
  readonly url: string
  /** `aac_160k`, `aac_96k`, `mp3_0_0`, `opus_0_0`, `abr_sq`… */
  readonly preset: string
  /** `hls`, `progressive`, `encrypted-hls` (AES-128), `cbc-encrypted-hls` / `ctr-encrypted-hls` (DRM). */
  readonly protocol: string
  readonly mime: string
  /** A 30-second preview (Go+). */
  readonly snipped: boolean
  /** `sq`, `lq`; `hq` is Go+'s (a subscriber session). */
  readonly quality: string
}

export type SoundcloudTrack = {
  readonly id: string
  readonly title: string
  /** Its page (a private one with its `s-` token). */
  readonly url: string
  /** `<user>/<slug>` of its page, lower case: how a link finds it in memory. */
  readonly key: string | undefined
  readonly user: string
  readonly userName: string
  /** The credited artist (label releases), else the uploader. */
  readonly artist: string
  /** Seconds the stream lasts (a preview's 30 s for a snippet). */
  readonly duration: number | undefined
  /** Seconds the whole track lasts. */
  readonly fullDuration: number | undefined
  readonly policy: string | undefined
  readonly secret: string | undefined
  readonly transcodings: readonly Transcoding[]
  /** Sent with each transcoding call, as the site does (the clear streams answer without it too). */
  readonly authorization: string | undefined
  readonly artwork: string | undefined
  /** Unix seconds. */
  readonly createdAt: number | undefined
}

export type SoundcloudUser = {
  readonly id: string
  readonly permalink: string
  readonly name: string
  readonly trackCount: number | undefined
}

/** A set's track: whole, or only its id (sets carry 5 whole tracks, then stubs). */
export type TrackRef = SoundcloudTrack | string

export type SoundcloudSet = {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly user: string
  readonly userName: string
  readonly secret: string | undefined
  readonly tracks: readonly TrackRef[]
  readonly trackCount: number | undefined
}

export type Resolved =
  | {readonly kind: 'track'; readonly track: SoundcloudTrack}
  | {readonly kind: 'set'; readonly set: SoundcloudSet}
  | {readonly kind: 'user'; readonly user: SoundcloudUser}

const changed = (what: string) => new MetaError('format-changed', `SoundCloud: ${what}.`)

/** The id as the API writes it (a number), as a string. */
const idOf = (value: unknown): string | undefined => {
  const n = num(value)
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? String(n) : undefined
}

const seconds = (ms: unknown): number | undefined => {
  const n = num(ms)
  return n !== undefined && n > 0 ? n / 1000 : undefined
}

const unixOf = (value: unknown): number | undefined => {
  const raw = text(value)
  const ms = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/** The page of a track: a private one keeps its token in the path (the API's permalink usually has it). */
function pageOf(permalink: string, secret: string | undefined): string {
  if (!secret || permalink.endsWith(`/${secret}`)) return permalink
  return `${permalink.replace(/\/+$/, '')}/${secret}`
}

/** The artwork at 500 × 500 instead of the 100 × 100 the API names. */
const artworkOf = (value: unknown): string | undefined => text(value)?.replace(/-large(\.\w+)$/, '-t500x500$1')

function readTranscodings(value: unknown): Transcoding[] {
  const out: Transcoding[] = []
  for (const raw of list(value)) {
    const url = text(dig(raw, 'url'))
    const preset = text(dig(raw, 'preset'))
    const protocol = text(dig(raw, 'format', 'protocol')) ?? text(dig(raw, 'protocol'))
    if (!url || !preset || !protocol) continue
    out.push({
      url,
      preset,
      protocol,
      mime: text(dig(raw, 'format', 'mime_type')) ?? text(dig(raw, 'mime')) ?? '',
      snipped: dig(raw, 'snipped') === true,
      quality: text(dig(raw, 'quality')) ?? '',
    })
  }
  return out
}

/** A whole track (with its media), or undefined for a stub or something else. O(transcodings). */
export function readTrack(json: unknown): SoundcloudTrack | undefined {
  if (!isObject(json) || json['kind'] !== 'track') return undefined
  const id = idOf(json['id'])
  const permalink = text(json['permalink_url'])
  const media = json['media']
  if (!id || !permalink || !isObject(media)) return undefined
  const secret = text(json['secret_token'])
  const url = pageOf(permalink, secret)
  const link = parseSoundcloudLink(url)
  const user = text(dig(json, 'user', 'permalink')) ?? (link && 'user' in link ? link.user : '')
  const userName = text(dig(json, 'user', 'username')) ?? user
  return {
    id,
    title: text(json['title']) ?? id,
    url,
    key: link?.kind === 'track' ? keyOf(link.user, link.slug) : undefined,
    user,
    userName,
    artist: text(dig(json, 'publisher_metadata', 'artist')) ?? userName,
    duration: seconds(json['duration']),
    fullDuration: seconds(json['full_duration']),
    policy: text(json['policy']),
    secret,
    transcodings: readTranscodings(media['transcodings']),
    authorization: text(json['track_authorization']),
    artwork: artworkOf(json['artwork_url']),
    createdAt: unixOf(json['created_at']),
  }
}

function readUser(json: unknown): SoundcloudUser | undefined {
  const id = idOf(dig(json, 'id'))
  const permalink = text(dig(json, 'permalink'))
  if (!id || !permalink) return undefined
  return {id, permalink, name: text(dig(json, 'username')) ?? permalink, trackCount: num(dig(json, 'track_count'))}
}

/** A set (playlist or album): its whole tracks as they are, the rest as ids, in the set's order. O(tracks). */
export function readSet(json: unknown): SoundcloudSet | undefined {
  if (!isObject(json) || json['kind'] !== 'playlist') return undefined
  const id = idOf(json['id'])
  const url = text(json['permalink_url'])
  if (!id || !url) return undefined
  const tracks: TrackRef[] = []
  for (const raw of list(json['tracks'])) {
    const track = readTrack(raw)
    if (track) tracks.push(track)
    else {
      const stub = idOf(dig(raw, 'id'))
      if (stub) tracks.push(stub)
    }
  }
  const user = text(dig(json, 'user', 'permalink')) ?? ''
  return {
    id,
    title: text(json['title']) ?? id,
    url,
    user,
    userName: text(dig(json, 'user', 'username')) ?? user,
    secret: text(json['secret_token']),
    tracks,
    trackCount: num(json['track_count']),
  }
}

/** What `/resolve` found. A shape it doesn't know is a change on SoundCloud's side. */
export function readResolved(json: unknown): Resolved {
  const kind = dig(json, 'kind')
  if (kind === 'track') {
    const track = readTrack(json)
    if (track) return {kind: 'track', track}
  } else if (kind === 'playlist' || kind === 'system-playlist') {
    const set = readSet(json)
    if (set) return {kind: 'set', set}
  } else if (kind === 'user') {
    const user = readUser(json)
    if (user) return {kind: 'user', user}
  }
  throw changed(`resolve answered ${typeof kind === 'string' ? `a "${kind}"` : 'something'} it can't read`)
}

/** `/tracks?ids=`: whole tracks, in no particular order (callers map them by id). */
export function readTracks(json: unknown): SoundcloudTrack[] {
  if (!Array.isArray(json)) throw changed('the tracks of a set came back in another shape')
  const out: SoundcloudTrack[] = []
  for (const raw of json) {
    const track = readTrack(raw)
    if (track) out.push(track)
  }
  return out
}

const nextOf = (json: unknown): string | undefined => text(dig(json, 'next_href'))

/** A page of `/users/<id>/tracks`: whole tracks. */
export function readTrackPage(json: unknown): CursorPage<SoundcloudTrack> {
  const collection = dig(json, 'collection')
  if (!Array.isArray(collection)) throw changed('a page of tracks came back in another shape')
  const items: SoundcloudTrack[] = []
  for (const raw of collection) {
    const track = readTrack(raw)
    if (track) items.push(track)
  }
  return {items, next: nextOf(json)}
}

/**
 * A page of `/users/<id>/likes`: the liked tracks (a liked set is left out:
 * its own link downloads it). A page of only liked sets adds nothing, which
 * the walk counts as a stall (three in a row end it).
 */
export function readLikesPage(json: unknown): CursorPage<SoundcloudTrack> {
  const collection = dig(json, 'collection')
  if (!Array.isArray(collection)) throw changed('a page of likes came back in another shape')
  const items: SoundcloudTrack[] = []
  for (const raw of collection) {
    const track = readTrack(dig(raw, 'track'))
    if (track) items.push(track)
  }
  return {items, next: nextOf(json)}
}

/** A page of `/users/<id>/playlists` or `/albums`: whole sets (their tracks as refs). */
export function readSetPage(json: unknown): CursorPage<SoundcloudSet> {
  const collection = dig(json, 'collection')
  if (!Array.isArray(collection)) throw changed('a page of sets came back in another shape')
  const items: SoundcloudSet[] = []
  for (const raw of collection) {
    const set = readSet(raw)
    if (set) items.push(set)
  }
  return {items, next: nextOf(json)}
}

// ─── formats ──────────────────────────────────────────────────────────────

/** `cbc-encrypted-hls`, `ctr-encrypted-hls`: CENC (Widevine + PlayReady), refused, never handed to yt-dlp. */
export const isDrm = (t: Transcoding): boolean => t.protocol.startsWith('cbc-') || t.protocol.startsWith('ctr-')
/** Protocols downloaded here, in order: one request, then HLS, then HLS with AES-128. */
const PROTOCOLS: readonly string[] = ['progressive', 'hls', 'encrypted-hls']

export type AudioCodec = 'aac' | 'mp3' | 'opus'

export function codecOf(t: Transcoding): AudioCodec | undefined {
  const mime = t.mime.toLowerCase()
  if (mime.includes('mp4a') || mime.startsWith('audio/mp4') || t.preset.startsWith('aac')) return 'aac'
  if (mime.includes('opus') || t.preset.startsWith('opus')) return 'opus'
  if (mime.startsWith('audio/mpeg') || t.preset.startsWith('mp3')) return 'mp3'
  return undefined
}

/** A transcoding this module can download: clear, whole, not Go+'s, not the broken `abr_*` master. O(1). */
function downloadable(t: Transcoding, policy: string | undefined): boolean {
  return (
    PROTOCOLS.includes(t.protocol) &&
    !t.preset.startsWith('abr') &&
    t.quality !== 'hq' &&
    !isPreview(t, policy) &&
    codecOf(t) !== undefined
  )
}

/** A 30-second preview: `snipped`, a `SNIP` policy, or a `/preview/` url. O(1). */
export const isPreview = (t: Transcoding, policy: string | undefined): boolean =>
  t.snipped || policy === 'SNIP' || t.url.includes('/preview/')

const rankOf = (t: Transcoding, container: AudioContainer): number => {
  const preset = PRESET_ORDER.findIndex(prefix => t.preset.startsWith(prefix))
  // Opus asked and an Opus stream there: copied as it is, no re-encode
  const codecFirst = container === 'opus' && codecOf(t) === 'opus' ? -1 : 0
  return (codecFirst * 100 + (preset === -1 ? PRESET_ORDER.length : preset)) * 10 + PROTOCOLS.indexOf(t.protocol)
}

/**
 * The transcodings to try, best first: clear HLS AAC 160k, then 96k, then
 * the legacy MP3 (progressive before HLS: one request instead of 1 + n) and
 * Opus; an Opus profile takes an Opus stream first. O(t log t), t ≤ ~10.
 */
export function candidates(track: SoundcloudTrack, container: AudioContainer): Transcoding[] {
  return track.transcodings
    .filter(t => downloadable(t, track.policy))
    .sort((a, b) => rankOf(a, container) - rankOf(b, container))
}

/**
 * Why a track can't be downloaded at all, or undefined. Region blocks,
 * DRM-only label releases and Go+ previews are what they are on every
 * extractor: none is handed to yt-dlp. A track with no transcoding at all is
 * a change here (yt-dlp may know). O(transcodings).
 */
export function problemOf(track: SoundcloudTrack): DownloadError | MetaError | undefined {
  if (track.policy === 'BLOCK') {
    return new DownloadError(
      'unavailable',
      'SoundCloud does not play this track in your country (its owner limits it by region).',
      undefined,
      undefined,
      'geo-blocked',
    )
  }
  if (candidates(track, 'm4a').length > 0) return undefined
  if (track.transcodings.some(isDrm)) {
    // decision 6: no public drm hint; the message says DRM, and no source:* details (never yt-dlp)
    return new DownloadError(
      'unavailable',
      'This SoundCloud track is DRM-protected (encrypted for SoundCloud’s own player, as label releases are): it can’t be downloaded.',
      undefined,
      undefined,
      'format-unavailable',
    )
  }
  if (track.transcodings.some(t => isPreview(t, track.policy))) {
    return new DownloadError(
      'unavailable',
      'SoundCloud plays only a 30-second preview of this track (the whole track is for SoundCloud Go+ subscribers): not downloaded.',
      undefined,
      undefined,
      'format-unavailable',
    )
  }
  return changed(
    track.transcodings.length === 0
      ? 'this track lists no formats'
      : `no format of this track is one this module reads (${track.transcodings.map(t => `${t.preset}/${t.protocol}`).join(', ')})`,
  )
}

/** The signed media url a transcoding call answers. */
export function readStream(json: unknown): string {
  const url = text(dig(json, 'url'))
  if (!url) throw changed('a format answered without its media url')
  return url
}

/** Ids a set still needs (its stubs), in the set's order, de-duplicated. O(n). */
export function stubsOf(refs: readonly TrackRef[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ref of refs) {
    if (typeof ref !== 'string' || seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}
