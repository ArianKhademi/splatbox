import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests run against the production build of the web app and only use the bundled demo
 * assets, so they need no api, storage, or worker.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 800 },
    // The full Chromium build in headless mode uses the GPU when the machine has one. On CI
    // runners without a GPU the flags let WebGL fall back to software rendering (SwiftShader);
    // SOFTWARE_GL=1 forces that path locally, to check the suite the way CI will run it.
    channel: 'chromium',
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.env.SOFTWARE_GL === '1' ? ['--use-angle=swiftshader'] : [])],
    },
  },
  webServer: {
    command: 'npm run build && npm run preview -- --strictPort',
    url: 'http://localhost:4173/demo/manifest.json',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
})
