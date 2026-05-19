/**
 * FineTunePage — Part 2 of the FFRDC demo.
 *
 * Full-screen overlay (z-50) that opens from a top-right "Fine-tune"
 * button on the main demo page. Three vertical sections:
 *
 *   1. Hero + primary "Start fine-tune (live)" button
 *   2. Live loss curve — SVG line chart fed by SSE from /api/finetune/loss
 *   3. Before / After caption gallery — 4 demo-locked aerospace images,
 *      side-by-side base Gemma 3 caption vs aero-tuned caption
 *
 * The training kick-off is REAL (POST /api/finetune/start spawns the
 * custom JAX/Flax LoRA loop in aero_lora_train_server.py on the v6e
 * pod). The captions are pre-computed (run once offline against the
 * prebaked Orbax checkpoint) and shipped as static JSON so the gallery
 * is instant.
 *
 * Storyboard: Decision 3 + Scenes 5/6 in
 * ~/.claude/plans/karen-dahut-ceo-of-atomic-finch.md.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { X, Cpu, Sparkles, Loader2, Play } from 'lucide-react'

const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
const TPU_API = isHttps ? '' : 'http://34.8.175.195'

interface FineTunePageProps {
  open: boolean
  onClose: () => void
}

interface LossPoint { step: number; loss: number }

interface DemoImage {
  id: string
  url: string
  before: string
  after: string
}

interface CaptionsResponse {
  images: DemoImage[]
  _status?: string
}

export default function FineTunePage({ open, onClose }: FineTunePageProps) {
  const [jobId, setJobId] = useState<string | null>(null)
  const [maxSteps, setMaxSteps] = useState<number>(30)
  const [loss, setLoss] = useState<LossPoint[]>([])
  const [trainingState, setTrainingState] = useState<'idle' | 'starting' | 'streaming' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [captions, setCaptions] = useState<DemoImage[] | null>(null)
  // Latest phase event from the SSE stream (e.g. "Provisioning v6e slice…",
  // "Loading Gemma 3 4B checkpoint…"). Cleared when the first loss step lands.
  const [phaseMessage, setPhaseMessage] = useState<string | null>(null)
  const [path, setPath] = useState<'warm-pod' | 'k8s-job' | 'unknown'>('unknown')
  const eventSourceRef = useRef<EventSource | null>(null)

  // Fetch the cached before/after captions on first mount of the panel
  useEffect(() => {
    if (!open) return
    fetch(`${TPU_API}/api/finetune/captions`)
      .then(r => r.json())
      .then((data: CaptionsResponse) => setCaptions(data.images))
      .catch(() => {})
  }, [open])

  // Tear down SSE on unmount or when the panel closes
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
    }
  }, [])

  const startTraining = async () => {
    setTrainingState('starting')
    setError(null)
    setLoss([])
    try {
      const resp = await fetch(`${TPU_API}/api/finetune/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setJobId(data.job_id)
      setMaxSteps(data.max_steps)

      // Open SSE stream
      const es = new EventSource(`${TPU_API}/api/finetune/loss?job_id=${data.job_id}`)
      eventSourceRef.current = es
      setTrainingState('streaming')

      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data)
          if (e.final) {
            setTrainingState(e.status === 'done' ? 'done' : 'error')
            if (e.status === 'error') setError('trainer process exited non-zero')
            es.close()
            return
          }
          // Phase event — runs before any loss step, surfaces the
          // "what is happening right now" (provisioning / image pull /
          // model load / JIT compile) so the user isn't staring at a
          // blank screen on the slow path.
          if (typeof e.phase === 'string') {
            if (e.path) setPath(e.path)
            if (typeof e.message === 'string') setPhaseMessage(e.message)
            return
          }
          if (typeof e.step === 'number' && typeof e.loss === 'number') {
            // First loss step has landed — clear the phase indicator so
            // the loss curve takes over visually.
            setPhaseMessage(null)
            setLoss(prev => [...prev, { step: e.step, loss: e.loss }])
          }
        } catch (err) {
          console.error('SSE parse error', err)
        }
      }
      es.onerror = () => {
        setTrainingState('error')
        setError('SSE connection lost')
        es.close()
      }
    } catch (err) {
      setTrainingState('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-start justify-center overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-6xl m-6 bg-[#0a0a0f] border border-white/10 rounded-xl shadow-2xl p-6 pointer-events-auto">
        {/* Close */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-sans text-xl font-bold tracking-wide flex items-center gap-2">
            <Sparkles size={20} className="text-emerald-400" />
            Fine-tune Gemma 3 4B Multimodal on aero imagery
          </h2>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white p-1 rounded transition-colors"
            aria-label="Close fine-tune page"
          >
            <X size={20} />
          </button>
        </div>


        {/* === Section 1: training control === */}
        <section className="mb-8 border border-white/10 rounded-lg p-4 bg-white/[0.02]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-white font-mono text-xs uppercase tracking-widest flex items-center gap-2">
              <Cpu size={14} className="text-[#00ffcc]" />
              Live training
            </h3>
            <span className="text-white/40 text-[10px] font-mono uppercase tracking-wider">
              {trainingState === 'idle' && '— ready —'}
              {trainingState === 'starting' && 'starting trainer…'}
              {trainingState === 'streaming' && `streaming (${loss.length} / ${maxSteps} steps)`}
              {trainingState === 'done' && `done (${loss.length} steps)`}
              {trainingState === 'error' && 'error'}
            </span>
          </div>

          <button
            onClick={startTraining}
            disabled={trainingState === 'starting' || trainingState === 'streaming'}
            className="px-4 py-2 text-sm font-mono uppercase tracking-wider bg-emerald-500/15 text-emerald-200 border border-emerald-500/40 rounded-lg hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-wait transition-colors flex items-center gap-2"
          >
            {trainingState === 'starting' || trainingState === 'streaming' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            {trainingState === 'idle' && 'Start fine-tune'}
            {trainingState === 'starting' && 'Spawning trainer on v6e pod…'}
            {trainingState === 'streaming' && `Training… step ${loss.length} / ${maxSteps}`}
            {trainingState === 'done' && 'Run again'}
            {trainingState === 'error' && 'Retry'}
          </button>

          {error && (
            <p className="text-red-400 text-xs font-mono mt-2">{error}</p>
          )}

          {/* Phase indicator — only visible while no loss has landed yet.
              Tells the audience exactly which stage is in progress on the
              slow K8s-Job path; the warm-pod path skips this almost
              instantly. */}
          {phaseMessage && loss.length === 0 && trainingState === 'streaming' && (
            <div className="mt-3 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono flex items-start gap-2">
              <Loader2 size={12} className="animate-spin mt-0.5 flex-shrink-0" />
              <span>
                {path === 'warm-pod' && (
                  <span className="text-emerald-300">[warm pod] </span>
                )}
                {path === 'k8s-job' && (
                  <span className="text-amber-300">[cold start] </span>
                )}
                {phaseMessage}
              </span>
            </div>
          )}

          {/* Loss curve — simple SVG */}
          <div className="mt-4 h-48">
            <LossCurve data={loss} maxSteps={maxSteps} />
          </div>
        </section>

        {/* === Section 2: before / after caption gallery === */}
        <section>
          <h3 className="text-white font-mono text-xs uppercase tracking-widest mb-3 flex items-center gap-2">
            <Sparkles size={14} className="text-emerald-400" />
            Before vs After
          </h3>
          {captions === null ? (
            <p className="text-white/40 text-xs font-mono">loading captions…</p>
          ) : captions.length === 0 ? (
            <p className="text-amber-400/80 text-xs font-mono">
              No captions yet — the prebaked checkpoint hasn't been trained.
              Real Before/After captions land here once a real fine-tune
              produces a real checkpoint. We will not display fabricated
              captions in the meantime.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {captions.map(img => (
                <CaptionCard key={img.id} image={img} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LossCurve({ data, maxSteps }: { data: LossPoint[]; maxSteps: number }) {
  // Tiny hand-rolled SVG line chart. Avoids adding recharts/d3 as a dep
  // for what is fundamentally a single-line plot of (step, loss).
  const w = 600, h = 180, pad = 28
  const xs = data.map(p => p.step)
  const ys = data.map(p => p.loss)
  const xMax = Math.max(maxSteps - 1, ...(xs.length ? xs : [0]))
  const yMin = ys.length ? Math.min(...ys) : 0
  const yMax = ys.length ? Math.max(...ys) : 1
  const yRange = Math.max(yMax - yMin, 0.01)
  const X = (s: number) => pad + (s / Math.max(xMax, 1)) * (w - 2 * pad)
  const Y = (l: number) => h - pad - ((l - yMin) / yRange) * (h - 2 * pad)
  const path = useMemo(
    () => data.map((p, i) => `${i === 0 ? 'M' : 'L'} ${X(p.step)} ${Y(p.loss)}`).join(' '),
    [data, xMax, yRange],
  )
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full">
      {/* Axes */}
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
      <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
      {/* Y-axis ticks */}
      {ys.length > 0 && (
        <>
          <text x={pad - 4} y={Y(yMax)} fontSize={9} fill="rgba(255,255,255,0.5)" textAnchor="end">{yMax.toFixed(2)}</text>
          <text x={pad - 4} y={Y(yMin)} fontSize={9} fill="rgba(255,255,255,0.5)" textAnchor="end">{yMin.toFixed(2)}</text>
        </>
      )}
      {/* X-axis ticks */}
      <text x={pad} y={h - pad + 12} fontSize={9} fill="rgba(255,255,255,0.5)">step 0</text>
      <text x={w - pad} y={h - pad + 12} fontSize={9} fill="rgba(255,255,255,0.5)" textAnchor="end">{maxSteps}</text>
      <text x={w / 2} y={h - 4} fontSize={9} fill="rgba(255,255,255,0.4)" textAnchor="middle">training step</text>
      {/* Line */}
      {data.length > 1 && (
        <path d={path} stroke="rgb(52, 211, 153)" strokeWidth={2} fill="none" />
      )}
      {/* Points */}
      {data.map((p, i) => (
        <circle key={i} cx={X(p.step)} cy={Y(p.loss)} r={2.5} fill="rgb(52, 211, 153)" />
      ))}
      {/* Latest value callout */}
      {data.length > 0 && (
        <text x={w - pad - 4} y={pad + 12} fontSize={11} fill="rgb(52, 211, 153)" textAnchor="end" fontFamily="monospace">
          loss = {data[data.length - 1].loss.toFixed(3)}
        </text>
      )}
      {data.length === 0 && (
        <text x={w / 2} y={h / 2} fontSize={11} fill="rgba(255,255,255,0.3)" textAnchor="middle" fontFamily="monospace">
          (no loss data yet — click Start fine-tune)
        </text>
      )}
    </svg>
  )
}

function CaptionCard({ image }: { image: DemoImage }) {
  return (
    <div className="border border-white/10 rounded-lg p-3 bg-white/[0.02]">
      <img
        src={`${TPU_API}${image.url}`}
        alt={image.id}
        className="w-full rounded bg-black/40 mb-3"
        onError={(e) => { (e.currentTarget.style.display = 'none') }}
      />
      <div className="space-y-2 text-[11px] font-mono leading-relaxed">
        <div>
          <div className="text-white/30 uppercase tracking-wider mb-1">Base Gemma 3</div>
          <div className="text-white/60 italic">"{image.before}"</div>
        </div>
        <div>
          <div className="text-emerald-400/80 uppercase tracking-wider mb-1">Aero-tuned Gemma 3</div>
          <div className="text-emerald-200">"{image.after}"</div>
        </div>
      </div>
    </div>
  )
}
