import { useEffect, useState } from 'react'
import type { UsageSnapshot } from '../../../core/usage'

export interface UsageState {
  codex: UsageSnapshot | null
  claude: UsageSnapshot | null
}

export function useUsage() {
  const api = window.bluevis
  const [usage, setUsage] = useState<UsageState>({ codex: null, claude: null })
  useEffect(() => {
    const load = () => void api.usage.get().then((u) => setUsage(u as UsageState))
    load()
    // Codex writes its session log as it works; re-read periodically.
    const id = setInterval(load, 60_000)
    const off = api.on('usage', (u) => setUsage(u as UsageState))
    return () => {
      clearInterval(id)
      off()
    }
  }, [api])
  return usage
}

export function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export function until(ms?: number) {
  if (!ms) return ''
  const m = Math.round((ms - Date.now()) / 60000)
  if (m <= 0) return 'resets now'
  if (m < 60) return `resets in ${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `resets in ${h}h` : `resets in ${Math.round(h / 24)}d`
}

/** Remaining percent; a window whose reset time has passed is full again even if not re-observed. */
const left = (w: UsageSnapshot['windows'][number]) => (w.resetsAt && w.resetsAt < Date.now() ? 100 : Math.max(0, 100 - w.usedPercent))

/** Header meters: remaining allowance in each tool's tightest window. */
export function UsageChips({ usage, onOpen }: { usage: UsageState; onOpen: () => void }) {
  const chips = (['codex', 'claude'] as const)
    .map((p) => {
      const s = usage[p]
      if (!s) return null
      const w = [...s.windows].sort((a, b) => left(a) - left(b))[0]
      return { p, w, s }
    })
    .filter(Boolean) as { p: 'codex' | 'claude'; w: UsageSnapshot['windows'][number]; s: UsageSnapshot }[]
  if (!chips.length) return null
  return (
    <button className="usage-chips" onClick={onOpen} aria-label="Usage left. Click for details.">
      {chips.map(({ p, w, s }) => (
        <span key={p} className="usage-chip" data-high={left(w) <= 20} title={`${p === 'codex' ? 'Codex' : 'Claude'} ${w.name}: ${Math.round(left(w))}% left, ${until(w.resetsAt)} (observed ${ago(s.observedAt)})`}>
          <span className="mono">{p === 'codex' ? 'Codex' : 'Claude'}</span>
          <span className="meter">
            <i style={{ width: `${left(w)}%` }} />
          </span>
          <span className="mono pct">{Math.round(left(w))}%</span>
        </span>
      ))}
      <span className="mono usage-left">left</span>
    </button>
  )
}

export function UsageDetail({ usage }: { usage: UsageState }) {
  const api = window.bluevis
  const [busy, setBusy] = useState(false)
  return (
    <div className="usage-detail">
      {(['codex', 'claude'] as const).map((p) => {
        const s = usage[p]
        return (
          <div key={p} className="usage-card">
            <div className="row">
              <span className="eyebrow">{p === 'codex' ? `Codex${s?.plan ? ` · ${s.plan}` : ''}` : 'Claude'}</span>
              <span className="mono" style={{ marginLeft: 'auto', color: 'var(--faint)' }}>
                {s ? `observed ${ago(s.observedAt)}` : 'not observed yet'}
              </span>
            </div>
            {s ? (
              s.windows.map((w) => (
                <div key={w.name} className="usage-window">
                  <div className="row">
                    <span>{w.name}</span>
                    <span className="mono" style={{ marginLeft: 'auto' }}>
                      {Math.max(0, Math.round((100 - w.usedPercent) * 10) / 10)}% left · {until(w.resetsAt)}
                    </span>
                  </div>
                  <div className="meter wide" data-high={w.usedPercent >= 80}>
                    <i style={{ width: `${Math.max(0, 100 - w.usedPercent)}%` }} />
                  </div>
                </div>
              ))
            ) : (
              <p style={{ color: 'var(--mist)', fontSize: 12.5, margin: '8px 0 0' }}>
                {p === 'codex' ? 'Appears after Codex runs once.' : 'Appears after any Claude run, or refresh below.'}
              </p>
            )}
            {p === 'claude' && (
              <button
                className="btn btn-quiet"
                style={{ paddingLeft: 0, marginTop: 6 }}
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await api.usage.refreshClaude().finally(() => setBusy(false))
                }}
              >
                {busy ? 'Checking…' : 'Refresh (one tiny Haiku call)'}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
