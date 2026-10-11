import {defineConfig} from '@playwright/test'

const config = defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: {timeout: 30_000},
  workers: 1,
  reporter: [['list']],
})

export default config
