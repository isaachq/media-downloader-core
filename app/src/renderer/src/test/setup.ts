import '@testing-library/jest-dom/vitest'
import {cleanup} from '@testing-library/react'
import {afterEach, vi} from 'vitest'

/**
 * Warnings are bugs: a deprecated Ant Design prop, a React key or act()
 * problem fails the test that caused it, so none reaches the app's console.
 */
const warnings: string[] = []
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    const text = args.map(String).join(' ')
    if (/\[antd|Warning:|act\(/.test(text)) warnings.push(text)
    original(...args)
  }
}

afterEach(() => {
  cleanup()
  const found = warnings.splice(0)
  if (found.length) throw new Error(`warnings:\n${[...new Set(found)].join('\n')}`)
})

// jsdom lacks these browser APIs that Ant Design relies on (main-process tests run in plain node)
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
  // jsdom computes no pseudo-elements (::before, scrollbars): answer with the element's own style
  // instead of jsdom's "Not implemented" notice on every measurement
  const computedStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = (element: Element) => computedStyle(element)
}
