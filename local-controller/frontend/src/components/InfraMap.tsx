import React from 'react'
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api'
import ZoneMarker, { type MarkerState } from './ZoneMarker'
import type { BackendId, LaneStatus } from '../types'
import { BACKENDS } from '../backends'

const MAPS_API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || ''

import { HUD_MAP_STYLES } from '../mapStyles'

export interface ZoneInfo {
  id: string
  lat: number
  lng: number
  label: string
  backends: BackendId[]
}

export const ZONE_LOCATIONS: ZoneInfo[] = [
  // All CONUS GCP regions — exact coordinates from hud.jamalmahboob.com + Google data
  { id: 'us-west1',    lat: 45.6095, lng: -121.1914, label: 'us-west1',    backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },          // The Dalles, Oregon
  { id: 'us-west2',    lat: 34.0207, lng: -118.5518, label: 'us-west2',    backends: [] },                                                 // Los Angeles, California
  { id: 'us-west3',    lat: 40.7608, lng: -111.8910, label: 'us-west3',    backends: [] },                                                 // Salt Lake City, Utah
  { id: 'us-west4',    lat: 36.1699, lng: -115.1398, label: 'us-west4',    backends: [] },                                                 // Las Vegas, Nevada
  { id: 'us-west8',    lat: 33.4484, lng: -112.0740, label: 'us-west8',    backends: [] },                                                 // Phoenix, Arizona
  { id: 'us-central1', lat: 41.2328, lng:  -95.8817, label: 'us-central1', backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu', 'af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] }, // Council Bluffs, Iowa
  { id: 'us-south1',   lat: 32.8203, lng:  -97.0430, label: 'us-south1',   backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },          // Dallas, Texas
  { id: 'us-east1',    lat: 33.1974, lng:  -80.0100, label: 'us-east1',    backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },          // Moncks Corner, South Carolina
  { id: 'us-east4',    lat: 39.0300, lng:  -77.5121, label: 'us-east4',    backends: ['af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] },           // Ashburn, Northern Virginia
  { id: 'us-east5',    lat: 39.9829, lng:  -83.0734, label: 'us-east5',    backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu', 'af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] }, // Columbus, Ohio
  { id: 'us-east7',    lat: 35.2271, lng:  -80.8431, label: 'us-east7',    backends: [] },                                                 // Charlotte, North Carolina
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
        styles: HUD_MAP_STYLES as google.maps.MapTypeStyle[],
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
