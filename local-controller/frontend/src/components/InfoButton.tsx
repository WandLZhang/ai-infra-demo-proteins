import React, { useState } from 'react'

interface InfoButtonProps {
  title: string
  sections: { heading: string; body: string }[]
}

export default function InfoButton({ title, sections }: InfoButtonProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        title="Talk track"
        style={{
          position: 'fixed', top: 16, right: 16, zIndex: 50,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,0.2)',
          color: '#d3d3d3', cursor: 'pointer',
          fontFamily: 'BaronNeue, serif', fontSize: 18, fontStyle: 'italic',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(9,211,172,0.2)'; (e.currentTarget as HTMLElement).style.borderColor = '#09d3ac' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.6)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.2)' }}
      >
        i
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{
            position: 'fixed', inset: 0, zIndex: 49, background: 'rgba(0,0,0,0.5)',
          }} />
          <div style={{
            position: 'fixed', top: 64, right: 16, zIndex: 51,
            width: '34vw', maxHeight: 'calc(100vh - 96px)',
            background: 'rgba(15,15,20,0.92)', backdropFilter: 'blur(16px)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4,
            padding: '20px 24px', overflowY: 'auto',
            fontFamily: 'BaronNeue, sans-serif',
            color: '#d3d3d3',
            boxShadow: '0 12px 48px rgba(0,0,0,0.7)',
          }}>
            <div style={{
              fontSize: 18, color: '#09d3ac', marginBottom: 14,
              textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 400,
            }}>
              {title}
            </div>
            {sections.map((s, i) => (
              <div key={i} style={{ marginBottom: 18 }}>
                <div style={{
                  fontSize: 14, color: '#708090', textTransform: 'uppercase',
                  letterSpacing: '0.1em', marginBottom: 6,
                }}>{s.heading}</div>
                <div style={{ fontSize: 14, lineHeight: 1.55, color: '#d3d3d3', whiteSpace: 'pre-wrap' as const }}>{s.body}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
