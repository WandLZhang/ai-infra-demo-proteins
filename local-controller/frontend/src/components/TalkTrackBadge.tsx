import React, { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { MessageSquare } from 'lucide-react'

interface TalkTrackBadgeProps {
  slide: number
  label: string
}

export default function TalkTrackBadge({ slide, label }: TalkTrackBadgeProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className="inline-flex items-center gap-2 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      <motion.div
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-sm"
        animate={{ borderColor: ['rgba(255,255,255,0.1)', 'rgba(16,185,129,0.4)', 'rgba(255,255,255,0.1)'] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-[10px] font-bold text-emerald-300">
          {slide}
        </div>
        <MessageSquare size={10} className="text-white/30" />
        <span className="text-[11px] text-white/60 max-w-xs truncate">{label}</span>
      </motion.div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            className="absolute bottom-full mb-2 left-0 right-0 px-4 py-2 rounded-lg bg-black/80 border border-white/10 text-xs text-white/70"
          >
            <div className="text-[10px] text-emerald-400 font-mono mb-1">Slide {slide}</div>
            {label}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
