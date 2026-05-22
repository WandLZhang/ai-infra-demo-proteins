// Protein demo types.

export interface Protein {
  id: string
  name: string
  sequence: string
  uniprotId: string
  description: string
  residueCount: number
}

export type ModelId = 'af2' | 'esmfold' | 'boltz2'
export type SiliconId = 'tpu' | 'gpu'
export type BackendId = `${ModelId}-${SiliconId}`

export interface PredictRequest {
  sequence: string
  featureId?: string  // for AF2 (pre-computed MSA features)
}

export interface PredictResponse {
  pdb: string
  plddt_mean: number
  plddt_min?: number
  plddt_max?: number
  solve_time_ms: number
  device_kind: string
  num_devices: number
  seq_len: number
  model?: string
  result_id?: string
}

// Each backend lane tracks its lifecycle state
export type LaneState =
  | 'idle'
  | 'queued'
  | 'allocating'    // Spot allocation in progress
  | 'pulling'       // Container image pull
  | 'loading'       // Model weights loading
  | 'inferring'     // Forward pass running
  | 'done'
  | 'failed'

export interface LaneStatus {
  backendId: BackendId
  state: LaneState
  startedAt: number | null
  completedAt: number | null
  elapsedMs: number
  costAccumulated: number
  result: PredictResponse | null
  error: string | null
  talkTrackSlide: number
  talkTrackLabel: string
}

// Talk track badge mapping — each element maps to a slide
export interface TalkTrackPoint {
  slide: number
  label: string
  description: string
  triggeredBy: LaneState | 'summary'
}

// Reused from aero-sim — TpuMetrics modal
export interface TpuMetrics {
  devices: Array<{ id: number; platform: string; device_kind: string }>
  platform?: {
    default_backend: string
    device_count: number
    platforms_available: string[]
    jax_version: string
    float64_enabled: boolean
    jax_platforms_env: string
  }
  num_devices: number
  jax_version?: string
  torch_version?: string
  warm: boolean
  warm_error: string | null
}

export interface ScorecardRow {
  model: string
  tpuCost: number
  gpuCost: number
  savings: string
}
