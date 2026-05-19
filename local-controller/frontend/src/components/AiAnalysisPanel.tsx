import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Bot, Send, RotateCcw, ChevronDown, ChevronUp, Sparkles } from 'lucide-react'
import { streamAiAnalysis, streamAiChat, buildAnalyzeParams, type AiAnalyzeParams } from '../api'
import type { SimulationResult, WindParams } from '../types'

interface Message {
  role: 'user' | 'assistant' | 'system'
  text: string
}

interface AiAnalysisPanelProps {
  simResult: SimulationResult | null
  wind: WindParams
  gcsPath: string | null
  uploadReady: boolean
}

export default function AiAnalysisPanel({ simResult, wind, gcsPath, uploadReady }: AiAnalysisPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Auto-analyze when upload completes (gcsPath changes or uploadReady becomes true)
  const prevGcsPathRef = useRef<string | null>(null)
  useEffect(() => {
    if (!uploadReady || !simResult) return
    if (gcsPath === prevGcsPathRef.current) return
    prevGcsPathRef.current = gcsPath
    runAutoAnalysis()
  }, [gcsPath, uploadReady])

  const runAutoAnalysis = useCallback(async () => {
    if (!simResult || streaming) return

    const params: AiAnalyzeParams = gcsPath
      ? { gcs_path: gcsPath }
      : buildAnalyzeParams(simResult, wind)

    setStreaming(true)

    let assistantText = ''
    setMessages(prev => [...prev, { role: 'system', text: 'Analyzing simulation results...' }])

    try {
      await streamAiAnalysis(
        params,
        (chunk) => {
          assistantText += chunk
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last?.role === 'assistant') {
              updated[updated.length - 1] = { role: 'assistant', text: assistantText }
            } else {
              // Remove the "Analyzing..." system message and add assistant
              if (last?.role === 'system') updated.pop()
              updated.push({ role: 'assistant', text: assistantText })
            }
            return updated
          })
        },
        (_fullText) => { /* done */ },
        (err) => {
          setMessages(prev => [...prev.filter(m => m.role !== 'system'), { role: 'system', text: `Error: ${err}` }])
        },
      )
    } finally {
      setStreaming(false)
    }
  }, [simResult, wind, gcsPath, streaming])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setStreaming(true)

    let assistantText = ''

    try {
      await streamAiChat(
        text,
        null,
        (chunk) => {
          assistantText += chunk
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last?.role === 'assistant') {
              updated[updated.length - 1] = { role: 'assistant', text: assistantText }
            } else {
              updated.push({ role: 'assistant', text: assistantText })
            }
            return updated
          })
        },
        (_fullText) => { /* done */ },
        (err) => {
          setMessages(prev => [...prev, { role: 'system', text: `Error: ${err}` }])
        },
        gcsPath,
      )
    } finally {
      setStreaming(false)
    }
  }, [input, streaming, gcsPath])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const resetChat = () => {
    setMessages([])
    fetch('/api/ai/reset', { method: 'POST' })
  }

  return (
    <div className={`bg-black/50 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl flex flex-col transition-all duration-300 ${
      collapsed ? 'h-12' : 'h-[320px]'
    }`} style={{ width: '100%' }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer border-b border-white/10 shrink-0"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-[#00ffcc]" />
          <span className="text-white font-sans text-sm font-semibold uppercase tracking-widest">
            Gemini
          </span>
          {streaming && (
            <Sparkles size={12} className="text-yellow-400 animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <button
              onClick={(e) => { e.stopPropagation(); resetChat() }}
              className="text-white/30 hover:text-white/70 transition-colors"
              title="Reset conversation"
            >
              <RotateCcw size={14} />
            </button>
          )}
          {collapsed ? <ChevronUp size={16} className="text-white/40" /> : <ChevronDown size={16} className="text-white/40" />}
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.length === 0 && !streaming && (
              <div className="text-white/30 text-xs font-mono text-center mt-8">
                {simResult
                  ? 'Click "Analyze" or ask a question about the simulation.'
                  : 'Run a simulation to get AI analysis.'}
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'text-[#00ffcc] font-mono pl-4 border-l-2 border-[#00ffcc]/30'
                  : msg.role === 'system'
                  ? 'text-yellow-400/70 font-mono italic text-center'
                  : 'text-white/80 font-sans'
              }`}>
                {msg.role === 'assistant' ? (
                  <div className="whitespace-pre-wrap" dangerouslySetInnerHTML={{
                    __html: formatMarkdown(msg.text)
                  }} />
                ) : (
                  msg.text
                )}
              </div>
            ))}

            {streaming && messages[messages.length - 1]?.role !== 'assistant' && (
              <div className="text-white/40 text-xs font-mono animate-pulse">Thinking...</div>
            )}
          </div>

          {/* Input area */}
          <div className="px-3 pb-3 pt-1 border-t border-white/10 shrink-0">
            <div className="flex gap-2">
              {simResult && !streaming && uploadReady && (
                <button
                  onClick={runAutoAnalysis}
                  className="px-3 py-2 text-[10px] font-mono uppercase tracking-wider bg-[#00ffcc]/10 text-[#00ffcc] border border-[#00ffcc]/20 rounded-lg hover:bg-[#00ffcc]/20 transition-colors whitespace-nowrap"
                >
                  Analyze
                </button>
              )}
              <div className="flex-1 flex bg-white/5 border border-white/10 rounded-lg overflow-hidden">
                <input
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about the simulation..."
                  disabled={streaming || !uploadReady}
                  className="flex-1 bg-transparent text-white text-xs font-mono px-3 py-2 outline-none placeholder:text-white/20 disabled:opacity-40"
                />
                <button
                  onClick={sendMessage}
                  disabled={streaming || !input.trim() || !uploadReady}
                  className="px-3 text-[#00ffcc]/60 hover:text-[#00ffcc] disabled:text-white/10 transition-colors"
                >
                  <Send size={14} />
                </button>
              </div>
            </div>

            {/* Quick prompts */}
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {[
                'Optimal cruise?',
                'Near stall?',
                'Drag breakdown',
                'Explain L/D',
              ].map(q => (
                <button
                  key={q}
                  onClick={() => { setInput(q); }}
                  disabled={streaming}
                  className="text-[9px] font-mono text-white/30 hover:text-white/60 bg-white/5 hover:bg-white/10 px-2 py-1 rounded transition-colors disabled:opacity-30"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}


function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong class="text-[#00ffcc]">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-white/10 px-1 rounded text-[#00ffcc]/80">$1</code>')
    .replace(/^- /gm, '<span class="text-[#00ffcc]/50 mr-1">&#x2022;</span>')
    .replace(/\n/g, '<br/>')
}
