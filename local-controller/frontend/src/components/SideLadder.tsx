import React from 'react'
import type { BackendId, LaneStatus } from '../types'
import { BACKENDS } from '../backends'

interface SideLadderProps {
  lanes: Record<BackendId, LaneStatus>
  onSelect: (id: BackendId) => void
}

function stateLabel(state: string): string {
  switch (state) {
    case 'idle': return 'ready'
    case 'queued': return 'provisioning...'
    case 'allocating': return 'provisioning...'
    case 'loading': return 'loading model'
    case 'inferring': return 'inferring...'
    case 'done': return 'complete'
    case 'failed': return 'no capacity'
    default: return state
  }
}

export default function SideLadder({ lanes, onSelect }: SideLadderProps) {
  const doneLanes = BACKENDS.map(b => ({ b, lane: lanes[b.id] })).filter(x => x.lane.state === 'done' && x.lane.costAccumulated > 0)
  const cheapest = doneLanes.length > 0 ? Math.min(...doneLanes.map(x => x.lane.costAccumulated)) : null

  return (
    <div className="sideLadderWrapper">
      {BACKENDS.map(b => {
        const lane = lanes[b.id]
        const cost = lane.costAccumulated
        const ratio = cheapest && cost > 0 ? cost / cheapest : null

        let borderColor = 'rgba(255, 255, 255, 0.2)'
        if (lane.state === 'queued' || lane.state === 'allocating') {
          borderColor = 'rgba(244, 180, 0, 0.7)'
        }
        if (lane.state === 'loading' || lane.state === 'inferring' || lane.state === 'done') {
          borderColor = 'rgba(15, 157, 88, 0.7)'
        }
        if (lane.state === 'failed') {
          borderColor = 'rgba(219, 68, 55, 0.7)'
        }

        let subtitle = stateLabel(lane.state)
        if (lane.state === 'done') {
          subtitle = `$${cost.toFixed(4)} / predict`
          if (ratio !== null && ratio <= 1.01) subtitle += ' · best'
          else if (ratio !== null) subtitle += ` · ${ratio.toFixed(1)}×`
        }

        return (
          <div
            key={b.id}
            className="sideLadderItem"
            style={{ borderLeftColor: borderColor }}
            onClick={() => onSelect(b.id)}
            title={`Slide ${b.talkTrackSlide}: ${b.talkTrackLabel}`}
          >
            <span className="sideLadderName">{b.shortLabel}</span>
            <span className="sideLadderSub">{subtitle}</span>
          </div>
        )
      })}
    </div>
  )
}
