import { test } from '@playwright/test'
import { canvasCoverage, clockState, clockTime, dragScrubber, expect, frames, mixerTime, openDemo, seekTo, switchTo, type DemoId } from './helpers'

test.describe('viewer smoke: every asset kind loads and draws', () => {
  const cases: { id: DemoId; kind: string; check: RegExp; testId: string }[] = [
    { id: 'fox', kind: 'character', check: /576 tris · 1 meshes · 24 bones/, testId: 'model-stats' },
    { id: 'fox-motion', kind: 'clip', check: /0 tris · 0 meshes · 24 bones/, testId: 'model-stats' },
    { id: 'avocado-splat', kind: 'splat', check: /59,995 splats/, testId: 'splat-count' },
    { id: 'walk-pair', kind: 'pair', check: /4,672 tris · 1 meshes · 19 bones/, testId: 'model-stats' },
  ]
  for (const { id, kind, check, testId } of cases) {
    test(`${kind}: ${id}`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (err) => errors.push(err.message))
      await openDemo(page, id)
      await expect(page.locator('.viewer')).toHaveAttribute('data-kind', kind)
      await expect(page.getByTestId(testId)).toHaveText(check)
      await frames(page, 3)

      const { png, coverage } = await canvasCoverage(page)
      await testInfo.attach(`${id}.png`, { body: png, contentType: 'image/png' })
      // Something other than background is on screen: at least 1% of the canvas.
      expect(coverage).toBeGreaterThan(0.01)
      expect(errors).toEqual([])
    })
  }
})

test.describe('character and clip playback', () => {
  test('lists every clip in the file and switches between them', async ({ page }) => {
    await openDemo(page, 'fox')
    const clips = page.getByLabel('Clip', { exact: true })
    await expect(clips.locator('option')).toHaveText([/Survey \(3\.42s\)/, /Walk \(0\.71s\)/, /Run \(1\.16s\)/])
    await expect(page.getByTestId('frame-readout')).toHaveText('frame 0 / 102')
    await clips.selectOption({ index: 2 })
    await expect(page.getByTestId('frame-readout')).toHaveText('frame 0 / 34')
  })

  test('dragging the scrubber sets the mixer time, and the time and frame readouts follow', async ({ page }) => {
    await openDemo(page, 'fox') // Survey, 3.42 s
    const release = await dragScrubber(page, 0.75)
    const held = await clockState(page)
    expect(held.status).toBe('scrubbing')
    expect(held.time).toBeGreaterThan(0.7 * held.duration)
    expect(held.time).toBeLessThan(0.8 * held.duration)
    // The pose follows the thumb while the button is still down.
    expect(await mixerTime(page)).toBeCloseTo(held.time, 5)
    await expect(page.getByTestId('time-readout')).toHaveText(`${held.time.toFixed(2)}s / 3.42s`)
    await expect(page.getByTestId('frame-readout')).toHaveText(`frame ${Math.floor(held.time * 30 + 1e-3)} / 102`)
    const late = (await canvasCoverage(page)).png
    await release()
    expect((await clockState(page)).status).toBe('paused')

    // Scrubbing changes the picture: the pose near the end is not the pose near the start.
    const releaseEarly = await dragScrubber(page, 0.05)
    expect(await mixerTime(page)).toBeLessThan(0.1 * held.duration)
    const early = (await canvasCoverage(page)).png
    await releaseEarly()
    expect(early.equals(late)).toBe(false)
  })

  test('scrubbing during playback pauses it and releasing resumes', async ({ page }) => {
    await openDemo(page, 'fox')
    await page.getByRole('button', { name: 'Play' }).click()
    const release = await dragScrubber(page, 0.5)
    const held = await clockTime(page)
    await page.waitForTimeout(200)
    expect(await clockTime(page)).toBe(held) // the clock does not run while the thumb is held
    await release()
    expect((await clockState(page)).status).toBe('playing')
    await page.waitForTimeout(200)
    expect(await clockTime(page)).toBeGreaterThan(held)
  })

  test('play, pause, speed and loop drive the clock', async ({ page }) => {
    await openDemo(page, 'fox')
    await page.getByLabel('Clip', { exact: true }).selectOption({ index: 1 }) // Walk, 0.71 s
    await page.getByRole('button', { name: 'Play' }).click()
    await page.waitForTimeout(1000)
    // After a second of a 0.71 s clip the clock has wrapped at least once and is still running.
    const state = await page.evaluate(() => window.__splatbox!.clock!.getState())
    expect(state.status).toBe('playing')
    expect(state.time).toBeLessThan(0.71)

    await page.getByRole('button', { name: 'Pause' }).click()
    const paused = await clockTime(page)
    await page.waitForTimeout(300)
    expect(await clockTime(page)).toBe(paused)
    expect(await mixerTime(page)).toBeCloseTo(paused, 3)

    // Arrow keys step exactly one frame.
    await page.keyboard.press('ArrowRight')
    expect(await clockTime(page)).toBeCloseTo(Math.min(paused + 1 / 30, 0.7083), 3)

    // Without loop, playback stops on the last frame. At 2x the clip is over in 0.35 s, which on a
    // slow machine is less than the time between a click and the next assertion, so the states the
    // clock passes through are recorded in the page rather than sampled from the test.
    await page.getByLabel('Loop').uncheck()
    await page.getByLabel('Speed').selectOption('2')
    await page.evaluate(() => {
      const clock = window.__splatbox!.clock!
      const seen: string[] = []
      clock.subscribe(() => {
        const { status } = clock.getState()
        if (seen[seen.length - 1] !== status) seen.push(status)
      })
      ;(window as unknown as { __statuses: string[] }).__statuses = seen
    })
    await page.getByRole('button', { name: 'Play' }).click()
    await expect.poll(async () => (await clockState(page)).status).toBe('paused')
    expect(await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses)).toEqual(['playing', 'paused'])
    expect(await clockTime(page)).toBeCloseTo(0.7083, 3)
  })

  test('the skeleton overlay draws the bones over the mesh', async ({ page }) => {
    await openDemo(page, 'fox')
    await frames(page, 3)
    const before = await page.evaluate(() => window.__splatbox!.rendererMemory!())
    const plain = (await canvasCoverage(page)).png
    await page.getByLabel('Skeleton').check()
    await frames(page, 3)
    // The helper is one extra line geometry in the scene, and the picture changes.
    expect((await page.evaluate(() => window.__splatbox!.rendererMemory!())).geometries).toBe(before.geometries + 1)
    expect((await canvasCoverage(page)).png.equals(plain)).toBe(false)
    await page.getByLabel('Skeleton').uncheck()
    await frames(page, 3)
    expect(await page.evaluate(() => window.__splatbox!.rendererMemory!())).toEqual(before)
  })

  test('applies clips from a second GLB when the skeleton matches, and refuses when it does not', async ({ page }) => {
    await openDemo(page, 'fox')
    const clips = page.getByLabel('Clip', { exact: true })
    await expect(clips.locator('option')).toHaveCount(3)

    await page.getByLabel('External clip').selectOption({ label: 'Fox motion' })
    await expect(page.getByTestId('clip-match')).toHaveAttribute('data-fits', 'true')
    await expect(page.getByTestId('clip-match')).toContainText('21/21 tracks bound')
    await expect(clips.locator('option')).toHaveCount(6)
    // The first external clip is selected automatically and it poses the fox.
    await expect(clips.locator('option:checked')).toContainText('external')
    await seekTo(page, 0.5)
    expect(await mixerTime(page)).toBeCloseTo(0.5, 5)

    // The mannequin has different bone names, so none of the fox's tracks bind.
    await switchTo(page, 'mannequin')
    await page.getByLabel('External clip').selectOption({ label: 'Fox motion' })
    await expect(page.getByTestId('clip-match')).toHaveAttribute('data-fits', 'false')
    await expect(page.getByTestId('clip-match')).toContainText('0/21 tracks bound')
    await expect(page.getByLabel('Clip', { exact: true }).locator('option')).toHaveCount(1)
  })
})

test.describe('splat scene', () => {
  test('shows the splat count and the scale slider changes the picture', async ({ page }) => {
    await openDemo(page, 'avocado-splat')
    // 60,010 splats are in the file; 15 at the faded rim of the ground disc fall under the alpha cutoff.
    await expect(page.getByTestId('splat-count')).toHaveText('59,995 splats')
    await frames(page, 5)
    const full = await canvasCoverage(page)
    await page.getByLabel('Splat scale').fill('0.1')
    await frames(page, 5)
    const thin = await canvasCoverage(page)
    // Splats a tenth of the size leave gaps, so less of the canvas is covered.
    expect(thin.coverage).toBeLessThan(full.coverage * 0.9)
    expect(thin.png.equals(full.png)).toBe(false)
  })
})
