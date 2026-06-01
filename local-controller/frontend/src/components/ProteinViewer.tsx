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

type Phase = 'init' | 'waiting' | 'ready'

export default function ProteinViewer({ visible }: ProteinViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<any>(null)
  const lastUpdatedRef = useRef<string | null>(null)
  const [timestampLabel, setTimestampLabel] = useState<string>('')
  const [phase, setPhase] = useState<Phase>('init')

  // Initialize viewer once when visible flips true.
  useEffect(() => {
    if (!visible || !containerRef.current) return
    let cancelled = false
    let pollId: ReturnType<typeof setInterval> | null = null
    const controller = new AbortController()

    async function init() {
      // Dynamic import keeps 3dmol out of any code path that doesn't need it.
      const $3Dmol = await import('3dmol')
      if (cancelled || !containerRef.current) return

      viewerRef.current = $3Dmol.createViewer(containerRef.current, {
        // backgroundAlpha=0 enables WebGL alpha so the HUD shows through.
        // (The Color value still has to be a string per 3dmol's TypeScript
        // typings, even though the runtime accepts hex numbers.)
        backgroundColor: '#000000',
        backgroundAlpha: 0,
        antialias: true,
      })

      await refreshIfNew()
      pollId = setInterval(refreshIfNew, POLL_INTERVAL_MS)
    }

    async function refreshIfNew() {
      try {
        const metaResp = await fetch(PDB_METADATA_URL, { cache: 'no-store', signal: controller.signal })
        // 404 = af2-tpu.pdb doesn't exist in GCS yet. Could be: fresh setup
        // (no run has ever completed), or a run in flight that wiped the
        // file before the new AF2-TPU has produced output. Show a clear
        // placeholder instead of a black void.
        if (metaResp.status === 404) {
          if (!cancelled) setPhase('waiting')
          return
        }
        if (!metaResp.ok) return
        const meta: { updated: string } = await metaResp.json()
        const updated = meta.updated
        if (lastUpdatedRef.current === updated) {
          // Already rendered this version — keep current view, ensure phase=ready.
          if (!cancelled && phase !== 'ready') setPhase('ready')
          return
        }

        const pdbResp = await fetch(PDB_URL, { cache: 'no-store', signal: controller.signal })
        if (!pdbResp.ok) return
        const pdbText = await pdbResp.text()

        const v = viewerRef.current
        if (!v || cancelled) return
        v.clear()
        v.addModel(pdbText, 'pdb')
        // Classic AlphaFold pLDDT coloring — pLDDT is stored in the PDB B-factor field.
        //   >= 90  very high confidence  dark blue
        //   70-90  high confidence       light blue
        //   50-70  low confidence        yellow
        //   <  50  very low confidence   orange
        v.setStyle({}, {
          cartoon: {
            colorfunc: (atom: any) => {
              const b = atom.b
              if (b >= 90) return 0x0053D6
              if (b >= 70) return 0x65CBF3
              if (b >= 50) return 0xFFDB13
              return 0xFF7D45
            },
          },
        })
        v.zoomTo()
        v.spin('y', 0.5)
        v.render()

        lastUpdatedRef.current = updated
        setTimestampLabel(formatEst(updated))
        setPhase('ready')
      } catch {
        // Per spec: silent on failure (includes AbortError from cleanup).
      }
    }

    init()

    return () => {
      cancelled = true
      controller.abort()
      if (pollId) clearInterval(pollId)
      if (viewerRef.current) {
        try {
          viewerRef.current.spin(false)
          viewerRef.current.clear()
        } catch { /* viewer torn down */ }
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
        background: 'transparent',
        backdropFilter: 'blur(10px)',           // frosted-glass — matches .location-paper
        WebkitBackdropFilter: 'blur(10px)',     // Safari
        display: 'flex',
        flexDirection: 'column',
        animation: 'softFadeIn 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div
        ref={containerRef}
        className="protein-viewer-canvas"
        style={{ flex: 1, position: 'relative' }}
      >
        {/* Timestamp lives INSIDE the canvas wrapper as absolute-positioned
            so it never reorders the wrapper's children — moving the canvas
            div's index in JSX causes React to remount it, which strands the
            3dmol viewer ref against a detached DOM node (HMR pain). */}
        <div
          className="protein-viewer-ts"
          style={{
            position: 'absolute',
            top: 10,
            left: 0,
            right: 0,
            textAlign: 'center',
            fontFamily: "'Courier New', Courier, monospace",
            fontSize: 10,
            color: '#708090',
            letterSpacing: '0.12em',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        >
          {timestampLabel || ' '}
        </div>
        {phase !== 'ready' && (
          <div
            className="protein-viewer-placeholder"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
              fontFamily: "'Courier New', Courier, monospace",
              color: '#5a6878',
              letterSpacing: '0.15em',
              pointerEvents: 'none',
              padding: '0 20px',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: '#09d3ac',
                opacity: 0.65,
                letterSpacing: '0.2em',
                animation: 'softPulse 2.2s ease-in-out infinite',
              }}
            >
              {phase === 'init' ? 'CONNECTING…' : 'AWAITING AF2-TPU'}
            </div>
            <div style={{ fontSize: 9, lineHeight: 1.5, maxWidth: 220 }}>
              {phase === 'init'
                ? 'fetching last inference from gs://wz-nih-demo-shared/job/af2-tpu.pdb'
                : 'no structure in GCS yet — render will appear within 30 s of upload'}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
