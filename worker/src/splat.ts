import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'

export interface SplatRenderRequest {
  /** The scene file on local disk. */
  scenePath: string
  /** ply, splat or ksplat. */
  format: string
  flipY: boolean
  outDir: string
  frames: number
  size: number
}

export interface SplatRenderer {
  /** Renders the turntable and returns the frame PNG paths in turn order. */
  render(request: SplatRenderRequest): Promise<string[]>
  close(): Promise<void>
}

/** The object web/src/render/main.ts publishes on `window` for this module to drive. */
interface TurntablePage {
  ready?: boolean
  error?: string
  frame(index: number): Promise<string>
}

const SCENE_ROUTE = '__scene__'

/** Runs inside the page (where globalThis is window); typed here because the worker has no DOM types. */
const turntableOnPage = () => (globalThis as unknown as { splatboxTurntable?: TurntablePage }).splatboxTurntable

/**
 * Renders splat turntables with the web viewer's own splat code, in a headless Chromium.
 *
 * The page at `pageUrl` (web/render.html) loads a scene, frames it, and exposes `frame(i)`, which
 * moves the camera to view i, waits for the splats to be depth-sorted for that view, and returns
 * the canvas as a PNG data URL. The scene file never leaves this machine: Playwright intercepts
 * the page's request for it and answers from disk, so no storage URL or CORS setup is involved.
 */
export function createSplatRenderer(pageUrl: string): SplatRenderer {
  let browser: Promise<Browser> | null = null // launched on first use, then shared by later jobs

  return {
    async render(request) {
      browser ??= chromium.launch({
        // The full Chromium build (not the stripped headless shell) renders on the GPU when the
        // host has one. Servers usually do not, so also allow WebGL on the software rasterizer.
        channel: 'chromium',
        args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      })
      const context = await (await browser).newContext({
        viewport: { width: request.size, height: request.size },
        deviceScaleFactor: 1,
      })
      try {
        const page = await context.newPage()
        await page.route(
          (url) => url.pathname.endsWith(`/${SCENE_ROUTE}`),
          (route) => route.fulfill({ path: request.scenePath, contentType: 'application/octet-stream' }),
        )
        const query = new URLSearchParams({
          scene: SCENE_ROUTE,
          format: request.format,
          size: String(request.size),
          frames: String(request.frames),
          flipY: request.flipY ? '1' : '0',
        })
        await page.goto(`${pageUrl}?${query}`)
        // Wait until the page has either loaded the scene or given up.
        const handle = await page.waitForFunction(turntableOnPage, null, { timeout: 180_000 })
        const error = await handle.evaluate((turntable) => turntable?.error)
        if (error) throw new Error(`the render page could not load the scene: ${error}`)

        const paths: string[] = []
        for (let index = 0; index < request.frames; index++) {
          const dataUrl = await handle.evaluate((turntable, i) => turntable!.frame(i), index)
          const path = join(request.outDir, `frame_${String(index).padStart(4, '0')}.png`)
          await writeFile(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
          paths.push(path)
        }
        return paths
      } finally {
        await context.close()
      }
    },

    async close() {
      if (browser) await (await browser).close()
      browser = null
    },
  }
}
