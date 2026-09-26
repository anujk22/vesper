import { powerMonitor } from 'electron'
import { nearDuplicates } from '../core/consolidate'
import type { ModelChoice } from '../core/types'
import { runProvider } from './providers'
import { getSettings } from './settings'
import type { Vault } from './vault'

// Background memory upkeep. It runs only when it costs Anuj nothing: plugged in, the Mac idle for
// ten minutes, no thermal pressure, Vesper not busy, and at most once every thirty minutes. Each
// run does one small unit of work, so it never keeps the GPU (or the fans) busy for long.
const TICK = 5 * 60_000
const IDLE_SECONDS = 10 * 60
const GAP = 30 * 60_000

function ask(prompt: string, cwd: string): Promise<string> {
  const s = getSettings()
  // Idle time on a local model is free, so it thinks as hard as it can.
  const choice: ModelChoice = { ...s.brain, effort: 'high' }
  return new Promise((resolve, reject) => {
    let text = ''
    let failed: string | null = null
    const h = runProvider({
      choice,
      prompt,
      cwd,
      role: 'brain',
      localBaseUrl: s.localBaseUrl,
      system: 'You maintain a personal knowledge base. Be exact; never invent facts. Reply with JSON only.',
      onEvent: (e) => {
        if (e.kind === 'text-delta') text += e.text
        if (e.kind === 'message') text = e.text
        if (e.kind === 'error') failed = e.message
      }
    })
    void h.done.then(() => (failed && !text ? reject(new Error(failed)) : resolve(text)))
  })
}

export function startIdleWork(o: { vault: Vault; cwd: string; embed: (texts: string[]) => Promise<number[][] | null>; busy: () => boolean }) {
  let last = 0
  let running = false
  const calm = () => {
    const thermal = (powerMonitor as unknown as { getCurrentThermalState?: () => string }).getCurrentThermalState?.() ?? 'unknown'
    return !['serious', 'critical'].includes(thermal)
  }
  setInterval(async () => {
    const s = getSettings()
    if (running || Date.now() - last < GAP || s.brain.provider !== 'local') return
    if (powerMonitor.isOnBatteryPower() || powerMonitor.getSystemIdleTime() < IDLE_SECONDS || !calm() || o.busy()) return
    running = true
    last = Date.now()
    try {
      await o.vault.refreshEmbeddings()
      const notes = o.vault.inbox()
      if (notes.length < 2) return
      const vecs = await o.embed(notes.map((n) => `${n.title}. ${n.body.slice(0, 1500)}`))
      if (!vecs) return
      const group = nearDuplicates(notes.map((n, i) => ({ path: n.path, vec: vecs[i] })))[0]?.slice(0, 5)
      if (!group) return
      const picked = notes.filter((n) => group.includes(n.path))
      const reply = await ask(
        `These notes in Anuj's knowledge base were captured automatically and look like near-duplicates. Merge them into one note that keeps every distinct fact, date and name, and drops repetition. If they are actually about different things, say so.

${picked.map((n) => `### ${n.title} (${n.path})\n${n.body.trim()}`).join('\n\n')}

Reply with only JSON: {"same": true|false, "title": "short title", "text": "the merged note in markdown"}`,
        o.cwd
      )
      const d = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { same?: boolean; title?: string; text?: string }
      // Re-check just before writing: Anuj may have come back while the model was thinking.
      if (d.same && d.title && d.text && !o.busy() && powerMonitor.getSystemIdleTime() >= 60) await o.vault.consolidate(group, d.title, d.text)
    } catch {
      // Background upkeep never surfaces errors; the next idle window tries again.
    } finally {
      running = false
    }
  }, TICK)
}
