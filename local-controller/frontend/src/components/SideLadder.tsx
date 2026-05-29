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
    case 'queued': return 'queued'
    case 'allocating': return 'allocating spot'
    case 'pulling': return 'pulling container'
    case 'loading': return 'loading model'
    case 'inferring': return 'inferring...'
    case 'done': return 'complete'
    case 'failed': return 'failed'
    default: return state
  }
}

export default function SideLadder({ lanes, onSelect }: SideLadderProps) {
  const pairId = (id: string) => {
    const [model, silicon] = [id.replace(/-tpu$|-gpu$/, ''), id.endsWith('-tpu') ? 'tpu' : 'gpu']
    return `${model}-${silicon === 'tpu' ? 'gpu' : 'tpu'}` as BackendId
  }

  return (
    <div className="sideLadderWrapper">
      {BACKENDS.map(b => {
        const lane = lanes[b.id]
        const cost = lane.costAccumulated
        const counterpartId = pairId(b.id)
        const counterpart = lanes[counterpartId]
        const bothDone = lane.state === 'done' && counterpart?.state === 'done' && cost > 0 && counterpart.costAccumulated > 0
        const pairCheapest = bothDone ? Math.min(cost, counterpart.costAccumulated) : null
        const ratio = pairCheapest ? cost / pairCheapest : null

        let borderColor = 'rgba(255, 255, 255, 0.2)'
        if (lane.state !== 'idle' && lane.state !== 'done' && lane.state !== 'failed') {
          borderColor = 'rgba(244, 180, 0, 0.7)'
        }
        if (lane.state === 'done') {
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
