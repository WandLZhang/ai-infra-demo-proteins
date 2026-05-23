import React from 'react'
import { OverlayView } from '@react-google-maps/api'

export type MarkerState = 'idle' | 'active' | 'done'

interface ZoneMarkerProps {
  position: google.maps.LatLngLiteral
  label: string
  subtitle?: string
  subtitleHref?: string
  state: MarkerState
  onClick?: () => void
}

export default function ZoneMarker({ position, label, subtitle, subtitleHref, state, onClick }: ZoneMarkerProps) {
  const stateClass = state === 'done' ? 'marker-done' : state === 'active' ? 'marker-active' : ''

  return (
    <OverlayView position={position} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
      <div className={`zone-marker-wrap ${stateClass}`} onClick={onClick}>
        <div className="marker-spinner-box">
          <div className="rotatingBoxes1" />
          <div className="rotatingBoxes2" />
          <div className="rotatingBoxes3" />
        </div>
        <div className="marker-text-box">
          <b>{label}</b>
          {subtitle && (
            subtitleHref
              ? <a href={subtitleHref} target="_blank" rel="noopener" style={{ display: 'block', fontSize: '0.75em', color: '#708090', textDecoration: 'none', marginTop: 1 }}>{subtitle}</a>
              : <span style={{ display: 'block', fontSize: '0.75em', color: '#708090', marginTop: 1 }}>{subtitle}</span>
          )}
        </div>
      </div>
    </OverlayView>
  )
}
