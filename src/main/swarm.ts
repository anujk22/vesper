import { randomUUID } from 'node:crypto'
import { parseSwarmPlan, peerDigest, SWARM_PALETTE, swarmPlanPrompt, type Swarm, type SwarmAgent, type SwarmMessage } from '../core/swarm'
import type { ModelChoice } from '../core/types'
import { runProvider, type RunHandle } from './providers'
import { webSearch } from './search'
import { getSettings } from './settings'
import { heavy } from './splash'

interface Call {
  prompt: string
  system: string
  effort?: ModelChoice['effort'] | 'none'
  onThinking?: (t: string) => void
  onText?: (t: string) => void
}

const now = () => new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', dateStyle: 'long' })

/**
 * Runs agent teams. Every agent is its own concurrent request to the conversation model (Splash
 * serves several at once), streams into its own column, and reads the others' latest messages
 * between rounds. The main chat stays in charge: it launches the team and writes the verdict.
 */
export class SwarmManager {
  private swarms = new Map<string, Swarm>()
  private handles = new Map<string, Set<RunHandle>>()
  private dirty = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(
    private cwd: string,
    private emit: (s: Swarm) => void,
    /** Called when a team finishes its rounds, so the main chat can write the verdict. */
    private onFinished: (s: Swarm) => void
  ) {}

  forChat(chatId: string): Swarm[] {
    return [...this.swarms.values()].filter((s) => s.chatId === chatId)
  }

  running() {
    return [...this.swarms.values()].some((s) => s.status === 'running' || s.status === 'planning')
  }

  get(id: string) {
    return this.swarms.get(id)
  }

  /** Restore a reopened chat's teams; anything cut off mid-run stays as it was, marked stopped. */
  load(swarms: Swarm[]) {
    for (const s of swarms) {
      if (s.status === 'running' || s.status === 'planning') s.status = 'stopped'
      s.agents.forEach((a, i) => (a.hue ??= SWARM_PALETTE[i % SWARM_PALETTE.length].hue))
      for (const a of s.agents) a.messages = a.messages.map((m) => (m.pending ? { ...m, pending: false, text: m.text || '(interrupted)' } : m))
      this.swarms.set(s.id, s)
    }
  }

  /** Streaming updates arrive per token from several agents; coalesce them into one update per swarm every 60ms. */
  private touch(s: Swarm) {
    this.dirty.add(s.id)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      for (const id of this.dirty) {
        const sw = this.swarms.get(id)
        if (sw) this.emit(structuredClone(sw))
      }
      this.dirty.clear()
    }, 60)
  }

  private call(swarmId: string, c: Call): Promise<string> {
    const s = getSettings()
    const { effort: _, ...base } = s.brain
    // Teams think on the dense model (loaded on demand) when conversation runs on a Splash model.
    const choice = heavy(c.effort === 'none' || !c.effort ? base : { ...base, effort: c.effort })
    return new Promise((resolve, reject) => {
      let text = ''
      let streamed = ''
      let failed: string | null = null
      const handle = runProvider({
        choice,
        prompt: c.prompt,
        system: c.system,
        cwd: this.cwd,
        role: 'brain',
        localBaseUrl: s.localBaseUrl,
        onEvent: (e) => {
          if (e.kind === 'thinking-delta') c.onThinking?.(e.text)
          if (e.kind === 'text-delta') c.onText?.((streamed += e.text))
          if (e.kind === 'message') text = e.text
          if (e.kind === 'error') failed = e.message
        }
      })
      const set = this.handles.get(swarmId) ?? new Set()
      set.add(handle)
      this.handles.set(swarmId, set)
      void handle.done.then(() => {
        set.delete(handle)
        if (failed && !text && !streamed) reject(new Error(failed))
        else resolve((text || streamed).trim())
      })
    })
  }

  private system(a: SwarmAgent, s: Swarm) {
    const team = s.agents.map((x) => `${x.name} (${x.persona})`).join(', ')
    return `You are ${a.name}, one of ${s.agents.length} AI agents Anuj launched in Vesper to work on: "${s.goal}". The team: ${team}.
Your persona: ${a.persona}. Stay in character and keep your own angle; do not drift toward agreement unless you are genuinely persuaded.
Be concise: under 170 words per message, plain prose or a few bullets. Refer to teammates by name. Cite web sources as [n] when you use them. No em dashes.`
  }

  /** Stream one agent message into its column. */
  private async speak(s: Swarm, a: SwarmAgent, prompt: string, round?: number) {
    const m: SwarmMessage = { id: randomUUID(), from: 'agent', text: '', at: Date.now(), pending: true, round, activity: [] }
    a.messages.push(m)
    this.touch(s)
    try {
      let sources = ''
      if (s.research && round === 1) {
        const q = await this.call(s.id, { system: this.system(a, s), effort: 'none', prompt: `Today is ${now()}. Your task: ${a.task}\nWrite one web search query that would find evidence for your angle. Reply with only the query.` })
        const query = q.replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 200) || s.goal
        const results = await webSearch(query, 5).catch(() => [])
        m.activity = [`Searched "${query}" · ${results.length} results`]
        m.web = results.map((r) => ({ title: r.title || r.url, url: r.url }))
        sources = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.text.slice(0, 1400)}`).join('\n\n')
        this.touch(s)
      }
      const text = await this.call(s.id, {
        system: this.system(a, s),
        effort: 'low',
        prompt: sources ? `${prompt}\n\n<sources>\n${sources}\n</sources>` : prompt,
        onThinking: (t) => {
          m.thinking = (m.thinking ?? '') + t
          this.touch(s)
        },
        onText: (partial) => {
          if (m.thinking && m.thoughtMs === undefined) m.thoughtMs = Date.now() - m.at
          m.text = partial.replace(/\n\s*---\s*\n/g, '\n\n')
          this.touch(s)
        }
      })
      m.text = text.replace(/\n\s*---\s*\n/g, '\n\n') || '(no reply)'
    } catch (e) {
      m.error = true
      m.text = (e as Error).message === 'Stopped' ? 'Stopped.' : `Failed: ${(e as Error).message}`
    }
    m.pending = false
    if (!m.activity?.length) delete m.activity
    this.touch(s)
  }

  /** Plan the team, then run its rounds. Resolves when the rounds are done (or stopped). */
  async start(chatId: string, goal: string, count?: number): Promise<Swarm> {
    const s: Swarm = { id: randomUUID(), chatId, goal, mode: 'debate', rounds: 2, round: 0, research: false, agents: [], status: 'planning', startedAt: Date.now() }
    this.swarms.set(s.id, s)
    this.touch(s)
    const plan = parseSwarmPlan(await this.call(s.id, { system: 'You design small teams of AI agents. Reply with JSON only.', effort: 'none', prompt: swarmPlanPrompt(goal, count, now()) }).catch(() => ''), count)
    if (!plan) {
      s.status = 'error'
      this.touch(s)
      throw new Error('Could not plan the team. Try rephrasing what the agents should do.')
    }
    Object.assign(s, { mode: plan.mode, rounds: plan.rounds, research: plan.research, status: 'running' as const })
    s.agents = plan.agents.map((a, i) => ({ id: randomUUID(), name: a.name, persona: a.persona, task: a.task, ...SWARM_PALETTE[i % SWARM_PALETTE.length], messages: [] }))
    this.touch(s)
    void this.run(s)
    return s
  }

  private async run(s: Swarm) {
    for (let r = 1; r <= s.rounds && s.status === 'running'; r++) {
      s.round = r
      this.touch(s)
      await Promise.all(
        s.agents.map((a) =>
          this.speak(
            s,
            a,
            r === 1
              ? `Goal: ${s.goal}\nYour task: ${a.task}\n\nGive your opening take.`
              : `Round ${r} of ${s.rounds}. What your teammates said last:\n\n${peerDigest(s, a.id)}\n\nRespond to them by name: take on their strongest points, concede what is right, and sharpen your position.${r === s.rounds ? ' This is the last round; end with your bottom line in one sentence.' : ''}`,
            r
          )
        )
      )
    }
    if (s.status !== 'running') return
    s.status = 'done'
    this.touch(s)
    this.onFinished(s)
  }

  /** Anuj talking to one agent directly: it answers in character, aware of what the others said. */
  async ask(swarmId: string, agentId: string, text: string) {
    const s = this.swarms.get(swarmId)
    const a = s?.agents.find((x) => x.id === agentId)
    if (!s || !a) throw new Error('That agent is gone.')
    a.messages.push({ id: randomUUID(), from: 'user', text, at: Date.now() })
    const mine = a.messages
      .filter((m) => m.text && !m.pending)
      .slice(-8)
      .map((m) => `${m.from === 'user' ? 'Anuj' : a.name}: ${m.text.slice(0, 1500)}`)
      .join('\n\n')
    await this.speak(s, a, `Your conversation so far:\n${mine}\n\nWhat your teammates said last:\n${peerDigest(s, a.id) || '(nothing yet)'}\n\nAnuj just asked you: ${text}\nAnswer Anuj directly.`)
  }

  stop(swarmId: string) {
    const s = this.swarms.get(swarmId)
    if (!s) return
    if (s.status === 'running' || s.status === 'planning') s.status = 'stopped'
    for (const h of this.handles.get(swarmId) ?? []) h.stop()
    this.touch(s)
  }
}
