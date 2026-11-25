import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { recordBundledModules } from './scripts/third-party.ts'

const apiPort = Number(process.env.TRAIL_PORT || 4477)

export default defineConfig({
  root: 'web',
  plugins: [react(), recordBundledModules()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // Keep the notices that libraries mark to be kept (/*! … */, @license), which name their
    // authors and licences. Vite drops them by default, and DOMPurify's is in no other file.
    rolldownOptions: { output: { comments: { legal: true } } },
  },
  server: {
    port: 4478,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
})
