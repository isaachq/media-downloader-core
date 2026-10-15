import type {MdcApi} from '../../shared/contract'

declare global {
  interface Window {
    mdc?: MdcApi
  }
}

let override: MdcApi | undefined

/** The bridge exposed by the preload; tests inject a fake with `setApi`; the web demo installs its own (see `installWebBridge`). */
export function api(): MdcApi {
  const bridge = override ?? window.mdc
  if (!bridge) throw new Error('The desktop bridge is not available.')
  return bridge
}

export function setApi(fake: MdcApi | undefined): void {
  override = fake
}

/** Whether this page runs inside the desktop app (the preload would then have exposed `window.mdc`). */
export const isElectron = (): boolean => typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent)

/**
 * The web demo (the page served outside Electron): an in-browser bridge with
 * sample data. Loaded on demand, so the desktop build never carries it — and
 * a desktop window whose preload failed shows the real error, not sample data.
 */
export async function installWebBridge(): Promise<void> {
  if (window.mdc || isElectron()) return
  const {createWebBridge} = await import('./web-bridge')
  window.mdc = createWebBridge()
}
