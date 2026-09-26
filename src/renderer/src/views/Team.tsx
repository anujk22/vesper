import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Swarm, SwarmAgent, SwarmMessage } from '../../../core/swarm'
import type { Turn } from '../../../core/types'
import { Markdown } from '../components/Markdown'
import { Orb } from '../orb/Orb'
import { Trace } from './Talk'

const statusLine = (s: Swarm) =>
  s.status === 'planning'
    ? 'Putting the team together'
    : s.status === 'running'
      ? s.mode === 'debate'
        ? `Debating · round ${s.round} of ${s.rounds}`
        : 'Working in parallel'
      : s.status === 'done'
        ? 'Finished · verdict in the main chat'
        : s.status === 'stopped'
          ? 'Stopped'
          : 'Failed'

const silent = () => 0

/** An agent's orb: Vesper's own shader, recolored. It moves only while the agent is working. */
export function AgentOrb({ agent, live, size }: { agent: SwarmAgent; live: boolean; size: number }) {
  return <Orb mode={live ? 'thinking' : 'idle'} level={silent} moons={0} size={size} radius={0.62} accent={{ hue: agent.hue, chroma: 1.35 }} className="agent-orb" />
}

/**
 * The team beside the main chat. A roster of agents on top (click one to follow only it, or @ to
 * talk to it from the main composer) and one shared floor below: every message in order, grouped
 * by round, colored by who said it. A debate reads top to bottom instead of across cramped columns.
 */
export function TeamPanel({ swarm, onHide, onMention }: { swarm: Swarm; onHide: () => void; onMention: (name: string) => void }) {
  const api = window.bluevis
  const [focus, setFocus] = useState<string | null>(null)
  const floor = useRef<HTMLDivElement>(null)
  const entries = swarm.agents
    .flatMap((a, i) => a.messages.map((m) => ({ a, i, m })))
    .filter((e) => !focus || e.a.id === focus)
    // Rounds in order, agents in roster order within a round; direct exchanges follow by time.
    .sort((x, y) => (x.m.round ?? 99) - (y.m.round ?? 99) || (x.m.round ? x.i - y.i : x.m.at - y.m.at))
  useLayoutEffect(() => {
    const el = floor.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [swarm])
  let lastRound: number | undefined = -1
  return (
    <section className="team" aria-label="Agent team">
      <header className="team-head">
        <div className="team-title">
          <span className="eyebrow">{statusLine(swarm)}</span>
          <h2 title={swarm.goal}>{swarm.goal}</h2>
        </div>
        {(swarm.status === 'running' || swarm.status === 'planning') && (
          <button className="btn btn-quiet" onClick={() => api.swarm.stop(swarm.id)}>
            Stop team
          </button>
        )}
        <button className="btn btn-quiet" onClick={onHide}>
          Hide
        </button>
      </header>
      <div className="roster">
        {swarm.agents.map((a, i) => {
          const live = a.messages.some((m) => m.pending)
          return (
            <div key={a.id} className="roster-agent" data-focus={focus === a.id} data-dim={!!focus && focus !== a.id} style={{ ['--agent' as string]: a.color, animationDelay: `${i * 90}ms` } as CSSProperties}>
              <button className="roster-main" onClick={() => setFocus(focus === a.id ? null : a.id)} title={focus === a.id ? 'Show everyone' : `Show only ${a.name}`}>
                <AgentOrb agent={a} live={live} size={46} />
                <span className="roster-id">
                  <span className="roster-name">{a.name}</span>
                  <span className="roster-persona">{a.persona}</span>
                </span>
              </button>
              <button className="roster-at mono" onClick={() => onMention(a.name)} title={`Talk to ${a.name}`} aria-label={`Talk to ${a.name}`}>
                @
              </button>
            </div>
          )
        })}
        {swarm.status === 'planning' && <div className="team-planning mono">Choosing who should be on it…</div>}
      </div>
      <div className="floor" ref={floor}>
        {entries.map(({ a, m }) => {
          const header = m.round !== lastRound && swarm.mode === 'debate' ? (m.round ? `Round ${m.round}` : 'Direct') : null
          lastRound = m.round
          return (
            <div key={m.id}>
              {header && <div className="eyebrow floor-round">{header}</div>}
              <FloorEntry agent={a} m={m} />
            </div>
          )
        })}
      </div>
    </section>
  )
}

function FloorEntry({ agent, m }: { agent: SwarmAgent; m: SwarmMessage }) {
  if (m.from === 'user')
    return (
      <div className="floor-entry floor-user">
        <span className="floor-who mono">You to {agent.name}</span>
        <div className="floor-text">{m.text}</div>
      </div>
    )
  return (
    <div className="floor-entry" data-error={!!m.error} style={{ ['--agent' as string]: agent.color } as CSSProperties}>
      <span className="floor-who">
        <span className="floor-dot" data-live={!!m.pending} />
        {agent.name}
      </span>
      <Trace turn={m as unknown as Turn} />
      {m.text ? <Markdown className="floor-text" text={m.text} /> : m.pending && !m.thinking && !m.activity?.length && <span className="floor-wait mono">getting started</span>}
    </div>
  )
}

/** A small flat dot in an agent's color, for compact places (the team card, the chat bar). */
export function AgentDot({ agent, live, size = 12 }: { agent: Pick<SwarmAgent, 'color'>; live?: boolean; size?: number }) {
  return <span className="agent-dot" data-live={!!live} style={{ ['--agent' as string]: agent.color, width: size, height: size } as CSSProperties} aria-hidden="true" />
}
