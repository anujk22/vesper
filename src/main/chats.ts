import { app } from 'electron'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cosine } from '../core/retrieval'
import type { Swarm } from '../core/swarm'
import type { ChatSummary, ModelChoice, Turn } from '../core/types'

interface SavedChat {
  id: string
  title: string
  at: number
  turns: Turn[]
  sessions: Partial<Record<ModelChoice['provider'], string>>
  swarms?: Swarm[]
}

/** Talk conversations, one JSON file each, so any chat can be reopened and continued. */
export class ChatStore {
  private dir = join(app.getPath('userData'), 'chats')
  private index = new Map<string, ChatSummary>()
  private loaded = new Map<string, SavedChat>()
  private vectors = new Map<string, number[]>()
  /** Set by main once the local sidecar can embed text. */
  embedder: ((texts: string[], query: boolean) => Promise<number[][] | null>) | null = null

  constructor() {
    mkdirSync(this.dir, { recursive: true })
    for (const f of readdirSync(this.dir).filter((x) => x.endsWith('.json'))) {
      try {
        const c = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as SavedChat
        this.index.set(c.id, { id: c.id, title: c.title, at: c.at, count: c.turns.length })
      } catch {
        // A damaged file is skipped, not fatal.
      }
    }
  }

  list(): ChatSummary[] {
    return [...this.index.values()].sort((a, b) => b.at - a.at)
  }

  save(id: string, turns: Turn[], sessions: SavedChat['sessions'], swarms: Swarm[] = []) {
    const first = turns.find((t) => t.speaker === 'user')
    if (!first) return
    const title = first.text.replace(/\s+/g, ' ').slice(0, 80)
    const at = turns.at(-1)?.at ?? Date.now()
    const chat: SavedChat = { id, title, at, turns, sessions, ...(swarms.length ? { swarms } : {}) }
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(chat))
    this.index.set(id, { id, title, at, count: turns.length })
    this.loaded.set(id, structuredClone(chat))
  }

  load(id: string): SavedChat {
    const c = structuredClone(this.loaded.get(id)) ?? (JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as SavedChat)
    // A reply cut off by quitting stays as it was, not stuck "thinking".
    c.turns = c.turns.map((t) => (t.pending ? { ...t, pending: false, text: t.text || '(interrupted)' } : t))
    return c
  }

  /**
   * Exchanges from other chats in the last two weeks that are about what Anuj just said, so a detail
   * mentioned in one chat can be pieced together in the next. Matched by meaning with the local embedder.
   */
  async recall(query: string, exclude: string, limit = 3): Promise<string> {
    if (!this.embedder) return ''
    const since = Date.now() - 14 * 86400_000
    const items: { key: string; at: number; text: string }[] = []
    for (const s of this.list()) {
      if (s.id === exclude || s.at < since) continue
      const { turns } = this.load(s.id)
      turns.forEach((t, i) => {
        const reply = turns.slice(i + 1).find((x) => x.speaker !== 'user')
        if (t.speaker === 'user' && t.text) items.push({ key: `${s.id}:${t.id}`, at: t.at, text: `Anuj: ${t.text.slice(0, 600)}${reply?.text ? `\nYou: ${reply.text.slice(0, 500)}` : ''}` })
      })
    }
    const missing = items.filter((x) => !this.vectors.has(x.key))
    for (let i = 0; i < missing.length; i += 64) {
      const vecs = await this.embedder(missing.slice(i, i + 64).map((x) => x.text), false)
      if (!vecs) return ''
      missing.slice(i, i + 64).forEach((x, j) => this.vectors.set(x.key, vecs[j]))
    }
    const qv = (await this.embedder([query], true))?.[0]
    if (!qv || !items.length) return ''
    const scored = items.map((x) => ({ ...x, score: cosine(qv, this.vectors.get(x.key)!) }))
    const best = Math.max(...scored.map((x) => x.score))
    // Same bar as vault context: only strong meaning matches, never filler.
    const cutoff = Math.max(0.63, best - 0.06)
    return scored
      .filter((x) => x.score >= cutoff)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .sort((a, b) => a.at - b.at)
      .map((x) => `[${new Date(x.at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })}]\n${x.text}`)
      .join('\n\n')
  }
}
