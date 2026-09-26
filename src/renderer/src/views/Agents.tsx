import { useEffect, useState } from 'react'
import type { AgentTask, Project, Settings } from '../../../core/types'
import { Markdown } from '../components/Markdown'
import { TaskStatus } from '../components/TaskStatus'
import { TerminalPane } from '../components/TerminalPane'
import { dispose } from '../terminals'
import type { TerminalInfo } from '../../../core/terminal'

const LIVE = new Set(['starting', 'investigating', 'editing', 'testing', 'awaiting-approval'])

function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function agentLabel(t: AgentTask) {
  return `${t.choice.provider === 'codex' ? 'Codex' : t.choice.provider === 'claude' ? 'Claude' : 'Local'} · ${t.choice.model}`
}

export function Agents({
  tasks,
  focus,
  onFocus,
  settings,
  terms,
  termFocus,
  onTermFocus,
  onTakeOver
}: {
  tasks: AgentTask[]
  focus: string | null
  onFocus: (id: string) => void
  settings: Settings | null
  terms: TerminalInfo[]
  termFocus: string | null
  onTermFocus: (id: string | null) => void
  onTakeOver: (t: AgentTask) => void
}) {
  const api = window.bluevis
  const selected = tasks.find((t) => t.id === focus) ?? tasks[0]
  const term = terms.find((t) => t.id === termFocus)
  const [split, setSplit] = useState<string | null>(null)
  const side = split && split !== term?.id ? terms.find((t) => t.id === split) : undefined
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [])

  const close = async (id: string) => {
    await api.terminals.kill(id)
    dispose(id)
    if (split === id) setSplit(null)
    if (termFocus === id) onTermFocus(terms.find((t) => t.id !== id && t.id !== split)?.id ?? split ?? null)
  }
  const splitFrom = async (t: TerminalInfo) => {
    const n = (await api.terminals.create({ cwd: t.cwd })) as TerminalInfo
    setSplit(n.id)
  }

  return (
    <div className="split agents">
      <aside className="panel">
        <h2 className="panel-title">Work</h2>
        <p className="panel-sub">Terminals and agents, side by side. Ask Vesper about the terminal you are looking at and it can read it.</p>
        <div className="eyebrow side-head">Terminals</div>
        <NewTerminal onOpen={(t) => onTermFocus(t.id)} />
        {terms.map((t) => (
          <button key={t.id} className="list-item" aria-current={t.id === term?.id || t.id === side?.id} onClick={() => onTermFocus(t.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="eyebrow">{t.cwd.split('/').filter(Boolean).at(-1) ?? 'home'}</span>
              <span className="mono" style={{ color: t.exited === undefined ? 'var(--sky)' : 'var(--faint)' }}>
                {t.exited === undefined ? 'running' : `exited ${t.exited}`}
              </span>
            </div>
            <div className="t">{t.command ?? t.title}</div>
          </button>
        ))}
        <div className="eyebrow side-head">Agents</div>
        <NewTask settings={settings} />
        {tasks.map((t) => (
          <button
            key={t.id}
            className="list-item"
            aria-current={!term && t.id === selected?.id}
            onClick={() => {
              onTermFocus(null)
              onFocus(t.id)
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="eyebrow">{t.project ?? 'folder'}</span>
              <TaskStatus status={t.status} />
            </div>
            <div className="t">{t.title}</div>
            <div className="s mono">
              {agentLabel(t)} · {LIVE.has(t.status) ? `last seen ${ago(t.lastEventAt)}` : ago(t.endedAt ?? t.lastEventAt)}
            </div>
          </button>
        ))}
      </aside>
      {term ? (
        <section className="panel term-area" data-split={!!side}>
          <TerminalPane info={term} onClose={() => close(term.id)} onSplit={side ? undefined : () => splitFrom(term)} />
          {side && <TerminalPane info={side} onClose={() => close(side.id)} />}
        </section>
      ) : (
        <section className="panel">{selected ? <TaskDetail task={selected} onTakeOver={onTakeOver} /> : <NoTasks />}</section>
      )}
    </div>
  )
}

/** Opens a login shell in a project folder. */
function NewTerminal({ onOpen }: { onOpen: (t: TerminalInfo) => void }) {
  const api = window.bluevis
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState('')
  useEffect(() => {
    void api.projects.list().then((p) => {
      const list = p as Project[]
      setProjects(list)
      setProject((cur) => cur || list[0]?.path || '')
    })
  }, [api])
  const open = async () => onOpen((await api.terminals.create({ cwd: project || undefined })) as TerminalInfo)
  return (
    <div className="row new-term">
      <select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Folder for the new terminal">
        {projects.map((p) => (
          <option key={p.path} value={p.path}>
            {p.name}
          </option>
        ))}
        <option value="">Home folder</option>
      </select>
      <button className="btn" onClick={open}>
        New terminal
      </button>
    </div>
  )
}

function NoTasks() {
  return (
    <div className="empty">
      <h3>No agents yet</h3>
      <p>
        Say “have Codex investigate the failing test in Yonder”, or write a brief on the left. Agents run in their project folder, sandboxed, and report back
        here.
      </p>
    </div>
  )
}

function NewTask({ settings }: { settings: Settings | null }) {
  const api = window.bluevis
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState('')
  const [agent, setAgent] = useState<'codex' | 'claude'>('codex')
  const [prompt, setPrompt] = useState('')
  useEffect(() => {
    void api.projects.list().then((p) => {
      const list = p as Project[]
      setProjects(list)
      setProject((cur) => cur || list[0]?.name || '')
    })
  }, [api])
  const start = async () => {
    if (!prompt.trim() || !project) return
    await api.tasks.start({ agent, project, prompt: prompt.trim() })
    setPrompt('')
  }
  return (
    <div className="new-task">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Brief an agent…"
        aria-label="Agent brief"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start()
        }}
      />
      <div className="row">
        <select className="select" value={agent} onChange={(e) => setAgent(e.target.value as 'codex' | 'claude')} aria-label="Agent">
          <option value="codex">Codex · {settings?.worker.provider === 'codex' ? settings.worker.model : 'gpt-6-sol'}</option>
          <option value="claude">Claude · opus</option>
        </select>
        <select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          {projects.map((p) => (
            <option key={p.path} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={!prompt.trim() || !project} onClick={start}>
          Start
        </button>
      </div>
    </div>
  )
}

/** Output stays folded unless the step failed or is still running; the command line tells the story. */
function Step({ step: s }: { step: AgentTask['steps'][number] }) {
  const [open, setOpen] = useState(s.status !== 'done')
  return (
    <li data-s={s.status}>
      <button className="label" style={{ textAlign: 'left', cursor: s.detail ? 'pointer' : 'default' }} onClick={() => setOpen(!open)} aria-expanded={s.detail ? open : undefined}>
        <span className="kind">{s.kind === 'command' ? '$' : s.kind === 'edit' ? 'edit' : s.kind}</span>
        {s.label}
        {s.status === 'failed' && <span style={{ color: 'var(--fault)', marginLeft: 8 }}>✗ failed</span>}
      </button>
      {s.detail && open && <pre>{s.detail}</pre>}
    </li>
  )
}

function TaskDetail({ task, onTakeOver }: { task: AgentTask; onTakeOver: (t: AgentTask) => void }) {
  const api = window.bluevis
  const live = LIVE.has(task.status)
  const steps = task.steps.slice(-40)
  return (
    <div>
      <div className="task-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow">
            {agentLabel(task)} · {task.project ?? task.cwd}
          </div>
          <h2>{task.title}</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
          <TaskStatus status={task.status} />
          {live && (
            <button className="btn" onClick={() => api.tasks.stop(task.id)} title="Stops the process. Edits already made stay in the working tree.">
              Stop agent
            </button>
          )}
          {!live && task.sessionId && (task.choice.provider === 'codex' || task.choice.provider === 'claude') && (
            <button className="btn" onClick={() => onTakeOver(task)} title="Continue this agent's thread interactively in a terminal">
              Take over in terminal
            </button>
          )}
        </div>
      </div>

      <div className="task-grid">
        <div>
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            Observed steps
          </div>
          {steps.length === 0 ? (
            <p style={{ color: 'var(--mist)' }}>{live ? 'No steps observed yet. The agent is reading and planning.' : 'The agent made no observable tool calls.'}</p>
          ) : (
            <ul className="steps">
              {steps.map((s) => (
                <Step key={s.id} step={s} />
              ))}
            </ul>
          )}
          {task.finalMessage && (
            <div className="report">
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Agent report · reported, not verified by Vesper
              </div>
              <Markdown text={task.finalMessage} />
            </div>
          )}
          {task.error && (
            <div className="report">
              <div className="eyebrow" style={{ marginBottom: 10, color: 'var(--fault)' }}>
                Error
              </div>
              <p style={{ color: '#ffc1c3', margin: 0 }}>{task.error}</p>
            </div>
          )}
        </div>
        <aside className="facts">
          {task.plan && task.plan.length > 0 && (
            <div>
              <div className="eyebrow">Plan</div>
              <ul className="plan">
                {task.plan.map((p, i) => (
                  <li key={i} data-done={p.done}>
                    {p.done ? '✓' : '○'} {p.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Files changed
            </div>
            {task.filesChanged.length ? (
              <div className="files">
                {task.filesChanged.map((f) => (
                  <span key={f}>{f.replace(task.cwd + '/', '')}</span>
                ))}
              </div>
            ) : (
              <span style={{ color: 'var(--mist)', fontSize: 13 }}>None observed</span>
            )}
          </div>
          {task.diffStat && (
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                Working tree diff
              </div>
              <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--bone-2)', fontSize: 10 }}>
                {task.diffStat}
              </pre>
            </div>
          )}
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Verification
            </div>
            <p style={{ margin: 0, color: 'var(--mist)', fontSize: 12.5 }}>
              {task.status === 'completed-verified'
                ? 'A test, build or typecheck passed after the last edit.'
                : task.status === 'completed-unverified'
                  ? 'No passing check was observed after the last edit. Treat the result as unconfirmed.'
                  : live
                    ? 'Decided when the agent finishes.'
                    : 'Not applicable.'}
            </p>
          </div>
          <button className="btn btn-quiet" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => api.projects.reveal(task.cwd)}>
            Reveal folder
          </button>
        </aside>
      </div>
    </div>
  )
}
