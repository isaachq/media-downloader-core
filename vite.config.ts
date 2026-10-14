import path from 'node:path'
import react from '@vitejs/plugin-react'
import {defineConfig} from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
  resolve: {
    alias: {
      'media-downloader-core': path.resolve(__dirname, 'src/index.ts'),
    },
  },
})
