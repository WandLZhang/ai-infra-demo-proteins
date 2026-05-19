import React, { useEffect, useState } from 'react'
import { X, Cpu, Zap, Database, Clock, Activity, Server, HardDrive, BarChart3 } from 'lucide-react'
import { fetchTpuMetrics } from '../api'
import type { TpuMetrics } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  latestTimings?: Record<string, number>
  computeDevice?: string
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Cpu; children: React.ReactNode }) {
  return (
    <div className="border border-white/10 rounded-lg bg-black/30 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-white/5 border-b border-white/10">
        <Icon size={14} className="text-[#00ffcc]" />
        <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-white/80">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function KV({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-white/5 last:border-0">
      <span className="font-sans text-[11px] uppercase tracking-wider text-white/50">{label}</span>
      <span className={`font-mono text-xs ${highlight ? 'text-[#00ffcc]' : 'text-white/80'}`}>{value}</span>
    </div>
  )
}

function TimingBar({ label, ms, maxMs }: { label: string; ms: number; maxMs: number }) {
  const pct = Math.min((ms / Math.max(maxMs, 1)) * 100, 100)
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="font-sans text-[10px] uppercase tracking-wider text-white/50 w-28 text-right shrink-0">{label}</span>
      <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden relative">
        <div
          className="h-full rounded transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, #00ffcc, ${pct > 60 ? '#ffcc00' : '#00ffcc'})`,
            opacity: 0.8,
          }}
        />
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] text-white/70">
          {ms.toFixed(1)}ms
        </span>
      </div>
    </div>
  )
}

function MemoryBar({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total > 0 ? (used / total) * 100 : 0
  const usedMB = (used / 1024 / 1024).toFixed(0)
  const totalMB = (total / 1024 / 1024).toFixed(0)
  return (
    <div className="py-1">
      <div className="flex justify-between mb-1">
        <span className="font-sans text-[10px] uppercase tracking-wider text-white/50">{label}</span>
        <span className="font-mono text-[10px] text-white/60">{usedMB} / {totalMB} MB ({pct.toFixed(1)}%)</span>
      </div>
      <div className="h-3 bg-white/5 rounded overflow-hidden">
        <div
          className="h-full rounded transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: pct > 80 ? '#ff4444' : pct > 50 ? '#ffcc00' : '#00ffcc',
            opacity: 0.7,
          }}
        />
      </div>
    </div>
  )
}

export default function TpuMetricsModal({ open, onClose, latestTimings, computeDevice }: Props) {
  const [metrics, setMetrics] = useState<TpuMetrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetchTpuMetrics()
      .then(setMetrics)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  // Merge latest timings from props with metrics data
  const timings = latestTimings || metrics?.timings?.latest || {}
  const timingKeys = ['solve_ms', 'seed_ms', 'streamlines_ms', 'aero_ms', 'transform_ms', 'serialize_ms']
  const maxTiming = Math.max(...timingKeys.map(k => timings[k] ?? 0), 1)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-[#0a0a0a] border border-[#00ffcc]/20 rounded-2xl shadow-2xl shadow-[#00ffcc]/5 w-full max-w-4xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[#0a0a0a]/95 backdrop-blur-md border-b border-[#00ffcc]/20 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#00ffcc]/10 flex items-center justify-center">
              <Cpu size={18} className="text-[#00ffcc]" />
            </div>
            <div>
              <h2 className="font-mono text-sm font-bold text-white tracking-tight">TPU Compute Metrics</h2>
              <p className="font-sans text-[10px] text-white/40 uppercase tracking-widest mt-0.5">
                {computeDevice || 'loading...'} {metrics?.platform?.jax_version ? `// JAX ${metrics.platform.jax_version}` : ''}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors"
          >
            <X size={16} className="text-white/60" />
          </button>
        </div>

        {loading && (
          <div className="p-12 text-center">
            <div className="inline-block w-6 h-6 border-2 border-[#00ffcc]/30 border-t-[#00ffcc] rounded-full animate-spin" />
            <p className="font-mono text-xs text-white/40 mt-3">Fetching metrics...</p>
          </div>
        )}

        {error && (
          <div className="p-6">
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
              <p className="font-mono text-xs text-red-400">{error}</p>
            </div>
          </div>
        )}

        {!loading && metrics && (
          <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Devices */}
            <Section title="Accelerator Devices" icon={Zap}>
              {metrics.devices.map((d, i) => (
                <div key={i} className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
                  <div className={`w-2 h-2 rounded-full ${d.platform === 'tpu' ? 'bg-[#00ffcc] shadow-[0_0_6px_#00ffcc]' : d.platform === 'gpu' ? 'bg-yellow-400' : 'bg-white/30'}`} />
                  <div className="flex-1">
                    <span className="font-mono text-xs text-white/80">{d.device_kind}</span>
                    <span className="font-mono text-[10px] text-white/30 ml-2">id:{d.id}</span>
                  </div>
                  <span className={`font-mono text-[10px] uppercase px-2 py-0.5 rounded ${
                    d.platform === 'tpu' ? 'bg-[#00ffcc]/10 text-[#00ffcc]' : 'bg-white/5 text-white/50'
                  }`}>
                    {d.platform}
                  </span>
                </div>
              ))}
              <div className="mt-3 pt-2 border-t border-white/5">
                <KV label="Default Backend" value={metrics.platform.default_backend} highlight />
                <KV label="JAX Version" value={metrics.platform.jax_version} />
                <KV label="Float64" value={metrics.platform.float64_enabled ? 'enabled' : 'disabled'} />
                <KV label="JAX_PLATFORMS" value={metrics.platform.jax_platforms_env} />
              </div>
            </Section>

            {/* XLA Cache */}
            <Section title="XLA Compilation Cache" icon={Database}>
              <KV label="Status" value={metrics.xla_cache.enabled ? 'ACTIVE' : 'DISABLED'} highlight={metrics.xla_cache.enabled} />
              <KV label="Type" value={metrics.xla_cache.type} />
              <KV label="Directory" value={metrics.xla_cache.directory} />
              {metrics.timings.run_count !== undefined && (
                <KV label="Cached Runs" value={metrics.timings.run_count} highlight />
              )}
              <div className="mt-3 pt-2 border-t border-white/5">
                <p className="font-sans text-[10px] text-white/30 leading-relaxed">
                  XLA compiles JAX functions to optimized HLO programs on first call per unique input shape.
                  Compiled programs are cached to GCS so they persist across pod restarts.
                </p>
              </div>
            </Section>

            {/* Performance Breakdown — full width */}
            <div className="md:col-span-2">
              <Section title="Performance Breakdown" icon={BarChart3}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Bar chart */}
                  <div>
                    <p className="font-sans text-[10px] text-white/40 uppercase tracking-wider mb-3">Latest Simulation</p>
                    {timingKeys.map(k => (
                      <TimingBar
                        key={k}
                        label={k.replace('_ms', '').replace(/_/g, ' ')}
                        ms={timings[k] ?? 0}
                        maxMs={maxTiming}
                      />
                    ))}
                    {timings.total_ms !== undefined && (
                      <div className="mt-2 pt-2 border-t border-white/10 flex justify-between">
                        <span className="font-sans text-[10px] uppercase tracking-wider text-white/50">Total</span>
                        <span className="font-mono text-xs text-[#00ffcc] font-bold">{timings.total_ms.toFixed(1)}ms</span>
                      </div>
                    )}
                    {timings.panel_count !== undefined && (
                      <div className="flex justify-between mt-1">
                        <span className="font-sans text-[10px] uppercase tracking-wider text-white/50">Panels</span>
                        <span className="font-mono text-xs text-white/60">{timings.panel_count}</span>
                      </div>
                    )}
                  </div>

                  {/* Averages */}
                  <div>
                    <p className="font-sans text-[10px] text-white/40 uppercase tracking-wider mb-3">
                      Averages ({metrics.timings.run_count ?? 0} runs)
                    </p>
                    {metrics.timings.averages && Object.entries(metrics.timings.averages)
                      .filter(([k]) => timingKeys.includes(k))
                      .map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between py-1.5 border-b border-white/5">
                          <span className="font-sans text-[10px] uppercase tracking-wider text-white/40">
                            {k.replace('_ms', '').replace(/_/g, ' ')}
                          </span>
                          <div className="flex gap-3 font-mono text-[10px]">
                            <span className="text-white/30">min {v.min}</span>
                            <span className="text-[#00ffcc]">avg {v.mean}</span>
                            <span className="text-white/30">max {v.max}</span>
                          </div>
                        </div>
                      ))
                    }
                  </div>
                </div>
              </Section>
            </div>

            {/* Memory */}
            <Section title="Device Memory" icon={HardDrive}>
              {Object.entries(metrics.memory).map(([key, val]) => {
                if (typeof val === 'string') return <p key={key} className="font-sans text-[10px] text-white/30">{val}</p>
                if (typeof val !== 'object' || val === null) return null
                if ('note' in val) return <p key={key} className="font-sans text-[10px] text-white/30">{(val as { note: string }).note}</p>
                const mem = val as { bytes_in_use: number; bytes_limit: number; peak_bytes_in_use: number }
                return (
                  <div key={key}>
                    <MemoryBar label={key} used={mem.bytes_in_use} total={mem.bytes_limit} />
                    {mem.peak_bytes_in_use > 0 && (
                      <p className="font-mono text-[10px] text-white/30 mt-0.5">
                        Peak: {(mem.peak_bytes_in_use / 1024 / 1024).toFixed(0)} MB
                      </p>
                    )}
                  </div>
                )
              })}
              {Object.keys(metrics.memory).length === 0 && (
                <p className="font-sans text-[10px] text-white/30">No accelerator memory stats available (CPU mode)</p>
              )}
            </Section>

            {/* Micro-benchmark */}
            <Section title="Micro-Benchmark" icon={Activity}>
              {Object.entries(metrics.benchmark).map(([k, v]) => (
                <KV
                  key={k}
                  label={k.replace(/_/g, ' ')}
                  value={typeof v === 'number' ? `${v}${k.includes('_us') ? 'us' : k.includes('_ms') ? 'ms' : ''}` : String(v)}
                  highlight={typeof v === 'number'}
                />
              ))}
            </Section>

            {/* Solver Config — full width */}
            <div className="md:col-span-2">
              <Section title="Solver Configuration" icon={Server}>
                <div className="grid grid-cols-2 gap-x-6">
                  {Object.entries(metrics.solver).map(([k, v]) => (
                    <KV key={k} label={k.replace(/_/g, ' ')} value={Array.isArray(v) ? v.join(', ') : String(v)} />
                  ))}
                </div>
              </Section>
            </div>

            {/* Uptime */}
            {metrics.uptime.seconds_since_first_sim !== undefined && (
              <div className="md:col-span-2 flex justify-center">
                <div className="flex items-center gap-2 px-4 py-2 bg-white/5 rounded-full">
                  <Clock size={12} className="text-white/30" />
                  <span className="font-mono text-[10px] text-white/30">
                    Uptime since first sim: {formatUptime(metrics.uptime.seconds_since_first_sim)}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}
