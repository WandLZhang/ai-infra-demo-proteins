import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Cpu, Zap, Download, Brain, CheckCircle, XCircle, Clock, DollarSign } from 'lucide-react'
import type { LaneStatus, LaneState } from '../types'
import type { AcceleratorBackend } from '../backends'

const STATE_CONFIG: Record<LaneState, { icon: any; label: string; color: string }> = {
  idle:       { icon: Clock,       label: 'Idle',            color: 'text-zinc-500' },
  queued:     { icon: Clock,       label: 'Queued',          color: 'text-zinc-400' },
  allocating: { icon: Zap,         label: 'Spot allocating', color: 'text-yellow-400' },
  pulling:    { icon: Download,    label: 'Pulling image',   color: 'text-blue-400' },
  loading:    { icon: Brain,       label: 'Loading model',   color: 'text-purple-400' },
  inferring:  { icon: Cpu,         label: 'Inferring',       color: 'text-cyan-400' },
  done:       { icon: CheckCircle, label: 'Done',            color: 'text-emerald-400' },
  failed:     { icon: XCircle,     label: 'Failed',          color: 'text-red-400' },
}

const PROGRESS_ORDER: LaneState[] = ['idle', 'queued', 'allocating', 'pulling', 'loading', 'inferring', 'done']

function progressPercent(state: LaneState): number {
  const idx = PROGRESS_ORDER.indexOf(state)
  if (idx < 0) return 0
  return Math.round((idx / (PROGRESS_ORDER.length - 1)) * 100)
}

interface BackendLaneProps {
  backend: AcceleratorBackend
  status: LaneStatus
  isSelected: boolean
  onSelect: () => void
}

export default function BackendLane({ backend, status, isSelected, onSelect }: BackendLaneProps) {
  const cfg = STATE_CONFIG[status.state]
  const Icon = cfg.icon
  const pct = progressPercent(status.state)
  const isTpu = backend.siliconId === 'tpu'

  const [elapsedDisplay, setElapsedDisplay] = useState('0.0s')

  useEffect(() => {
    if (!status.startedAt || status.state === 'done' || status.state === 'failed' || status.state === 'idle') {
      if (status.completedAt && status.startedAt) {
        setElapsedDisplay(`${((status.completedAt - status.startedAt) / 1000).toFixed(1)}s`)
      }
      return
    }
    const interval = setInterval(() => {
      setElapsedDisplay(`${((Date.now() - status.startedAt!) / 1000).toFixed(1)}s`)
    }, 100)
    return () => clearInterval(interval)
  }, [status.startedAt, status.state, status.completedAt])

  return (
    <motion.div
      onClick={onSelect}
      className={`
        relative overflow-hidden rounded-lg border cursor-pointer
        transition-all duration-200
        ${isSelected ? 'ring-2 ring-white/30 bg-white/[0.06]' : 'bg-white/[0.03] hover:bg-white/[0.05]'}
        ${backend.accent}
      `}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Progress bar background */}
      <div className="absolute inset-0 pointer-events-none">
        <motion.div
          className={`h-full ${isTpu ? 'bg-emerald-500/10' : 'bg-amber-500/10'}`}
          initial={{ width: '0%' }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>

      <div className="relative p-3 flex items-center gap-3">
        {/* Silicon badge */}
        <div className={`
          flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase tracking-wider
          ${isTpu ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}
        `}>
          {backend.siliconName}
        </div>

        {/* Model name */}
        <div className="flex-shrink-0 text-sm font-medium text-white/80 w-20">
          {backend.modelName}
        </div>

        {/* State indicator */}
        <div className={`flex items-center gap-1.5 flex-1 ${cfg.color}`}>
          <Icon size={14} className={status.state === 'inferring' || status.state === 'allocating' ? 'animate-pulse' : ''} />
          <span className="text-xs font-mono">{cfg.label}</span>
        </div>

        {/* Timer */}
        <div className="text-xs font-mono text-white/50 w-14 text-right">
          {status.state !== 'idle' ? elapsedDisplay : '—'}
        </div>

        {/* Cost */}
        <div className="flex items-center gap-0.5 text-xs font-mono w-20 text-right">
          <DollarSign size={10} className="text-white/30" />
          <span className={status.state === 'done' ? (isTpu ? 'text-emerald-300' : 'text-amber-300') : 'text-white/40'}>
            {status.costAccumulated > 0 ? status.costAccumulated.toFixed(4) : '0.0000'}
          </span>
        </div>

        {/* Talk track badge */}
        <AnimatePresence>
          {status.state === 'done' && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="flex-shrink-0 w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-white/60"
              title={backend.talkTrackLabel}
            >
              {backend.talkTrackSlide}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Expanded detail on selection */}
      <AnimatePresence>
        {isSelected && status.result && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="relative border-t border-white/5 px-3 py-2 text-[11px] font-mono text-white/40 space-y-1"
          >
            <div>pLDDT: <span className="text-white/70">{status.result.plddt_mean.toFixed(1)}</span></div>
            <div>Device: <span className="text-white/70">{status.result.device_kind}</span></div>
            <div>Residues: <span className="text-white/70">{status.result.seq_len}</span></div>
            <div className="text-white/20">{backend.blurb}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
