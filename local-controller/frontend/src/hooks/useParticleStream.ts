import { useRef, useEffect, useCallback, useState } from 'react'

const MSG_POSITIONS = 0x01
const MSG_RESPAWN = 0x02
const MAX_TRAIL_LENGTH = 40
const STEPS_PER_TICK = 5
const RECONNECT_DELAY = 1000
const MAX_RETRIES = 3

export interface ParticleStreamState {
  trails: Float32Array
  trailLengths: Int32Array
  writeHeads: Int32Array
  particleCount: number
  connected: boolean
}

interface SimParams {
  mach: number
  alpha: number
  beta: number
  particleCount: number
}

export function useParticleStream(
  active: boolean,
  simParams: SimParams | null,
): ParticleStreamState {
  const wsRef = useRef<WebSocket | null>(null)
  const retriesRef = useRef(0)
  const closingRef = useRef(false) // suppress reconnect during intentional close

  // Trails data lives in refs — mutated in-place, read by useFrame (no re-render needed)
  const trailsRef = useRef<Float32Array>(new Float32Array(0))
  const trailLengthsRef = useRef<Int32Array>(new Int32Array(0))

  // These trigger re-renders so StreamlineRenderer mounts/unmounts correctly
  const [connected, setConnected] = useState(false)
  const [pCount, setPCount] = useState(0)

  // Ring buffer write heads per particle
  const writeHeadsRef = useRef<Int32Array>(new Int32Array(0))

  // Keep latest simParams in a ref so the WS callbacks always see current values
  const simParamsRef = useRef(simParams)
  simParamsRef.current = simParams

  const initBuffers = useCallback((count: number) => {
    trailsRef.current = new Float32Array(count * MAX_TRAIL_LENGTH * 3)
    trailLengthsRef.current = new Int32Array(count)
    writeHeadsRef.current = new Int32Array(count)
    setPCount(count)
  }, [])

  const sendStart = useCallback((params: SimParams) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const count = Math.min(Math.max(params.particleCount, 4), 200)
    ws.send(JSON.stringify({
      type: 'start',
      mach: params.mach,
      alpha: params.alpha,
      beta: params.beta,
      particle_count: count,
    }))
  }, [])

  // Open WebSocket — does NOT depend on simParams
  const connect = useCallback(() => {
    if (!active) return

    closingRef.current = false
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}/api/particles/stream`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      retriesRef.current = 0
      setConnected(true)

      // Send start with whatever the current params are
      const params = simParamsRef.current
      if (params) sendStart(params)
    }

    ws.onmessage = (event) => {
      // Handle JSON messages (started, error)
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'started' && msg.particle_count) {
            initBuffers(msg.particle_count)
          }
        } catch { /* ignore parse errors */ }
        return
      }

      if (!(event.data instanceof ArrayBuffer)) return

      const view = new DataView(event.data)
      const msgType = view.getUint32(0, true)
      const trails = trailsRef.current
      const trailLengths = trailLengthsRef.current
      const P = trailLengths.length

      if (msgType === MSG_POSITIONS && P > 0) {
        const floats = new Float32Array(event.data, 4)
        const totalPoints = floats.length / 3
        const steps = Math.floor(totalPoints / P)

        for (let s = 0; s < steps; s++) {
          for (let p = 0; p < P; p++) {
            const srcIdx = (s * P + p) * 3
            const writeHead = writeHeadsRef.current[p]
            const dstIdx = (p * MAX_TRAIL_LENGTH + (writeHead % MAX_TRAIL_LENGTH)) * 3

            trails[dstIdx] = floats[srcIdx]
            trails[dstIdx + 1] = floats[srcIdx + 1]
            trails[dstIdx + 2] = floats[srcIdx + 2]

            writeHeadsRef.current[p] = writeHead + 1
            if (trailLengths[p] < MAX_TRAIL_LENGTH) {
              trailLengths[p]++
            }
          }
        }
      } else if (msgType === MSG_RESPAWN) {
        const indices = new Uint16Array(event.data, 4)
        for (let i = 0; i < indices.length; i++) {
          const p = indices[i]
          if (p < P) {
            trailLengths[p] = 0
            writeHeadsRef.current[p] = 0
          }
        }
      }
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null

      // Only auto-reconnect on unexpected disconnects
      if (!closingRef.current && active && retriesRef.current < MAX_RETRIES) {
        retriesRef.current++
        setTimeout(connect, RECONNECT_DELAY)
      }
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [active, initBuffers, sendStart])

  // Connect once when active, disconnect when inactive
  useEffect(() => {
    if (active && simParams) {
      connect()
    }

    return () => {
      closingRef.current = true
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      setConnected(false)
    }
  }, [active, connect])

  // When simParams change, send new start on the existing connection
  const prevParamsRef = useRef(simParams)
  useEffect(() => {
    if (
      simParams &&
      prevParamsRef.current !== simParams &&
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      sendStart(simParams)
    }
    prevParamsRef.current = simParams
  }, [simParams, sendStart])

  return {
    trails: trailsRef.current,
    trailLengths: trailLengthsRef.current,
    writeHeads: writeHeadsRef.current,
    particleCount: pCount,
    connected,
  }
}

export { MAX_TRAIL_LENGTH }
