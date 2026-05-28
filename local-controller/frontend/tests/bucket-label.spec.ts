import { test, expect } from '@playwright/test'

test('bucket label wraps tightly around text on Catalog slide', async ({ page }) => {
  await page.goto('/')

  // Wait for map to load (look for an existing zone marker)
  await page.waitForSelector('.zone-marker-wrap', { timeout: 15_000 })

  // Press Enter to start the demo (home → dispatching/running)
  await page.keyboard.press('Enter')
  // Press Enter again to advance to Catalog
  await page.waitForTimeout(800)
  await page.keyboard.press('Enter')

  // Wait for bucket label
  const label = page.locator('.bucket-label')
  await expect(label).toBeVisible({ timeout: 5_000 })

  // Read bounding boxes
  const box = await label.boundingBox()
  const name = await page.locator('.bucket-label-name').boundingBox()
  const meta = await page.locator('.bucket-label-meta').boundingBox()
  console.log('bucket-label box:', box)
  console.log('bucket-label-name box:', name)
  console.log('bucket-label-meta box:', meta)

  // Tight wrap check: box width should be close to the widest child + padding (24px)
  const widest = Math.max(name?.width ?? 0, meta?.width ?? 0)
  console.log('widest child:', widest, 'box width:', box?.width)
  // Allow up to 60px of padding/margin total (we set 12px L/R padding = 24px, plus border)
  expect(box!.width).toBeLessThan(widest + 60)
  // And the box should be reasonably small (not stretched to viewport width)
  expect(box!.width).toBeLessThan(600)

  await page.screenshot({ path: 'test-results/bucket-label.png', fullPage: false })
})
