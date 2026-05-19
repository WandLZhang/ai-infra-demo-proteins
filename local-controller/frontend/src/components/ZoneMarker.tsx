import React from 'react'
import { OverlayView } from '@react-google-maps/api'

export type MarkerState = 'idle' | 'active' | 'done'

interface ZoneMarkerProps {
  position: google.maps.LatLngLiteral
  label: string
  state: MarkerState
  onClick?: () => void
}

export default function ZoneMarker({ position, label, state, onClick }: ZoneMarkerProps) {
  const stateClass = state === 'done' ? 'marker-done' : state === 'active' ? 'marker-active' : ''

  return (
    <OverlayView position={position} mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}>
      <div className={`marker-outer ${stateClass}`} onClick={onClick} style={{ cursor: 'pointer' }}>
        <div className="rotatingBoxes1" />
        <div className="rotatingBoxes2" />
        <div className="rotatingBoxes3" />
        <div className="marker-label">{label}</div>
      </div>
    </OverlayView>
  )
}
