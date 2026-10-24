import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  type AppSettings,
  AUDIO_FORMATS,
  BROWSERS,
  type Format,
  isLanguage,
  pickLanguage,
  QUALITIES,
  type Quality,
  type ThemeMode,
  VIDEO_FORMATS,
} from '../shared/contract'

/** First-run settings; `languages` are the system's preferred languages, in order. */
export function defaultSettings(
  downloadDir: string,
  maxConcurrency: number,
  languages: readonly string[],
): AppSettings {
  return {
    language: pickLanguage(languages),
    theme: 'system',
    downloadDir,
    format: 'mp4',
    quality: 'best',
    concurrency: maxConcurrency,
    validation: 'full',
    cookiesFromBrowser: '',
    embedMetadata: true,
    embedThumbnail: false,
    longVideoMinutes: 30,
    notifications: true,
    portableNames: true,
    autoUpdate: true,
    slideshowMode: 'video',
    slideshowSeconds: 3,
    tourDone: false,
    syncEnabled: false,
    validateAfter: false,
    cpuBoost: false,
  }
}

/** The most simultaneous downloads: with half the processors, and with up to 60% of them. */
export type ConcurrencyLimits = {readonly half: number; readonly boosted: number}

const FORMATS: readonly string[] = [...VIDEO_FORMATS, ...AUDIO_FORMATS]

/**
 * Merge an untrusted patch (it comes from the renderer) into settings: every
 * field is type- and range-checked, unknown or invalid values are ignored
 * (so is a settings.json of an older version: its `mode`, one site per run, is gone).
 */
export function mergeSettings(current: AppSettings, patch: unknown, limits: ConcurrencyLimits): AppSettings {
  if (typeof patch !== 'object' || patch === null) return current
  const p = patch as Record<string, unknown>
  const next: {-readonly [K in keyof AppSettings]: AppSettings[K]} = {...current}
  // the boost first: it decides how many downloads at once are allowed
  if (typeof p['cpuBoost'] === 'boolean') next.cpuBoost = p['cpuBoost']
  const maxConcurrency = next.cpuBoost ? limits.boosted : limits.half
  if (isLanguage(p['language'])) next.language = p['language']
  if (p['theme'] === 'system' || p['theme'] === 'light' || p['theme'] === 'dark') next.theme = p['theme'] as ThemeMode
  if (typeof p['downloadDir'] === 'string' && path.isAbsolute(p['downloadDir'])) next.downloadDir = p['downloadDir']
  if (typeof p['format'] === 'string' && FORMATS.includes(p['format'])) next.format = p['format'] as Format
  if (typeof p['quality'] === 'string' && (QUALITIES as readonly string[]).includes(p['quality']))
    next.quality = p['quality'] as Quality
  if (Number.isInteger(p['concurrency']))
    next.concurrency = Math.min(maxConcurrency, Math.max(1, p['concurrency'] as number))
  // boost off: what was allowed only with it comes down to the new ceiling
  next.concurrency = Math.min(maxConcurrency, next.concurrency)
  if (typeof p['validateAfter'] === 'boolean') next.validateAfter = p['validateAfter']
  if (p['validation'] === 'full' || p['validation'] === 'quick' || p['validation'] === 'none')
    next.validation = p['validation']
  if (
    typeof p['cookiesFromBrowser'] === 'string' &&
    (p['cookiesFromBrowser'] === '' || (BROWSERS as readonly string[]).includes(p['cookiesFromBrowser']))
  )
    next.cookiesFromBrowser = p['cookiesFromBrowser']
  if (typeof p['embedMetadata'] === 'boolean') next.embedMetadata = p['embedMetadata']
  if (typeof p['embedThumbnail'] === 'boolean') next.embedThumbnail = p['embedThumbnail']
  if (Number.isInteger(p['longVideoMinutes']))
    next.longVideoMinutes = Math.min(600, Math.max(5, p['longVideoMinutes'] as number))
  if (typeof p['notifications'] === 'boolean') next.notifications = p['notifications']
  if (typeof p['portableNames'] === 'boolean') next.portableNames = p['portableNames']
  if (typeof p['autoUpdate'] === 'boolean') next.autoUpdate = p['autoUpdate']
  if (p['slideshowMode'] === 'video' || p['slideshowMode'] === 'images-audio' || p['slideshowMode'] === 'images') {
    next.slideshowMode = p['slideshowMode']
  }
  if (typeof p['tourDone'] === 'boolean') next.tourDone = p['tourDone']
  if (typeof p['syncEnabled'] === 'boolean') next.syncEnabled = p['syncEnabled']
  if (typeof p['slideshowSeconds'] === 'number' && Number.isFinite(p['slideshowSeconds'])) {
    next.slideshowSeconds = Math.min(30, Math.max(1, Math.round(p['slideshowSeconds'])))
  }
  return next
}

/** settings.json in userData; written atomically, a corrupt file falls back to defaults. */
export class SettingsStore {
  #current: AppSettings

  constructor(
    private readonly file: string,
    defaults: AppSettings,
    private readonly limits: ConcurrencyLimits,
  ) {
    this.#current = defaults
  }

  get current(): AppSettings {
    return this.#current
  }

  async load(): Promise<AppSettings> {
    try {
      const saved: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.#current = mergeSettings(this.#current, saved, this.limits)
    } catch {
      // first launch or unreadable file: keep defaults
    }
    return this.#current
  }

  async update(patch: unknown): Promise<AppSettings> {
    this.#current = mergeSettings(this.#current, patch, this.limits)
    await fs.mkdir(path.dirname(this.file), {recursive: true})
    const tmp = `${this.file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.#current, null, 2))
    await fs.rename(tmp, this.file)
    return this.#current
  }
}
