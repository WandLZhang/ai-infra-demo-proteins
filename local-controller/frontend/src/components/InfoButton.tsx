import React from 'react'

type Variant = 'popover' | 'hero'

interface InfoButtonProps {
  title: string
  sections: { body: string }[]
  open: boolean
  onToggle: () => void
  variant?: Variant
}

const POPOVER_STYLE: React.CSSProperties = {
  position: 'fixed', top: 60, right: 16, zIndex: 30, width: '34vw',
  maxHeight: 'calc(100vh - 96px)',
  backdropFilter: 'blur(10px)',
  transformOrigin: 'top right', overflow: 'hidden',
}

const HERO_STYLE: React.CSSProperties = {
  position: 'fixed', top: '50%', left: '50%', zIndex: 30,
  width: '58vw',
  maxHeight: '82vh',
  background: '#000',
  border: '1.5px solid #09d3ac',
  boxShadow: '0 0 28px rgba(9, 211, 172, 0.35), inset 0 0 18px rgba(9, 211, 172, 0.04)',
  transformOrigin: 'center center', overflow: 'hidden',
}

export default function InfoButton({ title, sections, open, onToggle, variant = 'popover' }: InfoButtonProps) {
  const isHero = variant === 'hero'
  const baseStyle = isHero ? HERO_STYLE : POPOVER_STYLE
  const openTransform = isHero ? 'translate(-50%, -50%) scale(1)' : 'scale(1) translateY(0)'
  const closedTransform = isHero ? 'translate(-50%, -50%) scale(0.95)' : 'scale(0.95) translateY(-10px)'

  return (
    <>
      <button
        onClick={onToggle}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'white', padding: 8 }}
      >
        <span className="material-icons" style={{ fontSize: 28 }}>info_outline</span>
      </button>

      <div style={{
        ...baseStyle,
        transform: open ? openTransform : closedTransform,
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' as const : 'none' as const,
        transition: 'opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        <div style={{ maxHeight: isHero ? '82vh' : 'calc(100vh - 96px)', overflowY: 'auto', padding: isHero ? '28px 36px' : '20px 24px' }}>
          {/* key={title} forces remount on slide change so the fade animation re-fires */}
          <div className="info-content-wrap" key={title}>
            <div style={{
              fontSize: isHero ? 22 : 18, color: '#09d3ac', marginBottom: isHero ? 18 : 14,
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
                    fontSize: isHero ? 14 : 13, lineHeight: 1.55, color: '#d3d3d3',
                    fontFamily: "'Google Sans', sans-serif",
                    whiteSpace: 'pre-wrap' as const,
                  }}
                  dangerouslySetInnerHTML={{ __html: s.body }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
