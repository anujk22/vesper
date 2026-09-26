import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ModelChoice, Settings, Turn, AgentTask } from '../../../core/types'
import type { RelayRun } from '../../../core/relay'
import { Bell, Chevron } from './icons'
import { until, type UsageState } from './Usage'

export function Popover({ button, children, align = 'right', label }: { button: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="pop-anchor" ref={ref}>
      <button className="pop-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {button(open)}
      </button>
      {open && (
        <div className="popover glass" role="menu" data-align={align}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** Everything the header menu can offer; Settings picks which of these show. */
export const MODELS: { label: string; choice: ModelChoice; note: string }[] = [
  { label: 'Qwen 3.8 27B (local)', choice: { provider: 'local', model: 'incoai/Qwen3.8-27B-Splash', effort: 'low' }, note: 'Splash · smartest local, ~65 tok/s' },
  { label: 'Qwen 3.6 35B-A3B (local)', choice: { provider: 'local', model: 'incoai/Qwen3.6-35B-A3B-Splash', effort: 'low' }, note: 'Splash · fastest local, ~95 tok/s' },
  { label: 'GPT-6-Luna', choice: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }, note: 'Codex · fast' },
  { label: 'GPT-6-Sol', choice: { provider: 'codex', model: 'gpt-6-sol', effort: 'low' }, note: 'Codex · balanced' },
  { label: 'GPT-6-Astra', choice: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' }, note: 'Codex · deepest' },
  { label: 'Claude Haiku', choice: { provider: 'claude', model: 'haiku' }, note: 'Claude · fast' },
  { label: 'Claude Sonnet', choice: { provider: 'claude', model: 'sonnet' }, note: 'Claude · balanced' },
  { label: 'Claude Opus', choice: { provider: 'claude', model: 'opus' }, note: 'Claude · deepest' }
]

export const modelKey = (c: ModelChoice) => `${c.provider}:${c.model}`

/** Conversation model switcher, with how much of each subscription is left. */
export function ModelMenu({ settings, label, usage, onChange }: { settings: Settings | null; label?: string; usage: UsageState; onChange: (s: Settings) => void }) {
  const api = window.bluevis
  const cur = settings?.brain
  return (
    <Popover
      label="Conversation model"
      button={() => (
        <span className="model-chip glass">
          {label ?? '…'}
          <Chevron />
        </span>
      )}
    >
      {(close) => (
        <div className="menu">
          <div className="eyebrow menu-head">Conversation model</div>
          {MODELS.filter((m) => !settings?.pickerModels || settings.pickerModels.includes(modelKey(m.choice)) || (cur?.provider === m.choice.provider && cur?.model === m.choice.model)).map((m) => (
            <button
              key={m.label}
              className="menu-item"
              role="menuitemradio"
              aria-checked={cur?.provider === m.choice.provider && cur?.model === m.choice.model}
              onClick={async () => {
                onChange((await api.settings.set({ brain: m.choice })) as Settings)
                close()
              }}
            >
              <span>{m.label}</span>
              <span className="mono menu-note">{m.note}</span>
            </button>
          ))}
          <div className="eyebrow menu-head" style={{ marginTop: 8 }}>
            Remaining
          </div>
          {(['codex', 'claude'] as const).map((p) => {
            const s = usage[p]
            return (
              <div key={p} className="menu-usage">
                <span>{p === 'codex' ? 'Codex' : 'Claude'}</span>
                {s ? (
                  s.windows.map((w) => (
                    <span key={w.name} className="mono menu-note" data-high={w.usedPercent >= 80}>
                      {w.name} {Math.max(0, Math.round(100 - w.usedPercent))}% left · {until(w.resetsAt)}
                    </span>
                  ))
                ) : (
                  <span className="mono menu-note">not observed yet</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Popover>
  )
}

/** Things that need Anuj: proposals awaiting a go-ahead, running and failed work. */
export type AttentionItem = { key: string; label: string; detail: string; go: () => void; tone: 'warm' | 'live' | 'bad' }

export function AttentionMenu({ turns, tasks, relays, extra = [], onGo }: { turns: Turn[]; tasks: AgentTask[]; relays: RelayRun[]; extra?: AttentionItem[]; onGo: (where: 'talk' | 'agents' | 'relays', id?: string) => void }) {
  const items: AttentionItem[] = [...extra]
  for (const t of turns) if (t.action?.state === 'proposed') items.push({ key: t.id, label: `Approve ${t.action.agent === 'claude' ? 'Claude' : 'Codex'}?`, detail: t.action.prompt.slice(0, 80), go: () => onGo('talk'), tone: 'warm' })
  for (const r of relays) if (r.status === 'running') items.push({ key: r.id, label: `Relay running · ${r.title}`, detail: r.stages.find((s) => s.status === 'running')?.label ?? '', go: () => onGo('relays', r.id), tone: 'live' })
  for (const t of tasks.slice(0, 8)) {
    if (['starting', 'investigating', 'editing', 'testing'].includes(t.status)) items.push({ key: t.id, label: `Agent working · ${t.project ?? ''}`, detail: t.title, go: () => onGo('agents', t.id), tone: 'live' })
    else if (t.status === 'failed') items.push({ key: t.id, label: `Agent failed · ${t.project ?? ''}`, detail: t.title, go: () => onGo('agents', t.id), tone: 'bad' })
  }
  return (
    <Popover
      label="Needs your attention"
      button={() => (
        <span className="icon-btn bell">
          <Bell />
          {items.length > 0 && <span className="badge">{items.length}</span>}
        </span>
      )}
    >
      {(close) => (
        <div className="menu" style={{ width: 300 }}>
          <div className="eyebrow menu-head">Needs you</div>
          {items.length === 0 && <p className="menu-empty">Nothing needs you right now.</p>}
          {items.map((i) => (
            <button
              key={i.key}
              className="menu-item attention"
              data-tone={i.tone}
              onClick={() => {
                i.go()
                close()
              }}
            >
              <span>{i.label}</span>
              <span className="menu-note">{i.detail}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

export function AccountMenu({ onSettings }: { onSettings: () => void }) {
  const api = window.bluevis
  return (
    <Popover label="Vesper menu" button={() => <span className="avatar">A</span>}>
      {(close) => (
        <div className="menu">
          {(
            [
              ['Settings', onSettings],
              ['Shrink to orb   ⌥Space', () => api.window.setMode('compact')],
              ['Hide', () => api.window.hide()],
              ['Quit Vesper   ⌘Q', () => api.window.quit()]
            ] as [string, () => void][]
          ).map(([l, fn]) => (
            <button
              key={l}
              className="menu-item"
              onClick={() => {
                close()
                fn()
              }}
            >
              <span>{l}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}
