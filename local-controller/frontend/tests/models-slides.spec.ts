import { test, expect } from '@playwright/test'

test('models1/2/3 render hero info box + ProteinViewer with EST timestamp', async ({ page }) => {
  await page.goto('http://localhost:3000/')
  await page.waitForSelector('.zone-marker-wrap', { state: 'attached', timeout: 15_000 })
  await page.waitForTimeout(1500)  // let map tiles settle

  // Press Enter to start the demo, then right-arrow 14 times to reach models1
  // (home → dispatching/running → catalog → catalog2 → catalog3 → catalog4 → md1 → md2 → md3
  //  → pd1 → pd2 → img → gen → tpu1 → tpu2 → tpu3 → models1)
  await page.keyboard.press('Enter')        // home → dispatching/running
  await page.waitForTimeout(800)
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(400)
  }

  // models1 — ProteinViewer + hero info box should be visible
  const viewer = page.locator('.protein-viewer-wrap')
  await expect(viewer).toBeVisible({ timeout: 5_000 })
  // 3Dmol creates a canvas inside the container — wait for it
  await page.waitForSelector('.protein-viewer-canvas canvas', { timeout: 10_000 })

  // EST timestamp label appears once the PDB fetch resolves
  const tsLabel = page.locator('.protein-viewer-ts')
  await expect(tsLabel).toContainText(/INFERRED \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} EST/, { timeout: 10_000 })

  await page.screenshot({ path: 'test-results/models1.png', fullPage: false })

  // Right-arrow → models2, viewer should still be there
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  await expect(viewer).toBeVisible()
  await page.screenshot({ path: 'test-results/models2.png', fullPage: false })

  // Right-arrow → models3
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  await expect(viewer).toBeVisible()
  await page.screenshot({ path: 'test-results/models3.png', fullPage: false })

  // models3 is the final manual slide. ArrowRight from here is a no-op
  // (transition to 'done' is auto-only via inference polling). Verify staying.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  await expect(viewer).toBeVisible()

  // Left-arrow back through models2 → models1 → tpu3 — viewer hides when leaving models
  await page.keyboard.press('ArrowLeft')   // models3 → models2
  await page.waitForTimeout(400)
  await expect(viewer).toBeVisible()
  await page.keyboard.press('ArrowLeft')   // models2 → models1
  await page.waitForTimeout(400)
  await expect(viewer).toBeVisible()
  await page.keyboard.press('ArrowLeft')   // models1 → tpu3
  await page.waitForTimeout(400)
  await expect(viewer).toBeHidden()

  // Right-arrow back to models1, viewer reappears
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  await expect(viewer).toBeVisible()
})
