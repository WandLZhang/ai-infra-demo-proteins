import type { BackendId, LaneStatus, PredictResponse } from './types'

const STATE_SERVER = (import.meta as any).env?.VITE_STATE_SERVER || 'http://localhost:8080'

export interface SubmitResult {
  run_id: string
  already_running: boolean
  dispatch_lines?: string[]
}

export async function submitRun(proteinId: string): Promise<SubmitResult> {
  const resp = await fetch(`${STATE_SERVER}/api/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protein_id: proteinId }),
  })
  if (!resp.ok) throw new Error(`Submit failed: HTTP ${resp.status}`)
  return resp.json()
}

export interface RunStatus {
  run_id: string
  lanes: Record<string, LaneStatusBlob>
  all_complete: boolean
  manifest?: {
    protein_id: string
    sequence_length: number
    submitted_at: string
    status: string
  }
}

export interface LaneStatusBlob {
  backend_id: string
  run_id: string
  state: string
  started_at?: string
  completed_at?: string | null
  elapsed_ms?: number
  cost_accumulated?: number
  result?: {
    output_gcs_path: string
    output_chars: number
    solve_time_ms: number
    model: string
    silicon: string
    seq_len: number
  } | null
  error?: string | null
}

export async function pollStatus(runId: string): Promise<RunStatus> {
  const resp = await fetch(`${STATE_SERVER}/api/status/${runId}`)
  if (!resp.ok) throw new Error(`Status failed: HTTP ${resp.status}`)
  return resp.json()
}

export async function getLatestRun(): Promise<RunStatus | null> {
  const resp = await fetch(`${STATE_SERVER}/api/latest`)
  if (!resp.ok) throw new Error(`Latest failed: HTTP ${resp.status}`)
  const data = await resp.json()
  if (!data.run_id) return null
  return data
}

export function blobToLaneStatus(blob: LaneStatusBlob, backendId: BackendId): Partial<LaneStatus> {
  return {
    backendId,
    state: blob.state as LaneStatus['state'],
    startedAt: blob.started_at ? new Date(blob.started_at).getTime() : null,
    completedAt: blob.completed_at ? new Date(blob.completed_at).getTime() : null,
    elapsedMs: blob.elapsed_ms || 0,
    costAccumulated: blob.cost_accumulated || 0,
    result: blob.result ? {
      pdb: '',
      plddt_mean: 0,
      solve_time_ms: blob.result.solve_time_ms,
      device_kind: blob.result.silicon === 'tpu' ? 'TPU v6e' : 'NVIDIA A100',
      num_devices: 1,
      seq_len: blob.result.seq_len,
      model: blob.result.model,
    } : null,
    error: blob.error || null,
  }
}
