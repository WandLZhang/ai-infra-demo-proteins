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
        {activeZone || 'Biowulf Controller — Standing By'}
      </div>
      <div className="location-paper-name">
        {protein.name}
      </div>
      <div className="location-paper-coords">
        ID: {protein.uniprotId} · {protein.residueCount} AA · {savings ? `SAVINGS: ${savings}` : 'BURSTING READY'}
      </div>
      {totalCost !== undefined && (
        <div className="location-paper-cost">
          <span style={{ fontSize: 10, color: '#09d3ac', fontWeight: 700 }}>SESSION COST: </span>
          <span style={{ fontSize: 14, color: '#fff', fontFamily: "'Google Sans', sans-serif" }}>${totalCost.toFixed(4)}</span>
        </div>
      )}
    </div>
  )
}
