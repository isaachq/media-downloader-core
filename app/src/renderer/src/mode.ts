import {MODE_MISMATCH, type RunMode} from '../../shared/contract'
import type {MessageKey, Translate} from './i18n'

/** The name of a mode ("TikTok", "YouTube and websites"…). */
export const modeName = (t: Translate, mode: RunMode): string => t(`mode.${mode}` as MessageKey)

/** The words for a link of another mode, from the main process's refusal ("mode-mismatch:instagram"); else undefined. */
export function mismatchText(t: Translate, error: unknown, mode: RunMode): string | undefined {
  const text = error instanceof Error ? error.message : String(error)
  const found = new RegExp(`${MODE_MISMATCH}:(\\w+)`).exec(text)
  if (!found) return undefined
  return t('mode.wrongLink', {site: modeName(t, found[1] as RunMode), mode: modeName(t, mode)})
}
