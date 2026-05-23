import type { BackendId, LaneStatus } from './types'

const STATE_SERVER = (import.meta as any).env?.VITE_STATE_SERVER || 'http://localhost:8080'
const GCS_BUCKET = 'wz-nih-demo-shared'
const GCS_BASE = `https://storage.googleapis.com/${GCS_BUCKET}`

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

const ALL_BACKENDS: BackendId[] = [
  'af2-tpu', 'af2-gpu', 'esmfold-tpu', 'esmfold-gpu', 'boltz2-tpu', 'boltz2-gpu',
]

async function fetchGcsJson(path: string): Promise<any | null> {
  const resp = await fetch(`${GCS_BASE}/${path}?t=${Date.now()}`, { cache: 'no-store' })
  if (!resp.ok) return null
  return resp.json()
}

export async function pollStatus(runId: string): Promise<RunStatus> {
  const lanes: Record<string, LaneStatusBlob> = {}

  const results = await Promise.all(
    ALL_BACKENDS.map(async (bid) => {
      const blob = await fetchGcsJson(`jobs/${runId}/${bid}.json`)
      return { bid, blob }
    })
  )

  for (const { bid, blob } of results) {
    lanes[bid] = blob || { backend_id: bid, run_id: runId, state: 'idle' }
  }

  const all_complete = ALL_BACKENDS.every(
    b => lanes[b]?.state === 'done' || lanes[b]?.state === 'failed'
  )

  return { run_id: runId, lanes, all_complete }
}

export interface SlurmEvent {
  ts: string
  msg: string
}

export async function pollEvents(runId: string): Promise<SlurmEvent[]> {
  const listResp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o?prefix=jobs/${runId}/log/&delimiter=/&t=${Date.now()}`,
    { cache: 'no-store' }
  )
  if (!listResp.ok) return []
  const listData = await listResp.json()
  const items: { name: string }[] = listData.items || []
  items.sort((a, b) => a.name.localeCompare(b.name))

  const events: SlurmEvent[] = await Promise.all(
    items.map(async (item) => {
      const data = await fetchGcsJson(item.name)
      return data as SlurmEvent | null
    })
  ).then(results => results.filter(Boolean) as SlurmEvent[])

  return events
}

export async function getLatestRun(): Promise<RunStatus | null> {
  const resp = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o?prefix=jobs/&delimiter=/`,
    { cache: 'no-store' }
  )
  if (!resp.ok) return null
  const data = await resp.json()

  const prefixes: string[] = data.prefixes || []
  if (prefixes.length === 0) return null

  const runIds = prefixes
    .map((p: string) => p.replace('jobs/', '').replace('/', ''))
    .filter(Boolean)
    .sort()
    .reverse()

  const latestId = runIds[0]
  return pollStatus(latestId)
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
