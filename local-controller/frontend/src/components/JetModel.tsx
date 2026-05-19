import React, { useRef, useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { ShaderMaterial, DoubleSide, Float32BufferAttribute, Vector3, Matrix4 } from 'three'
import type { Mesh, BufferGeometry } from 'three'
import type { VisualizationMode } from '../types'

const MODEL_URL = 'https://raw.githubusercontent.com/LinirZamir/F22_GLTF-3d-file/master/f22_raptor/scene.gltf'

interface JetModelProps {
  mode: VisualizationMode
  speed: number
  mach: number
  solverCentroids?: number[] | null  // flat [cx,cy,cz, ...] from solver mesh
  cpValues?: number[] | null         // one per solver face
  cpRange?: [number, number]
}

/**
 * Interpolates solver Cp data onto GLTF display mesh vertices
 * using nearest-centroid spatial lookup.
 */
function interpolateCpToVertices(
  geometry: BufferGeometry,
  solverCentroids: number[],
  cpValues: number[],
): Float32Array {
  const positions = geometry.attributes.position
  const vertexCount = positions.count
  const cpAttr = new Float32Array(vertexCount)
  const nCentroids = cpValues.length

  // Build centroid array for fast lookup
  const cx = new Float64Array(nCentroids)
  const cy = new Float64Array(nCentroids)
  const cz = new Float64Array(nCentroids)
  for (let i = 0; i < nCentroids; i++) {
    cx[i] = solverCentroids[i * 3]
    cy[i] = solverCentroids[i * 3 + 1]
    cz[i] = solverCentroids[i * 3 + 2]
  }

  // For each vertex, find nearest solver centroid
  for (let v = 0; v < vertexCount; v++) {
    const vx = positions.getX(v)
    const vy = positions.getY(v)
    const vz = positions.getZ(v)

    let bestDist = Infinity
    let bestIdx = 0

    for (let c = 0; c < nCentroids; c++) {
      const dx = vx - cx[c]
      const dy = vy - cy[c]
      const dz = vz - cz[c]
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < bestDist) {
        bestDist = d2
        bestIdx = c
      }
    }

    cpAttr[v] = cpValues[bestIdx]
  }

  return cpAttr
}

export default function JetModel({ mode, speed, mach, solverCentroids, cpValues, cpRange }: JetModelProps) {
  const { scene } = useGLTF(MODEL_URL)

  const hasCpData = !!(solverCentroids && cpValues && cpValues.length > 0 && solverCentroids.length > 0)
  const cpMin = cpRange?.[0] ?? -1.5
  const cpMax = cpRange?.[1] ?? 1.0
  const blendRef = useRef(1.0)
  const hasExistingCp = useRef(false)

  const surfaceMaterial = useMemo(() => new ShaderMaterial({
    uniforms: {
      uMode: { value: 0 },
      uHasCpData: { value: 0 },
      uTime: { value: 0 },
      uCpMin: { value: -1.5 },
      uCpMax: { value: 1.0 },
      uMach: { value: 0.5 },
      uBlend: { value: 1.0 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying float vCp;
      varying float vCpPrev;
      attribute float aCp;
      attribute float aCpPrev;

      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vCp = aCp;
        vCpPrev = aCpPrev;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform int uMode;
      uniform int uHasCpData;
      uniform float uTime;
      uniform float uCpMin;
      uniform float uCpMax;
      uniform float uMach;
      uniform float uBlend;

      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      varying float vCp;
      varying float vCpPrev;

      float normCp() {
        float range = uCpMax - uCpMin;
        if (range < 0.01) range = 1.0;
        return clamp((vCp - uCpMin) / range, 0.0, 1.0);
      }

      // Pressure: blue (suction) -> cyan -> green -> yellow -> red (stagnation)
      vec3 getCpColor(float t) {
        vec3 c1 = vec3(0.0, 0.0, 1.0);
        vec3 c2 = vec3(0.0, 1.0, 1.0);
        vec3 c3 = vec3(0.0, 1.0, 0.0);
        vec3 c4 = vec3(1.0, 1.0, 0.0);
        vec3 c5 = vec3(1.0, 0.0, 0.0);
        if (t < 0.25) return mix(c1, c2, t * 4.0);
        if (t < 0.50) return mix(c2, c3, (t - 0.25) * 4.0);
        if (t < 0.75) return mix(c3, c4, (t - 0.50) * 4.0);
        return mix(c4, c5, (t - 0.75) * 4.0);
      }

      // Thermal: dark blue (cold) -> cyan -> yellow -> red (hot)
      vec3 getThermalColor(float t) {
        vec3 c1 = vec3(0.0, 0.1, 0.4);
        vec3 c2 = vec3(0.0, 0.8, 1.0);
        vec3 c3 = vec3(1.0, 0.8, 0.0);
        vec3 c4 = vec3(1.0, 0.1, 0.0);
        if (t < 0.33) return mix(c1, c2, t * 3.0);
        if (t < 0.66) return mix(c2, c3, (t - 0.33) * 3.0);
        return mix(c3, c4, (t - 0.66) * 3.0);
      }

      // Stress: dark -> green -> red
      vec3 getStressColor(float t) {
        vec3 c1 = vec3(0.05, 0.05, 0.1);
        vec3 c2 = vec3(0.0, 1.0, 0.5);
        vec3 c3 = vec3(1.0, 0.0, 0.2);
        if (t < 0.5) return mix(c1, c2, t * 2.0);
        return mix(c2, c3, (t - 0.5) * 2.0);
      }

      vec3 getNoDataColor() {
        float gridX = mod(vWorldPosition.x * 8.0, 1.0);
        float gridZ = mod(vWorldPosition.z * 8.0, 1.0);
        float gridY = mod(vWorldPosition.y * 8.0, 1.0);
        float grid = (gridX < 0.06 || gridZ < 0.06 || gridY < 0.06) ? 0.4 : 0.08;
        return vec3(0.0, grid * 0.8, grid);
      }

      void main() {
        vec3 color;
        float cp = mix(vCpPrev, vCp, uBlend);

        if (uHasCpData == 0) {
          color = getNoDataColor();
        } else if (uMode == 0) {
          // Adiabatic recovery temperature ratio T_local/T_inf = 1 + (gamma-1)/2 * M^2 * Cp
          // (gamma=1.4 → factor 0.2). Stagnation (Cp=+1) is HOT (RED);
          // suction peaks (Cp<<0) cool adiabatically (DARK BLUE).
          float tempRatio = 1.0 + 0.2 * uMach * uMach * cp;
          float maxRatio = 1.0 + 0.2 * uMach * uMach * uCpMax;
          float minRatio = 1.0 + 0.2 * uMach * uMach * uCpMin;
          float t = clamp((tempRatio - minRatio) / max(maxRatio - minRatio, 0.001), 0.0, 1.0);
          color = getThermalColor(t);
        } else if (uMode == 1) {
          float qNorm = uMach * uMach / (0.85 * 0.85);
          float load = abs(cp) * qNorm;
          float t = clamp(load / 2.0, 0.0, 1.0);
          color = getStressColor(t);
        } else {
          color = getCpColor(normCp());
        }

        vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
        float diff = max(dot(vNormal, lightDir), 0.0) * 0.3 + 0.7;
        float fresnel = pow(1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
        gl_FragColor = vec4(color * diff + vec3(0.08 * fresnel), 0.95);
      }
    `,
    transparent: true,
    side: DoubleSide,
  }), [])

  // Map solver Cp data onto display mesh via nearest-centroid interpolation
  useEffect(() => {
    if (!scene) return

    const primInverse = new Matrix4().makeRotationY(Math.PI / 2)

    // Pass A: solver centroid bbox (target frame for the affine)
    let sxMin = Infinity, sxMax = -Infinity
    let syMin = Infinity, syMax = -Infinity
    let szMin = Infinity, szMax = -Infinity
    if (hasCpData && solverCentroids && cpValues) {
      const n = cpValues.length
      for (let i = 0; i < n; i++) {
        const x = solverCentroids[i * 3]
        const y = solverCentroids[i * 3 + 1]
        const z = solverCentroids[i * 3 + 2]
        if (x < sxMin) sxMin = x; if (x > sxMax) sxMax = x
        if (y < syMin) syMin = y; if (y > syMax) syMax = y
        if (z < szMin) szMin = z; if (z > szMax) szMax = z
      }
    }

    // Pass B: display bbox in solver-aligned frame
    // (display GLTF is ~unit scale, solver mesh is ~10s of meters — without
    //  this alignment all display verts would snap to centroids near solver
    //  origin and the model would render a single color.)
    let dxMin = Infinity, dxMax = -Infinity
    let dyMin = Infinity, dyMax = -Infinity
    let dzMin = Infinity, dzMax = -Infinity
    if (hasCpData && mode !== 'visual') {
      const tmp = new Vector3()
      scene.traverse((child) => {
        if (!(child as Mesh).isMesh) return
        const m = child as Mesh
        m.updateWorldMatrix(true, false)
        const m2s = primInverse.clone().multiply(m.matrixWorld)
        const pos = (m.geometry as BufferGeometry).attributes.position
        for (let vi = 0; vi < pos.count; vi++) {
          tmp.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(m2s)
          if (tmp.x < dxMin) dxMin = tmp.x; if (tmp.x > dxMax) dxMax = tmp.x
          if (tmp.y < dyMin) dyMin = tmp.y; if (tmp.y > dyMax) dyMax = tmp.y
          if (tmp.z < dzMin) dzMin = tmp.z; if (tmp.z > dzMax) dzMax = tmp.z
        }
      })
    }

    // Per-axis affine: display_bbox -> solver_bbox
    const dxSpan = Math.max(dxMax - dxMin, 1e-6)
    const dySpan = Math.max(dyMax - dyMin, 1e-6)
    const dzSpan = Math.max(dzMax - dzMin, 1e-6)
    const aXs = (sxMax - sxMin) / dxSpan
    const aYs = (syMax - syMin) / dySpan
    const aZs = (szMax - szMin) / dzSpan
    const aXo = (sxMin + sxMax) / 2 - aXs * (dxMin + dxMax) / 2
    const aYo = (syMin + syMax) / 2 - aYs * (dyMin + dyMax) / 2
    const aZo = (szMin + szMax) / 2 - aZs * (dzMin + dzMax) / 2

    scene.traverse((child) => {
      if ((child as Mesh).isMesh) {
        const mesh = child as Mesh
        const geom = mesh.geometry as BufferGeometry

        if (!mesh.userData.originalMaterial) {
          mesh.userData.originalMaterial = mesh.material
        }

        if (mode === 'visual') {
          mesh.material = mesh.userData.originalMaterial
        } else {
          mesh.material = surfaceMaterial

          const vertexCount = geom.attributes.position.count
          if (hasCpData) {
            mesh.updateWorldMatrix(true, false)
            const meshToSolver = primInverse.clone().multiply(mesh.matrixWorld)

            const pos = geom.attributes.position
            const cpAttr = new Float32Array(vertexCount)
            const nCentroids = cpValues!.length
            const v = new Vector3()

            for (let vi = 0; vi < vertexCount; vi++) {
              v.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi))
              v.applyMatrix4(meshToSolver)

              const qx = v.x * aXs + aXo
              const qy = v.y * aYs + aYo
              const qz = v.z * aZs + aZo

              let bestDist = Infinity
              let bestIdx = 0
              for (let c = 0; c < nCentroids; c++) {
                const dx = qx - solverCentroids![c * 3]
                const dy = qy - solverCentroids![c * 3 + 1]
                const dz = qz - solverCentroids![c * 3 + 2]
                const d2 = dx * dx + dy * dy + dz * dz
                if (d2 < bestDist) {
                  bestDist = d2
                  bestIdx = c
                }
              }
              cpAttr[vi] = cpValues![bestIdx]
            }

            const existingCp = geom.attributes.aCp
            if (existingCp && hasExistingCp.current) {
              geom.setAttribute('aCpPrev', new Float32BufferAttribute(
                new Float32Array(existingCp.array as Float32Array), 1
              ))
              blendRef.current = 0.0
            } else {
              geom.setAttribute('aCpPrev', new Float32BufferAttribute(new Float32Array(cpAttr), 1))
              blendRef.current = 1.0
            }

            geom.setAttribute('aCp', new Float32BufferAttribute(cpAttr, 1))
          } else {
            geom.setAttribute('aCp', new Float32BufferAttribute(new Float32Array(vertexCount), 1))
            geom.setAttribute('aCpPrev', new Float32BufferAttribute(new Float32Array(vertexCount), 1))
          }
        }
      }
    })
  }, [scene, mode, solverCentroids, cpValues, hasCpData, surfaceMaterial])

  useEffect(() => {
    if (hasCpData) hasExistingCp.current = true
  }, [cpValues])

  useFrame((state, delta) => {
    surfaceMaterial.uniforms.uTime.value = state.clock.elapsedTime
    surfaceMaterial.uniforms.uHasCpData.value = hasCpData ? 1 : 0
    surfaceMaterial.uniforms.uMode.value = mode === 'thermal' ? 0 : mode === 'stress' ? 1 : 2
    surfaceMaterial.uniforms.uCpMin.value = cpMin
    surfaceMaterial.uniforms.uCpMax.value = cpMax
    surfaceMaterial.uniforms.uMach.value = mach

    // Animate blend from 0 -> 1 over ~400ms
    if (blendRef.current < 1.0) {
      blendRef.current = Math.min(1.0, blendRef.current + delta / 0.4)
    }
    surfaceMaterial.uniforms.uBlend.value = blendRef.current
  })

  return (
    <primitive object={scene} rotation={[0, -Math.PI / 2, 0]} />
  )
}
