import React from 'react'
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api'
import ZoneMarker, { type MarkerState } from './ZoneMarker'
import type { BackendId, LaneStatus } from '../types'
import { BACKENDS } from '../backends'

const MAPS_API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || ''

const MAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#1d2c4d' }] },
  { elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a3646' }] },
  { featureType: 'administrative' as const, elementType: 'geometry.stroke', stylers: [{ color: '#4b6878' }] },
  { featureType: 'administrative.country' as const, elementType: 'labels', stylers: [{ visibility: 'on' }] },
  { featureType: 'administrative.province' as const, elementType: 'geometry.stroke', stylers: [{ color: '#4b6878' }] },
  { featureType: 'landscape' as const, elementType: 'geometry', stylers: [{ color: '#171717' }] },
  { featureType: 'road' as const, elementType: 'geometry', stylers: [{ color: '#2c6675' }] },
  { featureType: 'road' as const, elementType: 'labels.text.fill', stylers: [{ color: '#98a5be' }] },
  { featureType: 'road' as const, elementType: 'labels.text.stroke', stylers: [{ color: '#1d2c4d' }] },
  { featureType: 'water' as const, elementType: 'geometry.fill', stylers: [{ color: '#283d6a' }] },
  { featureType: 'water' as const, elementType: 'geometry', stylers: [{ color: '#3a4762' }] },
  { featureType: 'poi' as const, stylers: [{ visibility: 'off' }] },
  { featureType: 'transit' as const, stylers: [{ visibility: 'off' }] },
]

export interface ZoneInfo {
  id: string
  lat: number
  lng: number
  label: string
  backends: BackendId[]
}

export const ZONE_LOCATIONS: ZoneInfo[] = [
  { id: 'us-west1-c', lat: 45.5945, lng: -122.1562, label: 'us-west1', backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },
  { id: 'us-east5', lat: 34.0071, lng: -84.1487, label: 'us-east5', backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu', 'af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] },
  { id: 'us-central1', lat: 41.2619, lng: -95.8608, label: 'us-central1', backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu', 'af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] },
  { id: 'us-east1', lat: 33.1960, lng: -80.0131, label: 'us-east1', backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },
]

interface InfraMapProps {
  lanes: Record<BackendId, LaneStatus>
  onZoneClick: (zone: ZoneInfo) => void
}

function getZoneState(zone: ZoneInfo, lanes: Record<BackendId, LaneStatus>): MarkerState {
  const anyDone = zone.backends.some(bid => lanes[bid]?.state === 'done')
  const anyActive = zone.backends.some(bid => {
    const s = lanes[bid]?.state
    return s && s !== 'idle' && s !== 'done' && s !== 'failed'
  })
  if (anyDone) return 'done'
  if (anyActive) return 'active'
  return 'idle'
}

export default function InfraMap({ lanes, onZoneClick }: InfraMapProps) {
  const { isLoaded } = useJsApiLoader({ googleMapsApiKey: MAPS_API_KEY })

  if (!isLoaded) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#171717', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#708090', fontFamily: 'Courier New, monospace', fontSize: 14 }}>Loading map...</div>
      </div>
    )
  }

  return (
    <GoogleMap
      mapContainerStyle={{ width: '100vw', height: '100vh' }}
      center={{ lat: 39.5, lng: -98.35 }}
      zoom={5}
      options={{
        styles: MAP_STYLES as google.maps.MapTypeStyle[],
        disableDefaultUI: true,
        zoomControl: false,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        backgroundColor: '#171717',
      }}
    >
      {ZONE_LOCATIONS.map(zone => (
        <ZoneMarker
          key={zone.id}
          position={{ lat: zone.lat, lng: zone.lng }}
          label={zone.label}
          state={getZoneState(zone, lanes)}
          onClick={() => onZoneClick(zone)}
        />
      ))}
    </GoogleMap>
  )
}
