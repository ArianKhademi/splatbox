import { test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { canvasCoverage, expect } from './helpers'

/**
 * The whole product through the browser: upload a model, watch the jobs finish, open it, delete it.
 * It needs a running stack (web, api, worker, Redis, storage), so it is opt-in:
 *
 *   STACK_URL=http://localhost:5173 API_TOKEN=... npx playwright test stack
 */
const STACK_URL = process.env.STACK_URL
const MODEL = fileURLToPath(new URL('../../worker/test/fixtures/RiggedFigure.glb', import.meta.url))

test('upload in the browser, convert, thumbnail, view, delete', async ({ page }) => {
  test.skip(!STACK_URL, 'set STACK_URL (and API_TOKEN) to run against a live stack')
  const name = `e2e upload ${Date.now()}`

  await page.goto(`${STACK_URL}/#/`)
  // Browsing is open; uploading needs the token, exchanged for a session cookie here.
  await expect(page.getByTestId('asset-grid')).toBeVisible()
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByLabel('API token').fill(process.env.API_TOKEN ?? '')
  await page.getByRole('button', { name: 'Use token' }).click()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()

  // Upload through the form: create, PUT straight to storage, complete.
  await page.getByRole('button', { name: 'Upload', exact: true }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Asset file').setInputFiles(MODEL)
  await page.getByTestId('upload-form').getByRole('button', { name: 'Upload' }).click()

  // The card appears while jobs run, then settles on ready with a poster.
  const card = page.getByTestId('asset-card').filter({ hasText: name })
  await expect(card).toBeVisible()
  await expect(card.getByTestId('card-status')).toHaveText('ready', { timeout: 120_000 })
  await expect(card.locator('img.poster')).toBeVisible()
  await expect(card).toContainText('256') // triangles
  await expect(card).toContainText('→') // size before and after

  // Hovering swaps in the animated turntable.
  await card.hover()
  await expect(card.locator('img.turntable')).toBeVisible()

  // The asset page loads the converted (Draco) GLB from storage and draws it.
  await card.click()
  const details = page.getByTestId('asset-details')
  await expect(details).toContainText('convert')
  await expect(details).toContainText('completed')
  await page.waitForFunction(() => Boolean(window.__splatbox?.assetReady), null, { timeout: 60_000 })
  await expect(page.getByTestId('model-stats')).toContainText('256 tris')
  expect((await canvasCoverage(page)).coverage).toBeGreaterThan(0.01)

  // Delete removes it from the grid.
  page.once('dialog', (dialog) => void dialog.accept())
  await details.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('asset-grid')).toBeVisible()
  await expect(page.getByTestId('asset-card').filter({ hasText: name })).toHaveCount(0)
})
