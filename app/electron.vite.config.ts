import react from '@vitejs/plugin-react'
import {defineConfig, externalizeDepsPlugin} from 'electron-vite'

// The engine has no runtime dependencies, so it is bundled into the main process:
// the packaged app ships out/ only, with no node_modules.
const bundleEngine = externalizeDepsPlugin({exclude: ['media-downloader-core']})

const config = defineConfig({
  main: {plugins: [bundleEngine]},
  preload: {plugins: [bundleEngine]},
  renderer: {plugins: [react()]},
})

export default config
