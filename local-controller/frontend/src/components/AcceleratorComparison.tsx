import React, { useState, useEffect } from 'react'
import { Cpu, Loader2, Layers } from 'lucide-react'
import { COMPARISON_BACKENDS, resolveApiBase, type AcceleratorBackend } from '../backends'
import type { WindParams } from '../types'

interface RunState {
  status: 'idle' | 'pending' | 'ok' | 'error'
  solveTimeMs?: number
  nCases?: number       // for sweep mode
  computeDevice?: string
  error?: string
}

interface BackendMeta {
  /** Live readiness from /api/ready. 'unknown' while we haven't probed yet. */
  ready: 'unknown' | 'ready' | 'not-ready' | 'unreachable'
  /** Authoritative silicon string from /api/metrics — e.g. "TPU v6 lite",
   *  "NVIDIA H100 80GB HBM3". This is what proves the demo isn't a slide. */
  silicon?: string
}

interface AcceleratorComparisonProps {
  /** Bumped by App.tsx every time the user clicks Simulate. */
  triggerKey: number
  wind: WindParams
  particleCount: number
  meshResolution: number
}

/** Sweep batch sizes the user can pick. 100 is the demo default; 1000 is the
 *  storyboard's "wow" headline ("a thousand design cases in one TPU call"). */
const SWEEP_N_OPTIONS = [100, 500, 1000] as const
type SweepN = typeof SWEEP_N_OPTIONS[number]

export default function AcceleratorComparison({
  triggerKey, wind, particleCount, meshResolution,
}: AcceleratorComparisonProps) {
  const [runs, setRuns] = useState<Record<string, RunState>>(() =>
    Object.fromEntries(COMPARISON_BACKENDS.map(b => [b.id, { status: 'idle' as const }])),
  )
  const [mode, setMode] = useState<'single' | 'sweep'>('single')
  const [sweepInFlight, setSweepInFlight] = useState(false)
  const [sweepN, setSweepN] = useState<SweepN>(100)
  const [meta, setMeta] = useState<Record<string, BackendMeta>>(() =>
    Object.fromEntries(COMPARISON_BACKENDS.map(b => [b.id, { ready: 'unknown' as const }])),
  )

  // On mount + every 30s: probe each backend's /api/ready (health dot) and
  // /api/metrics.devices[0].device_kind (silicon string). The silicon string
  // is what makes the demo non-spoofable — it's coming from `jax.devices()`
  // inside the running pod, so "TPU v6 lite" / "NVIDIA H100 80GB HBM3"
  // appearing next to a row proves there's actual silicon behind it.
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      const next: Record<string, BackendMeta> = {}
      await Promise.all(COMPARISON_BACKENDS.map(async (b) => {
        try {
          const [readyResp, metricsResp] = await Promise.all([
            fetch(`${resolveApiBase(b)}/api/ready`).catch(() => null),
            fetch(`${resolveApiBase(b)}/api/metrics`).catch(() => null),
          ])
          let ready: BackendMeta['ready'] = 'unreachable'
          if (readyResp) ready = readyResp.ok ? 'ready' : 'not-ready'
          let silicon: string | undefined
          if (metricsResp?.ok) {
            const m = await metricsResp.json()
            silicon = m?.devices?.[0]?.device_kind
          }
          next[b.id] = { ready, silicon }
        } catch {
          next[b.id] = { ready: 'unreachable' }
        }
      }))
      if (!cancelled) setMeta(next)
    }
    probe()
    const id = setInterval(probe, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Fan-out helper used by both single and sweep modes. We deliberately
  // wait for ALL backends to settle, then commit one setRuns call so both
  // rows render in the same React frame — avoids the cognitive dissonance
  // of "GPU appears first" just because its fetch was first in the array.
  const fanOut = async (endpoint: '/api/simulate' | '/api/sweep', body: string) => {
    setRuns(Object.fromEntries(COMPARISON_BACKENDS.map(b => [b.id, { status: 'pending' as const }])))

    const results = await Promise.all(
      COMPARISON_BACKENDS.map(async (b): Promise<[string, RunState]> => {
        try {
          const resp = await fetch(`${resolveApiBase(b)}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json()
          return [b.id, {
            status: 'ok' as const,
            solveTimeMs: data.solveTimeMs,
            nCases: data.n_cases,
            computeDevice: data.computeDevice ?? data.compute_device,
          }]
        } catch (err) {
          return [b.id, {
            status: 'error' as const,
            error: err instanceof Error ? err.message : 'fetch failed',
          }]
        }
      })
    )

    // Single commit — both rows transition pending → ok at the same time.
    setRuns(Object.fromEntries(results))
  }

  // Sweep mode handler — wired to a button below.
  const runSweep = async () => {
    setSweepInFlight(true)
    setMode('sweep')
    const body = JSON.stringify({
      n_cases: sweepN,
      mesh_resolution: meshResolution,
    })
    await fanOut('/api/sweep', body)
    setSweepInFlight(false)
  }

  useEffect(() => {
    if (triggerKey === 0) return  // skip the initial render
    setMode('single')
    fanOut('/api/simulate', JSON.stringify({
      wind_speed: wind.speed,
      alpha_deg: wind.alpha,
      beta_deg: wind.beta,
      particle_count: Math.min(particleCount, 200),
      mesh_resolution: meshResolution,
    }))
  }, [triggerKey])

  // Find the cheapest finished run for ratio comparison.
  const finished = COMPARISON_BACKENDS
    .map(b => ({ b, run: runs[b.id] }))
    .filter(({ run }) => run.status === 'ok' && run.solveTimeMs !== undefined)
    .map(({ b, run }) => ({ b, costPerSolve: b.pricePerSec * (run.solveTimeMs! / 1000) }))

  const cheapest = finished.length > 0
    ? finished.reduce((min, cur) => cur.costPerSolve < min.costPerSolve ? cur : min)
    : null

  return (
    <div className="bg-black/40 backdrop-blur-md border border-white/10 p-5 rounded-xl shadow-2xl">
      <h2 className="text-white font-sans text-sm font-semibold uppercase tracking-widest mb-1 flex items-center gap-2">
        <Cpu size={16} className="text-[#00ffcc]" />
        Accelerator $/calc
      </h2>
      <p className="text-white/30 text-[10px] font-mono uppercase tracking-wider mb-3">
        {mode === 'sweep'
          ? `Same vmap'd ${sweepN}-case sweep. Live across silicon.`
          : 'Same panel-method solve. Live across silicon.'}
      </p>

      {/* Sweep N selector — segmented buttons for 100 / 500 / 1000 cases */}
      <div className="flex gap-1 mb-2">
        {SWEEP_N_OPTIONS.map(n => (
          <button
            key={n}
            onClick={() => setSweepN(n)}
            disabled={sweepInFlight}
            className={`flex-1 px-2 py-1 text-[9px] font-mono uppercase tracking-wider border rounded transition-colors disabled:opacity-40 disabled:cursor-wait ${
              n === sweepN
                ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/50'
                : 'bg-white/[0.02] text-white/40 border-white/10 hover:bg-white/[0.04]'
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      {/* Sweep button — fires a vmap'd batch (the storyboard's wow demo) */}
      <button
        onClick={runSweep}
        disabled={sweepInFlight}
        className="w-full mb-3 px-3 py-2 text-[11px] font-mono uppercase tracking-wider bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-wait transition-colors flex items-center justify-center gap-2"
        title={`vmap solve over ${sweepN} (Mach, alpha, beta) cases — TPU's matmul array stays loaded`}
      >
        <Layers size={12} />
        {sweepInFlight ? `Sweeping ${sweepN} cases...` : `Run ${sweepN}-case design sweep`}
      </button>

      <div className="space-y-2">
        {COMPARISON_BACKENDS.map((b) => {
          const run = runs[b.id]
          const m = meta[b.id]
          const costPerSolve = run.solveTimeMs !== undefined
            ? b.pricePerSec * (run.solveTimeMs / 1000)
            : null
          const ratio = cheapest && costPerSolve !== null
            ? costPerSolve / cheapest.costPerSolve
            : null
          // Health dot color encodes /api/ready state. Pulses when 'ready'
          // (live + warm), stays steady-amber when reachable but warming up,
          // red when /api unreachable. Audience proof that we're not running
          // a recording.
          const dotClass = m?.ready === 'ready'
            ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)] animate-pulse'
            : m?.ready === 'not-ready'
            ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]'
            : m?.ready === 'unreachable'
            ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)]'
            : 'bg-white/20'
          const dotTitle = m?.ready === 'ready' ? 'live + warm'
            : m?.ready === 'not-ready' ? 'reachable but warming up (JIT compile)'
            : m?.ready === 'unreachable' ? 'unreachable — pod down or LB not routing'
            : 'probing...'
          return (
            <div
              key={b.id}
              className={`border ${b.accent} bg-white/[0.02] rounded-lg p-3`}
              title={b.blurb}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`}
                    title={dotTitle}
                  />
                  <span className="font-mono text-[11px] uppercase tracking-wider text-white/80 truncate">
                    {b.shortLabel}
                  </span>
                  {/* Silicon badge — `device_kind` straight from jax.devices()
                      inside the running pod. Audience-credible because it
                      can't be spoofed from a slide. */}
                  {m?.silicon && (
                    <span
                      className="text-[8.5px] font-mono italic text-white/35 truncate"
                      title={`Authoritative silicon string from /api/metrics → jax.devices()[0].device_kind on the running pod`}
                    >
                      {m.silicon}
                    </span>
                  )}
                </div>
                {run.status === 'pending' && (
                  <Loader2 size={12} className="text-[#00ffcc] animate-spin shrink-0" />
                )}
                {run.status === 'error' && (
                  <span className="text-red-400 text-[9px] font-mono uppercase shrink-0">err</span>
                )}
              </div>

              {run.status === 'idle' && (
                <div className="text-white/20 font-mono text-[10px]">— click Simulate —</div>
              )}

              {run.status === 'pending' && (
                <div className="text-white/40 font-mono text-[10px]">running...</div>
              )}

              {run.status === 'error' && (
                <div className="text-red-400/80 font-mono text-[10px]" title={run.error}>
                  {run.error?.slice(0, 40) || 'failed'}
                </div>
              )}

              {run.status === 'ok' && (() => {
                // Throughput per dollar — the headline metric. For single-solve
                // mode, it's "solves per $". For sweep mode, it's "cases per $".
                // Algebraically, "solves per $ per minute of runtime" simplifies
                // to "solves per $" (the per-minute factor cancels out), so we
                // label it the cleaner way.
                const itemsPerDollar = run.solveTimeMs && run.solveTimeMs > 0
                  ? (run.nCases ?? 1) / costPerSolve!
                  : 0
                const itemsPerDollarStr = itemsPerDollar >= 1e6
                  ? `${(itemsPerDollar / 1e6).toFixed(1)}M`
                  : itemsPerDollar >= 1e3
                  ? `${(itemsPerDollar / 1e3).toFixed(1)}K`
                  : `${Math.round(itemsPerDollar)}`
                const costLabel = run.nCases ? `$ / ${run.nCases} cases` : '$ / solve'
                const throughputLabel = run.nCases ? 'cases / $' : 'solves / $'
                return (
                  <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                    <div>
                      <div className="text-white/30 uppercase tracking-wider">{costLabel}</div>
                      <div className="text-[#00ffcc]">${costPerSolve!.toFixed(6)}</div>
                    </div>
                    <div>
                      <div className="text-white/30 uppercase tracking-wider">{throughputLabel}</div>
                      <div className="text-[#00ffcc]">{itemsPerDollarStr}</div>
                    </div>
                    <div>
                      <div className="text-white/30 uppercase tracking-wider">vs best</div>
                      <div className={ratio === 1 ? 'text-emerald-400' : 'text-white/60'}>
                        {ratio === 1 ? '✓' : `${ratio!.toFixed(1)}×`}
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>
    </div>
  )
}
