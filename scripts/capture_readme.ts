/**
 * Records the README's viewer GIFs and screenshots by driving the real web app in Chromium.
 *
 *   npx tsx scripts/capture_readme.ts
 *
 * The four viewer captures use the bundled demo assets, so they only need the web app
 * (`npm run dev -w web`, or WEB_URL). The browse-grid and asset-page screenshots need the api and
 * a worker running with assets in them (`npx tsx scripts/run_pipeline.ts`); they are skipped when
 * the api is not reachable. Needs ffmpeg on PATH to turn the recordings into GIFs.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'))
const WEB = process.env.WEB_URL ?? 'http://localhost:5173'
const OUT = join(ROOT, 'docs/images')
const SIZE = { width: 1280, height: 720 }

const READY: Record<string, string> = {
  fox: '/demo/fox.glb',
  'fox-motion': '/demo/fox-motion.glb',
  'avocado-splat': '/demo/avocado.splat',
  'walk-pair': '/demo/pair-motion.glb',
}

async function openDemo(page: Page, id: string): Promise<void> {
  await page.goto(`${WEB}/#/demo/${id}`)
  await page.waitForFunction((url) => (window as unknown as { __splatbox?: { assetReady?: string } }).__splatbox?.assetReady === url, READY[id])
  await page.waitForTimeout(400)
}

/** Drags inside the canvas to orbit the camera. */
async function orbit(page: Page, dx: number, dy = 0, steps = 45): Promise<void> {
  const box = (await page.locator('canvas').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps })
  await page.mouse.up()
}

/** Drags the timeline thumb from one fraction of the track to another. */
async function scrub(page: Page, from: number, to: number, steps = 40): Promise<void> {
  const box = (await page.getByLabel('Timeline').boundingBox())!
  const x = (f: number) => box.x + 8 + f * (box.width - 16)
  const y = box.y + box.height / 2
  await page.mouse.move(x(from), y)
  await page.mouse.down()
  await page.mouse.move(x(to), y, { steps })
  await page.mouse.up()
}

/**
 * Runs `action` on a fresh page while recording it, then converts the part of the recording that
 * starts once the asset was on screen into a GIF.
 */
async function recordGif(browser: Browser, name: string, id: string, action: (page: Page) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'splatbox-capture-'))
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir, size: SIZE } })
  const page = await context.newPage()
  const recordingStarted = Date.now()
  await openDemo(page, id)
  const skip = (Date.now() - recordingStarted) / 1000
  await action(page)
  await page.waitForTimeout(300)
  await context.close() // finishes the video file
  const video = await page.video()!.path()
  const gif = join(OUT, `${name}.gif`)
  const filter = 'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer:bayer_scale=4'
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip.toFixed(2), '-i', video, '-vf', filter, gif])
  rmSync(dir, { recursive: true, force: true })
  console.log(`wrote docs/images/${name}.gif`)
}

async function captureViewer(browser: Browser): Promise<void> {
  await recordGif(browser, 'viewer-character', 'fox', async (page) => {
    await page.getByLabel('Clip', { exact: true }).selectOption({ index: 1 }) // Walk
    await page.getByRole('button', { name: 'Play' }).click()
    await page.waitForTimeout(900)
    await page.getByLabel('Skeleton').check()
    await page.waitForTimeout(700)
    await orbit(page, 260)
    await page.waitForTimeout(600)
    await orbit(page, -180, 40)
    await page.waitForTimeout(500)
  })

  await recordGif(browser, 'viewer-clip-scrub', 'fox', async (page) => {
    await page.getByLabel('Clip', { exact: true }).selectOption({ index: 0 }) // Survey
    await scrub(page, 0, 0.8, 70)
    await page.waitForTimeout(300)
    await scrub(page, 0.8, 0.3, 50)
    await page.waitForTimeout(300)
    await page.getByLabel('Clip', { exact: true }).selectOption({ index: 2 }) // Run
    await page.waitForTimeout(300)
    await scrub(page, 0, 1, 60)
    await page.waitForTimeout(300)
  })

  await recordGif(browser, 'viewer-splat', 'avocado-splat', async (page) => {
    await orbit(page, 320, 20, 60)
    await page.waitForTimeout(400)
    const slider = page.getByLabel('Splat scale')
    for (const value of ['0.7', '0.45', '0.25', '0.45', '0.7', '1']) {
      await slider.fill(value)
      await page.waitForTimeout(280)
    }
    await orbit(page, -260, -30, 50)
    await page.waitForTimeout(400)
  })

  await recordGif(browser, 'viewer-pair', 'walk-pair', async (page) => {
    await page.getByRole('button', { name: 'Play' }).click()
    await page.waitForTimeout(2600)
    await page.getByRole('button', { name: 'Pause' }).click()
    await page.waitForTimeout(300)
    await scrub(page, 0.5, 0.95, 40)
    await page.waitForTimeout(250)
    await scrub(page, 0.95, 0.1, 60)
    await page.waitForTimeout(400)
  })
}

async function captureApp(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const health = await page.request.get(`${WEB}/api/health`).catch(() => null)
  if (!health?.ok()) {
    console.log('api not reachable: skipping the browse grid and asset page screenshots')
    return context.close()
  }

  await page.goto(`${WEB}/#/`)
  await page.getByLabel('API token').fill(process.env.API_TOKEN ?? '')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByTestId('asset-card').first().waitFor()
  // Thumbnails load lazily as cards come into view; wait for the visible ones.
  await page.waitForFunction(() => {
    const posters = [...document.querySelectorAll<HTMLImageElement>('img.poster')]
    return posters.length >= 8 && posters.every((img) => img.complete && img.naturalWidth > 0)
  })
  await page.screenshot({ path: join(OUT, 'browse-grid.png') })
  console.log('wrote docs/images/browse-grid.png')

  // Hover a card: the animated turntable is fetched and drawn over the poster.
  const card = page.getByTestId('asset-card').filter({ hasText: 'Lantern' })
  await card.hover()
  await card.locator('img.turntable').waitFor()
  await page.waitForTimeout(700)
  await card.screenshot({ path: join(OUT, 'card-hover.png') })
  console.log('wrote docs/images/card-hover.png')

  await card.click()
  await page.getByTestId('asset-details').waitFor()
  await page.waitForFunction(() => Boolean((window as unknown as { __splatbox?: { assetReady?: string } }).__splatbox?.assetReady))
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(OUT, 'asset-page.png') })
  console.log('wrote docs/images/asset-page.png')
  await context.close()
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ channel: 'chromium' })
  try {
    await captureViewer(browser)
    await captureApp(browser)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
