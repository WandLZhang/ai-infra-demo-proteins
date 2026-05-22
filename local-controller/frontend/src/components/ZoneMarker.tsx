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
      <div className={`zone-marker-wrap ${stateClass}`} onClick={onClick}>
        <div className="marker-spinner-box">
          <div className="rotatingBoxes1" />
          <div className="rotatingBoxes2" />
          <div className="rotatingBoxes3" />
        </div>
        <div className="marker-text-box">
          <b>{label}</b>
        </div>
      </div>
    </OverlayView>
  )
}
