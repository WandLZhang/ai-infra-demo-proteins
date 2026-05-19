import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  AdditiveBlending,
  Line,
} from 'three'
import { MAX_TRAIL_LENGTH } from '../hooks/useParticleStream'

interface StreamlineRendererProps {
  trails: Float32Array
  trailLengths: Int32Array
  writeHeads: Int32Array
  particleCount: number
  connected: boolean
}

export default function StreamlineRenderer({
  trails,
  trailLengths,
  writeHeads,
  particleCount,
  connected,
}: StreamlineRendererProps) {
  const linesRef = useRef<{ geometry: BufferGeometry; line: Line }[]>([])
  const groupRef = useRef<Group>(null)

  const material = useMemo(
    () =>
      new LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
        blending: AdditiveBlending,
        linewidth: 1,
      }),
    [],
  )

  // Create/recreate line objects when particle count changes
  const prevCountRef = useRef(0)
  if (particleCount !== prevCountRef.current && particleCount > 0) {
    prevCountRef.current = particleCount

    // Clean up old geometries
    linesRef.current.forEach(({ geometry }) => geometry.dispose())

    const newLines: { geometry: BufferGeometry; line: Line }[] = []
    for (let i = 0; i < particleCount; i++) {
      const geom = new BufferGeometry()
      const positions = new Float32Array(MAX_TRAIL_LENGTH * 3)
      const colors = new Float32Array(MAX_TRAIL_LENGTH * 3)

      geom.setAttribute('position', new Float32BufferAttribute(positions, 3))
      geom.setAttribute('color', new Float32BufferAttribute(colors, 3))
      geom.setDrawRange(0, 0)

      const line = new Line(geom, material)
      line.frustumCulled = false
      newLines.push({ geometry: geom, line })
    }
    linesRef.current = newLines
  }

  useFrame(() => {
    if (!connected || particleCount === 0) return

    const lines = linesRef.current
    if (lines.length !== particleCount) return

    for (let p = 0; p < particleCount; p++) {
      const trailLen = trailLengths[p]
      const { geometry } = lines[p]
      const posAttr = geometry.getAttribute('position') as Float32BufferAttribute
      const colorAttr = geometry.getAttribute('color') as Float32BufferAttribute

      if (trailLen < 2) {
        geometry.setDrawRange(0, 0)
        continue
      }

      // Copy trail points from ring buffer in oldest-to-newest order
      const baseIdx = p * MAX_TRAIL_LENGTH * 3
      const posArray = posAttr.array as Float32Array
      const writeHead = writeHeads[p]

      // If buffer hasn't wrapped, read 0..trailLen-1
      // If wrapped, read from (writeHead % MAX_TRAIL_LENGTH) onward
      const start = trailLen < MAX_TRAIL_LENGTH ? 0 : (writeHead % MAX_TRAIL_LENGTH)

      for (let i = 0; i < trailLen; i++) {
        const ringIdx = (start + i) % MAX_TRAIL_LENGTH
        const srcIdx = baseIdx + ringIdx * 3
        const dstIdx = i * 3
        posArray[dstIdx] = trails[srcIdx]
        posArray[dstIdx + 1] = trails[srcIdx + 1]
        posArray[dstIdx + 2] = trails[srcIdx + 2]
      }
      posAttr.needsUpdate = true

      // Compute colors from point spacing (velocity proxy)
      const colorArray = colorAttr.array as Float32Array
      let maxSpacing = 0
      const spacings = new Float32Array(trailLen)

      for (let i = 1; i < trailLen; i++) {
        const di = i * 3
        const pi = (i - 1) * 3
        const dx = posArray[di] - posArray[pi]
        const dy = posArray[di + 1] - posArray[pi + 1]
        const dz = posArray[di + 2] - posArray[pi + 2]
        spacings[i] = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (spacings[i] > maxSpacing) maxSpacing = spacings[i]
      }
      spacings[0] = spacings[1] || 0

      for (let i = 0; i < trailLen; i++) {
        const t = maxSpacing > 0 ? spacings[i] / maxSpacing : 0.5
        const ci = i * 3
        if (t < 0.25) {
          colorArray[ci] = 0
          colorArray[ci + 1] = t * 4
          colorArray[ci + 2] = 1
        } else if (t < 0.5) {
          colorArray[ci] = 0
          colorArray[ci + 1] = 1
          colorArray[ci + 2] = 1 - (t - 0.25) * 4
        } else if (t < 0.75) {
          colorArray[ci] = (t - 0.5) * 4
          colorArray[ci + 1] = 1
          colorArray[ci + 2] = 0
        } else {
          colorArray[ci] = 1
          colorArray[ci + 1] = 1 - (t - 0.75) * 4
          colorArray[ci + 2] = 0
        }
      }
      colorAttr.needsUpdate = true

      geometry.setDrawRange(0, trailLen)
    }
  })

  if (particleCount === 0 || !connected) return null

  return (
    <group ref={groupRef}>
      {linesRef.current.map(({ line }, i) => (
        <primitive key={i} object={line} />
      ))}
    </group>
  )
}
