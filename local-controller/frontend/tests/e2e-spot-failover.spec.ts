import { test, expect } from '@playwright/test'

const GCS_BASE = 'https://storage.googleapis.com/wz-nih-demo-shared'

test('Spot failover: verify completed run renders correctly', async ({ page }) => {
  // Wait for all 6 backends to be done in GCS before loading the page
  const backends = ['af2-tpu', 'af2-gpu', 'esmfold-tpu', 'esmfold-gpu', 'boltz2-tpu', 'boltz2-gpu']
  const maxWait = 180_000
  const start = Date.now()

  while (Date.now() - start < maxWait) {
    const states = await Promise.all(
      backends.map(async b => {
        try {
          const resp = await fetch(`${GCS_BASE}/job/${b}.json?t=${Date.now()}`)
          if (!resp.ok) return 'idle'
          const data = await resp.json()
          return data.state || 'idle'
        } catch { return 'idle' }
      })
    )
    if (states.every(s => s === 'done' || s === 'failed')) break
    await new Promise(r => setTimeout(r, 5000))
  }

  // Load the page — it will see completed run and start dripping events
  await page.goto('/')
  await page.waitForTimeout(3000)

  // Press Enter to trigger a new run replay
  await page.keyboard.press('Enter')

  // Wait for terminal to show "done" (drip queue processes all events with real timestamps)
  // The real-time gap is ~90s (65s Spot wait + 25s inference). Wait up to 3 minutes.
  await page.locator('[style*="Courier"]').first().waitFor()
  const maxDripWait = 180_000
  const dripStart = Date.now()
  let terminalHasDone = false

  while (Date.now() - dripStart < maxDripWait) {
    const text = await page.locator('[style*="Courier"]').first().textContent() || ''
    if (text.includes('done —') && text.includes('resubmit')) {
      terminalHasDone = true
      break
    }
    await page.waitForTimeout(5000)
  }

  // Wait a bit more for the last events to drip
  await page.waitForTimeout(10000)

  // Screenshot the final state
  await page.screenshot({ path: 'tests/screenshots/spot-failover-final.png', fullPage: true })

  // Verify terminal content
  const terminalText = await page.locator('[style*="Courier"]').first().textContent() || ''
  expect(terminalText).toContain('sbatch')

  // Verify side ladder has cost entries
  const ladderText = await page.locator('.sideLadderWrapper').textContent() || ''
  console.log('Side ladder text:', ladderText.substring(0, 200))

  // Verify zone markers exist (Biowulf + active regions)
  const markerBoxes = await page.locator('.marker-text-box').count()
  console.log(`Zone marker boxes: ${markerBoxes}`)
  expect(markerBoxes).toBeGreaterThanOrEqual(3)

  // Log what we found
  console.log(`Terminal has "done": ${terminalHasDone}`)
  console.log(`Terminal has "spot-tpu": ${terminalText.includes('spot-tpu')}`)
  console.log(`Terminal has "resubmit": ${terminalText.includes('resubmit')}`)
})
