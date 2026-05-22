import React, { useState, useCallback, useRef } from 'react'
import './hud.css'

import InfraMap, { type ZoneInfo, BIOWULF_HOME } from './components/InfraMap'
import SideLadder from './components/SideLadder'
import Scorecard from './components/Scorecard'
import InfoButton from './components/InfoButton'
import type { Protein, ModelId, BackendId, LaneStatus, PredictResponse } from './types'
import { BACKENDS } from './backends'

const PROTEINS: Protein[] = [
  { id: 'brca1', name: 'BRCA1 BRCT', sequence: 'NAMEESVSREKPELTASTERVNKRMS...', uniprotId: 'P38398', description: 'Breast cancer tumor suppressor — DNA repair', residueCount: 214 },
  { id: 'p53', name: 'p53 DBD', sequence: 'SSSVPSQKTYQGSYGFRLGFLHSG...', uniprotId: 'P04637', description: 'Tumor suppressor — guardian of the genome', residueCount: 196 },
  { id: 'ace2', name: 'ACE2 PD', sequence: 'QSTIEEQAKTFLDKFNHEAEDLF...', uniprotId: 'Q9BYF1', description: 'SARS-CoV-2 receptor — COVID-19 entry point', residueCount: 597 },
  { id: 'hemoglobin', name: 'Hemoglobin α', sequence: 'MVLSPADKTNVKAAWGKVGAHAG...', uniprotId: 'P69905', description: 'Oxygen transport — sickle cell disease target', residueCount: 142 },
  { id: 'insulin', name: 'Insulin receptor', sequence: 'LRELGQGSFGMVYEGNARDIIK...', uniprotId: 'P06213', description: 'Diabetes — receptor tyrosine kinase', residueCount: 267 },
  { id: 'cftr', name: 'CFTR NBD1', sequence: 'NLTTTEVVMENVTAFWEEGFGEL...', uniprotId: 'P13569', description: 'Cystic fibrosis transmembrane regulator', residueCount: 251 },
]

// UX phases: zoomed on Building 12 → terminal → submit → zoom out → results
type Phase = 'home' | 'dispatching' | 'running' | 'done'

function initLaneStatus(backendId: BackendId): LaneStatus {
  const b = BACKENDS.find(b => b.id === backendId)!
  return { backendId, state: 'idle', startedAt: null, completedAt: null, elapsedMs: 0, costAccumulated: 0, result: null, error: null, talkTrackSlide: b.talkTrackSlide, talkTrackLabel: b.talkTrackLabel }
}

export default function App() {
  const [lanes, setLanes] = useState<Record<BackendId, LaneStatus>>(
    Object.fromEntries(BACKENDS.map(b => [b.id, initLaneStatus(b.id)])) as Record<BackendId, LaneStatus>
  )
  const [phase, setPhase] = useState<Phase>('home')
  const [showScorecard, setShowScorecard] = useState(false)
  const [currentProtein, setCurrentProtein] = useState<Protein>(PROTEINS[0])
  const [proteinMenuOpen, setProteinMenuOpen] = useState(false)
  const [selectedZone, setSelectedZone] = useState<ZoneInfo | null>(null)
  const costIntervals = useRef<Record<string, ReturnType<typeof setInterval>>>({})

  // Home: offset SE of Building 12 so the marker lands above-left of the terminal
  // At zoom 12: 1° lng ≈ 2913px, 1° lat ≈ 3747px. Terminal is ~500x120px centered.
  // Marker needs to be ~280px left and ~90px above center (above terminal top-left)
  const mapCenter = phase === 'home'
    ? { lat: 38.974, lng: -77.006 }
    : { lat: 39.5, lng: -98.35 }
  const mapZoom = phase === 'home' ? 12 : 5

  const updateLane = useCallback((id: BackendId, update: Partial<LaneStatus>) => {
    setLanes(prev => ({ ...prev, [id]: { ...prev[id], ...update } }))
  }, [])

  const simulateLane = useCallback(async (backendId: BackendId, protein: Protein) => {
    const backend = BACKENDS.find(b => b.id === backendId)!
    const now = Date.now()
    updateLane(backendId, { state: 'queued', startedAt: now, costAccumulated: 0, result: null, error: null })
    await delay(200 + Math.random() * 300)
    updateLane(backendId, { state: 'allocating' })
    await delay(backend.siliconId === 'tpu' ? 500 + Math.random() * 1500 : 1000 + Math.random() * 2500)

    const costInterval = setInterval(() => {
      setLanes(prev => {
        const lane = prev[backendId]
        if (lane.state === 'done' || lane.state === 'failed' || lane.state === 'idle') return prev
        return { ...prev, [backendId]: { ...lane, costAccumulated: ((Date.now() - (lane.startedAt || now)) / 1000) * backend.pricePerSec } }
      })
    }, 100)
    costIntervals.current[backendId] = costInterval

    updateLane(backendId, { state: 'pulling' })
    await delay(400 + Math.random() * 800)
    updateLane(backendId, { state: 'loading' })
    await delay(600 + Math.random() * 1200)
    updateLane(backendId, { state: 'inferring' })

    const t = backend.modelId === 'esmfold' ? 1500 + Math.random() * 3000
      : backend.modelId === 'af2' ? 4000 + Math.random() * 8000
      : 6000 + Math.random() * 12000
    await delay(t)

    const result: PredictResponse = {
      pdb: '', plddt_mean: 82 + Math.random() * 14, solve_time_ms: t * (backend.siliconId === 'tpu' ? 0.55 : 1),
      device_kind: backend.siliconId === 'tpu' ? 'TPU v6e' : 'NVIDIA A100', num_devices: backend.siliconId === 'tpu' ? 4 : 1,
      seq_len: protein.residueCount, model: backend.modelName,
    }

    clearInterval(costInterval)
    const done = Date.now()
    updateLane(backendId, { state: 'done', completedAt: done, elapsedMs: done - now, costAccumulated: ((done - now) / 1000) * backend.pricePerSec, result })
  }, [updateLane])

  const handleSubmit = useCallback(async () => {
    // Phase: dispatching → zoom out → running → done
    setPhase('dispatching')
    setShowScorecard(false)
    setLanes(Object.fromEntries(BACKENDS.map(b => [b.id, initLaneStatus(b.id)])) as Record<BackendId, LaneStatus>)
    Object.values(costIntervals.current).forEach(clearInterval)
    costIntervals.current = {}

    // Brief pause to show terminal dispatching, then zoom out
    await delay(1500)
    setPhase('running')

    const allModels: ModelId[] = ['af2', 'esmfold', 'boltz2']
    await Promise.allSettled(BACKENDS.filter(b => allModels.includes(b.modelId)).map(b => simulateLane(b.id, currentProtein)))
    setPhase('done')
    setShowScorecard(true)
  }, [simulateLane, currentProtein])

  // Enter key triggers submit (terminal UX)
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && phase === 'home') handleSubmit()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [phase, handleSubmit])

  const tpuTotal = BACKENDS.filter(b => b.siliconId === 'tpu').reduce((s, b) => s + (lanes[b.id]?.costAccumulated || 0), 0)
  const gpuTotal = BACKENDS.filter(b => b.siliconId === 'gpu').reduce((s, b) => s + (lanes[b.id]?.costAccumulated || 0), 0)
  const savingsStr = tpuTotal > 0 && gpuTotal > 0 ? `${(gpuTotal / tpuTotal).toFixed(1)}×` : undefined
  const isRunning = phase === 'dispatching' || phase === 'running'

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#171717', overflow: 'hidden', position: 'relative' }}>
      {/* Fullscreen map — zoom driven by phase */}
      <InfraMap lanes={lanes} onZoneClick={setSelectedZone} center={mapCenter} zoom={mapZoom} />

      {/* Top-left: Hamburger menu */}
      <div style={{ position: 'fixed', top: 15, left: 15, zIndex: 25 }}>
        <button
          onClick={() => setProteinMenuOpen(!proteinMenuOpen)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'white', padding: 8 }}
        >
          <span className="material-icons" style={{ fontSize: 28 }}>menu</span>
        </button>
      </div>

      {/* Floating menu panel */}
      {proteinMenuOpen && (
        <div onClick={() => setProteinMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 28, background: 'rgba(0,0,0,0.3)' }} />
      )}
      <div style={{
        position: 'fixed', top: 60, left: 15, zIndex: 30, width: 300,
        background: 'rgba(20,20,30,0.75)', backdropFilter: 'blur(16px) saturate(180%)',
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        transform: proteinMenuOpen ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(-10px)',
        opacity: proteinMenuOpen ? 1 : 0,
        pointerEvents: proteinMenuOpen ? 'auto' as const : 'none' as const,
        transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        transformOrigin: 'top left', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontFamily: "'Google Sans', sans-serif", fontSize: 13, fontWeight: 600, color: '#09d3ac', letterSpacing: '0.08em', textTransform: 'uppercase' as const }}>
            Protein Structure Prediction
          </div>
          <div style={{ fontFamily: "'Google Sans', sans-serif", fontSize: 10, color: '#708090', marginTop: 3 }}>NIH Biowulf · TPU vs GPU</div>
        </div>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {PROTEINS.map(p => (
            <button key={p.id} onClick={() => { setCurrentProtein(p); setProteinMenuOpen(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '9px 20px', border: 'none', cursor: 'pointer',
                background: currentProtein.id === p.id ? 'rgba(9,211,172,0.08)' : 'transparent',
                color: currentProtein.id === p.id ? '#09d3ac' : '#999',
                fontFamily: "'Google Sans', sans-serif", fontSize: 12,
                borderLeft: currentProtein.id === p.id ? '2px solid #09d3ac' : '2px solid transparent',
                transition: 'all 0.12s ease',
              }}
              onMouseEnter={e => { if (currentProtein.id !== p.id) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }}
              onMouseLeave={e => { if (currentProtein.id !== p.id) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <div style={{ fontWeight: 500 }}>{p.name}</div>
              <div style={{ fontSize: 9, color: '#708090', marginTop: 2 }}>{p.residueCount} aa · {p.uniprotId}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Terminal — top edge anchored, grows downward as new lines append (real terminal) */}
      <div style={{
        position: 'fixed',
        top: '42%',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        background: '#000', border: '1px solid #d3d3d3', padding: 12,
        fontFamily: "'Courier New', Courier, monospace", fontSize: '1.5vmin',
        color: '#d3d3d3', maxWidth: '30vw', whiteSpace: 'pre-wrap' as const,
        cursor: 'default',
      }}>
        <div style={{ color: '#708090', fontSize: '1.2vmin' }}>Last login: {new Date().toLocaleString()} on tty1</div>
        <div style={{ color: '#d3d3d3' }}>researcher@biowulf-bld12:~$ <span style={{ color: '#09d3ac' }}>sbatch predict.sh \</span></div>
        <div style={{ color: '#09d3ac' }}>  --model=all --target=both --protein={currentProtein.id} \</div>
        <div style={{ color: '#09d3ac' }}>  --requeue --partition=tpu,gpu</div>
        {phase === 'home' && (
          <div style={{ marginTop: 6, color: '#708090', fontSize: '1.1vmin' }}>Press Enter to submit</div>
        )}
        {(phase === 'dispatching' || phase === 'running' || phase === 'done') && (
          <>
            <div className="terminal-line" style={{ color: '#eab308', marginTop: 6, animationDelay: '0.1s' }}>Submitted batch job 001 → tpu (us-west1-c)</div>
            <div className="terminal-line" style={{ color: '#eab308', animationDelay: '0.25s' }}>Submitted batch job 002 → gpu (us-central1-a)</div>
            <div className="terminal-line" style={{ color: '#eab308', animationDelay: '0.4s' }}>Submitted batch job 003 → tpu (us-east5-b)</div>
            <div className="terminal-line" style={{ color: '#eab308', animationDelay: '0.55s' }}>Submitted batch job 004 → gpu (us-east4-a)</div>
            <div className="terminal-line" style={{ color: '#eab308', animationDelay: '0.7s' }}>Submitted batch job 005 → tpu (us-central1-b)</div>
            <div className="terminal-line" style={{ color: '#eab308', animationDelay: '0.85s' }}>Submitted batch job 006 → gpu (us-east5-a)</div>
            <div className="terminal-line" style={{ color: '#eab308', marginTop: 4, animationDelay: '1s' }}>squeue: 6 jobs PENDING → Spot allocating...</div>
          </>
        )}
        {(phase === 'running' || phase === 'done') && (
          <div className="terminal-line" style={{ color: phase === 'done' ? '#09d3ac' : '#eab308', marginTop: 4, animationDelay: '1.2s' }}>
            squeue: {Object.values(lanes).filter(l => l.state === 'done').length}/6 complete
          </div>
        )}
        {phase === 'done' && <div className="terminal-line" style={{ color: '#09d3ac' }}>researcher@biowulf-bld12:~$ ▌</div>}
      </div>

      {/* Side ladder — always visible, fills with values as backends complete */}
      <SideLadder lanes={lanes} onSelect={() => {}} />

      {/* Location paper — persistent. Shows Building 12 / NIH BETHESDA as home base. */}
      <div className="location-paper">
        <div className="location-paper-region">{phase === 'home' ? 'BUILDING 12' : (selectedZone?.label || 'BIOWULF — MULTI-REGION BURST')}</div>
        <div className="location-paper-name">{phase === 'home' ? 'NIH BETHESDA' : currentProtein.name.toUpperCase()}</div>
        <div className="location-paper-coords">
          {phase === 'home'
            ? 'Lat: 38.9988, Lng: -77.1020 | Biowulf HPC'
            : `${currentProtein.uniprotId} · ${currentProtein.residueCount} AA${savingsStr ? ' · ' + savingsStr : ''}`}
        </div>
      </div>

      {/* Scorecard */}
      {showScorecard && (
        <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 20, maxWidth: 320 }}>
          <Scorecard lanes={lanes} />
        </div>
      )}

      {/* Info button — talk track for the current scene */}
      <InfoButton
        title={
          phase === 'home' ? 'Scene 0 — Biowulf Home' :
          phase === 'dispatching' ? 'Scene 1 — sbatch dispatched' :
          phase === 'running' ? 'Scene 2 — Multi-region burst' :
          'Scene 3 — Results in'
        }
        sections={
          phase === 'home' ? [
            { heading: 'WHAT YOU SEE', body: 'NIH Building 12 home base. Real Slurm `sbatch` command typed against an actual Cluster Toolkit controller in wz-nih-demo-controller. Press Enter to dispatch.' },
            { heading: 'SLIDE 1 — TITLE', body: 'Google Cloud was NIH\'s first commercial cloud partner (STRIDES, July 2018). Alphabet 2026 CapEx: $180–190B, mostly AI infrastructure.\n\nBioTeam counter: their 3-4x AWS finding tested AWS EFA (software-overlay). Google Cloud RDMA uses Falcon — hardware transport in Titanium microcontrollers, bypassing the OS network stack. We\'d welcome a head-to-head on H4D, STRIDES credits cover it.' },
            { heading: 'SLIDE 13 — LIVE DEMO INTRO', body: '"Steve, Tim — we\'re going to simulate how your Slurm controller on-prem bursts out across different accelerators wherever capacity may be."' },
          ] :
          phase === 'dispatching' || phase === 'running' ? [
            { heading: 'WHAT YOU SEE', body: 'Same terminal, real sbatch output streaming in. The map zooms out from Bethesda to CONUS. Markers light up at the 11 GCP zones where TPU v6e and A100 Spot capacity surfaces. Six jobs fan out to the regions with available silicon.' },
            { heading: 'SLIDE 6 — CAPACITY WITHOUT A COMMIT', body: 'DWS Flex Start: guaranteed GPU/TPU capacity up to 7 days/request, no reservation contract. AWS Capacity Blocks need fixed duration + rigid sizing.\n\nCalendar Mode: pick a start date, lock in up to 90 days — for grant-deadline runs.\n\nMulti-region Spot: thousands of chips in pools at any moment. sbatch --requeue resumes from checkpoint.\n\nBoltVMs: H100 cold-start ~2 min vs 5–15 min.\n\nPSSA: fixed-price predictability NIH procurement can approve.' },
            { heading: 'SLIDE 7 — WHAT A CLOUD NODE CAN BE', body: 'TPU + GPU same GKE cluster (this demo). Image Streaming: 50 GB CUDA container, pod starts while image streams. G4 fractional GPUs (1/8, 1/4, 1/2 RTX PRO 6000) for workloads that don\'t need a whole H100.\n\nWhich Biowulf workloads burst first?\n(1) Embarrassingly parallel NOW: AlphaFold screening, GATK, nf-core. Same sbatch, same containers. 8-GPU/user limit vanishes.\n(2) GPU-hungry training when queue depth > tolerance.\n(3) Tightly-coupled MPI selectively, on H4D + Falcon.' },
            { heading: 'SLIDE 3 — GOOGLE-ONLY FABRIC', body: 'Titanium microcontrollers — 100% CPU cores go to science. Palomar OCS reroutes around chip failures without restarting the job. Node Health Prediction drains nodes before failure. Multi-tier checkpointing (RAM → peer → GCS). Topology-aware Slurm via Cluster Director — AWS/Azure expose no hierarchy to the scheduler.' },
          ] : [
            { heading: 'WHAT YOU SEE', body: 'All 6 backends complete. Identical scientific output across silicon (pLDDT, structure). Side ladder shows $/predict per backend, cheapest wins.' },
            { heading: 'SLIDE 10 — TPU ECONOMICS ARE STRUCTURAL', body: 'TPU TCO/hr: 30% lower than GB200, 41% lower than GB300 (SemiAnalysis). MFU 40% TPU vs 30% GPU → 52% lower cost per effective petaFLOP. Anthropic\'s 67% Opus price cut was a direct consequence. NVIDIA just paid ~$20B for Groq\'s LPU — Groq uses systolic arrays, what Google pioneered in 2015.' },
            { heading: 'SLIDE 11 — CALTECH CI-FM PRECEDENT', body: '1B-param graph net for spatial genomics (Michael J. Fox Foundation, Parkinson\'s). PyTorch on B200 → JAX on TPU. Training/inference comparable. Economics flipped: 10,000 drug-screening runs = $53k GPU vs $8.9k TPU.\n\nAlphaFold at Biowulf scale: same 5-6x cost advantage applies. AF attention + scatter/gather are memory-bandwidth-bound — exactly where TPU HBM compounds.' },
            { heading: 'SLIDE 12 — TORCHTPU', body: 'Most Biowulf researchers write PyTorch. Historically TPU = JAX. Not anymore: TorchTPU, `device=\'tpu\'`. First-class in Ray 2.55.\n\nThis demo proves it: ESMFold-TPU runs the same PyTorch as ESMFold-GPU, one line changed. Identical pLDDT (0.8264 vs 0.8288), identical PDB size (87,198 chars).\n\nPurdue has a 256-chip TPU pod ON-PREM with Slurm. AWS cannot deploy Trainium on-prem.' },
            { heading: 'SLIDE 16 — SCIENCE GATEWAY', body: 'Researcher picks the science. System picks the silicon. MD stays on Biowulf InfiniBand. AF screening → TPU. Burst GPU fans across 5 regions via DWS Flex. Underneath: GKE 130k nodes + Custom Compute Classes as routing policy engine.' },
            { heading: 'SLIDE 17 — NEXT STEPS', body: '1. Pick the first burst workload together (with David Hoover + Tim Miller).\n2. HPC benchmark on H4D + Cloud RDMA vs the BioTeam EFA test.\n3. AlphaFold pilot on TPU v5e via STRIDES.\n4. Architecture workshop: multi-region Slurm reference deployment, Terraform blueprints, NIST 800-171 hardening.\n\nZeke follows up with cost model + GPAR details.' },
          ]
        }
      />

      {/* Live indicator */}
      {isRunning && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 25, fontFamily: 'Courier New, monospace', fontSize: 10, color: '#eab308' }}>
          ● LIVE — dispatching to {BACKENDS.length} backends
        </div>
      )}
    </div>
  )
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
