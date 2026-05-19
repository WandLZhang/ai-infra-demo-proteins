// Accelerator backends for live $/calc comparison.
//
// Each backend exposes the same /api/simulate contract; the comparison panel
// fans out a single request to all of them in parallel and tabulates
// solveTimeMs + cost.
//
// pricePerSec is the slice/node Spot or Flex blended price, derived from
// Google's Cloud Billing Catalog API (https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus)
// queried 2026-04-20. Where multiple regions are available, we use the
// region matching the live deployment. Numbers reconcile to BigQuery
// billing-export within ~5% (storyboard Scene 3 "verified by BQ" badge).
//
// Per-chip-hour Spot SKUs used:
//   - TpuV5e Spot     ~ $0.78/chip-hr  (asia-southeast1 baseline)
//   - TpuV6e Spot     ~ $0.50/chip-hr  (mid us-central1 estimate, range $0.30-1.26)
//   - H100 80GB Spot  ~ $1.50-2.86/chip-hr (region dependent)
//   - H100 80GB Mega  ~ $2.20-3.12/chip-hr (region dependent)
// Multiplied by chip count per slice (4 for TPUs, 8 for GPUs), divided
// by 3600 for $/sec.
//
// To add a backend, drop a new entry. The comparison UI auto-renders.

export interface AcceleratorBackend {
  id: string
  label: string
  shortLabel: string
  apiBase: string
  apiBaseDirect: string
  pricePerSec: number
  accent: string
  blurb: string
}

const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'

export function resolveApiBase(backend: AcceleratorBackend): string {
  return isHttps ? backend.apiBase : backend.apiBaseDirect
}

export const COMPARISON_BACKENDS: AcceleratorBackend[] = [
  {
    id: 'gpu',
    label: 'GPU H100-mega 8x Flex',
    shortLabel: 'H100-mega 8x',
    apiBase: '/gpu',
    apiBaseDirect: 'http://34.170.250.197:8000',
    // 8 chips × $4.4239/chip-hr H100-mega Flex (DWS Defined Duration) ÷ 3600
    // = $0.009831/sec. Verified via Cloud Billing Catalog SKU API 2026-05-15.
    // 2026-05-15 pivot: us-east5-a + us-central1 GKE Autopilot Flex starvation
    // resolved via 32-zone queued FLEX_START spray — us-central1-b a3-mega
    // granted after 58 minutes in queue, with full 7-day max-run-duration.
    pricePerSec: 0.009831,
    accent: 'border-[#ffaa00]/40',
    blurb: 'a3-megagpu-8g (8x H100 80GB HBM3 NVLink) Flex DWS GCE-direct in us-central1-b — 7-day allocation',
  },
  {
    id: 'tpu-v6e',
    label: 'TPU v6e 2x2 Flex (Trillium)',
    shortLabel: 'TPU v6e',
    // May 2026 demo backend — us-east5 cluster (pivoted from us-central1
    // due to v6e capacity starvation on 2026-05-01).
    apiBase: '',
    apiBaseDirect: 'http://34.8.175.195',
    // 4 chips × $0.50/chip-hr Flex (midpoint estimate) ÷ 3600 = $0.000556/sec
    pricePerSec: 0.000556,
    accent: 'border-emerald-400/40',
    blurb: 'v6e-4 (4 Trillium chips, 128 GiB HBM total, 4.7× v5e BF16 TFLOPS) Flex in us-east5-a — 7-day allocation',
  },
]
