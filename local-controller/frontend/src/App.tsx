import React, { useState, useCallback, useRef, useEffect } from 'react'
import './hud.css'

import InfraMap, { type ZoneInfo, BIOWULF_HOME } from './components/InfraMap'
import type { MarkerState } from './components/ZoneMarker'
import SideLadder from './components/SideLadder'
import InfoButton from './components/InfoButton'
import type { Protein, ModelId, BackendId, LaneStatus, PredictResponse } from './types'
import { BACKENDS } from './backends'
import { submitRun, pollStatus, pollEvents } from './api'

const PROTEINS: Protein[] = [
  { id: 'brca1', name: 'BRCA1 BRCT', sequence: 'NAMEESVSREKPELTASTERVNKRMS...', uniprotId: 'P38398', description: 'Breast cancer tumor suppressor — DNA repair', residueCount: 214 },
  { id: 'p53', name: 'p53 DBD', sequence: 'SSSVPSQKTYQGSYGFRLGFLHSG...', uniprotId: 'P04637', description: 'Tumor suppressor — guardian of the genome', residueCount: 196 },
  { id: 'ace2', name: 'ACE2 PD', sequence: 'QSTIEEQAKTFLDKFNHEAEDLF...', uniprotId: 'Q9BYF1', description: 'SARS-CoV-2 receptor — COVID-19 entry point', residueCount: 597 },
  { id: 'hemoglobin', name: 'Hemoglobin α', sequence: 'MVLSPADKTNVKAAWGKVGAHAG...', uniprotId: 'P69905', description: 'Oxygen transport — sickle cell disease target', residueCount: 142 },
  { id: 'insulin', name: 'Insulin receptor', sequence: 'LRELGQGSFGMVYEGNARDIIK...', uniprotId: 'P06213', description: 'Diabetes — receptor tyrosine kinase', residueCount: 267 },
  { id: 'cftr', name: 'CFTR NBD1', sequence: 'NLTTTEVVMENVTAFWEEGFGEL...', uniprotId: 'P13569', description: 'Cystic fibrosis transmembrane regulator', residueCount: 251 },
]

// UX phases: zoomed on Building 12 → terminal → submit → zoom out → catalog → catalog2 → results
type Phase = 'home' | 'dispatching' | 'running' | 'catalog' | 'catalog2' | 'catalog3' | 'catalog4' | 'md1' | 'md2' | 'md3' | 'done'

function initLaneStatus(backendId: BackendId): LaneStatus {
  const b = BACKENDS.find(b => b.id === backendId)!
  return { backendId, state: 'idle', startedAt: null, completedAt: null, elapsedMs: 0, costAccumulated: 0, result: null, error: null, talkTrackSlide: b.talkTrackSlide, talkTrackLabel: b.talkTrackLabel }
}

export default function App() {
  const [lanes, setLanes] = useState<Record<BackendId, LaneStatus>>(
    Object.fromEntries(BACKENDS.map(b => [b.id, initLaneStatus(b.id)])) as Record<BackendId, LaneStatus>
  )
  const [phase, setPhase] = useState<Phase>('home')
  const [currentProtein, setCurrentProtein] = useState<Protein>(PROTEINS[0])
  const [proteinMenuOpen, setProteinMenuOpen] = useState(false)
  const [selectedZone, setSelectedZone] = useState<ZoneInfo | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [dispatchLines, setDispatchLines] = useState<string[]>([])
  const [infoOpen, setInfoOpen] = useState(false)
  const lineQueue = useRef<import('./api').SlurmEvent[]>([])
  const dripRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [zoneStates, setZoneStates] = useState<Record<string, MarkerState>>({})
  const [vmStates, setVmStates] = useState<Record<string, { name: string, zone: string, state: string, href: string }>>({})

  const mapCenter = phase === 'home'
    ? { lat: 38.974, lng: -77.006 }
    : { lat: 39.5, lng: -98.35 }
  const mapZoom = phase === 'home' ? 12 : 5

  const lastEventCount = useRef(0)
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalDone = useRef(false)

  function consoleUrl(ev: { vm?: string | null, zone?: string, partition?: string, project?: string }): string {
    if (!ev.vm || !ev.zone || !ev.project) return ''
    if (ev.partition === 'tpu')
      return `https://console.cloud.google.com/compute/tpus/details/${ev.zone}/${ev.vm}?project=${ev.project}`
    return `https://console.cloud.google.com/compute/instancesDetail/zones/${ev.zone}/instances/${ev.vm}?project=${ev.project}`
  }

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (dripRef.current) clearTimeout(dripRef.current)
    lastEventCount.current = 0
    lineQueue.current = []
    terminalDone.current = false

    const drainNext = () => {
      if (lineQueue.current.length === 0) {
        dripRef.current = setTimeout(drainNext, 500) as any
        return
      }
      const ev = lineQueue.current.shift()! as any

      // ── Terminal: show msg for all visible event types ──
      if (!terminalDone.current && ev.type !== 'node_up') {
        if (ev.type === 'complete') {
          terminalDone.current = true
        } else {
          setDispatchLines(prev => [...prev, ev.msg])
        }
      }

      // ── Side ladder: update lane state from structured fields ──
      const bid = ev.backend as BackendId | undefined
      if (bid && BACKENDS.some(b => b.id === bid)) {
        switch (ev.type) {
          case 'dispatch':
            setLanes(prev => ({ ...prev, [bid]: { ...prev[bid], state: 'queued' } }))
            break
          case 'sched_allocate':
          case 'allocate':
            setLanes(prev => ({ ...prev, [bid]: { ...prev[bid], state: 'allocating' } }))
            break
          case 'loading':
            setLanes(prev => ({ ...prev, [bid]: { ...prev[bid], state: 'loading' } }))
            break
          case 'inferring':
            setLanes(prev => ({ ...prev, [bid]: { ...prev[bid], state: 'inferring' } }))
            break
          case 'done':
            setLanes(prev => ({
              ...prev,
              [bid]: {
                ...prev[bid],
                state: 'done',
                elapsedMs: ev.elapsed_ms || prev[bid].elapsedMs,
                costAccumulated: ev.cost || prev[bid].costAccumulated,
                completedAt: new Date(ev.ts).getTime(),
              },
            }))
            break
          case 'failed':
            setLanes(prev => ({ ...prev, [bid]: { ...prev[bid], state: 'failed', error: ev.error || 'unknown' } }))
            break
          case 'requeue':
            setLanes(prev => ({ ...prev, [bid]: { ...prev[bid], state: 'queued' } }))
            break
        }
      }

      // ── Map markers: update zone state + VM entries from structured fields ──
      const region = ev.region as string | undefined
      if (region) {
        switch (ev.type) {
          case 'sched_allocate':
            if (ev.vm) {
              setZoneStates(prev => ({ ...prev, [region]: prev[region] === 'active' || prev[region] === 'done' ? prev[region] : 'provisioning' }))
              setVmStates(prev => {
                const existing = prev[ev.vm!]
                if (existing && (existing.state === 'active' || existing.state === 'done')) return prev
                return { ...prev, [ev.vm!]: { name: ev.vm!, zone: region, state: 'provisioning', href: existing?.href || consoleUrl(ev) } }
              })
            }
            break
          case 'allocate':
            if (ev.vm) {
              setZoneStates(prev => ({ ...prev, [region]: 'active' }))
              setVmStates(prev => ({ ...prev, [ev.vm!]: { name: ev.vm!, zone: region, state: 'active', href: consoleUrl(ev) } }))
            }
            break
          case 'done':
            if (ev.vm) {
              setVmStates(prev => prev[ev.vm!] ? { ...prev, [ev.vm!]: { ...prev[ev.vm!], state: 'done' } } : prev)
            }
            break
          case 'failed':
            if (ev.vm) {
              setVmStates(prev => prev[ev.vm!] ? { ...prev, [ev.vm!]: { ...prev[ev.vm!], state: 'failed' } } : prev)
              setZoneStates(prev => ({ ...prev, [region]: prev[region] === 'active' || prev[region] === 'done' ? prev[region] : 'failed' }))
            }
            break
          case 'spot_fail':
            setZoneStates(prev => ({ ...prev, [region]: prev[region] === 'active' || prev[region] === 'done' ? prev[region] : 'failed' }))
            setVmStates(prev => {
              const updated = { ...prev }
              let found = false
              for (const [key, vm] of Object.entries(updated)) {
                if (vm.zone === region && vm.state === 'provisioning') {
                  updated[key] = { ...vm, state: 'failed' }
                  found = true
                }
              }
              if (!found && ev.nodeset) {
                updated[`spot-${ev.nodeset}`] = { name: ev.nodeset!, zone: region, state: 'failed', href: '' }
              }
              return updated
            })
            break
        }
      }

      // Peek at next item's timestamp to calculate delay
      let delay = 600
      if (lineQueue.current.length > 0) {
        const next = lineQueue.current[0] as any
        if (ev.ts && next.ts) {
          const gap = new Date(next.ts).getTime() - new Date(ev.ts).getTime()
          delay = Math.max(100, gap)
        }
      }
      dripRef.current = setTimeout(drainNext, delay) as any
    }
    dripRef.current = setTimeout(drainNext, 500) as any
    pollRef.current = setInterval(async () => {
      try {
        const [status, events] = await Promise.all([
          pollStatus(),
          pollEvents(),
        ])

        if (events.length > lastEventCount.current) {
          const newEvents = events.slice(lastEventCount.current)
            .filter(e => e.type !== 'node_up')
          if (newEvents.length > 0) {
            lineQueue.current.push(...newEvents)
          }
          lastEventCount.current = events.length
        }

        if (status.all_complete && lineQueue.current.length === 0) {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          // Only auto-advance to 'done' if user hasn't manually advanced to 'catalog'
          setPhase(p => p === 'running' || p === 'dispatching' ? 'done' : p)
        }
      } catch (err) {
        console.error('Poll error:', err)
      }
    }, 2000)
  }, [])

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (dripRef.current) clearTimeout(dripRef.current)
    }
  }, [])

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [dispatchLines])

  const handleSubmit = useCallback(async () => {
    setPhase('dispatching')
        setDispatchLines([])
    setLanes(Object.fromEntries(BACKENDS.map(b => [b.id, initLaneStatus(b.id)])) as Record<BackendId, LaneStatus>)
    setZoneStates({})
    setVmStates({})

    try {
      const result = await submitRun(currentProtein.id)
      if (result.already_running) {
        setPhase('running')
      } else {
        setPhase('running')
      }
      startPolling()
    } catch (err) {
      console.error('Submit failed:', err)
      setDispatchLines([`Error: ${err}`])
      setPhase('home')
    }
  }, [currentProtein, startPolling])

  // Enter + Arrow keys advance the narrative: home → run → catalog → done
  // ArrowLeft navigates back through the same sequence
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault()
        if (phase === 'home') {
          // If a run is already in flight (user navigated back here), just go forward without re-submitting
          const hasActiveRun = Object.values(lanes).some(l => l.state !== 'idle')
          if (hasActiveRun) setPhase('running')
          else handleSubmit()
        }
        else if (phase === 'dispatching' || phase === 'running') setPhase('catalog')
        else if (phase === 'catalog') setPhase('catalog2')
        else if (phase === 'catalog2') setPhase('catalog3')
        else if (phase === 'catalog3') setPhase('catalog4')
        else if (phase === 'catalog4') setPhase('md1')
        else if (phase === 'md1') setPhase('md2')
        else if (phase === 'md2') setPhase('md3')
        // 'md3' is the final manual slide — auto-advance to 'done' happens only when inference completes (polling)
        // 'done' stays
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (phase === 'done') setPhase('md3')
        else if (phase === 'md3') setPhase('md2')
        else if (phase === 'md2') setPhase('md1')
        else if (phase === 'md1') setPhase('catalog4')
        else if (phase === 'catalog4') setPhase('catalog3')
        else if (phase === 'catalog3') setPhase('catalog2')
        else if (phase === 'catalog2') setPhase('catalog')
        else if (phase === 'catalog') setPhase('running')
        else if (phase === 'running' || phase === 'dispatching') setPhase('home')
        // 'home' stays
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [phase, handleSubmit, lanes])

  const isRunning = phase === 'dispatching' || phase === 'running'

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#171717', overflow: 'hidden', position: 'relative' }}>
      {/* Fullscreen map — zoom driven by phase */}
      <InfraMap lanes={lanes} zoneStates={zoneStates} vmStates={vmStates} onZoneClick={setSelectedZone} center={mapCenter} zoom={mapZoom} highlightUS={phase === 'catalog' || phase === 'catalog2' || phase === 'catalog3' || phase === 'catalog4'} showSpokes={phase === 'catalog2' || phase === 'catalog3' || phase === 'catalog4'} showHalos={phase === 'catalog3' || phase === 'catalog4'} />

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

      {/* Terminal — top edge anchored, auto-scrolls to bottom as new lines append */}
      <div ref={terminalRef} className="terminal-box" style={{
        position: 'fixed',
        // Home: original small centered box (42vh top + 25vh tall → 33vh bottom).
        // Non-home: spans from below hamburger to just above location-paper (~12vw + buffer).
        top:    phase === 'home' ? '42vh' : '75px',
        bottom: phase === 'home' ? '33vh' : 'calc(12vw + 12px)',
        // Tighter when anchored so more map is visible. Width animates in Phase 2.
        width:  phase === 'home' ? '30vw' : '22vw',
        // Always anchored at left: 1vw. Centered on home via transform alone (no jiggle).
        // translateX(34vw) puts left edge at 35vw = (100-30)/2, centering the 30vw home box.
        left: '1vw',
        transform: phase === 'home' ? 'translateX(34vw)' : 'translateX(0)',
        // Two-phase: slide horizontally first (0-0.35s), THEN resize (0.35-0.70s) vertically + horizontally.
        transition:
          'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1),' +
          ' top 0.35s cubic-bezier(0.4, 0, 0.2, 1) 0.35s,' +
          ' bottom 0.35s cubic-bezier(0.4, 0, 0.2, 1) 0.35s,' +
          ' width 0.35s cubic-bezier(0.4, 0, 0.2, 1) 0.35s',
        zIndex: 20,
      }}>
        <div style={{ color: '#708090', fontSize: '1vmin' }}>Last login: {new Date().toLocaleString()} on tty1</div>
        <div style={{ color: '#d3d3d3' }}>researcher@biowulf-bld12:~$ <span style={{ color: '#09d3ac' }}>sbatch predict.sh \</span></div>
        <div style={{ color: '#09d3ac' }}>  --model=all --target=both --protein={currentProtein.id} \</div>
        <div style={{ color: '#09d3ac' }}>  --requeue --partition=tpu,gpu</div>
        {phase === 'home' && (
          <div style={{ marginTop: 6, color: '#708090', fontSize: '1.1vmin' }}>Press Enter to submit</div>
        )}
        {phase !== 'home' && dispatchLines.length > 0 && (
          <>
            {dispatchLines.map((line, i) => (
              <div key={i} className="terminal-line" style={{ color: '#eab308', marginTop: i === 0 ? 6 : 0 }}>{line}</div>
            ))}
          </>
        )}
        {phase === 'done' && <div className="terminal-line" style={{ color: '#09d3ac' }}>researcher@biowulf-bld12:~$ ▌</div>}
      </div>

      {/* Side ladder — always visible, fills with values as backends complete */}
      <SideLadder lanes={lanes} onSelect={() => {}} />

      {/* Location paper — key only changes on home↔cloud transitions, so the protein "comes in"
          on slide 1 → slide 2 and stays put through subsequent slide navigation */}
      <div className="location-paper" key={phase === 'home' ? 'loc-home' : 'loc-cloud'}>
        <div className="location-paper-region">
          {phase === 'home' ? 'BUILDING 12' : (selectedZone?.label || 'BIOWULF — MULTI-REGION BURST')}
        </div>
        <div className="location-paper-name">
          {phase === 'home' ? 'NIH BETHESDA' : currentProtein.name.toUpperCase()}
        </div>
        <div className="location-paper-coords">
          {phase === 'home'
            ? 'Lat: 38.9988, Lng: -77.1020 | Biowulf HPC'
            : `${currentProtein.uniprotId} · ${currentProtein.residueCount} AA`}
        </div>
      </div>

      {/* Info button — top right, same style as hamburger menu */}
      <div style={{ position: 'fixed', top: 15, right: 15, zIndex: 25 }}>
      <InfoButton
        open={infoOpen}
        onToggle={() => setInfoOpen(!infoOpen)}
        title={
          phase === 'home' ? 'Biowulf Home' :
          phase === 'dispatching' ? 'Multi-Region Burst' :
          phase === 'running' ? 'Multi-Region Burst' :
          phase === 'catalog' ? 'Biowulf Scientific Applications Catalog' :
          phase === 'catalog2' ? 'Multi-Region Bucket: Hierarchical Namespace' :
          phase === 'catalog3' ? 'Rapid Cache & Image Streaming' :
          phase === 'catalog4' ? 'vs AWS & Azure' :
          phase === 'md1' ? 'Molecular Dynamics' :
          phase === 'md2' ? 'H4D + Cloud RDMA (Falcon)' :
          phase === 'md3' ? 'Five MPI-Specific Google Features' :
          'Results'
        }
        sections={
          phase === 'home' ? [
            { body: 'The <a href="https://hpc.nih.gov/" target="_blank">Biowulf cluster</a> serves 2,500 researchers across 23 NIH institutes — 105,000 processors, 336 A100 GPUs, and a <a href="https://hpc.nih.gov/apps/" target="_blank">scientific applications catalog</a> that covers everything from GROMACS to AlphaFold. Building 12 is approaching end of life, GPU queue pressure continues to grow, and three new AI staff have joined to keep pace with demand. Today\'s conversation is about how to extend that capacity.\n\nGoogle Cloud was NIH\'s <a href="https://www.hpcwire.com/2018/07/31/google-is-first-partner-in-nihs-strides-effort-to-speed-discovery-in-the-cloud/" target="_blank">first commercial cloud partner</a> under the STRIDES Initiative in 2018. Google designs its own silicon, network transport, and datacenter hardware — attributes that make cloud bursting with Google worth a closer look.\n\nOn screen is a terminal on Building 12 with a real Slurm command: <code>sbatch predict.sh --model=all --target=both --protein=brca1 --requeue --partition=tpu,gpu</code>. This terminal sits inside a controller project simulating Biowulf on-premise, ready to burst compute into a separate cloud project. When we press Enter, six inference jobs will dispatch across both TPU and GPU partitions to whichever CONUS regions have Spot capacity.' },
          ] :
          phase === 'dispatching' || phase === 'running' ? [
            { body: 'The on-prem Slurm controller in one project submits jobs to compute nodes in a separate cloud project. The controller does not move — the compute bursts out.\n\nThe architecture is one Slurm cluster. The controller sits on-prem; in this demo it is simulated by a VM in a controller project connected to the burst project over <a href="https://cloud.google.com/vpc/docs/vpc-peering" target="_blank">VPC peering</a>. In production, NIH would use a <a href="https://cloud.google.com/network-connectivity/docs/interconnect/concepts/overview" target="_blank">400 Gbps Dedicated Interconnect</a> from Building 12 to the nearest Google edge in Ashburn — same private IP connectivity, sub-millisecond latency on the Interconnect leg, MACsec encrypted in transit. <a href="https://cloud.google.com/managed-microsoft-ad/docs/overview" target="_blank">Managed Microsoft AD</a> trust bridges Biowulf\'s UID/GID into cloud nodes, so researchers log in with the same identity they use today.\n\nSlurm\'s <code>--requeue</code> flag handles Spot preemption: if a node is reclaimed, the job retries in the next available zone. The compute nodesets are configured once with weight-based priority. For the TPU partition, Slurm tries us-west1 first (the largest Spot pool), then us-east5, then us-central1. For GPU, us-central1 is first. Researchers see none of this — they submit <code>sbatch</code> and Slurm handles the rest.' },
          ] :
          phase === 'catalog' ? [
            { body: 'The workloads in the <a href="https://hpc.nih.gov/apps/" target="_blank">Biowulf scientific applications catalog</a> fall into five categories by data and compute profile. Each maps to a different set of cloud primitives.' },
            { body: '<b>Cryo-EM &amp; Tomography</b>\n\nApps in scope: AreTomo2/3, MotionCor2/3, Gctf, CryoSPARC, RELION. Multi-GPU accelerated and queue-bound on Biowulf. Input datasets are large — hundreds of GB per session — but static per experiment, making this an ideal burst profile.\n\n<a href="https://cloud.google.com/storage-transfer/docs/overview" target="_blank">Storage Transfer Service</a> runs an agent on the GPFS filesystem and performs scheduled incremental syncs to a <a href="https://docs.cloud.google.com/storage/docs/locations" target="_blank">multi-region Cloud Storage bucket</a> (US). Only changed files transfer, POSIX attributes and symlinks are preserved, and project directories are pre-staged before jobs submit — the hundreds of GB of session data flow into the cloud once, not once per job.' },
          ] :
          phase === 'catalog2' ? [
            { body: 'The bucket has <a href="https://docs.cloud.google.com/storage/docs/hns-overview" target="_blank">Hierarchical Namespace</a> enabled. <b>8× higher initial QPS than flat buckets (40,000 reads/sec versus 5,000)</b> keeps RELION 3D classification and CryoSPARC NU-refine GPU workers saturated when each refinement round re-reads hundreds of thousands of small particle files.\n\n<b>Atomic folder renames</b> commit a RELION refinement job in one metadata-only API call — <code>gcloud storage mv gs://nih-biowulf-cryoem/Refine3D/job001.staging gs://nih-biowulf-cryoem/Refine3D/job001</code> updates the folder\'s path without physically copying or deleting the underlying particle files. On flat buckets, that same commit is a quadratic copy-and-delete loop across the entire particle stack.\n\nThe <b>99.95% SLA</b> matches the durability bar for irreplaceable microscope data, and the bucket is <b>reachable from every burst region</b> so Spot capacity that surfaces in a different zone next session doesn\'t trigger a re-stage.\n\nCompute nodes mount the bucket via <a href="https://cloud.google.com/storage/docs/cloud-storage-fuse/overview" target="_blank">Cloud Storage FUSE</a>, so the same <code>/data/</code> paths appear regardless of which region the Spot allocation surfaces in — RELION, CryoSPARC, AreTomo, and MotionCor all expect POSIX paths, and Slurm\'s <code>--requeue</code> across regions then works without rewriting job scripts.' },
          ] :
          phase === 'catalog3' ? [
            { body: 'In each burst zone, <a href="https://docs.cloud.google.com/storage/docs/rapid/rapid-cache" target="_blank">Rapid Cache</a> sits as a zonal SSD read cache on top of the multi-region bucket. First read warms the cache; subsequent reads in that zone hit <b>2.5 TB/s at sub-millisecond latency</b> with reduced multi-region transfer fees. For a multi-hour CryoSPARC NU-refine job that re-reads the same particle stack dozens of times, the cache turns a recurring multi-region egress bill into a one-time warm-up — bursting across five regions does not pay 5× egress.\n\nContainer distribution follows the same first-read-fast pattern. <a href="https://catalog.ngc.nvidia.com/orgs/hpc/containers/relion" target="_blank">RELION</a> and <a href="https://catalog.ngc.nvidia.com/orgs/hpc/containers/gromacs" target="_blank">GROMACS</a> ship as pre-built NGC containers between 5 and 15 GB, and <a href="https://docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming" target="_blank">Image Streaming</a> pulls them from a remote filesystem so pods start immediately while the image downloads in the background — important when Spot capacity lands in a zone where the image isn\'t already cached locally.' },
          ] :
          phase === 'catalog4' ? [
            { body: '<b>AWS S3</b> has no true multi-region buckets. <a href="https://docs.aws.amazon.com/AmazonS3/latest/userguide/MultiRegionAccessPoints.html" target="_blank">Multi-Region Access Points</a> route requests intelligently, but each object still lives in a single region, so replication storage and cross-region egress both accrue on every cache miss. <a href="https://docs.aws.amazon.com/AmazonS3/latest/userguide/mountpoint.html" target="_blank">Mountpoint for S3</a> reached general availability in 2023, giving it years less production exposure than <a href="https://cloud.google.com/storage/docs/cloud-storage-fuse/overview" target="_blank">Cloud Storage FUSE</a>, and there is no S3 equivalent to <a href="https://docs.cloud.google.com/storage/docs/rapid/rapid-cache" target="_blank">Rapid Cache</a> at any tier.\n\n<b>Azure Blob Storage</b> is region-pinned with no multi-region bucket equivalent in its catalog, and Azure caps useful <a href="https://learn.microsoft.com/en-us/azure/aks/artifact-streaming" target="_blank">image streaming</a> around 30 GB — half the headroom Google ships.' },
          ] :
          phase === 'md1' ? [
            { body: 'Apps in scope: GROMACS, NAMD, AMBER, Acemd. Tightly-coupled MPI, latency-sensitive, anchored in one region — a multi-region MPI job is not a meaningful configuration.\n\nThe hot scratch tier is zonal. Two options serve this profile: <a href="https://docs.cloud.google.com/managed-lustre/docs/overview" target="_blank">Managed Lustre</a>, built <a href="https://docs.cloud.google.com/managed-lustre/docs/overview" target="_blank">with DDN</a> — full POSIX, sub-millisecond latency, <b>10 TB/s</b> (AWS FSx for Lustre caps around 2 TB/s); or <a href="https://docs.cloud.google.com/storage/docs/rapid/rapid-bucket" target="_blank">Rapid Bucket</a>, a zonal Cloud Storage bucket using the Rapid storage class — sub-ms, <b>15 TB/s, 20 million QPS</b>, with appendable objects suited to streaming checkpoints. Both live in one zone, co-located with compute. The access pattern — tightly-coupled MPI with concurrent per-rank writes — is what these tiers were designed for.' },
          ] :
          phase === 'md2' ? [
            { body: '<a href="https://cloud.google.com/blog/products/compute/new-h4d-vms-optimized-for-hpc" target="_blank">H4D</a> is the HPC-optimized VM, purpose-built for tightly-coupled MPI. Hardware: <b>5th-gen AMD EPYC Turin, 192 vCPUs, up to 1.5 TB RAM, 200 Gbps</b> <a href="https://docs.cloud.google.com/compute/docs/instances/create-vm-with-rdma" target="_blank">Cloud RDMA</a> via <a href="https://cloud.google.com/blog/products/networking/understanding-cloud-rdma-scalable-high-performance-networking" target="_blank">Falcon</a> — the first CPU VM family to offer hardware-level RDMA in the cloud. Published benchmarks: <a href="https://cloud.google.com/blog/products/compute/new-h4d-vms-optimized-for-hpc" target="_blank">GROMACS Lignocellulose</a> at <b>2.8× over TCP</b> on 32 VMs with Falcon; Ansys Fluent <b>4.1× vs C2D</b>; OpenFOAM <b>5.2× vs C2D with 122% superlinear efficiency</b>.' },
          ] :
          phase === 'md3' ? [
            { body: 'MD is the canonical case for five MPI-specific Google features. Each is unique to Google Cloud:\n\n<ul style="margin: 8px 0; padding-left: 18px; list-style-type: none;"><li style="margin-bottom: 10px; padding-left: 12px; border-left: 2px solid #2a2a2a;"><a href="https://docs.cloud.google.com/cluster-director/docs/orchestration" target="_blank">Topology-aware Slurm via Cluster Director</a> — the physical network has rack/block/cluster tiers. Cluster Director exposes the hierarchy to Slurm so MPI ranks co-locate on the same rack. <a href="https://docs.cloud.google.com/ai-hypercomputer/docs/networking-overview" target="_blank">AWS and Azure have non-blocking fabrics but do not expose the hierarchy to the scheduler — placement is random</a>.</li><li style="margin-bottom: 10px; padding-left: 12px; border-left: 2px solid #2a2a2a;"><a href="https://docs.cloud.google.com/kubernetes-engine/docs/how-to/machine-learning/training/multi-tier-checkpointing" target="_blank">Multi-Tier Checkpointing</a> — writes to local RAM disk, replicates to peer nodes, async-uploads to Cloud Storage. When a long-running job restarts, it pulls from the nearest tier: local SSD first, peer node next, GCS last.</li><li style="margin-bottom: 10px; padding-left: 12px; border-left: 2px solid #2a2a2a;"><a href="https://docs.cloud.google.com/ai-hypercomputer/docs/workloads/enable-node-health-prediction" target="_blank">Node Health Prediction</a> — predicts which nodes will degrade in the next 5 hours based on metadata, heat, and packet integrity, and drains them before disruptive symptoms surface. SageMaker notifies after the fact.</li><li style="margin-bottom: 10px; padding-left: 12px; border-left: 2px solid #2a2a2a;"><a href="https://cloud.google.com/blog/products/networking/introducing-virgo-megascale-data-center-fabric" target="_blank">Optical Circuit Switching (Palomar)</a> — when a chip fails mid-job, OCS physically reroutes the topology around the failed chip without restarting. Anthropic uses this to survive daily failures across 1 million chips. For multi-day GROMACS runs, that is completion instead of restart.</li><li style="margin-bottom: 0; padding-left: 12px; border-left: 2px solid #2a2a2a;"><a href="https://cloud.google.com/blog/products/ai-machine-learning/goodput-metric-as-measure-of-ml-productivity" target="_blank">Goodput</a> — paid compute hours that were actually productive. Google publishes this as a service-level indicator, and Cluster Director optimizes for it.</li></ul>' },
          ] : [
            { body: 'Inference complete — results content TBD.' },
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
