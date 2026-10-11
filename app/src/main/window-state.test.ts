// @vitest-environment node
import {describe, expect, it} from 'vitest'
import {defaultBounds, MIN_SIZE, restoreBounds} from './window-state'

const laptop = {x: 0, y: 25, width: 1440, height: 875} // 13" MacBook work area
const monitor = {x: 0, y: 0, width: 2560, height: 1400}

describe('window size', () => {
  it('opens at ~92% of a laptop screen, centered', () => {
    const b = defaultBounds(laptop)
    expect(b).toMatchObject({width: 1325, height: 805, maximized: false})
    expect(b.x).toBe(Math.round((1440 - 1325) / 2))
    expect(b.y).toBe(25 + Math.round((875 - 805) / 2))
  })

  it('caps the size on a large monitor and never goes below the minimum', () => {
    expect(defaultBounds(monitor)).toMatchObject({width: 1600, height: 1050})
    const tiny = defaultBounds({x: 0, y: 0, width: 800, height: 600})
    expect(tiny.width).toBe(MIN_SIZE.width)
    expect(tiny.height).toBe(MIN_SIZE.height)
  })

  it('restores the saved window when it is still on a screen', () => {
    const saved = {x: 100, y: 80, width: 1400, height: 900, maximized: true}
    expect(restoreBounds(saved, [laptop], laptop)).toEqual(saved)
  })

  it('ignores a window left on an unplugged monitor, or a damaged file', () => {
    const offScreen = {x: 3000, y: 100, width: 1400, height: 900, maximized: false}
    expect(restoreBounds(offScreen, [laptop], laptop)).toEqual(defaultBounds(laptop))
    expect(restoreBounds({x: 'a'}, [laptop], laptop)).toEqual(defaultBounds(laptop))
    expect(restoreBounds(undefined, [laptop], laptop)).toEqual(defaultBounds(laptop))
  })
})
