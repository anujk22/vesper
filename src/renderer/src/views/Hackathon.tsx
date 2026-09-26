import { useEffect, useState } from 'react'
import { formatLeft, hackStatus, type Hackathon } from '../../../core/hackathon'
import type { AgentTask } from '../../../core/types'
import { Markdown } from '../components/Markdown'
import { TaskStatus } from '../components/TaskStatus'

const toLocal = (t: number) => {
  const d = new Date(t)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function HackDashboard({ h, tasks, onOpenTerminal, onOpenTask }: { h: Hackathon; tasks: AgentTask[]; onOpenTerminal: (cwd: string, title: string) => void; onOpenTask: (id: string) => void }) {
  const api = window.bluevis
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [agent, setAgent] = useState<'codex' | 'claude'>('codex')
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])
  const s = hackStatus(h, now)
  const span = h.deadline - h.startedAt
  const update = (patch: Partial<Hackathon>) => api.hackathons.update(h.id, patch)
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(null)
    }
  }
  const toggle = (id: string) => update({ milestones: h.milestones.map((m) => (m.id === id ? { ...m, done: !m.done } : m)) })

  return (
    <div className="hack">
      <header className="hack-head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">{h.url.replace('https://', '')}</div>
          <h2>{h.title}</h2>
        </div>
        <div className="countdown" data-urgent={s.left < 3 * 3600_000}>
          <span className="n">{formatLeft(s.left).replace(' left', '')}</span>
          <span className="eyebrow">{s.left > 0 ? 'left to submit' : ''}</span>
        </div>
      </header>

      <div className="timeline" aria-label="Build timeline">
        <div className="fill" style={{ width: `${s.progress * 100}%` }} />
        {h.milestones.map((m) => (
          <i
            key={m.id}
            title={`Hour ${m.hour}: ${m.title}`}
            data-s={m.done ? 'done' : s.behind.includes(m) ? 'behind' : 'open'}
            style={{ left: `${Math.min(100, ((m.hour * 3600_000) / span) * 100)}%` }}
          />
        ))}
      </div>
      <div className="hack-meta">
        <label className="mono">
          Deadline{' '}
          <input type="datetime-local" className="input mono" value={toLocal(h.deadline)} onChange={(e) => e.target.value && update({ deadline: new Date(e.target.value).getTime() })} />
        </label>
        {s.behind.length > 0 && <span className="behind">Behind on {s.behind.length === 1 ? s.behind[0].title : `${s.behind.length} checkpoints`}</span>}
        <button className="btn btn-quiet" style={{ marginLeft: 'auto' }} onClick={() => update({ active: !h.active })}>
          {h.active ? 'Leave hackathon mode' : 'Resume hackathon mode'}
        </button>
      </div>
      {error && <p className="notice">{error}</p>}

      <div className="hack-grid">
        <section className="card">
          <div className="card-head">
            <h3>Checkpoints</h3>
            {h.projectPath ? (
              <button className="btn btn-quiet" onClick={() => onOpenTerminal(h.projectPath!, h.title)}>
                Open terminal
              </button>
            ) : (
              <button className="btn" disabled={!!busy} onClick={() => act('scaffold', () => api.hackathons.scaffold(h.id))}>
                {busy === 'scaffold' ? 'Creating…' : 'Create project folder'}
              </button>
            )}
          </div>
          {h.projectPath && <div className="mono path">{h.projectPath.replace(/^\/Users\/[^/]+/, '~')}</div>}
          <ul className="checkpoints">
            {h.milestones
              .slice()
              .sort((a, b) => a.hour - b.hour)
              .map((m) => {
                const task = tasks.find((t) => t.id === m.taskId)
                return (
                  <li key={m.id} data-s={m.done ? 'done' : s.behind.includes(m) ? 'behind' : s.next === m ? 'next' : 'open'}>
                    <input type="checkbox" checked={m.done} onChange={() => toggle(m.id)} aria-label={`Done: ${m.title}`} />
                    <span className="mono hr">h{m.hour}</span>
                    <span className="t">{m.title}</span>
                    {task ? (
                      <button className="linkish" onClick={() => onOpenTask(task.id)}>
                        <TaskStatus status={task.status} />
                      </button>
                    ) : (
                      !m.done && (
                        <label className="pick" title="Select for an agent">
                          <input
                            type="checkbox"
                            checked={picked.has(m.id)}
                            onChange={() => {
                              const n = new Set(picked)
                              if (n.has(m.id)) n.delete(m.id)
                              else n.add(m.id)
                              setPicked(n)
                            }}
                          />
                          agent
                        </label>
                      )
                    )}
                  </li>
                )
              })}
          </ul>
          {h.milestones.length === 0 && <p className="panel-sub">No checkpoints were found in the plan.</p>}
          <div className="row" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <select className="select" value={agent} onChange={(e) => setAgent(e.target.value as 'codex' | 'claude')} aria-label="Agent">
              <option value="codex">Codex</option>
              <option value="claude">Claude Opus</option>
            </select>
            <button
              className="btn btn-primary"
              disabled={!picked.size || !!busy}
              onClick={() =>
                act('agents', async () => {
                  await api.hackathons.agents(h.id, [...picked], agent)
                  setPicked(new Set())
                })
              }
            >
              {busy === 'agents' ? 'Starting…' : `Start ${picked.size || ''} agent${picked.size === 1 ? '' : 's'}`}
            </button>
          </div>
          <p className="fine">Each agent works on its own branch in its own copy of the repo, so they never collide. Merge what works.</p>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Judging</h3>
          </div>
          <ul className="criteria">
            {h.criteria.map((c) => (
              <li key={c.id} data-covered={!!c.coveredBy.trim()}>
                <div className="t">{c.name}</div>
                <div className="d">{c.detail}</div>
                <input
                  className="input"
                  defaultValue={c.coveredBy}
                  placeholder="What in the demo covers this?"
                  onBlur={(e) => e.target.value !== c.coveredBy && update({ criteria: h.criteria.map((x) => (x.id === c.id ? { ...x, coveredBy: e.target.value } : x)) })}
                  aria-label={`Covered by, for ${c.name}`}
                />
              </li>
            ))}
          </ul>
          {h.hook && (
            <div className="hook">
              <span className="eyebrow">The hook</span>
              <p>{h.hook}</p>
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h3>Submission kit</h3>
          <button className="btn" disabled={!!busy} onClick={() => act('kit', () => api.hackathons.kit(h.id))}>
            {busy === 'kit' ? 'Writing…' : h.kit ? 'Rewrite from latest commits' : 'Write the kit'}
          </button>
        </div>
        {h.kit ? (
          <div className="kit">
            <ul className="checklist">
              {h.kit.checklist.map((c, i) => (
                <li key={i}>
                  <label>
                    <input type="checkbox" checked={c.done} onChange={() => update({ kit: { ...h.kit!, checklist: h.kit!.checklist.map((x, j) => (j === i ? { ...x, done: !x.done } : x)) } })} />
                    {c.text}
                  </label>
                </li>
              ))}
            </ul>
            <details open>
              <summary className="eyebrow">90 second demo script</summary>
              <Markdown text={h.kit.script} />
            </details>
            <details>
              <summary className="eyebrow">Devpost write-up</summary>
              <Markdown text={h.kit.writeup} />
            </details>
          </div>
        ) : (
          <p className="panel-sub">A Devpost write-up, a 90 second demo script and a submission checklist, written from the plan and what your commits show. Saved to the vault too.</p>
        )}
      </section>
    </div>
  )
}
