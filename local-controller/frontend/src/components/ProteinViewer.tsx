import React, { useEffect, useRef, useState } from 'react'

// Public-read bucket — all fetches anonymous.
const PDB_URL = 'https://storage.googleapis.com/wz-nih-demo-shared/job/af2-tpu.pdb'
const PDB_METADATA_URL = 'https://storage.googleapis.com/storage/v1/b/wz-nih-demo-shared/o/job%2Faf2-tpu.pdb'

// 30 seconds — picks up new AF2-TPU runs without user action, low load on GCS API.
const POLL_INTERVAL_MS = 30_000

// Render the GCS object's `updated` ISO-8601 timestamp in EST as
// "INFERRED 2026-06-01 14:32:18 EST".
function formatEst(isoTs: string): string {
  const d = new Date(isoTs)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const lookup: Record<string, string> = {}
  for (const p of parts) lookup[p.type] = p.value
  return `INFERRED ${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}:${lookup.second} EST`
}

interface ProteinViewerProps {
  /** When false, the component returns null (used to mount/unmount across phase changes). */
  visible: boolean
}

export default function ProteinViewer({ visible }: ProteinViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<any>(null)
  const lastUpdatedRef = useRef<string | null>(null)
  const [timestampLabel, setTimestampLabel] = useState<string>('')

  // Reset cached "last updated" each time we re-mount so we always re-fetch the PDB.
  useEffect(() => {
    if (!visible) return
    lastUpdatedRef.current = null
  }, [visible])

  // Initialize viewer once when visible flips true.
  useEffect(() => {
    if (!visible || !containerRef.current) return
    let cancelled = false
    let pollId: ReturnType<typeof setInterval> | null = null

    async function init() {
      // Dynamic import keeps 3dmol out of any code path that doesn't need it.
      const $3Dmol = await import('3dmol')
      if (cancelled || !containerRef.current) return

      viewerRef.current = $3Dmol.createViewer(containerRef.current, {
        backgroundColor: 'rgba(0,0,0,0)',  // transparent so the HUD shows through
        antialias: true,
      })

      await refreshIfNew()
      pollId = setInterval(refreshIfNew, POLL_INTERVAL_MS)
    }

    async function refreshIfNew() {
      try {
        const metaResp = await fetch(PDB_METADATA_URL, { cache: 'no-store' })
        if (!metaResp.ok) return
        const meta = await metaResp.json()
        const updated: string = meta.updated
        if (lastUpdatedRef.current === updated) return  // no new run since last poll

        const pdbResp = await fetch(PDB_URL, { cache: 'no-store' })
        if (!pdbResp.ok) return
        const pdbText = await pdbResp.text()

        const v = viewerRef.current
        if (!v || cancelled) return
        v.clear()
        v.addModel(pdbText, 'pdb')
        v.setStyle({}, { cartoon: { color: '#09d3ac' } })
        v.zoomTo()
        v.spin('y', 0.5)
        v.render()

        lastUpdatedRef.current = updated
        setTimestampLabel(formatEst(updated))
      } catch {
        // Per spec: no fallback, no error UI. Silent on failure; manual fix on demo day.
      }
    }

    init()

    return () => {
      cancelled = true
      if (pollId) clearInterval(pollId)
      if (viewerRef.current) {
        try { viewerRef.current.clear() } catch { /* viewer torn down */ }
        viewerRef.current = null
      }
    }
  }, [visible])

  if (!visible) return null

  return (
    <div
      className="protein-viewer-wrap"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: '20vw',
        height: '100vh',
        zIndex: 20,                      // above SideLadder (z-index ~10), below info box (z-index 30)
        background: 'rgba(0, 0, 0, 0.6)',
        borderLeft: '1px solid #2a2a2a',
        display: 'flex',
        flexDirection: 'column',
        animation: 'softFadeIn 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div
        ref={containerRef}
        className="protein-viewer-canvas"
        style={{ flex: 1, position: 'relative' }}
      />
      <div
        className="protein-viewer-ts"
        style={{
          padding: '10px 14px 14px',
          textAlign: 'center',
          fontFamily: "'Courier New', Courier, monospace",
          fontSize: 10,
          color: '#708090',
          letterSpacing: '0.12em',
        }}
      >
        {timestampLabel || ' '}
      </div>
    </div>
  )
}
