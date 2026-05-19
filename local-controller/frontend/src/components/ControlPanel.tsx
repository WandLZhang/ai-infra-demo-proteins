import React from 'react'
import { Settings2, Zap, Compass, Cpu, Play, History } from 'lucide-react'
import type { VisualizationMode, WindParams, ResultSummary } from '../types'

interface ControlPanelProps {
  wind: WindParams
  onWindChange: (wind: WindParams) => void
  particleDensity: number
  onParticleDensityChange: (v: number) => void
  meshResolution: number
  onMeshResolutionChange: (v: number) => void
  mode: VisualizationMode
  onModeChange: (m: VisualizationMode) => void
  simulating: boolean
  onSimulate: () => void
  results: ResultSummary[]
  onLoadResult: (resultId: string) => void
  loadingResult: boolean
}

export default function ControlPanel({
  wind, onWindChange,
  particleDensity, onParticleDensityChange,
  meshResolution, onMeshResolutionChange,
  mode, onModeChange,
  simulating, onSimulate,
  results, onLoadResult, loadingResult,
}: ControlPanelProps) {
  const particleCount = Math.floor(Math.pow(10, 2 + (particleDensity / 100) * 2.5))

  return (
    <div className="w-80 pointer-events-auto flex flex-col gap-4 hud-scroll">
      {/* Flight Parameters */}
      <div className="bg-black/40 backdrop-blur-md border border-white/10 p-6 rounded-xl shadow-2xl">
        <h2 className="text-white font-sans text-sm font-semibold uppercase tracking-widest mb-6 flex items-center gap-2">
          <Settings2 size={16} className="text-[#00ffcc]" />
          Flight Parameters
        </h2>
        <div className="space-y-6">
          {/* Airspeed */}
          <div>
            <div className="flex justify-between text-xs font-mono mb-2">
              <span className="text-white/60 uppercase">Airspeed (Mach)</span>
              <span className="text-[#00ffcc]">{wind.speed.toFixed(2)} M</span>
            </div>
            <input
              type="range" min="0.05" max="0.85" step="0.01"
              value={wind.speed}
              onChange={e => onWindChange({ ...wind, speed: parseFloat(e.target.value) })}
              className="w-full accent-[#00ffcc] h-1 bg-white/10 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#00ffcc] [&::-webkit-slider-thumb]:rounded-full cursor-pointer"
            />
          </div>

          {/* Angle of Attack */}
          <div>
            <div className="flex justify-between text-xs font-mono mb-2">
              <span className="text-white/60 uppercase">Angle of Attack (α)</span>
              <span className="text-[#00ffcc]">{wind.alpha.toFixed(1)}°</span>
            </div>
            <input
              type="range" min="-20" max="20" step="0.5"
              value={wind.alpha}
              onChange={e => onWindChange({ ...wind, alpha: parseFloat(e.target.value) })}
              className="w-full accent-[#00ffcc] h-1 bg-white/10 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#00ffcc] [&::-webkit-slider-thumb]:rounded-full cursor-pointer"
            />
          </div>

          {/* Sideslip / Yaw */}
          <div>
            <div className="flex justify-between text-xs font-mono mb-2">
              <span className="text-white/60 uppercase">Sideslip (β)</span>
              <span className="text-[#00ffcc]">{wind.beta.toFixed(1)}°</span>
            </div>
            <input
              type="range" min="-20" max="20" step="0.5"
              value={wind.beta}
              onChange={e => onWindChange({ ...wind, beta: parseFloat(e.target.value) })}
              className="w-full accent-[#00ffcc] h-1 bg-white/10 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#00ffcc] [&::-webkit-slider-thumb]:rounded-full cursor-pointer"
            />
          </div>

          {/* Wind Direction Compass */}
          <div className="pt-4 border-t border-white/10">
            <div className="flex items-center gap-2 mb-3">
              <Compass size={12} className="text-[#00ffcc]/60" />
              <span className="text-white/60 text-xs font-mono uppercase">Wind Vector</span>
            </div>
            <div className="flex items-center justify-center">
              <svg width="100" height="100" viewBox="-50 -50 100 100" className="opacity-70">
                {/* Compass circle */}
                <circle cx="0" cy="0" r="45" fill="none" stroke="rgba(0,255,204,0.2)" strokeWidth="1" />
                <circle cx="0" cy="0" r="30" fill="none" stroke="rgba(0,255,204,0.1)" strokeWidth="0.5" />
                {/* Cardinal directions */}
                <text x="0" y="-38" textAnchor="middle" fill="rgba(0,255,204,0.5)" fontSize="6" fontFamily="monospace">N</text>
                <text x="38" y="2" textAnchor="middle" fill="rgba(0,255,204,0.5)" fontSize="6" fontFamily="monospace">E</text>
                <text x="0" y="42" textAnchor="middle" fill="rgba(0,255,204,0.5)" fontSize="6" fontFamily="monospace">S</text>
                <text x="-38" y="2" textAnchor="middle" fill="rgba(0,255,204,0.5)" fontSize="6" fontFamily="monospace">W</text>
                {/* Wind arrow */}
                <line
                  x1="0" y1="0"
                  x2={Math.sin(wind.beta * Math.PI / 180) * 35}
                  y2={-Math.cos(wind.alpha * Math.PI / 180) * 35}
                  stroke="#00ffcc" strokeWidth="2"
                  markerEnd="url(#arrowhead)"
                />
                <defs>
                  <marker id="arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                    <polygon points="0 0, 6 2, 0 4" fill="#00ffcc" />
                  </marker>
                </defs>
              </svg>
            </div>
          </div>

          {/* Particles */}
          <div className="pt-4 border-t border-white/10">
            <div className="flex justify-between text-xs font-mono mb-2">
              <span className="text-white/60 uppercase flex items-center gap-1">
                <Zap size={12} /> Particles
              </span>
              <span className="text-[#00ffcc]">{particleCount.toLocaleString()}</span>
            </div>
            <input
              type="range" min="0" max="100" step="1"
              value={particleDensity}
              onChange={e => onParticleDensityChange(parseInt(e.target.value))}
              className="w-full accent-[#00ffcc] h-1 bg-white/10 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#00ffcc] [&::-webkit-slider-thumb]:rounded-full cursor-pointer"
            />
          </div>

          {/* Mesh Resolution (compute power) */}
          <div className="pt-4 border-t border-white/10">
            <div className="flex justify-between text-xs font-mono mb-2">
              <span className="text-white/60 uppercase flex items-center gap-1">
                <Cpu size={12} /> Panel Resolution
              </span>
              <span className="text-[#00ffcc]">{meshResolution.toLocaleString()} panels</span>
            </div>
            <input
              type="range" min="200" max="3000" step="50"
              value={meshResolution}
              onChange={e => onMeshResolutionChange(parseInt(e.target.value))}
              className="w-full accent-[#00ffcc] h-1 bg-white/10 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#00ffcc] [&::-webkit-slider-thumb]:rounded-full cursor-pointer"
            />
          </div>

          {/* Simulate Button */}
          <div className="pt-4 border-t border-white/10">
            <button
              onClick={onSimulate}
              disabled={simulating}
              className="w-full py-3 flex items-center justify-center gap-2 bg-[#00ffcc] text-black font-mono text-sm font-bold uppercase tracking-wider rounded-lg hover:bg-[#00ffcc]/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-[0_0_20px_rgba(0,255,204,0.3)] hover:shadow-[0_0_30px_rgba(0,255,204,0.5)] cursor-pointer"
            >
              <Play size={16} />
              {simulating ? 'Simulating...' : 'Simulate'}
            </button>
          </div>

          {/* Previous Results */}
          {results.length > 0 && (
            <div className="pt-4 border-t border-white/10">
              <div className="flex items-center gap-2 mb-2">
                <History size={12} className="text-[#00ffcc]/60" />
                <span className="text-white/60 text-xs font-mono uppercase">Previous Results</span>
              </div>
              <select
                onChange={e => e.target.value && onLoadResult(e.target.value)}
                disabled={loadingResult || simulating}
                value=""
                className="w-full bg-white/5 border border-white/10 text-white/80 text-xs font-mono rounded-lg px-3 py-2 outline-none disabled:opacity-40 cursor-pointer appearance-none"
              >
                <option value="" disabled>Load a previous run...</option>
                {results.map(r => {
                  const ago = _timeAgo(r.ts)
                  return (
                    <option key={r.result_id} value={r.result_id} className="bg-black text-white">
                      M {r.mach.toFixed(2)} / α {r.alpha.toFixed(1)}° / β {r.beta.toFixed(1)}° — {ago}
                    </option>
                  )
                })}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Viz Mode Switcher */}
      <div className="bg-black/40 backdrop-blur-md border border-white/10 p-2 rounded-xl flex gap-1 shadow-2xl">
        {(['visual', 'thermal', 'stress', 'pressure'] as VisualizationMode[]).map(m => (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            className={`flex-1 py-2 text-[10px] font-mono uppercase tracking-widest rounded-lg transition-all ${
              mode === m
                ? 'bg-[#00ffcc] text-black font-bold shadow-[0_0_15px_rgba(0,255,204,0.4)]'
                : 'text-white/50 hover:text-white hover:bg-white/5'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  )
}

function _timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
