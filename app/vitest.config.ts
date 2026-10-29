import react from '@vitejs/plugin-react'
import {defineConfig} from 'vitest/config'

const config = defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/renderer/src/**/*.test.{ts,tsx}', 'src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
    setupFiles: ['src/renderer/src/test/setup.ts'],
    css: false,
    testTimeout: 20_000,
    // a jsdom fork per CPU (11 on 12 threads) starved the workers until they died mid-run; 4 ends in about 90 s
    maxWorkers: 4,
  },
})

export default config
