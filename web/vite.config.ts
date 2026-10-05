import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Dev and preview proxy /api to the api process so the session cookie stays same-origin.
const apiTarget = process.env.API_URL ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // index.html is the app; render.html is the bare page the worker drives to render splat turntables.
      input: { main: 'index.html', render: 'render.html' },
    },
  },
  server: { port: 5173, proxy: { '/api': apiTarget } },
  preview: { port: 4173, proxy: { '/api': apiTarget } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
