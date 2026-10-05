import { test } from '@playwright/test'
import { expect, openDemo } from './helpers'

/**
 * Frame-rate measurement on the 63k-triangle skinned mannequin. It only means something on a
 * machine with a GPU, so it is opt-in: PERF=1 npx playwright test perf
 */
test('plays a 50k+ triangle skinned character at 60 fps', async ({ page }) => {
  test.skip(process.env.PERF !== '1', 'set PERF=1 to run the frame-rate measurement')
  await openDemo(page, 'mannequin')
  await expect(page.getByTestId('model-stats')).toContainText('63,488 tris')
  await page.getByRole('button', { name: 'Play' }).click()

  const result = await page.evaluate(
    () =>
      new Promise<{ fps: number; p95Ms: number; frames: number; renderer: string }>((resolve) => {
        const gl = document.createElement('canvas').getContext('webgl2')!
        const info = gl.getExtension('WEBGL_debug_renderer_info')
        const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown'
        const intervals: number[] = []
        let last = performance.now()
        const start = last
        const tick = (now: number) => {
          intervals.push(now - last)
          last = now
          if (now - start < 5000) return requestAnimationFrame(tick)
          intervals.sort((a, b) => a - b)
          resolve({
            fps: (intervals.length / (now - start)) * 1000,
            p95Ms: intervals[Math.floor(intervals.length * 0.95)]!,
            frames: intervals.length,
            renderer,
          })
        }
        requestAnimationFrame(tick)
      }),
  )
  console.log(`perf: ${JSON.stringify(result)}`)
  expect(result.fps).toBeGreaterThanOrEqual(58)
})
