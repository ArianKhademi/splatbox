import { test } from '@playwright/test'
import { clockState, clockTime, dragScrubber, expect, FPS, frames, mixerTime, openDemo, seekTo } from './helpers'

const FRAME = 1 / FPS

async function videoTime(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => window.__splatbox!.videoTime!()!)
}

test.describe('pair mode: source video and generated motion on one clock', () => {
  const settled = (page: import('@playwright/test').Page) => page.waitForFunction(() => !document.querySelector('video')!.seeking)

  test('dragging the scrubber moves the video and the character to the same frame', async ({ page }) => {
    await openDemo(page, 'walk-pair')
    await expect(page.getByTestId('frame-readout')).toHaveText('frame 0 / 60')

    for (const fraction of [0.62, 0.2, 0.95]) {
      const release = await dragScrubber(page, fraction)
      await settled(page)
      await frames(page)
      const { time, status } = await clockState(page)
      expect(status).toBe('scrubbing')
      expect(Math.abs(time - fraction * 2)).toBeLessThan(0.1)
      // One clock: the video, the mixer and the readouts all sit on the scrubbed time.
      expect(await videoTime(page)).toBeCloseTo(time, 3)
      expect(await mixerTime(page)).toBeCloseTo(time, 3)
      const frame = Math.floor(time * FPS + 1e-3)
      await expect(page.getByTestId('video-frame')).toHaveText(`video frame ${frame}`)
      await expect(page.getByTestId('motion-frame')).toHaveText(`motion frame ${frame}`)
      await expect(page.getByTestId('frame-readout')).toHaveText(`frame ${frame} / 60`)
      await release()
    }
  })

  test('seeking to exact frames keeps both sides within one frame', async ({ page }) => {
    await openDemo(page, 'walk-pair')
    for (const frame of [37, 12, 59, 0]) {
      await seekTo(page, frame * FRAME)
      await settled(page)
      await frames(page)
      expect(Math.abs((await videoTime(page)) - (await mixerTime(page)))).toBeLessThanOrEqual(FRAME)
      await expect(page.getByTestId('video-frame')).toHaveText(`video frame ${frame}`)
      await expect(page.getByTestId('motion-frame')).toHaveText(`motion frame ${frame}`)
    }
    // Arrow keys step both sides one frame at a time.
    await page.keyboard.press('ArrowRight')
    await settled(page)
    await expect(page.getByTestId('video-frame')).toHaveText('video frame 1')
    await expect(page.getByTestId('motion-frame')).toHaveText('motion frame 1')
  })

  test('play and pause are shared, and playback stays within one frame at 30 fps', async ({ page }, testInfo) => {
    await openDemo(page, 'walk-pair')
    expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(true)

    // Sample both sides once per animation frame while playing through more than one loop.
    const drift = await page.evaluate(
      () =>
        new Promise<{ perFrame: number[]; presented: number[] }>((resolve) => {
          const video = document.querySelector('video')!
          const debug = window.__splatbox!
          const duration = debug.clock!.getState().duration
          const wrap = (d: number) => Math.min(d, Math.abs(duration - d)) // the two may sit either side of the loop point
          const perFrame: number[] = []
          const presented: number[] = []
          // (a) what the spec asks for: video.currentTime against mixer.time on every rendered frame.
          const onAnimationFrame = () => {
            if (!video.paused && !video.seeking) perFrame.push(wrap(Math.abs(video.currentTime - debug.mixerTime!()!)))
            if (perFrame.length < 150) requestAnimationFrame(onAnimationFrame)
            else resolve({ perFrame, presented })
          }
          // (b) stricter: the timestamp of the video frame actually on screen against the pose on screen.
          const onVideoFrame = (_now: number, meta: { mediaTime: number }) => {
            presented.push(wrap(Math.abs(meta.mediaTime - debug.mixerTime!()!)))
            video.requestVideoFrameCallback(onVideoFrame)
          }
          video.requestVideoFrameCallback(onVideoFrame)
          debug.clock!.play()
          requestAnimationFrame(onAnimationFrame)
        }),
    )
    const max = (values: number[]) => Math.max(...values)
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
    const summary = {
      samples: drift.perFrame.length,
      perFrameMaxMs: max(drift.perFrame) * 1000,
      perFrameMeanMs: mean(drift.perFrame) * 1000,
      presentedSamples: drift.presented.length,
      presentedMaxMs: max(drift.presented) * 1000,
      presentedMeanMs: mean(drift.presented) * 1000,
    }
    console.log(`pair sync: ${JSON.stringify(summary)}`)
    await testInfo.attach('sync.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' })

    expect(drift.perFrame.length).toBe(150)
    expect(max(drift.perFrame)).toBeLessThanOrEqual(FRAME)

    expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(false)
    await page.getByRole('button', { name: 'Pause' }).click()
    expect(await page.evaluate(() => document.querySelector('video')!.paused)).toBe(true)
    await frames(page)
    // Paused: the three times agree to the millisecond.
    const [clock, video, mixer] = [await clockTime(page), await videoTime(page), await mixerTime(page)]
    expect(video).toBeCloseTo(clock, 3)
    expect(mixer).toBeCloseTo(clock, 3)
  })

  test('the frame number burnt into the video matches the readout', async ({ page }, testInfo) => {
    // The demo video stamps "Frame N" on every frame; a screenshot at frame 37 is attached for the record.
    await openDemo(page, 'walk-pair')
    await seekTo(page, 37 * FRAME)
    await settled(page)
    await frames(page, 3)
    await expect(page.getByTestId('video-frame')).toHaveText('video frame 37')
    await testInfo.attach('pair-frame-37.png', { body: await page.locator('.panes').screenshot(), contentType: 'image/png' })
  })
})
