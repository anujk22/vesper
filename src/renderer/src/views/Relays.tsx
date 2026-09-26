import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RelayRun, StageRun } from '../../../core/relay'
import { Markdown } from '../components/Markdown'
import { formatLeft, type Hackathon } from '../../../core/hackathon'
import type { AgentTask } from '../../../core/types'
import { HackDashboard } from './Hackathon'

const GLYPH: Record<StageRun['status'], string> = { waiting: '○', running: '', done: '✓', failed: '✗', stopped: '■' }

function elapsed(s: StageRun) {
  if (!s.startedAt) return ''
  const sec = Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

export function Relays({
  runs,
  hacks,
  tasks,
  focus,
  onFocus,
  onOpenTerminal,
  onOpenTask
}: {
  runs: RelayRun[]
  hacks: Hackathon[]
  tasks: AgentTask[]
  focus: string | null
  onFocus: (id: string) => void
  onOpenTerminal: (cwd: string, title: string) => void
  onOpenTask: (id: string) => void
}) {
  const api = window.bluevis
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const hack = hacks.find((h) => h.id === focus) ?? (focus ? undefined : hacks.find((h) => h.active))
  const run = hack ? undefined : (runs.find((r) => r.id === focus) ?? runs[0])
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const start = async () => {
    if (!/devpost\.com/i.test(url)) return
    const r = (await api.relays.start(url.trim(), note.trim() || undefined)) as RelayRun
    onFocus(r.id)
    setUrl('')
    setNote('')
  }

  return (
    <div className="relays">
      <aside className="relay-list panel">
        <h2 className="panel-title">Hackathon</h2>
        <p className="panel-sub">Paste a Devpost link. Opus ideates, Astra challenges, Opus consolidates, all in the open. Then turn the plan into a build.</p>
        <div className="new-task">
          <input className="input" style={{ width: '100%', minWidth: 0 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://….devpost.com" aria-label="Devpost link" />
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything to steer it (optional)" aria-label="Note for the relay" style={{ minHeight: 44, marginTop: 8 }} />
          <div className="row">
            <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={!/devpost\.com/i.test(url)} onClick={start}>
              Start relay
            </button>
          </div>
        </div>
        {hacks.length > 0 && <div className="eyebrow side-head">Builds</div>}
        {hacks.map((h) => (
          <button key={h.id} className="list-item" aria-current={h.id === hack?.id} onClick={() => onFocus(h.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="eyebrow">{h.active ? 'locked in' : 'paused'}</span>
              <span className="mono" style={{ color: h.active ? 'var(--sky)' : 'var(--faint)' }}>
                {formatLeft(h.deadline - Date.now())}
              </span>
            </div>
            <div className="t">{h.title}</div>
          </button>
        ))}
        {runs.length > 0 && <div className="eyebrow side-head">Relays</div>}
        {runs.map((r) => (
          <button key={r.id} className="list-item" aria-current={!hack && r.id === run?.id} onClick={() => onFocus(r.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="eyebrow">{new Date(r.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
              <span className="status" data-s={r.status === 'done' ? 'completed-verified' : r.status}>
                {r.status === 'running' ? <span className="spin" /> : null}
                {r.status}
              </span>
            </div>
            <div className="t">{r.title}</div>
            <div className="relay-dots" aria-hidden="true">
              {r.stages.map((s) => (
                <i key={s.id} data-s={s.status} />
              ))}
            </div>
          </button>
        ))}
      </aside>
      <section className="relay-stage">
        {hack ? (
          <HackDashboard h={hack} tasks={tasks} onOpenTerminal={onOpenTerminal} onOpenTask={onOpenTask} />
        ) : run ? (
          <Pipeline run={run} hacks={hacks} onFocus={onFocus} />
        ) : (
          <Empty />
        )}
      </section>
    </div>
  )
}

function Empty() {
  return (
    <div className="empty">
      <h3>Nothing relayed yet</h3>
      <p>Paste a Devpost link on the left, or just say “brainstorm this” with the link. You will see every model's work as it happens.</p>
    </div>
  )
}

function Pipeline({ run, hacks, onFocus }: { run: RelayRun; hacks: Hackathon[]; onFocus: (id: string) => void }) {
  const api = window.bluevis
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const built = hacks.find((h) => h.relayId === run.id)
  const active = run.stages.findIndex((s) => s.status === 'running')
  const [pinned, setPinned] = useState<number | null>(null)
  const wide = pinned ?? (active >= 0 ? active : run.status === 'done' ? run.stages.length - 1 : 0)

  return (
    <div className="pipeline-wrap">
      <header className="pipeline-head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">{run.url.replace('https://', '')}</div>
          <h2>{run.title}</h2>
        </div>
        <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {run.outputPath && (
            <button className="btn" onClick={() => api.memory.open(run.outputPath)}>
              Open plan in vault
            </button>
          )}
          {run.status === 'running' && (
            <button className="btn" onClick={() => api.relays.stop(run.id)}>
              Stop relay
            </button>
          )}
          {run.status === 'done' &&
            (built ? (
              <button className="btn btn-primary" onClick={() => onFocus(built.id)}>
                Open the build
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={starting}
                title="Pulls the deadline, checkpoints and judging criteria out of the plan, and turns Vesper red until you submit"
                onClick={async () => {
                  setStarting(true)
                  setError(null)
                  try {
                    const h = (await api.hackathons.fromRelay(run.id)) as Hackathon
                    onFocus(h.id)
                  } catch (e) {
                    setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
                  }
                  setStarting(false)
                }}
              >
                {starting ? 'Reading the plan…' : 'Lock in: start building'}
              </button>
            ))}
        </div>
      </header>
      {error && <p className="notice">{error}</p>}
      <div className="pipeline">
        {run.stages.map((s, i) => (
          <div key={s.id} className="pipe-seg" style={{ flexGrow: i === wide ? 2.6 : 1 }}>
            {i > 0 && <div className="connector" data-live={s.status === 'running'} data-done={s.status !== 'waiting'} aria-hidden="true" />}
            <Column stage={s} index={i} wide={i === wide} onPick={() => setPinned(pinned === i ? null : i)} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Column({ stage: s, index, wide, onPick }: { stage: StageRun; index: number; wide: boolean; onPick: () => void }) {
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = body.current
    if (el && s.status === 'running') el.scrollTop = el.scrollHeight
  }, [s.text, s.events.length, s.status])
  return (
    <article className="column" data-s={s.status} data-wide={wide}>
      <button className="column-head" onClick={onPick} title={wide ? 'Unpin' : 'Expand this stage'}>
        <span className="step-no mono">{index + 1}</span>
        <span className="col-title">{s.label}</span>
        <span className="status" data-s={s.status === 'done' ? 'completed-verified' : s.status === 'failed' ? 'failed' : s.status}>
          {s.status === 'running' ? <span className="spin" /> : <span className="g">{GLYPH[s.status]}</span>}
          {elapsed(s)}
        </span>
      </button>
      <div className="actor mono">{s.actor}</div>
      {s.handoff && (
        <div className="handoff">
          <span className="eyebrow">Handed</span> {s.handoff}
        </div>
      )}
      <div className="column-body" ref={body}>
        {s.events.length > 0 && (
          <ul className="events">
            {s.events.slice(-40).map((e, i) => (
              <li key={i} className="mono">
                {e.label}
              </li>
            ))}
          </ul>
        )}
        {s.status === 'waiting' && <p className="waiting">Waiting for the previous stage.</p>}
        {s.status === 'running' && !s.text && s.events.length === 0 && <p className="waiting">Reading and thinking. Output appears here as it streams.</p>}
        {s.text &&
          (index === 0 ? (
            <pre className="page-text">{s.text.slice(0, wide ? 12000 : 1500)}</pre>
          ) : wide ? (
            <Markdown text={s.text} />
          ) : (
            <p className="preview">{s.text.replace(/[#*`>|_-]+/g, ' ').replace(/\s+/g, ' ').slice(0, 700)}</p>
          ))}
        {s.error && <p className="notice">{s.error}</p>}
      </div>
    </article>
  )
}

/** Compact progress used inline in the conversation. */
export function RelayInline({ run, onOpen }: { run: RelayRun; onOpen: () => void }) {
  const cur = run.stages.find((s) => s.status === 'running')
  return (
    <button className="task-inline" onClick={onOpen}>
      <span className="mono" style={{ color: 'var(--bone)' }}>
        Relay
      </span>
      <span className="mono" style={{ color: 'var(--mist)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {run.title}
      </span>
      <span className="relay-dots" aria-hidden="true">
        {run.stages.map((s) => (
          <i key={s.id} data-s={s.status} />
        ))}
      </span>
      <span className="step mono">{cur ? `${cur.label} · ${cur.actor}${cur.events.at(-1) ? ` · ${cur.events.at(-1)!.label}` : ''}` : run.status}</span>
    </button>
  )
}
