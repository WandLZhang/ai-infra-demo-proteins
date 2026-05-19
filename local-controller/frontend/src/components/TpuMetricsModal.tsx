import React, { useEffect, useState } from 'react'
import { X, Cpu, Zap } from 'lucide-react'
import { fetchMetrics } from '../api'
import type { TpuMetrics } from '../types'
import { BACKENDS } from '../backends'

interface Props {
  onClose: () => void
}

export default function TpuMetricsModal({ onClose }: Props) {
  const [metrics, setMetrics] = useState<Record<string, TpuMetrics | null>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const results: Record<string, TpuMetrics | null> = {}
      for (const b of BACKENDS) {
        if (!b.apiBase) {
          results[b.id] = null
          continue
        }
        try {
          results[b.id] = await fetchMetrics(b.apiBase)
        } catch {
          results[b.id] = null
        }
      }
      setMetrics(results)
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#111118] border border-white/10 rounded-xl w-[600px] max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-cyan-400" />
            <span className="text-sm font-bold">Backend Metrics</span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-3">
          {loading ? (
            <div className="text-center text-white/40 py-8 text-sm">Loading metrics from backends...</div>
          ) : (
            BACKENDS.map(b => {
              const m = metrics[b.id]
              return (
                <div key={b.id} className={`p-3 rounded-lg border ${b.accent} bg-white/[0.02]`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Zap size={12} className={b.siliconId === 'tpu' ? 'text-emerald-400' : 'text-amber-400'} />
                    <span className="text-xs font-bold">{b.shortLabel}</span>
                    <span className={`ml-auto text-[10px] px-2 py-0.5 rounded ${m?.warm ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>
                      {m ? (m.warm ? 'WARM' : m.warm_error || 'COLD') : 'UNREACHABLE'}
                    </span>
                  </div>
                  {m && (
                    <div className="text-[10px] font-mono text-white/40 space-y-0.5">
                      <div>Devices: {m.devices?.map(d => d.device_kind).join(', ') || '—'}</div>
                      <div>Count: {m.num_devices} · {m.jax_version ? `JAX ${m.jax_version}` : m.torch_version ? `PyTorch ${m.torch_version}` : '—'}</div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
