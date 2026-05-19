import type { SimulationRequest, SimulationResult, TpuMetrics } from './types'

const API_BASE = '/api'

export async function runSimulation(params: SimulationRequest): Promise<SimulationResult> {
  const resp = await fetch(`${API_BASE}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wind_speed: params.wind.speed,
      alpha_deg: params.wind.alpha,
      beta_deg: params.wind.beta,
      particle_count: params.particleCount,
      mesh_resolution: params.meshResolution,
    }),
  })
  if (!resp.ok) throw new Error(`Simulation failed: ${resp.status}`)
  return resp.json()
}

export async function uploadMesh(file: File): Promise<{ meshId: string; faceCount: number }> {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(`${API_BASE}/mesh/upload`, {
    method: 'POST',
    body: form,
  })
  if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`)
  return resp.json()
}

export async function healthCheck(): Promise<{ status: string; compute_device: string }> {
  const resp = await fetch(`${API_BASE}/health`)
  return resp.json()
}

export async function fetchTpuMetrics(): Promise<TpuMetrics> {
  const resp = await fetch(`${API_BASE}/metrics`)
  if (!resp.ok) throw new Error(`Metrics fetch failed: ${resp.status}`)
  return resp.json()
}


// --- AI Agent API ---

export interface AiAnalyzeParams {
  gcs_path?: string | null
  conditions?: {
    mach: number
    alpha_deg: number
    beta_deg: number
    panel_count: number
    solve_time_ms: number
  }
  forces?: Record<string, number>
  cp?: { min: number; max: number; mean: number }

  question?: string
}

export function buildAnalyzeParams(
  result: SimulationResult,
  wind: { speed: number; alpha: number; beta: number },
  question?: string,
): AiAnalyzeParams {
  const cpArr = result.faceData.cp
  const cpMean = cpArr.length > 0
    ? cpArr.reduce((a, b) => a + b, 0) / cpArr.length
    : 0

  return {
    conditions: {
      mach: wind.speed,
      alpha_deg: wind.alpha,
      beta_deg: wind.beta,
      panel_count: result.panelCount,
      solve_time_ms: result.solveTimeMs,
    },
    forces: result.forces as unknown as Record<string, number>,
    cp: {
      min: result.faceData.cpMin,
      max: result.faceData.cpMax,
      mean: parseFloat(cpMean.toFixed(4)),
    },
    question,
  }
}

// --- Results History API ---

export async function fetchResultsList(
  user: string = 'demo@user.com',
  limit: number = 10,
  offset: number = 0,
): Promise<{ results: import('./types').ResultSummary[]; count: number }> {
  const resp = await fetch(
    `${API_BASE}/results?user=${encodeURIComponent(user)}&limit=${limit}&offset=${offset}`,
  )
  if (!resp.ok) throw new Error(`Failed to fetch results: ${resp.status}`)
  return resp.json()
}

export async function fetchResult(resultId: string): Promise<import('./types').SimulationResult> {
  const resp = await fetch(`${API_BASE}/results/${encodeURIComponent(resultId)}`)
  if (!resp.ok) throw new Error(`Failed to fetch result: ${resp.status}`)
  return resp.json()
}

export async function pollResultStatus(
  resultId: string,
  intervalMs: number = 200,
  maxRetries: number = 15,
): Promise<'ready' | 'failed'> {
  for (let i = 0; i < maxRetries; i++) {
    const resp = await fetch(`${API_BASE}/results/${encodeURIComponent(resultId)}/status`)
    if (resp.ok) {
      const data = await resp.json()
      if (data.status === 'ready') return 'ready'
      if (data.status === 'failed') return 'failed'
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return 'failed'
}

export async function streamAiAnalysis(
  params: AiAnalyzeParams,
  onChunk: (text: string) => void,
  onDone: (fullText: string) => void,
  onError: (msg: string) => void,
): Promise<void> {
  const resp = await fetch(`${API_BASE}/ai/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!resp.ok) {
    onError(`AI request failed: ${resp.status}`)
    return
  }

  await _readSSE(resp, onChunk, onDone, onError)
}

export async function streamAiChat(
  message: string,
  simContext: AiAnalyzeParams | null,
  onChunk: (text: string) => void,
  onDone: (fullText: string) => void,
  onError: (msg: string) => void,
  gcsPath?: string | null,
): Promise<void> {
  const body: Record<string, unknown> = { message }
  if (gcsPath) {
    body.gcs_path = gcsPath
  } else if (simContext) {
    body.sim_context = simContext
  }

  const resp = await fetch(`${API_BASE}/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    onError(`AI chat failed: ${resp.status}`)
    return
  }

  await _readSSE(resp, onChunk, onDone, onError)
}

async function _readSSE(
  resp: Response,
  onChunk: (text: string) => void,
  onDone: (fullText: string) => void,
  onError: (msg: string) => void,
) {
  const reader = resp.body?.getReader()
  if (!reader) {
    onError('No response body')
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const data = JSON.parse(line.slice(6))
        if (data.type === 'chunk') {
          onChunk(data.text)
        } else if (data.type === 'done') {
          onDone(data.full_text)
        } else if (data.type === 'error') {
          onError(data.message)
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }
}
