import { test } from '@playwright/test'
import { expect, frames, openDemo, switchTo, type DemoId } from './helpers'

const ORDER: DemoId[] = ['mannequin', 'fox-motion', 'avocado-splat', 'walk-pair', 'fox']

test('switching assets 50 times leaves no geometries or textures behind', async ({ page }) => {
  test.setTimeout(600_000)
  await openDemo(page, 'fox')
  const memory = () => page.evaluate(() => window.__splatbox!.rendererMemory!())

  const readings: { geometries: number; textures: number }[] = []
  let switches = 0
  for (let cycle = 0; cycle < 10; cycle++) {
    for (const id of ORDER) {
      await switchTo(page, id)
      switches++
    }
    // Back on the fox: let disposal of the previous asset settle, then read the renderer's counters.
    await frames(page, 5)
    readings.push(await memory())
  }
  console.log(`renderer.info.memory after each of 10 cycles (${switches} switches): ${JSON.stringify(readings)}`)

  expect(switches).toBe(50)
  // Every time the same asset is back on screen the counts are the same as the first time.
  for (const reading of readings) expect(reading).toEqual(readings[0])
})
