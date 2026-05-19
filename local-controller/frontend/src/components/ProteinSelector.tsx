import React, { useState } from 'react'
import { motion } from 'motion/react'
import { Dna, FlaskConical, Zap } from 'lucide-react'
import type { Protein, ModelId } from '../types'

const PROTEINS: Protein[] = [
  { id: 'brca1', name: 'BRCA1 BRCT', sequence: 'MPIGSKERPTFFEIFKTRCNKADLGPISLNWFEELSSEAPPYNSEPAEESEHKNNNYEPNLFKTPQRKPSYNQ...', uniprotId: 'P38398', description: 'Breast cancer tumor suppressor — DNA repair', residueCount: 213 },
  { id: 'p53', name: 'p53 DBD', sequence: 'MCNSSCMGGMNRRPILTIITLEDSSGKLLCQRFIPNGTFQHEAL...', uniprotId: 'P04637', description: 'Tumor suppressor — guardian of the genome', residueCount: 195 },
  { id: 'ace2', name: 'ACE2 PD', sequence: 'MSSSSWLLLSLVAVTAAQSTIEEQAKTFLDKFNHEAEDLFYQSS...', uniprotId: 'Q9BYF1', description: 'SARS-CoV-2 receptor — COVID-19 entry point', residueCount: 615 },
  { id: 'hemoglobin', name: 'Hemoglobin α', sequence: 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSH...', uniprotId: 'P69905', description: 'Oxygen transport — sickle cell disease target', residueCount: 142 },
  { id: 'insulin', name: 'Insulin receptor', sequence: 'MATGGRRGAAAAPLLVAVAALLLGAAGHLYPGEVCPGMDIRNNLTRLHELENCSVIE...', uniprotId: 'P06213', description: 'Diabetes — receptor tyrosine kinase', residueCount: 267 },
  { id: 'cftr', name: 'CFTR NBD1', sequence: 'MKQFNLRSFNQMAKEELYRQGVRVLVTHSKFQLQDRFPFQELLD...', uniprotId: 'P13569', description: 'Cystic fibrosis transmembrane regulator', residueCount: 250 },
]

const MODELS: { id: ModelId; name: string; badge: string; description: string }[] = [
  { id: 'af2', name: 'AlphaFold 2', badge: 'AF2', description: 'Gold standard — JAX/Haiku, needs MSA' },
  { id: 'esmfold', name: 'ESMFold', badge: 'ESM', description: 'Single-sequence — no MSA, seconds' },
  { id: 'boltz2', name: 'Boltz-2', badge: 'B2', description: 'Protein + RNA + DNA + ligands' },
]

interface ProteinSelectorProps {
  onSubmit: (protein: Protein, models: ModelId[]) => void
  isRunning: boolean
}

export default function ProteinSelector({ onSubmit, isRunning }: ProteinSelectorProps) {
  const [selectedProtein, setSelectedProtein] = useState<Protein>(PROTEINS[0])
  const [selectedModels, setSelectedModels] = useState<Set<ModelId>>(new Set(['af2', 'esmfold', 'boltz2']))

  const toggleModel = (id: ModelId) => {
    setSelectedModels(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const jobCount = selectedModels.size * 2 // each model × 2 silicons

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Section header */}
      <div className="flex items-center gap-2 text-white/60 text-xs font-mono uppercase tracking-widest">
        <Dna size={14} />
        <span>Protein</span>
      </div>

      {/* Protein selector */}
      <div className="grid grid-cols-2 gap-1.5">
        {PROTEINS.map(p => (
          <button
            key={p.id}
            onClick={() => setSelectedProtein(p)}
            className={`
              text-left px-2.5 py-1.5 rounded text-xs transition-all
              ${selectedProtein.id === p.id
                ? 'bg-white/10 text-white border border-white/20'
                : 'bg-white/[0.03] text-white/50 border border-transparent hover:bg-white/[0.06] hover:text-white/70'}
            `}
          >
            <div className="font-medium">{p.name}</div>
            <div className="text-[10px] text-white/30 mt-0.5">{p.residueCount} residues</div>
          </button>
        ))}
      </div>

      {/* Protein info card */}
      <div className="bg-white/[0.03] rounded-lg p-3 border border-white/5">
        <div className="text-sm font-medium text-white/80">{selectedProtein.name}</div>
        <div className="text-[11px] text-white/40 mt-1">{selectedProtein.description}</div>
        <div className="text-[10px] font-mono text-white/20 mt-1">UniProt: {selectedProtein.uniprotId} · {selectedProtein.residueCount} aa</div>
      </div>

      {/* Model selector */}
      <div className="flex items-center gap-2 text-white/60 text-xs font-mono uppercase tracking-widest mt-2">
        <FlaskConical size={14} />
        <span>Models</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {MODELS.map(m => (
          <button
            key={m.id}
            onClick={() => toggleModel(m.id)}
            className={`
              flex items-center gap-2 px-3 py-2 rounded text-xs transition-all
              ${selectedModels.has(m.id)
                ? 'bg-white/10 text-white border border-white/20'
                : 'bg-white/[0.03] text-white/40 border border-transparent hover:bg-white/[0.06]'}
            `}
          >
            <div className={`
              w-8 h-5 rounded text-[10px] font-bold flex items-center justify-center
              ${selectedModels.has(m.id) ? 'bg-emerald-500/30 text-emerald-300' : 'bg-white/5 text-white/20'}
            `}>
              {m.badge}
            </div>
            <div className="flex-1 text-left">
              <div className="font-medium">{m.name}</div>
              <div className="text-[10px] text-white/30">{m.description}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Submit button */}
      <motion.button
        onClick={() => onSubmit(selectedProtein, [...selectedModels])}
        disabled={isRunning || selectedModels.size === 0}
        className={`
          mt-4 w-full py-3 rounded-lg font-bold text-sm tracking-wide
          flex items-center justify-center gap-2
          transition-all
          ${isRunning
            ? 'bg-white/5 text-white/30 cursor-wait'
            : 'bg-gradient-to-r from-emerald-600 to-cyan-600 text-white hover:from-emerald-500 hover:to-cyan-500 shadow-lg shadow-emerald-500/20'}
        `}
        whileHover={isRunning ? {} : { scale: 1.02 }}
        whileTap={isRunning ? {} : { scale: 0.98 }}
      >
        <Zap size={16} />
        {isRunning
          ? 'Running...'
          : `Submit All · ${jobCount} jobs → TPU + GPU`}
      </motion.button>

      <div className="text-[10px] text-white/20 text-center font-mono">
        sbatch predict.sh --model=all --target=both --protein={selectedProtein.id}
      </div>
    </div>
  )
}

export { PROTEINS }
