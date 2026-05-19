import React, { useState, useCallback, useEffect, Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment, useProgress } from '@react-three/drei'
import { EffectComposer, Bloom, ChromaticAberration, Noise, Vignette } from '@react-three/postprocessing'
import { Vector2 } from 'three'
import { BlendFunction } from 'postprocessing'
import { Plane, Cpu, Sparkles } from 'lucide-react'

import ControlPanel from './components/ControlPanel'
import SensorReadings from './components/SensorReadings'
import AiAnalysisPanel from './components/AiAnalysisPanel'
import AcceleratorComparison from './components/AcceleratorComparison'
import FineTunePage from './components/FineTunePage'
import JetModel from './components/JetModel'
import StreamlineRenderer from './components/StreamlineRenderer'
import TpuMetricsModal from './components/TpuMetricsModal'
import { useParticleStream } from './hooks/useParticleStream'
import { runSimulation, fetchResultsList, fetchResult, pollResultStatus } from './api'
import type { VisualizationMode, WindParams, SensorData, SimulationResult, ResultSummary } from './types'

function Loader() {
  const { progress } = useProgress()
  return (
    <mesh>
      <boxGeometry args={[0, 0, 0]} />
      <meshBasicMaterial />
    </mesh>
  )
}

/**
 * Scene layout:
 * - GLTF model rendered with Cp mapped via nearest-centroid interpolation
 * - Streamlines in solver coordinate frame, same rotation as GLTF model
 * - Alpha/beta handled by the solver (flow direction), NOT visual rotation
 */
function AircraftScene({
  mode, speed, mach, solverCentroids, cpValues, cpRange,
  trails, trailLengths, writeHeads, particleCount, streamConnected,
}: {
  mode: VisualizationMode
  speed: number
  mach: number
  solverCentroids: number[] | null
  cpValues: number[] | null
  cpRange: [number, number]
  trails: Float32Array
  trailLengths: Int32Array
  writeHeads: Int32Array
  particleCount: number
  streamConnected: boolean
}) {
  return (
    <group>
      <JetModel
        mode={mode}
        speed={speed}
        mach={mach}
        solverCentroids={solverCentroids}
        cpValues={cpValues}
        cpRange={cpRange}
      />

      {/* Animated streamlines — same rotation as the GLTF model */}
      <group rotation={[0, -Math.PI / 2, 0]}>
        <StreamlineRenderer
          trails={trails}
          trailLengths={trailLengths}
          writeHeads={writeHeads}
          particleCount={particleCount}
          connected={streamConnected}
        />
      </group>
    </group>
  )
}

export default function App() {
  const [wind, setWind] = useState<WindParams>({ speed: 0.5, alpha: 5, beta: 0 })
  const [mode, setMode] = useState<VisualizationMode>('pressure')
  const [particleDensity, setParticleDensity] = useState(30)
  const [meshResolution, setMeshResolution] = useState(800)
  const [simulating, setSimulating] = useState(false)
  const [solverCentroids, setSolverCentroids] = useState<number[] | null>(null)
  const [cpValues, setCpValues] = useState<number[] | null>(null)
  const [cpRange, setCpRange] = useState<[number, number]>([-1.5, 1.0])
  const [simResult, setSimResult] = useState<SimulationResult | null>(null)
  const [simError, setSimError] = useState<string | null>(null)
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [resultsList, setResultsList] = useState<ResultSummary[]>([])
  const [loadingResult, setLoadingResult] = useState(false)
  const [gcsPath, setGcsPath] = useState<string | null>(null)
  const [simulatingVisible, setSimulatingVisible] = useState(false)
  const [uploadReady, setUploadReady] = useState(false)
  const [streamParams, setStreamParams] = useState<{ mach: number; alpha: number; beta: number; particleCount: number } | null>(null)
  // Bumped on every Simulate click so AcceleratorComparison can re-fan out.
  const [comparisonTrigger, setComparisonTrigger] = useState(0)
  // Top-right "Fine-tune" button toggles the Part 2 overlay (full-screen).
  const [finetuneOpen, setFinetuneOpen] = useState(false)

  const particleCount = Math.floor(Math.pow(10, 2 + (particleDensity / 100) * 2.5))
  const hasSimData = simResult !== null

  const streamState = useParticleStream(hasSimData, streamParams)

  const sensorData: SensorData = {
    liftCoeff: simResult?.forces.liftCoeff ?? 0,
    dragCoeff: simResult?.forces.dragCoeff ?? 0,
    lift: simResult?.forces.lift ?? 0,
    drag: simResult?.forces.drag ?? 0,
    dynamicPressure: 0.5 * 1.225 * Math.pow(wind.speed * 343, 2) / 1000,
    maxSurfaceTemp: 15 * (1 + 0.2 * wind.speed * wind.speed),
    structuralLoad: simResult ? Math.abs(simResult.forces.lift) / (9.81 * 19700) : 0,
    airDensity: 1.225,
  }

  const doSimulate = useCallback(async () => {
    setSimulating(true)
    setSimulatingVisible(false)
    setSimError(null)
    setGcsPath(null)
    setUploadReady(false)
    setComparisonTrigger(t => t + 1)  // fan out to comparison backends

    // Only show "Simulating..." after 500ms to avoid flicker on fast solves
    const showTimer = setTimeout(() => setSimulatingVisible(true), 500)

    try {
      const result = await runSimulation({
        wind,
        particleCount: Math.min(particleCount, 200),
        meshResolution,
      })
      setSimResult(result)
      setStreamParams({ mach: wind.speed, alpha: wind.alpha, beta: wind.beta, particleCount: Math.min(particleCount, 200) })
      if (result.faceData?.cp) {
        setCpValues(result.faceData.cp)
        setCpRange((() => {
          // Symmetric (Cp=0 centered) diverging colormap — the CFD standard.
          // Without this, the colormap midpoint lands at the median of the Cp
          // distribution rather than at Cp=0, so suction (negative) and pressure
          // (positive) regions don't look distinct — they all map to GREEN-YELLOW.
          // Centering on 0 puts SUCTION on the BLUE half and PRESSURE on the RED
          // half, which is what aerospace audiences expect to see.
          // Range half-width = max(|p5|, |p95|), clamped to [0.6, 1.5] so the
          // visualization always has reasonable contrast.
          const p5 = result.faceData.cpP5 ?? result.faceData.cpMin ?? -1.0
          const p95 = result.faceData.cpP95 ?? result.faceData.cpMax ?? 1.0
          const half = Math.min(Math.max(Math.abs(p5), Math.abs(p95), 0.6), 1.5)
          return [-half, half]
        })())
        setSolverCentroids(result.faceData.centroids)
      }
      // Poll for GCS upload completion, then set gcsPath for AI
      if (result.result_id) {
        pollResultStatus(result.result_id).then(status => {
          if (status === 'ready') {
            fetchResultsList().then(({ results }) => {
              setResultsList(results)
              const entry = results.find(r => r.result_id === result.result_id)
              if (entry) {
                setGcsPath(entry.gcs_path)
                setUploadReady(true)
              }
            })
          } else {
            // GCS upload failed — fall back to inline analysis
            console.warn('GCS upload failed, falling back to inline analysis')
            setUploadReady(true)
          }
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('Simulation failed:', msg)
      setSimError(msg)
    } finally {
      clearTimeout(showTimer)
      setSimulating(false)
      setSimulatingVisible(false)
    }
  }, [wind, particleCount, meshResolution])

  const loadResult = useCallback(async (resultId: string) => {
    setLoadingResult(true)
    try {
      const result = await fetchResult(resultId)
      setSimResult(result)
      if (result.faceData?.cp) {
        setCpValues(result.faceData.cp)
        setCpRange((() => {
          // Symmetric (Cp=0 centered) diverging colormap — the CFD standard.
          // Without this, the colormap midpoint lands at the median of the Cp
          // distribution rather than at Cp=0, so suction (negative) and pressure
          // (positive) regions don't look distinct — they all map to GREEN-YELLOW.
          // Centering on 0 puts SUCTION on the BLUE half and PRESSURE on the RED
          // half, which is what aerospace audiences expect to see.
          // Range half-width = max(|p5|, |p95|), clamped to [0.6, 1.5] so the
          // visualization always has reasonable contrast.
          const p5 = result.faceData.cpP5 ?? result.faceData.cpMin ?? -1.0
          const p95 = result.faceData.cpP95 ?? result.faceData.cpMax ?? 1.0
          const half = Math.min(Math.max(Math.abs(p5), Math.abs(p95), 0.6), 1.5)
          return [-half, half]
        })())
        setSolverCentroids(result.faceData.centroids)
      }
      // Update sliders to match loaded result
      const loadedAlpha = result.alpha ?? wind.alpha
      const loadedBeta = result.beta ?? wind.beta
      setWind({ speed: result.mach, alpha: loadedAlpha, beta: loadedBeta })
      setStreamParams({ mach: result.mach, alpha: loadedAlpha, beta: loadedBeta, particleCount: Math.min(particleCount, 200) })

      // Find the gcs_path for AI
      const entry = resultsList.find(r => r.result_id === resultId)
      if (entry) {
        setGcsPath(entry.gcs_path)
        setUploadReady(true)
      }
    } catch (err) {
      console.error('Failed to load result:', err)
    } finally {
      setLoadingResult(false)
    }
  }, [resultsList, wind.alpha, wind.beta])

  useEffect(() => {
    fetchResultsList().then(({ results }) => setResultsList(results)).catch(() => {})
  }, [])

  return (
    <div className="w-full h-screen bg-[#020202] overflow-hidden selection:bg-[#00ffcc] selection:text-black">
      {/* HUD Overlay */}
      <div className="absolute inset-0 z-10 pointer-events-none flex flex-col justify-between p-6">
        {/* Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-[#00ffcc] font-mono text-2xl font-bold tracking-tighter flex items-center gap-3">
              <Plane size={24} />
              Gemini for AERO-SIM // F-22
            </h1>
            <p className="text-white/40 font-sans text-xs uppercase tracking-[0.3em] mt-1 ml-9">
              Hess-Smith Panel Method
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMetricsOpen(true)}
              className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 border border-[#00ffcc]/20 bg-[#00ffcc]/5 hover:bg-[#00ffcc]/10 rounded-full transition-colors cursor-pointer"
              title="TPU Compute Metrics"
            >
              <Cpu size={14} className="text-[#00ffcc]" />
              <span className="text-[#00ffcc] font-mono text-[10px] uppercase tracking-wider">Metrics</span>
            </button>
            <button
              onClick={() => setFinetuneOpen(true)}
              className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 border border-emerald-400/40 bg-emerald-400/10 hover:bg-emerald-400/20 rounded-full transition-colors cursor-pointer"
              title="Fine-tune Gemma 3 on aerospace imagery (Part 2 of the demo)"
            >
              <Sparkles size={14} className="text-emerald-300" />
              <span className="text-emerald-300 font-mono text-[10px] uppercase tracking-wider">Fine-tune</span>
            </button>
            <div className="flex items-center gap-2 px-3 py-1 border border-[#00ffcc]/30 bg-[#00ffcc]/5 rounded-full">
              <div className={`w-2 h-2 rounded-full ${
                simulatingVisible ? 'bg-yellow-500 animate-pulse' : hasSimData ? 'bg-[#00ffcc]' : 'bg-red-500'
              }`} />
              <span className="text-[#00ffcc] font-mono text-xs uppercase tracking-wider">
                {simulatingVisible ? 'Computing...' : hasSimData ? `Live (${simResult!.solveTimeMs.toFixed(0)}ms / ${simResult!.panelCount} panels)` : 'Ready'}
              </span>
            </div>
          </div>
        </div>

        {/* Error message */}
        {simError && (
          <div className="mx-auto mt-2 px-4 py-2 bg-red-500/20 border border-red-500/50 rounded-lg pointer-events-auto">
            <p className="text-red-400 font-mono text-xs">{simError}</p>
          </div>
        )}

        {/* Bottom panels — control panel only on the left, right column moved up */}
        <div className="flex justify-between items-end w-full flex-1 min-h-0 pb-4">
          <ControlPanel
            wind={wind}
            onWindChange={setWind}
            particleDensity={particleDensity}
            onParticleDensityChange={setParticleDensity}
            meshResolution={meshResolution}
            onMeshResolutionChange={setMeshResolution}
            mode={mode}
            onModeChange={setMode}
            simulating={simulating}
            onSimulate={doSimulate}
            results={resultsList}
            onLoadResult={loadResult}
            loadingResult={loadingResult}
          />
        </div>
      </div>

      {/* Right column — pinned top-right, below header; Gemini → Sensor (collapsed) → Accelerator $/calc */}
      <div className="absolute top-20 right-6 z-20 w-96 flex flex-col gap-4 pointer-events-auto max-h-[calc(100vh-6rem)] overflow-y-auto overflow-x-hidden">
        <AiAnalysisPanel simResult={simResult} wind={wind} gcsPath={gcsPath} uploadReady={uploadReady} />
        <SensorReadings
          data={sensorData}
          solveTimeMs={simResult?.solveTimeMs}
          computeDevice={simResult?.computeDevice}
        />
        <AcceleratorComparison
          triggerKey={comparisonTrigger}
          wind={wind}
          particleCount={particleCount}
          meshResolution={meshResolution}
        />
      </div>

      {/* TPU Metrics Modal */}
      <TpuMetricsModal
        open={metricsOpen}
        onClose={() => setMetricsOpen(false)}
        latestTimings={simResult?.timings}
        computeDevice={simResult?.computeDevice}
      />

      {/* Part 2 — Fine-tune full-screen overlay */}
      <FineTunePage open={finetuneOpen} onClose={() => setFinetuneOpen(false)} />

      {/* 3D Scene */}
      <Canvas camera={{ position: [-10, 4, 10], fov: 45 }}>
        <color attach="background" args={['#020202']} />
        <fog attach="fog" args={['#020202', 10, 60]} />
        <ambientLight intensity={mode === 'visual' ? 1.5 : 0.4} />
        <directionalLight position={[10, 10, 5]} intensity={mode === 'visual' ? 2 : 1.0} />
        <directionalLight position={[-10, -10, -5]} intensity={0.5} />

        <Suspense fallback={<Loader />}>
          {mode === 'visual' && <Environment preset="city" />}
          <AircraftScene
            mode={mode}
            speed={wind.speed}
            mach={simResult?.mach ?? wind.speed}
            solverCentroids={solverCentroids}
            cpValues={cpValues}
            cpRange={cpRange}
            trails={streamState.trails}
            trailLengths={streamState.trailLengths}
            writeHeads={streamState.writeHeads}
            particleCount={streamState.particleCount}
            streamConnected={streamState.connected}
          />

          <EffectComposer>
            <Bloom
              luminanceThreshold={mode === 'visual' ? 0.8 : 0.7}
              luminanceSmoothing={0.9}
              intensity={mode === 'visual' ? 1 : 0.8}
            />
            <ChromaticAberration
              blendFunction={BlendFunction.NORMAL}
              offset={new Vector2(0.001 * wind.speed, 0.001 * wind.speed)}
            />
            <Noise opacity={0.03} />
            <Vignette eskil={false} offset={0.1} darkness={1.1} />
          </EffectComposer>
        </Suspense>

        <OrbitControls
          enablePan={false}
          enableZoom={true}
          minDistance={1}
          maxDistance={30}
          maxPolarAngle={Math.PI / 1.5}
          autoRotate={false}
        />
      </Canvas>
    </div>
  )
}
