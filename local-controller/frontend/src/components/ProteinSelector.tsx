import React, { useState } from 'react'
import { motion } from 'motion/react'
import { Dna, Zap } from 'lucide-react'
import type { Protein, ModelId } from '../types'

const PROTEINS: Protein[] = [
  { id: 'brca1', name: 'BRCA1 BRCT', sequence: 'MPIGSKERPTFFEIFKTRCNKADLGPISLNWFEELSSEAPPYNSEPAEESEHKNNNYEPNLFKTPQRKPSYNQ...', uniprotId: 'P38398', description: 'Breast cancer tumor suppressor — DNA repair', residueCount: 213 },
  { id: 'p53', name: 'p53 DBD', sequence: 'MCNSSCMGGMNRRPILTIITLEDSSGKLLCQRFIPNGTFQHEAL...', uniprotId: 'P04637', description: 'Tumor suppressor — guardian of the genome', residueCount: 195 },
  { id: 'ace2', name: 'ACE2 PD', sequence: 'MSSSSWLLLSLVAVTAAQSTIEEQAKTFLDKFNHEAEDLFYQSS...', uniprotId: 'Q9BYF1', description: 'SARS-CoV-2 receptor — COVID-19 entry point', residueCount: 615 },
  { id: 'hemoglobin', name: 'Hemoglobin α', sequence: 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSH...', uniprotId: 'P69905', description: 'Oxygen transport — sickle cell disease target', residueCount: 142 },
  { id: 'insulin', name: 'Insulin receptor', sequence: 'MATGGRRGAAAAPLLVAVAALLLGAAGHLYPGEVCPGMDIRNNLTRLHELENCSVIE...', uniprotId: 'P06213', description: 'Diabetes — receptor tyrosine kinase', residueCount: 267 },
  { id: 'cftr', name: 'CFTR NBD1', sequence: 'MKQFNLRSFNQMAKEELYRQGVRVLVTHSKFQLQDRFPFQELLD...', uniprotId: 'P13569', description: 'Cystic fibrosis transmembrane regulator', residueCount: 250 },
]

const ALL_MODELS: ModelId[] = ['af2', 'esmfold', 'boltz2']

interface ProteinSelectorProps {
  onSubmit: (protein: Protein, models: ModelId[]) => void
  isRunning: boolean
}

export default function ProteinSelector({ onSubmit, isRunning }: ProteinSelectorProps) {
  const [selectedProtein, setSelectedProtein] = useState<Protein>(PROTEINS[0])

  return (
    <div className="p-4 space-y-4">
      {/* Protein grid */}
      <div>
        <div className="text-white/30 text-[9px] font-mono uppercase tracking-widest mb-2 flex items-center gap-1.5">
          <Dna size={10} />
          Target protein
        </div>
        <div className="grid grid-cols-2 gap-1">
          {PROTEINS.map(p => (
            <button
              key={p.id}
              onClick={() => setSelectedProtein(p)}
              className={`text-left px-2 py-1.5 rounded text-[10px] font-mono transition-all ${
                selectedProtein.id === p.id
                  ? 'bg-[#00ffcc]/10 text-[#00ffcc] border border-[#00ffcc]/30'
                  : 'bg-white/[0.02] text-white/40 border border-transparent hover:bg-white/[0.04]'
              }`}
            >
              <div className="font-semibold">{p.name}</div>
              <div className="text-white/20 text-[8px]">{p.residueCount} aa</div>
            </button>
          ))}
        </div>
      </div>

      {/* Selected protein card */}
      <div className="bg-[#00ffcc]/5 border border-[#00ffcc]/20 rounded-lg p-3">
        <div className="text-[12px] font-mono font-bold text-[#00ffcc]">{selectedProtein.name}</div>
        <div className="text-[10px] text-white/50 mt-0.5">{selectedProtein.description}</div>
        <div className="text-[8px] font-mono text-white/20 mt-1">UniProt: {selectedProtein.uniprotId} · {selectedProtein.residueCount} aa</div>
      </div>

      {/* Submit button — matches F-22 SIMULATE */}
      <motion.button
        onClick={() => onSubmit(selectedProtein, ALL_MODELS)}
        disabled={isRunning}
        className={`w-full py-2.5 rounded-lg font-mono text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all border ${
          isRunning
            ? 'bg-white/[0.03] text-white/30 border-white/10 cursor-wait'
            : 'bg-[#00ffcc]/10 text-[#00ffcc] border-[#00ffcc]/30 hover:bg-[#00ffcc]/20'
        }`}
        whileHover={isRunning ? {} : { scale: 1.01 }}
        whileTap={isRunning ? {} : { scale: 0.99 }}
      >
        <Zap size={14} />
        {isRunning ? 'Running...' : 'Submit All'}
      </motion.button>

      <div className="text-[8px] text-white/15 font-mono text-center">
        AF2 + ESMFold + Boltz-2 → TPU + GPU · 6 jobs
      </div>
    </div>
  )
}

export { PROTEINS }
