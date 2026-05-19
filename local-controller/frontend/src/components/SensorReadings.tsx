import React, { useRef, useEffect, useState } from 'react'
import { Thermometer, Wind, Gauge, Layers, ArrowUp, ArrowDown, ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react'
import type { SensorData } from '../types'

function useAnimatedValue(target: number, duration: number = 500): number {
  const [display, setDisplay] = useState(target)
  const animRef = useRef<{ start: number; from: number; to: number; raf: number | null }>({
    start: 0, from: target, to: target, raf: null,
  })

  useEffect(() => {
    const a = animRef.current
    if (a.to === target) return

    a.from = display
    a.to = target
    a.start = performance.now()

    if (a.raf) cancelAnimationFrame(a.raf)

    const step = (now: number) => {
      const elapsed = now - a.start
      const t = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(a.from + (a.to - a.from) * eased)
      if (t < 1) {
        a.raf = requestAnimationFrame(step)
      }
    }
    a.raf = requestAnimationFrame(step)

    return () => { if (a.raf) cancelAnimationFrame(a.raf) }
  }, [target, duration])

  return display
}

interface SensorRowProps {
  label: string
  value: number
  format: (v: number) => string
  unit: string
  icon: LucideIcon
}

function SensorRow({ label, value, format, unit, icon: Icon }: SensorRowProps) {
  const animated = useAnimatedValue(value)
  return (
    <div className="flex items-center justify-between py-3 border-b border-[#00ffcc]/10 group hover:bg-[#00ffcc]/5 transition-colors">
      <div className="flex items-center gap-3">
        <Icon size={14} className="text-[#00ffcc]/60" />
        <span className="font-sans text-xs uppercase tracking-widest text-white/60">{label}</span>
      </div>
      <div className="font-mono text-sm text-[#00ffcc]">
        {format(animated)} <span className="text-[#00ffcc]/50 text-xs">{unit}</span>
      </div>
    </div>
  )
}

interface SensorReadingsProps {
  data: SensorData
  solveTimeMs?: number
  computeDevice?: string
}

export default function SensorReadings({ data, solveTimeMs, computeDevice }: SensorReadingsProps) {
  const [collapsed, setCollapsed] = useState(true)

  return (
    <div className="bg-black/40 backdrop-blur-md border border-white/10 p-5 rounded-xl shadow-2xl">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between cursor-pointer group"
      >
        <h2 className="text-white font-sans text-sm font-semibold uppercase tracking-widest flex items-center gap-2">
          <Gauge size={16} className="text-[#00ffcc]" />
          Sensor Readings
        </h2>
        <div className="flex items-center gap-2">
          {solveTimeMs !== undefined && (
            <span className="text-white/30 text-[9px] font-mono uppercase tracking-wider">
              {solveTimeMs.toFixed(0)}ms · {computeDevice || 'cpu'}
            </span>
          )}
          {collapsed
            ? <ChevronDown size={14} className="text-white/40 group-hover:text-[#00ffcc]" />
            : <ChevronUp size={14} className="text-white/40 group-hover:text-[#00ffcc]" />}
        </div>
      </button>

      {!collapsed && (
        <div className="flex flex-col sensor-scroll mt-4">
          <SensorRow label="Lift Coefficient" value={data.liftCoeff} format={v => v.toFixed(4)} unit="CL" icon={ArrowUp} />
          <SensorRow label="Drag Coefficient" value={data.dragCoeff} format={v => v.toFixed(4)} unit="CD" icon={ArrowDown} />
          <SensorRow label="Dynamic Pressure" value={data.dynamicPressure} format={v => v.toFixed(1)} unit="kPa" icon={Wind} />
          <SensorRow label="Max Surface Temp" value={data.maxSurfaceTemp} format={v => Math.round(v).toString()} unit="C" icon={Thermometer} />
          <SensorRow label="Structural Load" value={data.structuralLoad} format={v => v.toFixed(2)} unit="G" icon={Layers} />
          <SensorRow label="Air Density" value={data.airDensity} format={v => v.toFixed(3)} unit="kg/m3" icon={Wind} />
        </div>
      )}
    </div>
  )
}
