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
    <div className="location-paper">
      <div className="location-paper-region">
        {activeZone || 'NIH BIOWULF · PROTEIN STRUCTURE PREDICTION'}
      </div>
      <div className="location-paper-name" key={protein.id}>
        {protein.name}
      </div>
      <div className="location-paper-coords">
        {protein.description} · {protein.residueCount} aa · UniProt: {protein.uniprotId}
        {totalCost !== undefined && (
          <span style={{ marginLeft: 16, color: '#09d3ac' }}>
            TPU total: ${totalCost.toFixed(4)} {savings && `(${savings} cheaper)`}
          </span>
        )}
      </div>
    </div>
  )
}
