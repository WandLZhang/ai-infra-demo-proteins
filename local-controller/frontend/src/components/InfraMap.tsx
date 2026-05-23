import React, { useCallback, useRef } from 'react'
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api'
import ZoneMarker, { type MarkerState } from './ZoneMarker'
import type { BackendId, LaneStatus } from '../types'
import { BACKENDS } from '../backends'
import { HUD_MAP_STYLES } from '../mapStyles'

const MAPS_API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || ''

export interface ZoneInfo {
  id: string
  lat: number
  lng: number
  label: string
  backends: BackendId[]
}

// NIH Building 12, 12 South Dr, Bethesda MD 20892 (CIT / Biowulf HPC) — geocoded via OSM Nominatim
export const BIOWULF_HOME = { lat: 38.9988, lng: -77.1020 }

export const ZONE_LOCATIONS: ZoneInfo[] = [
  { id: 'us-west1',    lat: 45.6015, lng: -121.1842, label: 'us-west1',    backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },
  { id: 'us-west2',    lat: 34.0537, lng: -118.2428, label: 'us-west2',    backends: [] },
  { id: 'us-west3',    lat: 40.7596, lng: -111.8868, label: 'us-west3',    backends: [] },
  { id: 'us-west4',    lat: 36.1674, lng: -115.1484, label: 'us-west4',    backends: [] },
  { id: 'us-west8',    lat: 33.4484, lng: -112.0741, label: 'us-west8',    backends: [] },
  { id: 'us-central1', lat: 41.2588, lng:  -95.8519, label: 'us-central1', backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu', 'af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] },
  { id: 'us-south1',   lat: 32.7763, lng:  -96.7969, label: 'us-south1',   backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },
  { id: 'us-east1',    lat: 33.1960, lng:  -80.0131, label: 'us-east1',    backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },
  { id: 'us-east4',    lat: 39.0298, lng:  -77.4744, label: 'us-east4',    backends: ['af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] },
  { id: 'us-east5',    lat: 39.9623, lng:  -83.0007, label: 'us-east5',    backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu', 'af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] },
  { id: 'us-east7',    lat: 35.2272, lng:  -80.8431, label: 'us-east7',    backends: [] },
]

interface InfraMapProps {
  lanes: Record<BackendId, LaneStatus>
  onZoneClick: (zone: ZoneInfo) => void
  center: google.maps.LatLngLiteral
  zoom: number
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

const mapOptions: google.maps.MapOptions = {
  styles: HUD_MAP_STYLES as google.maps.MapTypeStyle[],
  disableDefaultUI: true,
  zoomControl: false,
  mapTypeControl: false,
  streetViewControl: false,
  fullscreenControl: false,
  backgroundColor: '#171717',
}

export default function InfraMap({ lanes, onZoneClick, center, zoom }: InfraMapProps) {
  const { isLoaded } = useJsApiLoader({ googleMapsApiKey: MAPS_API_KEY })

  // Two map instances stacked, cross-fade between them.
  const mapARef = useRef<google.maps.Map | null>(null)
  const mapBRef = useRef<google.maps.Map | null>(null)
  const initialZoom = useRef(zoom).current
  const initialCenter = useRef(center).current

  const [activeMap, setActiveMap] = React.useState<'A' | 'B'>('A')
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const onLoadA = useCallback((m: google.maps.Map) => {
    mapARef.current = m
    m.setZoom(initialZoom)
    m.setCenter(initialCenter)
  }, [initialZoom, initialCenter])

  const onLoadB = useCallback((m: google.maps.Map) => {
    mapBRef.current = m
    m.setZoom(initialZoom)
    m.setCenter(initialCenter)
  }, [initialZoom, initialCenter])

  // Cross-fade + uniform zoom-out: back map starts at mid-zoom on Kansas,
  // then steps out 1 level at a time at equal intervals for smooth motion.
  React.useEffect(() => {
    timersRef.current.forEach(t => clearTimeout(t))
    timersRef.current = []

    const front = activeMap === 'A' ? mapARef.current : mapBRef.current
    const back = activeMap === 'A' ? mapBRef.current : mapARef.current
    if (!front || !back) return

    const frontZoom = front.getZoom() ?? zoom
    if (Math.abs(frontZoom - zoom) < 0.5) {
      front.panTo(center)
      return
    }

    // Start back map at mid-zoom (tiles preload while invisible)
    const startZoom = Math.round((frontZoom + zoom) / 2)
    back.setZoom(startZoom)
    back.setCenter(center)

    const preloadMs = 500
    const stepCount = startZoom - zoom
    const msPerStep = 50

    // Begin cross-fade after tile preload
    const fadeTimer = setTimeout(() => {
      setActiveMap(prev => prev === 'A' ? 'B' : 'A')
    }, preloadMs)
    timersRef.current.push(fadeTimer)

    // Step zoom 1 level at a time, each step exactly msPerStep apart
    for (let i = 1; i <= stepCount; i++) {
      const z = startZoom - i
      const timer = setTimeout(() => {
        if (back) {
          back.setZoom(z)
        }
      }, preloadMs + i * msPerStep)
      timersRef.current.push(timer)
    }

    return () => {
      timersRef.current.forEach(t => clearTimeout(t))
      timersRef.current = []
    }
  }, [center.lat, center.lng, zoom])

  if (!isLoaded) {
    return (
      <div style={{ width: '100vw', height: '100vh', background: '#171717', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#708090', fontFamily: 'Courier New, monospace', fontSize: 14 }}>Loading map...</div>
      </div>
    )
  }

  const markers = (
    <>
      <ZoneMarker
        key="biowulf-home"
        position={BIOWULF_HOME}
        label="BIOWULF"
        subtitle="biowulf-controller"
        subtitleHref="https://console.cloud.google.com/compute/instancesDetail/zones/us-east5-a/instances/biowulf-controller?project=wz-nih-demo-controller"
        state="done"
        onClick={() => {}}
      />
      {ZONE_LOCATIONS.map(zone => (
        <ZoneMarker
          key={zone.id}
          position={{ lat: zone.lat, lng: zone.lng }}
          label={zone.label}
          state={getZoneState(zone, lanes)}
          onClick={() => onZoneClick(zone)}
        />
      ))}
    </>
  )

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      {/* Map A */}
      <div style={{
        position: 'absolute', inset: 0,
        opacity: activeMap === 'A' ? 1 : 0,
        transition: 'opacity 0.8s ease-in-out',
        pointerEvents: activeMap === 'A' ? 'auto' as const : 'none' as const,
      }}>
        <GoogleMap
          mapContainerStyle={{ width: '100vw', height: '100vh' }}
          center={initialCenter}
          zoom={initialZoom}
          onLoad={onLoadA}
          options={mapOptions}
        >
          {activeMap === 'A' && markers}
        </GoogleMap>
      </div>

      {/* Map B */}
      <div style={{
        position: 'absolute', inset: 0,
        opacity: activeMap === 'B' ? 1 : 0,
        transition: 'opacity 0.8s ease-in-out',
        pointerEvents: activeMap === 'B' ? 'auto' as const : 'none' as const,
      }}>
        <GoogleMap
          mapContainerStyle={{ width: '100vw', height: '100vh' }}
          center={initialCenter}
          zoom={initialZoom}
          onLoad={onLoadB}
          options={mapOptions}
        >
          {activeMap === 'B' && markers}
        </GoogleMap>
      </div>
    </div>
  )
}
