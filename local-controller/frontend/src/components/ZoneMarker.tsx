import React from 'react'
import { OverlayView } from '@react-google-maps/api'

export type MarkerState = 'idle' | 'provisioning' | 'failed' | 'active' | 'done'

export interface VMInfo {
  name: string
  href: string
  state: MarkerState
}

interface ZoneMarkerProps {
  position: google.maps.LatLngLiteral
  label: string
  subtitle?: string
  subtitleHref?: string
  state: MarkerState
  vms?: VMInfo[]
  onClick?: () => void
}

const VM_STATE_COLORS: Record<MarkerState, string> = {
  idle: '#708090',
  provisioning: '#eab308',
  failed: '#ef4444',
  active: '#09d3ac',
  done: '#09d3ac',
}

export default function ZoneMarker({ position, label, subtitle, subtitleHref, state, vms, onClick }: ZoneMarkerProps) {
  const stateClass = state === 'done' ? 'marker-done' : state === 'active' ? 'marker-active' : state === 'provisioning' ? 'marker-provisioning' : state === 'failed' ? 'marker-failed' : ''

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
          {subtitle && !vms?.length && (
            subtitleHref
              ? <a href={subtitleHref} target="_blank" rel="noopener" style={{ display: 'block', fontSize: '0.75em', color: '#708090', textDecoration: 'none', marginTop: 1 }}>{subtitle}</a>
              : <span style={{ display: 'block', fontSize: '0.75em', color: '#708090', marginTop: 1 }}>{subtitle}</span>
          )}
          {vms && vms.length > 0 && vms.map(vm => (
            vm.href ? (
              <a
                key={vm.name}
                href={vm.href}
                target="_blank"
                rel="noopener"
                style={{
                  display: 'block',
                  fontSize: '0.7em',
                  color: VM_STATE_COLORS[vm.state],
                  textDecoration: 'none',
                  marginTop: 1,
                }}
              >
                {vm.name}
              </a>
            ) : (
              <span
                key={vm.name}
                style={{
                  display: 'block',
                  fontSize: '0.7em',
                  color: VM_STATE_COLORS[vm.state],
                  marginTop: 1,
                }}
              >
                {vm.name}
              </span>
            )
          ))}
        </div>
      </div>
    </OverlayView>
  )
}
