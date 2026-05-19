import type { PredictResponse, TpuMetrics } from './types'

export async function predictStructure(
  apiBase: string,
  sequence: string,
  featureId?: string
): Promise<PredictResponse> {
  const resp = await fetch(`${apiBase}/api/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sequence, feature_id: featureId }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Predict failed: HTTP ${resp.status} ${text}`)
  }
  return resp.json()
}

export async function checkReady(apiBase: string): Promise<boolean> {
  try {
    const resp = await fetch(`${apiBase}/api/ready`, { signal: AbortSignal.timeout(5000) })
    return resp.ok
  } catch {
    return false
  }
}

export async function fetchMetrics(apiBase: string): Promise<TpuMetrics> {
  const resp = await fetch(`${apiBase}/api/metrics`)
  if (!resp.ok) throw new Error(`Metrics failed: HTTP ${resp.status}`)
  return resp.json()
}
