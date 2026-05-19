import React, { useState, useCallback, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom, ChromaticAberration, Noise, Vignette } from '@react-three/postprocessing'
import { Vector2 } from 'three'
import { BlendFunction } from 'postprocessing'
import { Dna, Activity, Cpu } from 'lucide-react'

import ProteinSelector, { PROTEINS } from './components/ProteinSelector'
import BackendLane from './components/BackendLane'
import Scorecard from './components/Scorecard'
import TalkTrackBadge from './components/TalkTrackBadge'
import TpuMetricsModal from './components/TpuMetricsModal'
import type { Protein, ModelId, BackendId, LaneStatus, LaneState, PredictResponse } from './types'
import { BACKENDS } from './backends'

function ProteinScene() {
  return (
    <group>
      <mesh rotation={[0, 0, 0]}>
        <torusKnotGeometry args={[1.2, 0.35, 200, 32, 2, 3]} />
        <meshStandardMaterial
          color="#4ade80"
          emissive="#065f46"
          emissiveIntensity={0.4}
          roughness={0.3}
          metalness={0.6}
        />
      </mesh>
      <ambientLight intensity={0.3} />
      <directionalLight position={[5, 5, 5]} intensity={0.8} />
      <pointLight position={[-3, -3, 2]} intensity={0.4} color="#06b6d4" />
    </group>
  )
}

function initLaneStatus(backendId: BackendId): LaneStatus {
  const b = BACKENDS.find(b => b.id === backendId)!
  return {
    backendId,
    state: 'idle',
    startedAt: null,
    completedAt: null,
    elapsedMs: 0,
    costAccumulated: 0,
    result: null,
    error: null,
    talkTrackSlide: b.talkTrackSlide,
    talkTrackLabel: b.talkTrackLabel,
  }
}

export default function App() {
  const [lanes, setLanes] = useState<Record<BackendId, LaneStatus>>(
    Object.fromEntries(BACKENDS.map(b => [b.id, initLaneStatus(b.id)])) as Record<BackendId, LaneStatus>
  )
  const [selectedLane, setSelectedLane] = useState<BackendId | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [showScorecard, setShowScorecard] = useState(false)
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [currentProtein, setCurrentProtein] = useState<Protein>(PROTEINS[0])
  const costIntervals = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  const updateLane = useCallback((id: BackendId, update: Partial<LaneStatus>) => {
    setLanes(prev => ({ ...prev, [id]: { ...prev[id], ...update } }))
  }, [])

  const simulateLane = useCallback(async (backendId: BackendId, protein: Protein) => {
    const backend = BACKENDS.find(b => b.id === backendId)!
    const now = Date.now()

    updateLane(backendId, { state: 'queued', startedAt: now, costAccumulated: 0, result: null, error: null })
    await delay(300 + Math.random() * 200)

    updateLane(backendId, { state: 'allocating' })
    const allocDelay = backend.siliconId === 'tpu' ? 800 + Math.random() * 1200 : 1500 + Math.random() * 2000
    await delay(allocDelay)

    const costInterval = setInterval(() => {
      setLanes(prev => {
        const lane = prev[backendId]
        if (lane.state === 'done' || lane.state === 'failed' || lane.state === 'idle') return prev
        const elapsed = (Date.now() - (lane.startedAt || now)) / 1000
        return { ...prev, [backendId]: { ...lane, costAccumulated: elapsed * backend.pricePerSec } }
      })
    }, 100)
    costIntervals.current[backendId] = costInterval

    updateLane(backendId, { state: 'pulling' })
    await delay(600 + Math.random() * 800)

    updateLane(backendId, { state: 'loading' })
    await delay(1000 + Math.random() * 1500)

    updateLane(backendId, { state: 'inferring' })

    let result: PredictResponse
    try {
      if (backend.apiBase) {
        const resp = await fetch(`${backend.apiBase}/api/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sequence: protein.sequence, feature_id: protein.id }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        result = await resp.json()
      } else {
        const inferDelay = backend.modelId === 'esmfold' ? 2000 + Math.random() * 3000
          : backend.modelId === 'af2' ? 5000 + Math.random() * 10000
          : 8000 + Math.random() * 15000
        await delay(inferDelay)
        const tpuSpeedFactor = backend.siliconId === 'tpu' ? 0.6 : 1.0
        result = {
          pdb: '',
          plddt_mean: 85 + Math.random() * 10,
          plddt_min: 60 + Math.random() * 20,
          plddt_max: 92 + Math.random() * 6,
          solve_time_ms: inferDelay * tpuSpeedFactor,
          device_kind: backend.siliconId === 'tpu' ? 'TPU v6e' : 'NVIDIA A100-SXM4-40GB',
          num_devices: backend.siliconId === 'tpu' ? 4 : 1,
          seq_len: protein.residueCount,
          model: backend.modelName,
        }
      }
    } catch (err: any) {
      clearInterval(costInterval)
      const elapsed = (Date.now() - now) / 1000
      updateLane(backendId, {
        state: 'failed', completedAt: Date.now(),
        costAccumulated: elapsed * backend.pricePerSec, error: err.message,
      })
      return
    }

    clearInterval(costInterval)
    const completedAt = Date.now()
    const totalElapsed = (completedAt - now) / 1000
    updateLane(backendId, {
      state: 'done', completedAt, elapsedMs: totalElapsed * 1000,
      costAccumulated: totalElapsed * backend.pricePerSec, result,
    })
  }, [updateLane])

  const handleSubmit = useCallback(async (protein: Protein, models: ModelId[]) => {
    setIsRunning(true)
    setShowScorecard(false)
    setCurrentProtein(protein)
    const resetLanes = Object.fromEntries(
      BACKENDS.map(b => [b.id, initLaneStatus(b.id)])
    ) as Record<BackendId, LaneStatus>
    setLanes(resetLanes)
    Object.values(costIntervals.current).forEach(clearInterval)
    costIntervals.current = {}

    const activeBackends = BACKENDS.filter(b => models.includes(b.modelId))
    await Promise.allSettled(activeBackends.map(b => simulateLane(b.id, protein)))
    setIsRunning(false)
    setShowScorecard(true)
  }, [simulateLane])

  const doneCount = Object.values(lanes).filter(l => l.state === 'done').length
  const activeCount = Object.values(lanes).filter(l => l.state !== 'idle').length

  return (
    <div className="w-screen h-screen bg-[#0a0a0f] text-white overflow-hidden flex">
      {/* LEFT — Protein selector */}
      <div className="w-72 flex-shrink-0 border-r border-white/5 overflow-y-auto">
        <div className="p-4 border-b border-white/5 flex items-center gap-2">
          <Dna size={18} className="text-emerald-400" />
          <span className="text-sm font-bold tracking-wide">PROTEIN DEMO</span>
          <span className="text-[10px] text-white/30 ml-auto font-mono">NIH Biowulf</span>
        </div>
        <ProteinSelector onSubmit={handleSubmit} isRunning={isRunning} />
      </div>

      {/* CENTER — 3D Viewer with F-22 post-processing */}
      <div className="flex-1 relative">
        <Canvas camera={{ position: [0, 0, 4], fov: 50 }} className="absolute inset-0">
          <ProteinScene />
          <OrbitControls enableDamping dampingFactor={0.05} />
          <EffectComposer>
            <Bloom intensity={0.4} luminanceThreshold={0.6} luminanceSmoothing={0.9} />
            <ChromaticAberration offset={new Vector2(0.0005, 0.0005)} blendFunction={BlendFunction.NORMAL} />
            <Noise opacity={0.04} blendFunction={BlendFunction.OVERLAY} />
            <Vignette eskil={false} offset={0.1} darkness={0.8} />
          </EffectComposer>
        </Canvas>

        {/* HUD overlay */}
        <div className="absolute top-4 left-4 z-10">
          <div className="text-[10px] font-mono text-white/30 space-y-0.5">
            <div>slurmctld @ wz-nih-demo-controller</div>
            <div>{currentProtein.name} · {currentProtein.residueCount} residues</div>
            <div>{activeCount > 0 ? `${doneCount}/${activeCount} backends complete` : 'idle'}</div>
          </div>
        </div>

        {showScorecard && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
            <TalkTrackBadge
              slide={16}
              label="This IS the Science Gateway. Researcher picks the science. System picks the silicon."
            />
          </div>
        )}

        <button
          onClick={() => setMetricsOpen(true)}
          className="absolute top-4 right-4 z-10 p-2 rounded bg-white/5 hover:bg-white/10 transition-colors"
          title="TPU/GPU Metrics"
        >
          <Cpu size={14} className="text-white/40" />
        </button>
      </div>

      {/* RIGHT — Backend lanes */}
      <div className="w-96 flex-shrink-0 border-l border-white/5 flex flex-col">
        <div className="p-4 border-b border-white/5 flex items-center gap-2">
          <Activity size={14} className="text-cyan-400" />
          <span className="text-xs font-mono uppercase tracking-widest text-white/60">Backend Lanes</span>
          {isRunning && (
            <span className="ml-auto text-[10px] font-mono text-yellow-400 animate-pulse">LIVE</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {BACKENDS.map(b => (
            <BackendLane
              key={b.id}
              backend={b}
              status={lanes[b.id]}
              isSelected={selectedLane === b.id}
              onSelect={() => setSelectedLane(selectedLane === b.id ? null : b.id)}
            />
          ))}
        </div>

        {showScorecard && <Scorecard lanes={lanes} />}
      </div>

      {metricsOpen && <TpuMetricsModal onClose={() => setMetricsOpen(false)} />}
    </div>
  )
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
