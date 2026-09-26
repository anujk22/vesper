import { useEffect, useRef, useState } from 'react'
import type { ModelChoice, Settings } from '../../../core/types'
import { Brain } from './icons'

export type ThinkLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra'
const LEVELS: { id: ThinkLevel; label: string; note: string }[] = [
  { id: 'off', label: 'Off', note: 'answers at once' },
  { id: 'low', label: 'Low', note: 'a few seconds' },
  { id: 'medium', label: 'Medium', note: 'thinks it through' },
  { id: 'high', label: 'High', note: 'slow and careful' },
  { id: 'ultra', label: 'Ultra', note: 'can split work across parallel agents' }
]

export function thinkLevel(s: Settings): ThinkLevel {
  if (s.ultra) return 'ultra'
  const e = s.brain.effort
  return e === 'low' || e === 'medium' || e === 'high' ? e : 'off'
}

/** The settings change for a level: effort on the conversation model, plus the Ultra flag. */
export function levelPatch(s: Settings, level: ThinkLevel): Partial<Settings> {
  const { effort: _, ...base } = s.brain
  const effort: ModelChoice['effort'] | undefined = level === 'ultra' ? 'high' : level === 'off' ? (s.brain.provider === 'codex' ? 'minimal' : undefined) : level
  return { brain: effort ? { ...base, effort } : base, ultra: level === 'ultra' }
}

/** Brain button for the composer. Opens a slider from Off to Ultra: drag the dot, click a stop, scroll, or use the arrow keys. */
export function ThinkingRail({ settings, onPick }: { settings: Settings; onPick: (l: ThinkLevel) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const level = thinkLevel(settings)
  const i = LEVELS.findIndex((l) => l.id === level)
  // While dragging, the dot follows the pointer freely and snaps to a stop on release.
  const [drag, setDrag] = useState<number | null>(null)
  const wheel = useRef(0)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const pick = (n: number) => {
    const c = Math.min(LEVELS.length - 1, Math.max(0, n))
    if (c !== i) onPick(LEVELS[c].id)
  }
  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }
  const pos = drag ?? i / (LEVELS.length - 1)
  const shown = drag === null ? i : Math.round(drag * (LEVELS.length - 1))
  return (
    <div className="rail-anchor" ref={ref}>
      <button className="round" data-level={level} aria-expanded={open} onClick={() => setOpen(!open)} title={`Thinking: ${LEVELS[i].label}`} aria-label={`Thinking: ${LEVELS[i].label}`}>
        <Brain />
      </button>
      {open && (
        <div
          className="rail"
          onWheel={(e) => {
            // Trackpads send many small deltas; one stop per ~60px of travel.
            wheel.current += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
            if (Math.abs(wheel.current) > 60) {
              pick(i + Math.sign(wheel.current))
              wheel.current = 0
            }
          }}
        >
          <div className="rail-head">
            <span className="eyebrow">Thinking</span>
            <span className="rail-value" data-ultra={LEVELS[shown].id === 'ultra'}>
              {LEVELS[shown].label}
            </span>
          </div>
          <div
            className="slider"
            ref={bar}
            role="slider"
            tabIndex={0}
            aria-label="Thinking"
            aria-valuemin={0}
            aria-valuemax={LEVELS.length - 1}
            aria-valuenow={i}
            aria-valuetext={LEVELS[i].label}
            data-dragging={drag !== null}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              setDrag(at(e.clientX))
            }}
            onPointerMove={(e) => drag !== null && setDrag(at(e.clientX))}
            onPointerUp={(e) => {
              pick(Math.round(at(e.clientX) * (LEVELS.length - 1)))
              setDrag(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') pick(i + 1)
              if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') pick(i - 1)
              if (e.key === 'Escape') setOpen(false)
            }}
            style={{ ['--pos' as string]: pos }}
          >
            <div className="slider-track">
              <div className="slider-fill" data-ultra={LEVELS[shown].id === 'ultra'} />
            </div>
            {LEVELS.map((l, n) => (
              <span key={l.id} className="slider-tick" data-on={n <= shown} style={{ left: `${(n / (LEVELS.length - 1)) * 100}%` }} />
            ))}
            <span className="slider-knob" data-ultra={LEVELS[shown].id === 'ultra'} />
          </div>
          <div className="slider-labels">
            {LEVELS.map((l, n) => (
              <button key={l.id} className="slider-label" aria-current={n === shown} onClick={() => pick(n)} style={{ left: `${(n / (LEVELS.length - 1)) * 100}%` }}>
                {l.label}
              </button>
            ))}
          </div>
          <div className="rail-note mono">{LEVELS[shown].note}</div>
        </div>
      )}
    </div>
  )
}
