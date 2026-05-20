import React, { useState, useCallback, useRef } from 'react'
import { Dna } from 'lucide-react'
import './hud.css'

import InfraMap, { type ZoneInfo, BIOWULF_HOME } from './components/InfraMap'
import SideLadder from './components/SideLadder'
import LocationPaper from './components/LocationPaper'
import Scorecard from './components/Scorecard'
import TalkTrackBadge from './components/TalkTrackBadge'
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

  // Map zoom state — driven by phase
  const mapCenter = phase === 'home'
    ? BIOWULF_HOME
    : { lat: 39.5, lng: -98.35 } // CONUS center
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

      {/* Terminal — Jamal's info card style, center bottom */}
      <div style={{
        position: 'fixed', bottom: 30, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
        background: '#000', border: '1px solid #d3d3d3', padding: 12,
        fontFamily: "'Courier New', Courier, monospace", fontSize: '1.4vmin',
        color: '#d3d3d3', maxWidth: '35vw', whiteSpace: 'pre-wrap' as const,
        cursor: phase === 'home' ? 'pointer' : 'default',
        transition: 'all 0.3s ease',
      }}
        onClick={phase === 'home' ? handleSubmit : undefined}
      >
        {phase === 'home' && (
          <>
            <div style={{ color: '#708090', fontSize: '1.2vmin' }}>Last login: {new Date().toLocaleString()} on tty1</div>
            <div style={{ color: '#d3d3d3' }}>researcher@biowulf-bld12:~$ <span style={{ color: '#09d3ac' }}>sbatch predict.sh \</span></div>
            <div style={{ color: '#09d3ac' }}>  --model=all --target=both --protein={currentProtein.id} \</div>
            <div style={{ color: '#09d3ac' }}>  --requeue --partition=tpu,gpu</div>
            <div style={{ marginTop: 6, color: '#708090', fontSize: '1.1vmin' }}>▶ Press Enter to submit 6 jobs</div>
          </>
        )}
        {phase === 'dispatching' && (
          <>
            <div style={{ color: '#eab308' }}>Submitted batch job 001 → tpu (us-west1-c)</div>
            <div style={{ color: '#eab308' }}>Submitted batch job 002 → gpu (us-central1-a)</div>
            <div style={{ color: '#eab308' }}>Submitted batch job 003 → tpu (us-east5-b)</div>
            <div style={{ color: '#eab308' }}>Submitted batch job 004 → gpu (us-east4-a)</div>
            <div style={{ color: '#eab308' }}>Submitted batch job 005 → tpu (us-central1-b)</div>
            <div style={{ color: '#eab308' }}>Submitted batch job 006 → gpu (us-east5-a)</div>
            <div style={{ color: '#eab308', marginTop: 4 }}>squeue: 6 jobs PENDING → Spot allocating...</div>
          </>
        )}
        {(phase === 'running' || phase === 'done') && (
          <>
            <div style={{ color: phase === 'done' ? '#09d3ac' : '#eab308' }}>
              squeue: {Object.values(lanes).filter(l => l.state === 'done').length}/6 complete
            </div>
            {phase === 'done' && <div style={{ color: '#09d3ac' }}>researcher@biowulf-bld12:~$ ▌</div>}
          </>
        )}
      </div>

      {/* Side ladder — only visible after zoom out */}
      {phase !== 'home' && <SideLadder lanes={lanes} onSelect={() => {}} />}

      {/* Location paper — changes based on phase */}
      {phase === 'home' ? (
        <div className="location-paper">
          <div className="location-paper-region">BUILDING 12</div>
          <div className="location-paper-name">NIH BETHESDA</div>
          <div className="location-paper-coords">Lat: 39.0003, Lng: -77.1003 | Biowulf HPC</div>
        </div>
      ) : (
        <LocationPaper
          protein={currentProtein}
          activeZone={selectedZone?.label}
          totalCost={showScorecard ? tpuTotal : undefined}
          savings={savingsStr}
        />
      )}

      {/* Scorecard */}
      {showScorecard && (
        <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 20, maxWidth: 320 }}>
          <Scorecard lanes={lanes} />
        </div>
      )}

      {/* Talk track badge */}
      {showScorecard && (
        <div style={{ position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 20 }}>
          <TalkTrackBadge slide={16} label="This IS the Science Gateway. Researcher picks the science. System picks the silicon." />
        </div>
      )}

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
