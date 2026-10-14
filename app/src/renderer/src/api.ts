import type {MdcApi} from '../../shared/contract'
import {createWebBridge} from './web-bridge'

declare global {
  interface Window {
    mdc?: MdcApi
  }
}

let override: MdcApi | undefined
let webFallback: MdcApi | undefined

/** The bridge exposed by the preload; tests inject a fake with `setApi`; web mode uses web-bridge. */
export function api(): MdcApi {
  if (override) return override
  if (typeof window !== 'undefined' && window.mdc) return window.mdc
  if (!webFallback) {
    webFallback = createWebBridge()
    if (typeof window !== 'undefined') {
      window.mdc = webFallback
    }
  }
  return webFallback
}

export function setApi(fake: MdcApi | undefined): void {
  override = fake
}
