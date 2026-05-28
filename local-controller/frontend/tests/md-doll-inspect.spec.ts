import { test, expect } from '@playwright/test'

test('inspect md russian doll across phases', async ({ page }) => {
  await page.goto('http://localhost:3000/')
  await page.waitForSelector('.zone-marker-wrap', { state: 'attached', timeout: 15_000 })
  await page.waitForTimeout(1500)  // wait for map tiles

  // home → dispatching/running
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  // → catalog
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  // → catalog2
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  // → catalog3
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  // → catalog4
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)

  // → md1
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)  // wait for zoom + doll delay
  await page.screenshot({ path: 'test-results/md1.png', fullPage: false })

  // → md2
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'test-results/md2.png', fullPage: false })

  // → md3
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'test-results/md3.png', fullPage: false })

  // → pd1 (Hyperdisk hub + fanout, stays on us-central1)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'test-results/pd1.png', fullPage: false })

  // → pd2 (zoom out to CONUS, SPOT/FLEX chips)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'test-results/pd2.png', fullPage: false })

  // → pd3 (stays on CONUS, chips persist)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'test-results/pd3.png', fullPage: false })

  // Get bounding boxes
  const outer = await page.locator('.md-doll-outer').boundingBox()
  const middle = await page.locator('.md-doll-middle').boundingBox()
  const inner = await page.locator('.md-doll-inner').boundingBox()
  const storageBoxes = await page.locator('.md-doll-storage').all()
  console.log('outer:', outer)
  console.log('middle:', middle)
  console.log('inner:', inner)
  for (let i = 0; i < storageBoxes.length; i++) {
    console.log(`storage[${i}]:`, await storageBoxes[i].boundingBox())
  }
  // Check overlap with zone marker at us-central1
  const markers = await page.locator('.zone-marker-wrap').all()
  console.log(`zone markers visible: ${markers.length}`)
})
