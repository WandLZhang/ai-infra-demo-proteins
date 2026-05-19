export type VisualizationMode = 'visual' | 'thermal' | 'stress' | 'pressure'

export interface WindParams {
  speed: number       // Mach number
  alpha: number       // Angle of attack (degrees)
  beta: number        // Sideslip angle (degrees)
}

export interface SimulationRequest {
  wind: WindParams
  particleCount: number
  meshResolution: number
}

export interface FaceData {
  cp: number[]
  cpMin: number
  cpMax: number
  cpP5: number    // 5th percentile — robust colormap range
  cpP95: number   // 95th percentile
  velocity: number[]
  normals: number[]
  centroids: number[]
}

export interface SolverMesh {
  vertices: number[]   // flat [x,y,z, ...]
  faces: number[]      // flat [i0,i1,i2, ...]
  faceCount: number
  vertexCount: number
}

export interface ForceData {
  lift: number
  drag: number
  sideForce: number
  liftCoeff: number
  dragCoeff: number
  dragParasite: number
  dragInduced: number
  dragWave: number
  liftOverDrag: number
  liftCurveSlope: number
  stallAngle: number
}

export interface SimulationResult {
  faceData: FaceData
  solverMesh: SolverMesh
  forces: ForceData
  computeDevice: string
  solveTimeMs: number
  panelCount: number
  mach: number
  timings?: Record<string, number>
  result_id?: string | null
  alpha?: number
  beta?: number
}

export interface TpuMetrics {
  devices: Array<{ id: number; platform: string; device_kind: string }>
  platform: {
    default_backend: string
    device_count: number
    platforms_available: string[]
    jax_version: string
    float64_enabled: boolean
    jax_platforms_env: string
  }
  xla_cache: {
    enabled: boolean
    directory: string
    type: string
  }
  solver: Record<string, unknown>
  timings: {
    latest?: Record<string, number>
    averages?: Record<string, { mean: number; min: number; max: number }>
    run_count?: number
  }
  memory: Record<string, { bytes_in_use: number; bytes_limit: number; peak_bytes_in_use: number; utilization_pct: number } | { note: string }>
  uptime: { seconds_since_first_sim?: number }
  benchmark: Record<string, number | string>
}

export interface SensorData {
  maxSurfaceTemp: number
  dynamicPressure: number
  structuralLoad: number
  airDensity: number
  liftCoeff: number
  dragCoeff: number
  lift: number
  drag: number
}

export interface ResultSummary {
  result_id: string
  ts: string
  session: string
  gcs_path: string
  mach: number
  alpha: number
  beta: number
  panels: number
  solve_ms: number
}
