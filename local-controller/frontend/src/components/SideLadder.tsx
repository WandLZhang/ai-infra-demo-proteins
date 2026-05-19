import React from 'react'
import type { BackendId, LaneStatus } from '../types'
import { BACKENDS } from '../backends'

interface SideLadderProps {
  lanes: Record<BackendId, LaneStatus>
  onSelect: (id: BackendId) => void
}

export default function SideLadder({ lanes, onSelect }: SideLadderProps) {
  const doneLanes = BACKENDS.map(b => ({ b, lane: lanes[b.id] })).filter(x => x.lane.state === 'done' && x.lane.costAccumulated > 0)
  const cheapest = doneLanes.length > 0 ? Math.min(...doneLanes.map(x => x.lane.costAccumulated)) : null

  return (
    <div className="side-ladder">
      {BACKENDS.map(b => {
        const lane = lanes[b.id]
        const stateClass = lane.state === 'done' ? 'done' : (lane.state !== 'idle' ? 'active' : '')
        const cost = lane.costAccumulated
        const ratio = cheapest && cost > 0 ? cost / cheapest : null

        return (
          <div key={b.id} className={`side-ladder-item ${stateClass}`} onClick={() => onSelect(b.id)}>
            <span style={{ fontWeight: 600, letterSpacing: '0.05em' }}>{b.shortLabel}</span>
            {lane.state === 'idle' && <span className="side-ladder-ms">— submit all —</span>}
            {lane.state !== 'idle' && lane.state !== 'done' && (
              <span className="side-ladder-ms">{lane.state}...</span>
            )}
            {lane.state === 'done' && (
              <span className="side-ladder-ms">
                ${cost.toFixed(4)} · {ratio !== null && ratio <= 1.01 ? '✓ best' : `${ratio?.toFixed(1)}×`}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
