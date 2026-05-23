import React, { useState, useCallback, useRef, useEffect } from 'react'
import './hud.css'

import InfraMap, { type ZoneInfo, BIOWULF_HOME } from './components/InfraMap'
import SideLadder from './components/SideLadder'
import Scorecard from './components/Scorecard'
import InfoButton from './components/InfoButton'
import type { Protein, ModelId, BackendId, LaneStatus, PredictResponse } from './types'
import { BACKENDS } from './backends'
import { submitRun, pollStatus, pollEvents, getLatestRun, blobToLaneStatus } from './api'

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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [dispatchLines, setDispatchLines] = useState<string[]>([])
  const [infoOpen, setInfoOpen] = useState(false)

  const mapCenter = phase === 'home'
    ? { lat: 38.974, lng: -77.006 }
    : { lat: 39.5, lng: -98.35 }
  const mapZoom = phase === 'home' ? 12 : 5

  const updateLane = useCallback((id: BackendId, update: Partial<LaneStatus>) => {
    setLanes(prev => ({ ...prev, [id]: { ...prev[id], ...update } }))
  }, [])

  const lastEventCount = useRef(0)

  const startPolling = useCallback((runId: string) => {
    if (pollRef.current) clearInterval(pollRef.current)
    lastEventCount.current = 0
    pollRef.current = setInterval(async () => {
      try {
        const [status, events] = await Promise.all([
          pollStatus(runId),
          pollEvents(runId),
        ])
        for (const [backendId, blob] of Object.entries(status.lanes)) {
          const update = blobToLaneStatus(blob, backendId as BackendId)
          updateLane(backendId as BackendId, update)
        }
        if (events.length > lastEventCount.current) {
          const newMsgs = events.slice(lastEventCount.current)
            .map(e => e.msg)
            .filter(m => !m.startsWith('squeue poller'))
          if (newMsgs.length > 0) {
            setDispatchLines(prev => [...prev, ...newMsgs])
          }
          lastEventCount.current = events.length
        }
        if (status.all_complete) {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          setPhase('done')
          setShowScorecard(true)
        }
      } catch (err) {
        console.error('Poll error:', err)
      }
    }, 2000)
  }, [updateLane])

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const handleSubmit = useCallback(async () => {
    setPhase('dispatching')
    setShowScorecard(false)
    setDispatchLines([])
    setLanes(Object.fromEntries(BACKENDS.map(b => [b.id, initLaneStatus(b.id)])) as Record<BackendId, LaneStatus>)

    try {
      const result = await submitRun(currentProtein.id)
      setActiveRunId(result.run_id)
      setPhase('running')
      startPolling(result.run_id)
    } catch (err) {
      console.error('Submit failed:', err)
      setDispatchLines([`Error: ${err}`])
      setPhase('home')
    }
  }, [currentProtein, startPolling])

  // Enter key triggers submit (terminal UX)
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (phase === 'home') handleSubmit()
      }
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
        color: '#d3d3d3', maxWidth: '30vw', maxHeight: '45vh', overflowY: 'auto' as const,
        whiteSpace: 'pre-wrap' as const, cursor: 'default',
      }}>
        <div style={{ color: '#708090', fontSize: '1.2vmin' }}>Last login: {new Date().toLocaleString()} on tty1</div>
        <div style={{ color: '#d3d3d3' }}>researcher@biowulf-bld12:~$ <span style={{ color: '#09d3ac' }}>sbatch predict.sh \</span></div>
        <div style={{ color: '#09d3ac' }}>  --model=all --target=both --protein={currentProtein.id} \</div>
        <div style={{ color: '#09d3ac' }}>  --requeue --partition=tpu,gpu</div>
        {phase === 'home' && (
          <div style={{ marginTop: 6, color: '#708090', fontSize: '1.1vmin' }}>Press Enter to submit</div>
        )}
        {(phase === 'dispatching' || phase === 'running' || phase === 'done') && dispatchLines.length > 0 && (
          <>
            {dispatchLines.map((line, i) => (
              <div key={i} className="terminal-line" style={{ color: '#eab308', marginTop: i === 0 ? 6 : 0 }}>{line}</div>
            ))}
          </>
        )}
        {(phase === 'running' || phase === 'done') && (() => {
          const laneVals = Object.values(lanes)
          const done = laneVals.filter(l => l.state === 'done').length
          const failed = laneVals.filter(l => l.state === 'failed').length
          const allocating = laneVals.filter(l => l.state === 'allocating').length
          const inferring = laneVals.filter(l => l.state === 'inferring').length
          const queued = laneVals.filter(l => l.state === 'queued').length
          const parts: string[] = []
          if (allocating > 0) parts.push(`${allocating} CONFIGURING`)
          if (inferring > 0) parts.push(`${inferring} RUNNING`)
          if (queued > 0) parts.push(`${queued} PENDING`)
          if (done > 0) parts.push(`${done} COMPLETED`)
          if (failed > 0) parts.push(`${failed} FAILED`)
          const summary = parts.length > 0 ? parts.join(', ') : 'waiting...'
          return (
            <div className="terminal-line" style={{ color: phase === 'done' ? '#09d3ac' : '#eab308', marginTop: 4 }}>
              squeue: {summary}
            </div>
          )
        })()}
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

      {/* Info button — top right, same style as hamburger menu */}
      <div style={{ position: 'fixed', top: 15, right: 15, zIndex: 25 }}>
      <InfoButton
        open={infoOpen}
        onToggle={() => setInfoOpen(!infoOpen)}
        title={
          phase === 'home' ? 'Biowulf Home' :
          phase === 'dispatching' ? 'Dispatching' :
          phase === 'running' ? 'Multi-Region Burst' :
          'Results'
        }
        sections={
          phase === 'home' ? [
            { body: 'The <a href="https://hpc.nih.gov/" target="_blank">Biowulf cluster</a> serves 2,500 researchers across 23 NIH institutes — 105,000 processors, 336 A100 GPUs, and a <a href="https://hpc.nih.gov/apps/" target="_blank">scientific applications catalog</a> that covers everything from GROMACS to AlphaFold. Building 12 is approaching end of life, GPU queue pressure continues to grow, and three new AI staff have joined to keep pace with demand. Today\'s conversation is about how to extend that capacity.\n\nGoogle Cloud was NIH\'s <a href="https://www.hpcwire.com/2018/07/31/google-is-first-partner-in-nihs-strides-effort-to-speed-discovery-in-the-cloud/" target="_blank">first commercial cloud partner</a> under the STRIDES Initiative in 2018. Google designs its own silicon, network transport, and datacenter hardware — attributes that make cloud bursting with Google worth a closer look.\n\nOn screen is a terminal on Building 12 with a real Slurm command: <code>sbatch predict.sh --model=all --target=both --protein=brca1 --requeue --partition=tpu,gpu</code>. This terminal sits inside a controller project simulating Biowulf on-premise, ready to burst compute into a separate cloud project. When we press Enter, six inference jobs will dispatch across both TPU and GPU partitions to whichever CONUS regions have Spot capacity.' },
          ] :
          phase === 'dispatching' || phase === 'running' ? [
            { body: 'The on-prem Slurm controller submitted six jobs to compute nodes in a separate cloud project. The controller didn\'t move — the compute burst out. Slurm\'s <code>--requeue</code> flag means if any Spot node is preempted, the job automatically retries in the next available zone.\n\nThe architecture is one Slurm cluster. The controller sits on-prem — simulated here by a VM in a controller project connected to the burst project via <a href="https://cloud.google.com/vpc/docs/vpc-peering" target="_blank">VPC peering</a>. In production, NIH would use a <a href="https://cloud.google.com/network-connectivity/docs/interconnect/concepts/overview" target="_blank">400G Dedicated Interconnect</a> from Building 12 to Ashburn. Same private IP connectivity, sub-millisecond latency, MACsec encrypted.\n\nCompute nodesets are defined with weight-based priority. TPU partition tries us-west1 first (largest Spot pool), then us-east5, us-central1. GPU tries us-central1 first. The admin configures this once — researchers never see it.\n\nFor storage, <a href="https://cloud.google.com/storage-transfer/docs/overview" target="_blank">Storage Transfer Service</a> runs an agent on GPFS and does scheduled incremental syncs to GCS — only new and changed files transfer. The Slurm prolog stages data from GCS to <a href="https://docs.cloud.google.com/managed-lustre/docs/overview" target="_blank">Managed Lustre</a> as hot scratch at job start; the epilog syncs results back.' },
            { body: '<b>Workloads suited for cloud bursting from <a href="https://hpc.nih.gov/apps/" target="_blank">Biowulf\'s catalog</a>:</b>\n\n<b>Cryo-EM</b> — AreTomo, MotionCor2, CryoSPARC, RELION. Multi-GPU, queue-bound. Pre-stage to Managed Lustre, run on cloud GPUs.\n\n<b>Molecular Dynamics</b> — GROMACS, NAMD, AMBER. Tightly-coupled MPI, latency-sensitive. For <a href="https://cloud.google.com/blog/products/compute/new-h4d-vms-optimized-for-hpc" target="_blank">H4D</a> with Cloud RDMA.\n\n<b>Protein Design</b> — RFdiffusion, BindCraft, AlphaFold. Embarrassingly parallel. Small inputs, large compute. Burst immediately, no storage dependency.\n\n<b>Biomedical Imaging</b> — nnU-Net, DeepLabCut. GPU-hungry. Datasets stage once to GCS, mount via <a href="https://cloud.google.com/storage/docs/cloud-storage-fuse/overview" target="_blank">Cloud Storage FUSE</a>.\n\n<b>Genomics</b> — SpliceAI, Nextflow/nf-core. <code>gs://</code> URIs define datasources natively. <a href="https://docs.cloud.google.com/batch/docs/nextflow" target="_blank">Cloud Batch</a> manages infrastructure.' },
            { body: 'DWS Flex Start: guaranteed 7 days, no reservation contract. Calendar Mode: lock in up to 90 days for grant deadlines.\n\nMulti-region Spot: <code>sbatch --requeue</code> resumes from checkpoint. BoltVMs: H100 cold-start ~2 min.\n\nPSSA: Each IC contributes via TAPs — researchers aren\'t charged per job. PSSA maps to that model: fixed annual line item, no per-researcher metering.' },
            { body: '6 of 7 top Biowulf GPU apps have pre-built containers:\nGROMACS, NAMD, AMBER, RELION — NGC containers\nRFdiffusion — BioNeMo Blueprints on GKE\nnnU-Net — standard PyTorch container\nCryoSPARC — license-bound manual deploy (vendor constraint, not GCP gap)\n\nCryo-EM (AreTomo, MotionCor2), biomedical imaging (DeepLabCut, nnU-Net), genomics (SpliceAI) — all covered.' },
            { body: 'Titanium: 100% CPU cores to science. Palomar OCS: reroutes around chip failures, no restart. Node Health Prediction: drains nodes before failure. Multi-tier checkpointing: RAM, peer, GCS. Topology-aware Slurm via Cluster Director.' },
          ] : [
            { body: 'All 6 backends complete. Identical scientific output across silicon. Side ladder shows $/predict per backend.' },
            { body: 'TPU TCO/hr: 30% lower than GB200, 41% lower than GB300 (SemiAnalysis). MFU 40% TPU vs 30% GPU.\n\nAnthropic, OpenAI, Apple, Meta, Midjourney, Recursion Pharma — all chose TPU at scale.\n\nCaltech CI-FM: 10,000 drug-screening runs = $53k GPU vs $8.9k TPU.' },
            { body: 'ESMFold-TPU: same PyTorch, one line changed. Identical pLDDT, identical PDB size.\n\nPurdue: 256-chip TPU pod ON-PREM with Slurm. AWS cannot deploy Trainium on-prem.' },
            { body: '1. Pick the first burst workload (with David Hoover + Tim Miller)\n2. HPC benchmark: H4D + Cloud RDMA vs BioTeam\'s EFA test\n3. AlphaFold pilot on TPU v5e via STRIDES\n4. Architecture workshop: multi-region Slurm, Terraform blueprints, NIST 800-171 hardening\n\nZeke follows up with cost model + GPAR details.' },
          ]
        }
      />
      </div>

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
