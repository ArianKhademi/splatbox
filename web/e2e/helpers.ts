import { expect, type Page } from '@playwright/test'

export const FPS = 30

/** URL of the main file of each demo asset; the viewer publishes it as `assetReady` once loaded and framed. */
export const DEMO = {
  fox: '/demo/fox.glb',
  mannequin: '/demo/mannequin.glb',
  'fox-motion': '/demo/fox-motion.glb',
  'avocado-splat': '/demo/avocado.splat',
  'walk-pair': '/demo/pair-motion.glb',
} as const

export type DemoId = keyof typeof DEMO

async function waitReady(page: Page, id: DemoId): Promise<void> {
  await page.waitForFunction((url) => window.__splatbox?.assetReady === url, DEMO[id], { timeout: 120_000 })
  if (id === 'walk-pair') {
    // The pair is ready when the clock has a duration, which needs the video's metadata too.
    await page.waitForFunction(() => (window.__splatbox?.clock?.getState().duration ?? 0) > 0)
  }
}

export async function openDemo(page: Page, id: DemoId): Promise<void> {
  await page.goto(`/#/demo/${id}`)
  await waitReady(page, id)
}

/** Switches asset through the sidebar, which keeps the viewer (and its WebGL context) mounted. */
export async function switchTo(page: Page, id: DemoId): Promise<void> {
  await page.getByTestId(`asset-${id}`).click()
  await waitReady(page, id)
}

/** Waits for the render loop to draw `count` more frames. */
export async function frames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
        step(n)
      }),
    count,
  )
}

/**
 * Screenshots the canvas and returns the fraction of its pixels that differ from the background
 * colour, i.e. how much of the picture is asset, grid, or splats.
 */
export async function canvasCoverage(page: Page): Promise<{ png: Buffer; coverage: number }> {
  const png = await page.locator('canvas').screenshot()
  const coverage = await page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    let different = 0
    // The stage background is #14161b = rgb(20, 22, 27).
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i]! - 20) + Math.abs(data[i + 1]! - 22) + Math.abs(data[i + 2]! - 27) > 24) different++
    }
    return different / (data.length / 4)
  }, png.toString('base64'))
  return { png, coverage }
}

export async function clockTime(page: Page): Promise<number> {
  return page.evaluate(() => window.__splatbox!.clock!.getState().time)
}

export async function mixerTime(page: Page): Promise<number> {
  return page.evaluate(() => window.__splatbox!.mixerTime!()!)
}

/** Jumps the clock to an exact time, for assertions that need an exact frame. */
export async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => window.__splatbox!.clock!.seek(t), seconds)
  await frames(page)
}

/**
 * Drags the timeline thumb with the real mouse to `fraction` of the way along and holds it there.
 * Returns the function that releases the button.
 */
export async function dragScrubber(page: Page, fraction: number): Promise<() => Promise<void>> {
  const scrubber = page.getByLabel('Timeline')
  const box = (await scrubber.boundingBox())!
  const state = await page.evaluate(() => window.__splatbox!.clock!.getState())
  // The centre of the thumb travels from half a thumb inside one end of the track to half a thumb inside the other.
  const inset = 8
  const x = (f: number) => box.x + inset + f * (box.width - 2 * inset)
  const y = box.y + box.height / 2
  await page.mouse.move(x(state.duration > 0 ? state.time / state.duration : 0), y)
  await page.mouse.down()
  await page.mouse.move(x(fraction), y, { steps: 10 })
  await frames(page)
  return async () => {
    await page.mouse.up()
    await frames(page)
  }
}

export async function clockState(page: Page) {
  return page.evaluate(() => window.__splatbox!.clock!.getState())
}

export { expect }
