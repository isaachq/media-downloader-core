import react from '@vitejs/plugin-react'
import {defineConfig} from 'vitest/config'

const config = defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/renderer/src/**/*.test.tsx'],
    setupFiles: ['src/renderer/src/test/setup.ts'],
    css: false,
    testTimeout: 20_000,
  },
})

export default config
