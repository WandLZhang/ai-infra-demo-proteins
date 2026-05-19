import React from 'react'
import { motion } from 'motion/react'
import { Trophy } from 'lucide-react'
import type { BackendId, LaneStatus } from '../types'
import { BACKENDS } from '../backends'

interface ScorecardProps {
  lanes: Record<BackendId, LaneStatus>
}

export default function Scorecard({ lanes }: ScorecardProps) {
  const models = ['af2', 'esmfold', 'boltz2'] as const
  const modelNames: Record<string, string> = { af2: 'AlphaFold 2', esmfold: 'ESMFold', boltz2: 'Boltz-2' }

  const rows = models.map(m => {
    const tpuLane = lanes[`${m}-tpu` as BackendId]
    const gpuLane = lanes[`${m}-gpu` as BackendId]
    const tpuCost = tpuLane?.state === 'done' ? tpuLane.costAccumulated : null
    const gpuCost = gpuLane?.state === 'done' ? gpuLane.costAccumulated : null
    const savings = tpuCost && gpuCost && tpuCost > 0 ? `${(gpuCost / tpuCost).toFixed(1)}x` : '—'
    return { model: modelNames[m], tpuCost, gpuCost, savings }
  }).filter(r => r.tpuCost !== null || r.gpuCost !== null)

  const totalTpu = rows.reduce((s, r) => s + (r.tpuCost || 0), 0)
  const totalGpu = rows.reduce((s, r) => s + (r.gpuCost || 0), 0)
  const totalSavings = totalTpu > 0 ? `${(totalGpu / totalTpu).toFixed(1)}x` : '—'

  if (rows.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="border-t border-white/5 p-3"
    >
      <div className="flex items-center gap-2 mb-2">
        <Trophy size={12} className="text-amber-400" />
        <span className="text-[10px] font-mono uppercase tracking-widest text-white/50">Cost Scorecard</span>
      </div>

      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-white/30">
            <th className="text-left py-1">Model</th>
            <th className="text-right py-1 text-emerald-400/60">TPU v6e</th>
            <th className="text-right py-1 text-amber-400/60">GPU A100</th>
            <th className="text-right py-1">Savings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.model} className="border-t border-white/5">
              <td className="py-1 text-white/60">{r.model}</td>
              <td className="py-1 text-right text-emerald-300">${r.tpuCost?.toFixed(4) ?? '—'}</td>
              <td className="py-1 text-right text-amber-300">${r.gpuCost?.toFixed(4) ?? '—'}</td>
              <td className="py-1 text-right text-white/80 font-bold">{r.savings}</td>
            </tr>
          ))}
          <tr className="border-t border-white/10 font-bold">
            <td className="py-1.5 text-white/80">TOTAL</td>
            <td className="py-1.5 text-right text-emerald-300">${totalTpu.toFixed(4)}</td>
            <td className="py-1.5 text-right text-amber-300">${totalGpu.toFixed(4)}</td>
            <td className="py-1.5 text-right text-white font-bold text-sm">{totalSavings}</td>
          </tr>
        </tbody>
      </table>
    </motion.div>
  )
}
