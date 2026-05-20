import React from 'react'
import type { Protein } from '../types'

interface LocationPaperProps {
  protein: Protein
  activeZone?: string
  totalCost?: number
  savings?: string
}

export default function LocationPaper({ protein, activeZone, totalCost, savings }: LocationPaperProps) {
  return (
    <div className="location-paper" key={protein.id}>
      <div className="location-paper-region">
        {activeZone || 'NIH BIOWULF'}
      </div>
      <div className="location-paper-name">
        {protein.name}
      </div>
      <div className="location-paper-coords">
        {protein.uniprotId} · {protein.residueCount} AA {savings && <span style={{ color: '#09d3ac' }}>· {savings}</span>}
      </div>
      {totalCost !== undefined && (
        <div className="location-paper-coords" style={{ marginTop: 4, animationDelay: '0.85s' }}>
          ${totalCost.toFixed(4)}
        </div>
      )}
    </div>
  )
}
