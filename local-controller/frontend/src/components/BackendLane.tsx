import React from 'react'
import { Loader2 } from 'lucide-react'
import type { LaneStatus } from '../types'
import type { AcceleratorBackend } from '../backends'

interface BackendLaneProps {
  backend: AcceleratorBackend
  status: LaneStatus
  isSelected: boolean
  onSelect: () => void
  cheapestCost: number | null
}

export default function BackendLane({ backend, status, isSelected, onSelect, cheapestCost }: BackendLaneProps) {
  const isTpu = backend.siliconId === 'tpu'
  const costPerSolve = status.costAccumulated
  const ratio = cheapestCost && costPerSolve > 0 ? costPerSolve / cheapestCost : null

  const dotClass = status.state === 'done'
    ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)] animate-pulse'
    : status.state === 'inferring' || status.state === 'loading' || status.state === 'allocating'
    ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]'
    : status.state === 'failed'
    ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)]'
    : 'bg-white/20'

  const siliconStr = status.result?.device_kind ?? (isTpu ? 'TPU v6 lite' : 'NVIDIA A100-SXM4-40GB')

  return (
    <div
      onClick={onSelect}
      className={`border ${backend.accent} bg-white/[0.02] rounded-lg p-3 cursor-pointer transition-all hover:bg-white/[0.04] ${isSelected ? 'ring-1 ring-white/20' : ''}`}
      title={backend.blurb}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
          <span className="font-mono text-[11px] uppercase tracking-wider text-white/80 truncate">
            {backend.shortLabel}
          </span>
          {status.state === 'done' && (
            <span className="text-[8.5px] font-mono italic text-white/35 truncate">{siliconStr}</span>
          )}
        </div>
        {(status.state === 'allocating' || status.state === 'pulling' || status.state === 'loading' || status.state === 'inferring') && (
          <Loader2 size={12} className="text-[#00ffcc] animate-spin shrink-0" />
        )}
        {status.state === 'failed' && (
          <span className="text-red-400 text-[9px] font-mono uppercase shrink-0">err</span>
        )}
      </div>

      {status.state === 'idle' && (
        <div className="text-white/20 font-mono text-[10px]">— click Submit All —</div>
      )}

      {(status.state === 'queued' || status.state === 'allocating') && (
        <div className="text-white/40 font-mono text-[10px]">
          {status.state === 'queued' ? 'queued...' : 'spot allocating...'}
        </div>
      )}

      {(status.state === 'pulling' || status.state === 'loading') && (
        <div className="text-white/40 font-mono text-[10px]">
          {status.state === 'pulling' ? 'pulling image...' : 'loading model...'}
        </div>
      )}

      {status.state === 'inferring' && (
        <div className="text-[#00ffcc]/60 font-mono text-[10px]">inferring...</div>
      )}

      {status.state === 'failed' && (
        <div className="text-red-400/80 font-mono text-[10px]">{status.error?.slice(0, 40) || 'failed'}</div>
      )}

      {status.state === 'done' && (() => {
        const itemsPerDollar = costPerSolve > 0 ? 1 / costPerSolve : 0
        const itemsStr = itemsPerDollar >= 1e6 ? `${(itemsPerDollar / 1e6).toFixed(1)}M`
          : itemsPerDollar >= 1e3 ? `${(itemsPerDollar / 1e3).toFixed(1)}K`
          : `${Math.round(itemsPerDollar)}`
        return (
          <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
            <div>
              <div className="text-white/30 uppercase tracking-wider">$ / predict</div>
              <div className="text-[#00ffcc]">${costPerSolve.toFixed(6)}</div>
            </div>
            <div>
              <div className="text-white/30 uppercase tracking-wider">predicts / $</div>
              <div className="text-[#00ffcc]">{itemsStr}</div>
            </div>
            <div>
              <div className="text-white/30 uppercase tracking-wider">vs best</div>
              <div className={ratio !== null && ratio <= 1.01 ? 'text-emerald-400' : 'text-white/60'}>
                {ratio !== null ? (ratio <= 1.01 ? '✓' : `${ratio.toFixed(1)}×`) : '—'}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
