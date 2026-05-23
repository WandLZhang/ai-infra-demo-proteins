import React from 'react'

interface InfoButtonProps {
  title: string
  sections: { body: string }[]
  open: boolean
  onToggle: () => void
}

export default function InfoButton({ title, sections, open, onToggle }: InfoButtonProps) {

  return (
    <>
      <button
        onClick={onToggle}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'white', padding: 8 }}
      >
        <span className="material-icons" style={{ fontSize: 28 }}>info_outline</span>
      </button>

      <div style={{
        position: 'fixed', top: 60, right: 16, zIndex: 30, width: '34vw',
        maxHeight: 'calc(100vh - 96px)',
        backdropFilter: 'blur(10px)',
        transform: open ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(-10px)',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' as const : 'none' as const,
        transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        transformOrigin: 'top right', overflow: 'hidden',
      }}>
        <div style={{ maxHeight: 'calc(100vh - 96px)', overflowY: 'auto', padding: '20px 24px' }}>
          <div style={{
            fontSize: 18, color: '#09d3ac', marginBottom: 14,
            fontFamily: "'BaronNeue-Regular', sans-serif",
            textTransform: 'uppercase' as const, letterSpacing: '0.12em', fontWeight: 400,
          }}>
            {title}
          </div>
          {sections.map((s, i) => (
            <div key={i} style={{ marginBottom: 18 }}>
              <div
                className="info-body"
                style={{
                  fontSize: 13, lineHeight: 1.55, color: '#d3d3d3',
                  fontFamily: "'Google Sans', sans-serif",
                  whiteSpace: 'pre-wrap' as const,
                }}
                dangerouslySetInnerHTML={{ __html: s.body }}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
