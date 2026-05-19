import React, { useState, useCallback, useRef, useMemo } from 'react'
import { ReactFlow, Background, Controls, type Node, type Edge, Position, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { motion, AnimatePresence } from 'motion/react'
import { Dna, Zap, DollarSign, Cpu, Server, Activity } from 'lucide-react'

import ProteinSelector, { PROTEINS } from './components/ProteinSelector'
import BackendLane from './components/BackendLane'
import Scorecard from './components/Scorecard'
import TalkTrackBadge from './components/TalkTrackBadge'
import type { Protein, ModelId, BackendId, LaneStatus, PredictResponse } from './types'
import { BACKENDS } from './backends'

function initLaneStatus(backendId: BackendId): LaneStatus {
  const b = BACKENDS.find(b => b.id === backendId)!
  return {
    backendId, state: 'idle', startedAt: null, completedAt: null,
    elapsedMs: 0, costAccumulated: 0, result: null, error: null,
    talkTrackSlide: b.talkTrackSlide, talkTrackLabel: b.talkTrackLabel,
  }
}

function buildInfraNodes(lanes: Record<BackendId, LaneStatus>): Node[] {
  const stateColor = (id: BackendId) => {
    const s = lanes[id]?.state
    if (s === 'done') return '#10b981'
    if (s === 'failed') return '#ef4444'
    if (s === 'inferring') return '#06b6d4'
    if (s === 'allocating' || s === 'pulling' || s === 'loading') return '#eab308'
    if (s === 'queued') return '#6366f1'
    return '#27272a'
  }

  const nodeStyle = (id: BackendId) => ({
    background: '#0a0a0f',
    border: `2px solid ${stateColor(id)}`,
    borderRadius: 8,
    padding: 12,
    color: '#e4e4e7',
    fontSize: 11,
    fontFamily: 'monospace',
    minWidth: 140,
    boxShadow: `0 0 12px ${stateColor(id)}33`,
  })

  return [
    // Controller
    {
      id: 'controller', type: 'default', position: { x: 50, y: 220 },
      data: { label: '🖥 slurmctld\nwz-nih-demo-controller' },
      style: { background: '#0a0a0f', border: '2px solid #06b6d4', borderRadius: 8, padding: 12, color: '#06b6d4', fontSize: 11, fontFamily: 'monospace', minWidth: 160, boxShadow: '0 0 20px #06b6d433' },
      sourcePosition: Position.Right,
    },
    // TPU column
    {
      id: 'tpu-header', type: 'default', position: { x: 380, y: 20 },
      data: { label: '⚡ TPU v6e Trillium\nSpot · 5 CONUS zones' },
      style: { background: '#064e3b22', border: '1px solid #10b98144', borderRadius: 8, padding: 10, color: '#6ee7b7', fontSize: 10, fontFamily: 'monospace', minWidth: 160 },
    },
    {
      id: 'af2-tpu', type: 'default', position: { x: 360, y: 100 },
      data: { label: `AF2\n${lanes['af2-tpu']?.state ?? 'idle'}` },
      style: nodeStyle('af2-tpu'), targetPosition: Position.Left, sourcePosition: Position.Right,
    },
    {
      id: 'esmfold-tpu', type: 'default', position: { x: 360, y: 210 },
      data: { label: `ESMFold\n${lanes['esmfold-tpu']?.state ?? 'idle'}` },
      style: nodeStyle('esmfold-tpu'), targetPosition: Position.Left, sourcePosition: Position.Right,
    },
    {
      id: 'boltz2-tpu', type: 'default', position: { x: 360, y: 320 },
      data: { label: `Boltz-2\n${lanes['boltz2-tpu']?.state ?? 'idle'}` },
      style: nodeStyle('boltz2-tpu'), targetPosition: Position.Left, sourcePosition: Position.Right,
    },
    // GPU column
    {
      id: 'gpu-header', type: 'default', position: { x: 620, y: 20 },
      data: { label: '🔥 GPU A100\nSpot · 2 CONUS zones' },
      style: { background: '#451a0322', border: '1px solid #f5920044', borderRadius: 8, padding: 10, color: '#fbbf24', fontSize: 10, fontFamily: 'monospace', minWidth: 160 },
    },
    {
      id: 'af2-gpu', type: 'default', position: { x: 600, y: 100 },
      data: { label: `AF2\n${lanes['af2-gpu']?.state ?? 'idle'}` },
      style: nodeStyle('af2-gpu'), targetPosition: Position.Left, sourcePosition: Position.Right,
    },
    {
      id: 'esmfold-gpu', type: 'default', position: { x: 600, y: 210 },
      data: { label: `ESMFold\n${lanes['esmfold-gpu']?.state ?? 'idle'}` },
      style: nodeStyle('esmfold-gpu'), targetPosition: Position.Left, sourcePosition: Position.Right,
    },
    {
      id: 'boltz2-gpu', type: 'default', position: { x: 600, y: 320 },
      data: { label: `Boltz-2\n${lanes['boltz2-gpu']?.state ?? 'idle'}` },
      style: nodeStyle('boltz2-gpu'), targetPosition: Position.Left, sourcePosition: Position.Right,
    },
    // Results
    {
      id: 'results', type: 'default', position: { x: 880, y: 220 },
      data: { label: '📊 Results\nPDB + pLDDT + $/prediction' },
      style: { background: '#0a0a0f', border: '1px solid #06b6d444', borderRadius: 8, padding: 12, color: '#a1a1aa', fontSize: 10, fontFamily: 'monospace', minWidth: 160 },
      targetPosition: Position.Left,
    },
  ]
}

function buildInfraEdges(lanes: Record<BackendId, LaneStatus>): Edge[] {
  const edgeColor = (id: BackendId) => {
    const s = lanes[id]?.state
    if (s === 'done') return '#10b981'
    if (s === 'inferring') return '#06b6d4'
    if (s !== 'idle') return '#eab30888'
    return '#27272a44'
  }
  const animated = (id: BackendId) => {
    const s = lanes[id]?.state
    return s !== 'idle' && s !== 'done' && s !== 'failed'
  }

  const backends: BackendId[] = ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu', 'af2-gpu', 'esmfold-gpu', 'boltz2-gpu']
  const edges: Edge[] = []

  for (const id of backends) {
    edges.push({
      id: `ctrl-${id}`, source: 'controller', target: id,
      animated: animated(id),
      style: { stroke: edgeColor(id), strokeWidth: animated(id) ? 2 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor(id) },
    })
    edges.push({
      id: `${id}-results`, source: id, target: 'results',
      animated: lanes[id]?.state === 'done',
      style: { stroke: lanes[id]?.state === 'done' ? '#10b981' : '#27272a22', strokeWidth: 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: lanes[id]?.state === 'done' ? '#10b981' : '#27272a22' },
    })
  }
  return edges
}

export default function App() {
  const [lanes, setLanes] = useState<Record<BackendId, LaneStatus>>(
    Object.fromEntries(BACKENDS.map(b => [b.id, initLaneStatus(b.id)])) as Record<BackendId, LaneStatus>
  )
  const [isRunning, setIsRunning] = useState(false)
  const [showScorecard, setShowScorecard] = useState(false)
  const [currentProtein, setCurrentProtein] = useState<Protein>(PROTEINS[0])
  const [selectedLane, setSelectedLane] = useState<BackendId | null>(null)
  const [controlsOpen, setControlsOpen] = useState(true)
  const costIntervals = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  const updateLane = useCallback((id: BackendId, update: Partial<LaneStatus>) => {
    setLanes(prev => ({ ...prev, [id]: { ...prev[id], ...update } }))
  }, [])

  const simulateLane = useCallback(async (backendId: BackendId, protein: Protein) => {
    const backend = BACKENDS.find(b => b.id === backendId)!
    const now = Date.now()
    updateLane(backendId, { state: 'queued', startedAt: now, costAccumulated: 0, result: null, error: null })
    await delay(300 + Math.random() * 400)

    updateLane(backendId, { state: 'allocating' })
    await delay(backend.siliconId === 'tpu' ? 600 + Math.random() * 1400 : 1200 + Math.random() * 2500)

    const costInterval = setInterval(() => {
      setLanes(prev => {
        const lane = prev[backendId]
        if (lane.state === 'done' || lane.state === 'failed' || lane.state === 'idle') return prev
        return { ...prev, [backendId]: { ...lane, costAccumulated: ((Date.now() - (lane.startedAt || now)) / 1000) * backend.pricePerSec } }
      })
    }, 100)
    costIntervals.current[backendId] = costInterval

    updateLane(backendId, { state: 'pulling' })
    await delay(500 + Math.random() * 1000)

    updateLane(backendId, { state: 'loading' })
    await delay(800 + Math.random() * 1500)

    updateLane(backendId, { state: 'inferring' })

    let result: PredictResponse
    try {
      if (backend.apiBase) {
        const resp = await fetch(`${backend.apiBase}/api/predict`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sequence: protein.sequence, feature_id: protein.id }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        result = await resp.json()
      } else {
        const t = backend.modelId === 'esmfold' ? 1500 + Math.random() * 3000
          : backend.modelId === 'af2' ? 4000 + Math.random() * 8000
          : 6000 + Math.random() * 12000
        await delay(t)
        result = {
          pdb: '', plddt_mean: 82 + Math.random() * 14, solve_time_ms: t * (backend.siliconId === 'tpu' ? 0.55 : 1),
          device_kind: backend.siliconId === 'tpu' ? 'TPU v6e' : 'NVIDIA A100', num_devices: backend.siliconId === 'tpu' ? 4 : 1,
          seq_len: protein.residueCount, model: backend.modelName,
        }
      }
    } catch (err: any) {
      clearInterval(costInterval)
      updateLane(backendId, { state: 'failed', completedAt: Date.now(), costAccumulated: ((Date.now() - now) / 1000) * backend.pricePerSec, error: err.message })
      return
    }

    clearInterval(costInterval)
    const done = Date.now()
    updateLane(backendId, { state: 'done', completedAt: done, elapsedMs: done - now, costAccumulated: ((done - now) / 1000) * backend.pricePerSec, result })
  }, [updateLane])

  const handleSubmit = useCallback(async (protein: Protein, models: ModelId[]) => {
    setIsRunning(true)
    setShowScorecard(false)
    setCurrentProtein(protein)
    setLanes(Object.fromEntries(BACKENDS.map(b => [b.id, initLaneStatus(b.id)])) as Record<BackendId, LaneStatus>)
    Object.values(costIntervals.current).forEach(clearInterval)
    costIntervals.current = {}
    await Promise.allSettled(BACKENDS.filter(b => models.includes(b.modelId)).map(b => simulateLane(b.id, protein)))
    setIsRunning(false)
    setShowScorecard(true)
  }, [simulateLane])

  const nodes = useMemo(() => buildInfraNodes(lanes), [lanes])
  const edges = useMemo(() => buildInfraEdges(lanes), [lanes])
  const doneCount = Object.values(lanes).filter(l => l.state === 'done').length
  const activeCount = Object.values(lanes).filter(l => l.state !== 'idle').length

  return (
    <div className="w-screen h-screen bg-[#060609] text-white overflow-hidden relative">
      {/* FULLSCREEN: Infrastructure Flow Diagram */}
      <div className="absolute inset-0">
        <ReactFlow
          nodes={nodes} edges={edges}
          fitView fitViewOptions={{ padding: 0.3 }}
          proOptions={{ hideAttribution: true }}
          style={{ background: '#060609' }}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
          panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false}
        >
          <Background color="#ffffff08" gap={40} size={1} />
        </ReactFlow>
      </div>

      {/* HUD — top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-3 bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
        <div className="flex items-center gap-3 pointer-events-auto">
          <Dna size={18} className="text-[#06b6d4]" />
          <span className="text-sm font-bold tracking-wider text-[#06b6d4]">PROTEIN STRUCTURE PREDICTION</span>
          <span className="text-[10px] text-white/20 font-mono ml-2">NIH Biowulf · TPU vs GPU</span>
        </div>
        <div className="flex items-center gap-4 text-[10px] font-mono text-white/30 pointer-events-auto">
          <span>{currentProtein.name} · {currentProtein.residueCount} aa</span>
          {activeCount > 0 && <span className="text-[#06b6d4]">{doneCount}/{activeCount} complete</span>}
          {isRunning && <span className="text-yellow-400 animate-pulse">● LIVE</span>}
        </div>
      </div>

      {/* LEFT OVERLAY — Protein selector (glass) */}
      <motion.div
        className="absolute top-16 left-4 z-20 w-64 rounded-xl bg-black/50 backdrop-blur-md border border-white/[0.06] shadow-2xl overflow-hidden"
        initial={{ x: -280 }} animate={{ x: 0 }} transition={{ duration: 0.4 }}
      >
        <ProteinSelector onSubmit={handleSubmit} isRunning={isRunning} />
      </motion.div>

      {/* RIGHT OVERLAY — Backend lanes (glass) */}
      <motion.div
        className="absolute top-16 right-4 z-20 w-80 rounded-xl bg-black/50 backdrop-blur-md border border-white/[0.06] shadow-2xl overflow-hidden max-h-[calc(100vh-5rem)]"
        initial={{ x: 340 }} animate={{ x: 0 }} transition={{ duration: 0.4 }}
      >
        <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
          <Activity size={12} className="text-[#06b6d4]" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/40">Accelerator $/calc</span>
        </div>
        <div className="p-2 space-y-1.5 overflow-y-auto max-h-[400px]">
          {BACKENDS.map(b => (
            <BackendLane key={b.id} backend={b} status={lanes[b.id]}
              isSelected={selectedLane === b.id} onSelect={() => setSelectedLane(selectedLane === b.id ? null : b.id)} />
          ))}
        </div>
        <AnimatePresence>{showScorecard && <Scorecard lanes={lanes} />}</AnimatePresence>
      </motion.div>

      {/* BOTTOM — Talk track badge */}
      {showScorecard && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20">
          <TalkTrackBadge slide={16} label="This IS the Science Gateway. Researcher picks the science. System picks the silicon." />
        </div>
      )}
    </div>
  )
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
