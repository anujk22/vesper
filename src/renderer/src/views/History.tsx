import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ThreadItem, ThreadSummary } from '../../../core/history'
import type { AgentTask } from '../../../core/types'
import { Markdown } from '../components/Markdown'
import { TaskStatus } from '../components/TaskStatus'
import { ago } from '../components/Usage'

const LIVE = new Set(['starting', 'investigating', 'editing', 'testing', 'awaiting-approval'])
const PAGE = 200

/** Past Codex and Claude Code threads, readable and continuable without leaving Vesper. */
type OpenTerminal = (provider: 'codex' | 'claude', id: string, cwd: string, title: string) => void

export function History({ tasks, onOpenTerminal }: { tasks: AgentTask[]; onOpenTerminal: OpenTerminal }) {
  const api = window.bluevis
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'codex' | 'claude'>('all')
  const [q, setQ] = useState('')
  const [file, setFile] = useState<string | null>(null)
  const load = () => void api.history.list().then((l) => setThreads(l as ThreadSummary[]))
  useEffect(load, [api])

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (threads ?? []).filter((t) => (filter === 'all' || t.provider === filter) && words.every((w) => `${t.title} ${t.cwd}`.toLowerCase().includes(w)))
  }, [threads, filter, q])
  const selected = shown.find((t) => t.file === file) ?? shown[0]

  return (
    <div className="split history">
      <aside className="panel">
        <h2 className="panel-title">History</h2>
        <p className="panel-sub">Your Codex and Claude Code threads. Pick one up here and it continues in the same thread.</p>
        <input className="input" style={{ width: '100%' }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles and folders" aria-label="Search threads" />
        <div className="seg" role="radiogroup" aria-label="Filter by tool">
          {(['all', 'codex', 'claude'] as const).map((f) => (
            <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'codex' ? 'Codex' : 'Claude'}
            </button>
          ))}
        </div>
        {!threads && <p className="panel-sub">Reading threads…</p>}
        {shown.map((t) => (
          <button key={t.file} className="list-item" aria-current={t.file === selected?.file} onClick={() => setFile(t.file)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="eyebrow">{folder(t.cwd)}</span>
              <span className="mono" style={{ color: 'var(--faint)' }}>
                {t.provider === 'codex' ? 'Codex' : 'Claude'} · {ago(t.updatedAt)}
              </span>
            </div>
            <div className="t">{t.title}</div>
          </button>
        ))}
        {threads && !shown.length && <p className="panel-sub">No threads match.</p>}
      </aside>
      <section className="panel thread-pane">{selected ? <Thread key={selected.file} thread={selected} tasks={tasks} onChanged={load} onOpenTerminal={onOpenTerminal} /> : <Empty />}</section>
    </div>
  )
}

function folder(cwd: string) {
  return cwd.split('/').filter(Boolean).at(-1) ?? 'no folder'
}

function Empty() {
  return (
    <div className="empty">
      <h3>No threads yet</h3>
      <p>Threads from the Codex app, the Codex CLI and Claude Code appear here once you have used them.</p>
    </div>
  )
}

function Thread({ thread, tasks, onChanged, onOpenTerminal }: { thread: ThreadSummary; tasks: AgentTask[]; onChanged: () => void; onOpenTerminal: OpenTerminal }) {
  const api = window.bluevis
  const [items, setItems] = useState<ThreadItem[] | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [text, setText] = useState('')
  const [taskId, setTaskId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const task = tasks.find((t) => t.id === taskId)
  const live = !!task && LIVE.has(task.status)

  const read = () =>
    void api.history
      .read(thread.file)
      .then((r) => setItems((r as { items: ThreadItem[] }).items))
      .catch((e: Error) => setError(e.message))
  useEffect(read, [thread.file])
  // When the continuation finishes, the thread file holds the new turn; re-read it.
  useEffect(() => {
    if (task && !live) {
      read()
      onChanged()
    }
  }, [task?.status])
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, task?.steps.length])

  const send = async () => {
    const prompt = text.trim()
    if (!prompt || live) return
    setError(null)
    try {
      const t = (await api.history.continue(thread.file, prompt)) as AgentTask
      setTaskId(t.id)
      setText('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const visible = items?.slice(-limit) ?? []
  return (
    <div className="thread">
      <header className="thread-head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">
            {thread.provider === 'codex' ? 'Codex' : 'Claude Code'} · {thread.cwd || 'no folder'}
          </div>
          <h2>{thread.title}</h2>
        </div>
        <button className="btn" disabled={live} onClick={() => onOpenTerminal(thread.provider, thread.id, thread.cwd, thread.title)} title={`Opens ${thread.provider === 'codex' ? 'codex resume' : 'claude --resume'} in a Work terminal`}>
          Open in terminal
        </button>
      </header>
      <div className="thread-body" ref={scroller}>
        {items && items.length > limit && (
          <button className="btn btn-quiet" onClick={() => setLimit((n) => n + PAGE)}>
            Show earlier ({items.length - limit} more)
          </button>
        )}
        {!items && !error && <p className="panel-sub">Reading thread…</p>}
        {group(visible).map((g, i) =>
          g.kind === 'user' ? (
            <div key={i} className="th-user">{g.items[0].text}</div>
          ) : g.kind === 'assistant' ? (
            <div key={i} className="th-assistant">
              <Markdown text={g.items[0].text} />
            </div>
          ) : (
            <details key={i} className="th-actions">
              <summary className="mono">{summarize(g.items)}</summary>
              <ul>
                {g.items.map((a, j) => (
                  <li key={j} className="mono">
                    <span className="k">{a.kind === 'command' ? '$' : a.kind === 'edit' ? '✎' : '·'}</span> {a.text}
                  </li>
                ))}
              </ul>
            </details>
          )
        )}
        {task && (
          <div className="th-live">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className="eyebrow">Continuing here</span>
              <TaskStatus status={task.status} />
              {live && (
                <button className="btn btn-quiet" style={{ marginLeft: 'auto' }} onClick={() => api.tasks.stop(task.id)}>
                  Stop
                </button>
              )}
            </div>
            <ul>
              {task.steps.slice(-12).map((s) => (
                <li key={s.id} className="mono" data-s={s.status}>
                  {s.label}
                </li>
              ))}
            </ul>
            {task.error && <p className="notice">{task.error}</p>}
          </div>
        )}
        {error && <p className="notice">{error}</p>}
      </div>
      <div className="thread-composer">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={live ? 'Working. You can stop it above.' : `Continue this ${thread.provider === 'codex' ? 'Codex' : 'Claude'} thread…`}
          aria-label="Continue this thread"
          disabled={live}
        />
        <button className="btn btn-primary" disabled={!text.trim() || live} onClick={send}>
          Send
        </button>
      </div>
      <p className="thread-note">Runs in {folder(thread.cwd)} with edits allowed, like a Vesper agent. It also appears under Agents.</p>
    </div>
  )
}

type Group = { kind: 'user' | 'assistant' | 'actions'; items: ThreadItem[] }

/** Consecutive commands, edits and tool calls collapse into one line between messages. */
function group(items: ThreadItem[]): Group[] {
  const out: Group[] = []
  for (const it of items) {
    const kind = it.kind === 'user' || it.kind === 'assistant' ? it.kind : 'actions'
    const last = out.at(-1)
    if (kind === 'actions' && last?.kind === 'actions') last.items.push(it)
    else out.push({ kind, items: [it] })
  }
  return out
}

function summarize(items: ThreadItem[]) {
  const n = (k: ThreadItem['kind']) => items.filter((i) => i.kind === k).length
  const parts = [n('command') && `${n('command')} command${n('command') > 1 ? 's' : ''}`, n('edit') && `${n('edit')} file edit${n('edit') > 1 ? 's' : ''}`, n('tool') && `${n('tool')} tool call${n('tool') > 1 ? 's' : ''}`]
  return parts.filter(Boolean).join(' · ')
}
