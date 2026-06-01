import { test, expect } from '@playwright/test'

test('models1/2/3 with hero info box open - fresh screenshots', async ({ page }) => {
  await page.goto('http://localhost:3000/')
  await page.waitForSelector('.zone-marker-wrap', { state: 'attached', timeout: 15_000 })
  await page.waitForTimeout(1500)

  // Press Enter + arrow right 15 times to reach models1
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(400)
  }

  // Wait for ProteinViewer to render the real PDB
  await page.waitForSelector('.protein-viewer-canvas canvas', { timeout: 15_000 })
  await expect(page.locator('.protein-viewer-ts')).toContainText(/INFERRED/, { timeout: 10_000 })

  // Click the hamburger to open the hero info box
  await page.locator('button:has(.material-icons)').first().click()
  await page.waitForTimeout(700)  // let opacity fade complete

  await page.screenshot({ path: 'test-results/models1-info-open.png', fullPage: false })

  // Right-arrow → models2, info box stays open
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'test-results/models2-info-open.png', fullPage: false })

  // Right-arrow → models3
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'test-results/models3-info-open.png', fullPage: false })
})
