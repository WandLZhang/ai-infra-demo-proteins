import React from 'react'

type Variant = 'popover' | 'hero'

interface InfoButtonProps {
  title: string
  sections: { body: string }[]
  open: boolean
  onToggle: () => void
  variant?: Variant
}

// Hero = popover with different position + size only. Pure opacity fade —
// no scale, no slide. Hero's translate(-50%, -50%) is static (centers the
// box) and never animates.
const POPOVER_STYLE: React.CSSProperties = {
  position: 'fixed', top: 60, right: 16, zIndex: 30, width: '34vw',
  maxHeight: 'calc(100vh - 96px)',
  backdropFilter: 'blur(10px)',
  overflow: 'hidden',
}

const HERO_STYLE: React.CSSProperties = {
  position: 'fixed', top: '50%', left: '50%', zIndex: 30, width: '58vw',
  maxHeight: '82vh',
  backdropFilter: 'blur(10px)',
  transform: 'translate(-50%, -50%)',
  overflow: 'hidden',
}

export default function InfoButton({ title, sections, open, onToggle, variant = 'popover' }: InfoButtonProps) {
  const isHero = variant === 'hero'
  const baseStyle = isHero ? HERO_STYLE : POPOVER_STYLE

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
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' as const : 'none' as const,
        transition: 'opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        <div style={{ maxHeight: isHero ? '82vh' : 'calc(100vh - 96px)', overflowY: 'auto', padding: '20px 24px' }}>
          {/* key includes body identity so cross-dissolve fires even when title is shared
              across slides (e.g. all three models* slides share the same hero title). */}
          <div className="info-content-wrap" key={title + (sections[0]?.body.slice(0, 40) ?? '')}>
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
      </div>
    </>
  )
}
