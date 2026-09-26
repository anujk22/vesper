// Subscription usage as reported by the tools themselves. Each snapshot keeps
// when it was observed, because a stale number must not look current.

export interface UsageWindow {
  name: string
  /** 0..100 */
  usedPercent: number
  resetsAt?: number
}

export interface UsageSnapshot {
  provider: 'codex' | 'claude'
  observedAt: number
  plan?: string
  windows: UsageWindow[]
}

function windowName(minutes: number): string {
  if (minutes === 300) return '5-hour'
  if (minutes === 10080) return 'weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`
  return `${Math.round(minutes / 60)}-hour`
}

/** The most recent `rate_limits` object in a Codex session log (JSONL). */
export function parseCodexRateLimits(jsonl: string, observedAt: number): UsageSnapshot | null {
  const lines = jsonl.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue
    try {
      const found = findKey(JSON.parse(lines[i]), 'rate_limits') as Record<string, any> | undefined
      if (!found) continue
      const windows: UsageWindow[] = []
      for (const k of ['primary', 'secondary']) {
        const w = found[k]
        if (w && typeof w.used_percent === 'number') {
          windows.push({ name: windowName(w.window_minutes ?? 0), usedPercent: w.used_percent, resetsAt: w.resets_at ? w.resets_at * 1000 : undefined })
        }
      }
      if (windows.length) return { provider: 'codex', observedAt, plan: found.plan_type ?? undefined, windows }
    } catch {
      // Partial or unrelated line; keep scanning backwards.
    }
  }
  return null
}

/** Claude's stream-json `rate_limit_event`. */
export function parseClaudeRateLimit(event: any, observedAt: number): UsageSnapshot | null {
  const info = event?.rate_limit_info
  const unified = info?.unifiedWindows
  if (!unified) return null
  const names: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly (Opus)' }
  const windows = Object.entries(unified as Record<string, { utilization?: number; resetsAt?: number }>)
    .filter(([, w]) => typeof w?.utilization === 'number')
    .map(([k, w]) => ({ name: names[k] ?? k.replace(/_/g, ' '), usedPercent: Math.round(w.utilization! * 1000) / 10, resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined }))
  return windows.length ? { provider: 'claude', observedAt, windows } : null
}

/** A nudge when a meaningful share of the weekly Codex allowance will reset unused within half a day. */
export function allowanceNudge(codex: UsageSnapshot | null, now: number): { left: number; hours: number } | null {
  const weekly = codex?.windows.find((w) => w.name === 'weekly')
  if (!weekly?.resetsAt || weekly.resetsAt < now) return null
  const left = 100 - weekly.usedPercent
  const hours = (weekly.resetsAt - now) / 3600_000
  return left >= 20 && hours <= 12 ? { left: Math.round(left), hours: Math.max(1, Math.round(hours)) } : null
}

function findKey(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  if (key in (obj as object)) return (obj as Record<string, unknown>)[key]
  for (const v of Object.values(obj as object)) {
    const f = findKey(v, key)
    if (f !== undefined) return f
  }
  return undefined
}
