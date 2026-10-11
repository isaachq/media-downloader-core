import type {MdcApi} from '../../shared/contract'

declare global {
  interface Window {
    mdc?: MdcApi
  }
}

let override: MdcApi | undefined

/** The bridge exposed by the preload; tests inject a fake with `setApi`. */
export function api(): MdcApi {
  const bridge = override ?? window.mdc
  if (!bridge) throw new Error('The desktop bridge is not available.')
  return bridge
}

export function setApi(fake: MdcApi | undefined): void {
  override = fake
}
