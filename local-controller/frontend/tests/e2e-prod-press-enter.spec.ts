/**
 * e2e-prod-press-enter.spec.ts
 *
 * Live production smoke test: opens the deployed Cloud Run frontend,
 * presses Enter to fire a real run, and watches the 6 backends complete
 * via direct GCS polling. Takes screenshots at key milestones.
 *
 * Run with:
 *   FRONTEND_URL=https://protein-demo-frontend-212183265679.us-east5.run.app \
 *     npx playwright test tests/e2e-prod-press-enter.spec.ts --reporter=list
 */
import { test, expect } from '@playwright/test'

const GCS_BASE = 'https://storage.googleapis.com/wz-nih-demo-shared'
const BACKENDS = ['af2-tpu', 'af2-gpu', 'esmfold-tpu', 'esmfold-gpu', 'boltz2-tpu', 'boltz2-gpu']

async function fetchStates(): Promise<Record<string, { state: string; elapsed_ms?: number; error?: string }>> {
  const out: Record<string, any> = {}
  await Promise.all(
    BACKENDS.map(async (b) => {
      try {
        const r = await fetch(`${GCS_BASE}/job/${b}.json?t=${Date.now()}`)
        if (!r.ok) {
          out[b] = { state: 'no-blob' }
          return
        }
        out[b] = await r.json()
      } catch (e) {
        out[b] = { state: 'fetch-error' }
      }
    }),
  )
  return out
}

function summarize(states: Record<string, any>): string {
  return BACKENDS.map((b) => {
    const d = states[b] || {}
    const ms = d.elapsed_ms ?? 0
    return `${b.padEnd(15)} ${(d.state || '?').padEnd(11)} ${String(ms).padStart(7)}ms ${d.error ? '| ' + d.error : ''}`
  }).join('\n  ')
}

test('production press-Enter triggers full 6-backend run', async ({ page }) => {
  test.setTimeout(15 * 60_000) // 15 min cap

  // 1. Capture pre-press state
  const pre = await fetchStates()
  console.log('\n=== PRE-PRESS GCS STATE ===\n  ' + summarize(pre))

  // 2. Load frontend
  await page.goto('/')
  await page.waitForLoadState('networkidle', { timeout: 30_000 })
  await page.screenshot({ path: 'tests/screenshots/prod-01-loaded.png', fullPage: true })

  // 3. Press Enter
  console.log('\n=== Pressing Enter ===')
  const pressTs = Date.now()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'tests/screenshots/prod-02-pressed.png', fullPage: true })

  // 4. Confirm a new trigger landed in GCS (within 30s the watcher writes new state)
  let triggered = false
  const triggerDeadline = pressTs + 60_000
  while (Date.now() < triggerDeadline) {
    const s = await fetchStates()
    const anyMoved = BACKENDS.some((b) => {
      const cur = s[b]?.state
      const prev = pre[b]?.state
      return cur && cur !== prev && cur !== 'no-blob' && (cur === 'allocating' || cur === 'loading' || cur === 'inferring' || cur === 'queued')
    })
    if (anyMoved) {
      triggered = true
      console.log(`  trigger picked up after ${((Date.now() - pressTs) / 1000).toFixed(1)}s`)
      console.log('  ' + summarize(s))
      break
    }
    await page.waitForTimeout(3000)
  }
  expect(triggered, 'No backend transitioned within 60s of press — trigger watcher / dispatch broken').toBe(true)

  // 5. Poll until all 6 reach done|failed, screenshot every 30s
  const completeDeadline = Date.now() + 12 * 60_000 // 12 min cap on actual run
  let shot = 3
  let allDone = false
  let lastStates: Record<string, any> = {}
  while (Date.now() < completeDeadline) {
    lastStates = await fetchStates()
    const states = BACKENDS.map((b) => lastStates[b]?.state || 'no-blob')
    const done = states.filter((s) => s === 'done' || s === 'failed').length
    console.log(`  [${new Date().toISOString().slice(11, 19)}] ${done}/6 complete`)
    console.log('  ' + summarize(lastStates))

    if (done === 6) {
      allDone = true
      break
    }
    await page.screenshot({ path: `tests/screenshots/prod-${String(shot).padStart(2, '0')}-progress.png`, fullPage: true })
    shot += 1
    await page.waitForTimeout(30_000)
  }

  await page.screenshot({ path: 'tests/screenshots/prod-final.png', fullPage: true })

  console.log('\n=== FINAL GCS STATE ===\n  ' + summarize(lastStates))

  // Pass criteria: all 6 reached terminal state. Individual failures are
  // logged but don't fail the test — we want to see the full picture.
  expect(allDone, 'Not all 6 backends reached done|failed within 12 min').toBe(true)

  // Report individual failures as warnings (won't fail test, just visible in log)
  const failed = BACKENDS.filter((b) => lastStates[b]?.state === 'failed')
  if (failed.length > 0) {
    console.warn(`  WARNING: ${failed.length} backend(s) failed: ${failed.join(', ')}`)
    for (const b of failed) {
      console.warn(`    ${b}: ${lastStates[b]?.error}`)
    }
  }
})
