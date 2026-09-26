// A team of parallel agents (Ultra): each has a nickname, a color and a stance, works in its own
// column, can read what the others said, and answers Anuj directly. The main chat moderates.

export interface SwarmMessage {
  id: string
  /** Who wrote it: the agent itself, Anuj, or another agent (by id). */
  from: 'agent' | 'user'
  text: string
  at: number
  pending?: boolean
  error?: boolean
  thinking?: string
  thoughtMs?: number
  activity?: string[]
  web?: { title: string; url: string }[]
  /** Debate round the message belongs to; user exchanges have none. */
  round?: number
}

export interface SwarmAgent {
  id: string
  name: string
  color: string
  /** OKLCH hue of the agent's orb (same shader as Vesper's, recolored). */
  hue: number
  /** One line: who this agent is and the angle it takes. */
  persona: string
  task: string
  messages: SwarmMessage[]
}

export interface Swarm {
  id: string
  chatId: string
  goal: string
  /** Debate: agents answer, then respond to each other. Parallel: each takes a part; no rounds. */
  mode: 'debate' | 'parallel'
  rounds: number
  round: number
  research: boolean
  agents: SwarmAgent[]
  status: 'planning' | 'running' | 'done' | 'stopped' | 'error'
  startedAt: number
}

/** Distinct on the dark glass and away from Vesper's own blue; each color's OKLCH hue tints its orb. */
export const SWARM_PALETTE = [
  { color: '#ff8a5c', hue: 45 },
  { color: '#5ce0b8', hue: 170 },
  { color: '#f5c542', hue: 90 },
  { color: '#c58cff', hue: 305 },
  { color: '#ff6fa8', hue: 355 },
  { color: '#7fe36a', hue: 140 }
]

export interface SwarmPlan {
  mode: 'debate' | 'parallel'
  rounds: number
  research: boolean
  agents: { name: string; persona: string; task: string }[]
}

export function swarmPlanPrompt(goal: string, count: number | undefined, now: string): string {
  return `Today is ${now}. Anuj wants a team of parallel AI agents for this:

${goal}

Design the team. ${count ? `Exactly ${count} agents.` : 'Two to four agents, only as many as genuinely help.'} Give each: a nickname that is a real first name (like Juno, Rex, Mira or Otto, never a role word like Optimist or Skeptic), a one-line persona that makes its angle distinct, and its task. Choose "debate" when the agents should argue and respond to each other, "parallel" when each covers a separate part. Set "research" true when facts from the web matter. Rounds: 1 for parallel, 2 or 3 for debate.

Reply with only JSON: {"mode":"debate|parallel","rounds":n,"research":true|false,"agents":[{"name":"...","persona":"...","task":"..."}]}`
}

export function parseSwarmPlan(text: string, count?: number): SwarmPlan | null {
  try {
    const d = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '')
    const agents = (Array.isArray(d.agents) ? d.agents : [])
      .filter((a: { name?: unknown }) => typeof a?.name === 'string' && a.name.trim())
      .slice(0, count ?? 4)
      .map((a: { name: string; persona?: string; task?: string }) => ({ name: a.name.trim().split(/\s+/)[0].slice(0, 16), persona: String(a.persona ?? ''), task: String(a.task ?? '') }))
    if (agents.length < 2) return null
    const mode = d.mode === 'parallel' ? 'parallel' : 'debate'
    const rounds = mode === 'parallel' ? 1 : Math.min(3, Math.max(2, Number(d.rounds) || 2))
    return { mode, rounds, research: !!d.research, agents }
  } catch {
    return null
  }
}

/** What an agent sees of the others: each one's latest finished message, labeled by nickname. */
export function peerDigest(swarm: Swarm, except: string): string {
  return swarm.agents
    .filter((a) => a.id !== except)
    .map((a) => {
      const last = [...a.messages].reverse().find((m) => m.from === 'agent' && !m.pending && !m.error && m.text)
      return last ? `${a.name} (${a.persona}):\n${last.text.slice(0, 2500)}` : ''
    })
    .filter(Boolean)
    .join('\n\n---\n\n')
}
