import React, { useCallback, useRef } from 'react'
import { GoogleMap, Polygon, OverlayView, useJsApiLoader } from '@react-google-maps/api'
import ZoneMarker, { type MarkerState, type VMInfo } from './ZoneMarker'
import type { BackendId, LaneStatus } from '../types'
import { BACKENDS } from '../backends'
import { HUD_MAP_STYLES } from '../mapStyles'

// Geographic center of CONUS — used to position the multi-region bucket label over the polygon.
const US_BUCKET_LABEL_POSITION: google.maps.LatLngLiteral = { lat: 39.83, lng: -98.58 }

// Approximate CONUS outline — used to portray the "US multi-region" Cloud Storage bucket footprint.
// Google defines US multi-region as "data centers in the United States" without enumerating which,
// so the whole CONUS is the correct mental model.
const US_MULTIREGION_PATH: google.maps.LatLngLiteral[] = [
  { lat: 48.5, lng: -124.7 }, // NW Washington
  { lat: 49.0, lng: -123.0 },
  { lat: 49.0, lng:  -95.2 }, // northern border MN
  { lat: 48.1, lng:  -89.5 }, // upper Great Lakes
  { lat: 46.5, lng:  -84.5 }, // Sault Ste Marie
  { lat: 45.0, lng:  -82.5 },
  { lat: 42.3, lng:  -83.0 }, // Detroit
  { lat: 42.0, lng:  -79.0 }, // Niagara
  { lat: 45.0, lng:  -74.5 }, // northern NY
  { lat: 47.5, lng:  -69.0 }, // Maine north
  { lat: 44.8, lng:  -67.0 }, // Maine east
  { lat: 41.3, lng:  -71.0 }, // Rhode Island
  { lat: 39.0, lng:  -74.5 }, // NJ shore
  { lat: 36.9, lng:  -75.9 }, // Virginia Beach
  { lat: 35.0, lng:  -75.5 }, // Outer Banks
  { lat: 32.0, lng:  -80.8 }, // Charleston SC
  { lat: 27.7, lng:  -80.4 }, // Florida east
  { lat: 25.1, lng:  -80.3 }, // Miami
  { lat: 24.5, lng:  -81.8 }, // Key West
  { lat: 26.5, lng:  -82.0 }, // Florida west
  { lat: 30.0, lng:  -85.5 }, // Panama City
  { lat: 29.5, lng:  -89.0 }, // Louisiana
  { lat: 29.2, lng:  -94.5 }, // Galveston
  { lat: 26.0, lng:  -97.2 }, // Brownsville
  { lat: 28.5, lng: -100.5 },
  { lat: 31.0, lng: -104.5 }, // Big Bend
  { lat: 31.3, lng: -108.5 },
  { lat: 31.3, lng: -111.0 }, // AZ-MX border
  { lat: 32.5, lng: -114.8 }, // Yuma
  { lat: 32.5, lng: -117.1 }, // San Diego
  { lat: 34.5, lng: -120.5 }, // Santa Barbara
  { lat: 36.6, lng: -121.9 }, // Monterey
  { lat: 39.5, lng: -123.7 }, // Mendocino
  { lat: 43.0, lng: -124.4 }, // Oregon coast
  { lat: 47.0, lng: -124.7 }, // Olympic
]

const US_MULTIREGION_POLYGON_OPTIONS: google.maps.PolygonOptions = {
  paths: US_MULTIREGION_PATH,
  fillColor: '#09d3ac',
  fillOpacity: 0.12,
  strokeColor: '#09d3ac',
  strokeOpacity: 0.55,
  strokeWeight: 1.2,
  clickable: false,
  zIndex: 1,
}

const MAPS_API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || ''
// Optional: a Cloud-based Map ID enables Google's native data-driven styling for country boundaries.
// To set up: Cloud Console → Maps Studio → create Map ID (JavaScript) → enable the Administrative
// Area Level 0 (Country) feature layer on its map style → paste here as VITE_GOOGLE_MAPS_MAP_ID.
// When set, the US is highlighted via the native country geometry instead of the polygon fallback.
const MAP_ID = (import.meta as any).env?.VITE_GOOGLE_MAPS_MAP_ID || ''
// Google Maps PlaceID for the United States of America.
const USA_PLACE_ID = 'ChIJCzYy5IS16lQRQrfeQ5K5Oxw'

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
  { id: 'us-west1',    lat: 45.6015, lng: -121.1842, label: 'us-west1',    backends: ['af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] },
  { id: 'us-west2',    lat: 34.0537, lng: -118.2428, label: 'us-west2',    backends: [] },
  { id: 'us-west3',    lat: 40.7596, lng: -111.8868, label: 'us-west3',    backends: [] },
  { id: 'us-west4',    lat: 36.1674, lng: -115.1484, label: 'us-west4',    backends: [] },
  { id: 'us-west8',    lat: 33.4484, lng: -112.0741, label: 'us-west8',    backends: [] },
  { id: 'us-central1', lat: 41.2588, lng:  -95.8519, label: 'us-central1', backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu', 'af2-gpu', 'esmfold-gpu', 'boltz2-gpu'] },
  { id: 'us-south1',   lat: 32.7763, lng:  -96.7969, label: 'us-south1',   backends: [] },
  { id: 'us-east1',    lat: 33.1960, lng:  -80.0131, label: 'us-east1',    backends: [] },
  { id: 'us-east4',    lat: 39.0298, lng:  -77.4744, label: 'us-east4',    backends: [] },
  { id: 'us-east5',    lat: 39.9623, lng:  -83.0007, label: 'us-east5',    backends: ['af2-tpu', 'esmfold-tpu', 'boltz2-tpu'] },
  { id: 'us-east7',    lat: 35.2272, lng:  -80.8431, label: 'us-east7',    backends: [] },
]

interface InfraMapProps {
  lanes: Record<BackendId, LaneStatus>
  zoneStates: Record<string, MarkerState>
  vmStates: Record<string, { name: string, zone: string, state: string, href: string }>
  onZoneClick: (zone: ZoneInfo) => void
  center: google.maps.LatLngLiteral
  zoom: number
  highlightUS?: boolean
  showSpokes?: boolean
  showHalos?: boolean
}

// When MAP_ID is set, all styling lives in Cloud Maps Studio (linked to the Map ID's Dark mode slot)
// and `styles` is ignored. `colorScheme: 'DARK'` forces dark rendering regardless of system preference.
// When MAP_ID is empty, we fall back to the legacy inline `styles`.
const mapOptions: google.maps.MapOptions = {
  ...(MAP_ID
    ? { mapId: MAP_ID, colorScheme: 'DARK' as any }
    : { styles: HUD_MAP_STYLES as google.maps.MapTypeStyle[] }),
  disableDefaultUI: true,
  zoomControl: false,
  mapTypeControl: false,
  streetViewControl: false,
  fullscreenControl: false,
  backgroundColor: '#171717',
}

// Style applied to the USA country feature when highlightUS is true.
const US_FEATURE_STYLE: google.maps.FeatureStyleOptions = {
  fillColor: '#09d3ac',
  fillOpacity: 0.12,
  strokeColor: '#09d3ac',
  strokeOpacity: 0.55,
  strokeWeight: 1.2,
}

export default function InfraMap({ lanes, zoneStates, vmStates, onZoneClick, center, zoom, highlightUS, showSpokes, showHalos }: InfraMapProps) {
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

  // Reachability spokes — cyan dashed lines from the bucket label out to each US zone, with the
  // dashes pulsing in opacity. Visualizes the "reachable from every burst region" claim on catalog2.
  React.useEffect(() => {
    if (!showSpokes) return
    const map = activeMap === 'A' ? mapARef.current : mapBRef.current
    if (!map) return
    const g = (window as any).google?.maps
    if (!g) return

    const polylines = ZONE_LOCATIONS.map(zone =>
      new g.Polyline({
        path: [US_BUCKET_LABEL_POSITION, { lat: zone.lat, lng: zone.lng }],
        geodesic: true,
        strokeOpacity: 0,
        clickable: false,
        zIndex: 2,
        icons: [
          {
            icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.5, strokeColor: '#09d3ac', scale: 2 },
            offset: '0',
            repeat: '12px',
          },
        ],
        map,
      })
    )

    // Pulse the dash opacity with a sine wave so all spokes breathe in unison.
    let t = 0
    const interval = setInterval(() => {
      t += 0.08
      const opacity = 0.5 + 0.4 * Math.sin(t)
      polylines.forEach(p => {
        const icons = p.get('icons')
        icons[0].icon.strokeOpacity = opacity
        p.set('icons', icons)
      })
    }, 50)

    return () => {
      clearInterval(interval)
      polylines.forEach(p => p.setMap(null))
    }
  }, [showSpokes, activeMap])

  // Paint the US boundary via Google Maps' Data layer with a real country GeoJSON.
  // This works without any Map ID / FeatureLayer setup and gives a proper coastline outline.
  React.useEffect(() => {
    const US_GEOJSON_URL = 'https://cdn.jsdelivr.net/gh/glynnbird/countriesgeojson@master/united%20states%20of%20america.geojson'
    const DATA_STYLE: google.maps.Data.StyleOptions = {
      fillColor: '#09d3ac',
      fillOpacity: 0.12,
      strokeColor: '#09d3ac',
      strokeOpacity: 0.55,
      strokeWeight: 1.2,
      clickable: false,
      zIndex: 1,
    }
    const apply = async (m: google.maps.Map | null, label: string) => {
      if (!m) return
      try {
        // Clear any existing features (toggle on/off as user navigates)
        m.data.forEach(f => m.data.remove(f))
        if (!highlightUS) return
        m.data.setStyle(DATA_STYLE)
        m.data.loadGeoJson(US_GEOJSON_URL)
        console.log(`[InfraMap ${label}] US Data layer loaded`)
      } catch (e) {
        console.warn(`[InfraMap ${label}] Data layer load failed:`, e)
      }
    }
    apply(mapARef.current, 'A')
    apply(mapBRef.current, 'B')
  }, [highlightUS])

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
      {/* US country highlight now renders via the Data layer effect above (loads real GeoJSON).
          The hand-drawn polygon constant is kept as a code-only fallback for catastrophic CDN
          failure — uncomment to use. */}
      {/* {highlightUS && <Polygon options={US_MULTIREGION_POLYGON_OPTIONS} />} */}
      {highlightUS && (
        <OverlayView position={US_BUCKET_LABEL_POSITION} mapPaneName={OverlayView.FLOAT_PANE}>
          <div className="bucket-label">
            <div className="bucket-label-name">gs://nih-biowulf-cryoem</div>
            <div className="bucket-label-meta">US Multi-Region · Cloud Storage</div>
          </div>
        </OverlayView>
      )}
      <ZoneMarker
        key="biowulf-home"
        position={BIOWULF_HOME}
        label="BIOWULF"
        subtitle="biowulf-controller"
        subtitleHref="https://console.cloud.google.com/compute/instancesDetail/zones/us-east5-a/instances/biowulf-controller?project=wz-nih-demo-controller"
        state="done"
        onClick={() => {}}
      />
      {ZONE_LOCATIONS.map(zone => {
        const zoneVms: VMInfo[] = Object.values(vmStates)
          .filter(vm => vm.zone === zone.id)
          .map(vm => ({
            name: vm.name,
            href: vm.href,
            state: vm.state as MarkerState,
          }))
        return (
          <ZoneMarker
            key={zone.id}
            position={{ lat: zone.lat, lng: zone.lng }}
            label={zone.label}
            state={zoneStates[zone.id] || 'idle'}
            vms={zoneVms}
            onClick={() => onZoneClick(zone)}
            showHalo={showHalos}
          />
        )
      })}
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
