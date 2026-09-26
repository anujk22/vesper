import { useEffect, useState } from 'react'
import type { Proposal } from '../../../core/importer'

interface ImportState {
  state: 'idle' | 'running' | 'done' | 'failed' | 'stopped'
  label: string
  batchesDone: number
  batchesTotal: number
  threads: number
  skipped: number
  error?: string
}

const KIND_LABEL: Record<Proposal['kind'], string> = {
  preference: 'Preference',
  decision: 'Decision',
  idea: 'Idea',
  fact: 'Fact',
  project: 'Project',
  goal: 'Goal',
  person: 'Person'
}

export function useProposals() {
  const api = window.bluevis
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [state, setState] = useState<ImportState | null>(null)
  useEffect(() => {
    void api.importer.proposals().then((p) => setProposals(p as Proposal[]))
    void api.importer.state().then((s) => setState(s as ImportState))
    const offs = [api.on('import:proposals', (p) => setProposals(p as Proposal[])), api.on('import:state', (s) => setState(s as ImportState))]
    return () => offs.forEach((o) => o())
  }, [api])
  return { proposals, state }
}

export function Review({ proposals, state }: { proposals: Proposal[]; state: ImportState | null }) {
  const api = window.bluevis
  const [dump, setDump] = useState('')
  const [filter, setFilter] = useState<Proposal['kind'] | 'all'>('all')
  const running = state?.state === 'running'
  const kinds = [...new Set(proposals.map((p) => p.kind))]
  const shown = proposals.filter((p) => filter === 'all' || p.kind === filter)
  const confident = proposals.filter((p) => p.confidence === 'high' && p.origin === 'user-stated')

  return (
    <div>
      <h2 className="panel-title">Teach Vesper</h2>
      <p className="panel-sub">Nothing enters your vault until you keep it. Assistant suggestions are never recorded as your decisions.</p>

      <div className="sources">
        <div className="source-card">
          <div className="eyebrow">ChatGPT history</div>
          <p>In ChatGPT, open Settings → Data controls → Export data, then choose the .zip it emails you. Already-imported conversations are skipped.</p>
          <button className="btn btn-primary" disabled={running} onClick={() => api.importer.chatgpt()}>
            Choose export…
          </button>
        </div>
        <div className="source-card">
          <div className="eyebrow">In your own words</div>
          <textarea
            value={dump}
            onChange={(e) => setDump(e.target.value)}
            placeholder="Your projects, goals, how you like to work, who you work with… as long as you like."
            aria-label="Describe yourself"
          />
          <button
            className="btn"
            disabled={running || !dump.trim()}
            onClick={async () => {
              await api.importer.text(dump)
              setDump('')
            }}
          >
            Extract notes
          </button>
        </div>
      </div>

      {state && state.state !== 'idle' && (
        <div className="import-progress" data-state={state.state}>
          <div className="row">
            <span className="mono">
              {state.state === 'running'
                ? `${state.label} · batch ${Math.min(state.batchesDone + 1, state.batchesTotal)} of ${state.batchesTotal} · ${state.threads} conversation${state.threads === 1 ? '' : 's'}`
                : state.state === 'done'
                  ? `${state.label} · finished · ${state.threads} read${state.skipped ? ` · ${state.skipped} already imported` : ''}`
                  : state.state === 'stopped'
                    ? `${state.label} · stopped after ${state.batchesDone} of ${state.batchesTotal} batches`
                    : `${state.label} · failed`}
            </span>
            {running && (
              <button className="link-btn" onClick={() => api.importer.stop()}>
                Stop
              </button>
            )}
          </div>
          {state.batchesTotal > 0 && (
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={state.batchesTotal} aria-valuenow={state.batchesDone}>
              <span style={{ width: `${(state.batchesDone / state.batchesTotal) * 100}%` }} />
            </div>
          )}
          {state.error && <p className="notice" style={{ margin: '10px 0 0' }}>{state.error}</p>}
        </div>
      )}

      <div className="review-head">
        <div className="eyebrow">
          {proposals.length} to review{running ? ' · more arriving' : ''}
        </div>
        {kinds.length > 1 && (
          <div className="row">
            <button className="choice" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              All
            </button>
            {kinds.map((k) => (
              <button key={k} className="choice" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        {confident.length > 1 && (
          <button
            className="btn"
            style={{ marginLeft: 'auto' }}
            onClick={async () => {
              for (const p of confident) await api.importer.accept(p.key)
            }}
          >
            Keep {confident.length} you clearly stated
          </button>
        )}
      </div>

      {proposals.length === 0 && !running && <p style={{ color: 'var(--mist)' }}>Nothing waiting. Import something above and proposed notes will appear here.</p>}

      <div className="proposals">
        {shown.map((p) => (
          <ProposalCard key={p.key} p={p} />
        ))}
      </div>
    </div>
  )
}

function ProposalCard({ p }: { p: Proposal }) {
  const api = window.bluevis
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(p.title)
  const [text, setText] = useState(p.text)
  return (
    <article className="proposal-card">
      <div className="row">
        <span className="eyebrow">{KIND_LABEL[p.kind]}</span>
        {p.project && <span className="mono" style={{ color: 'var(--glacier)' }}>{p.project}</span>}
        <span className="evidence mono" data-kind={p.origin === 'user-stated' ? 'observed' : 'inferred'}>
          {p.origin === 'user-stated' ? 'you said' : p.origin === 'assistant-suggested' ? 'assistant suggested' : 'inferred'}
        </span>
        <span className="mono" style={{ color: 'var(--faint)', marginLeft: 'auto' }}>
          {p.confidence} confidence
        </span>
      </div>
      {editing ? (
        <>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" style={{ width: '100%', margin: '10px 0 8px' }} />
          <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} aria-label="Text" style={{ width: '100%', height: 70, padding: 10 }} />
        </>
      ) : (
        <>
          <h4>{p.title}</h4>
          <p>{p.text}</p>
        </>
      )}
      <div className="row">
        <span className="mono" style={{ color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {p.source.kind === 'chatgpt' ? `ChatGPT · “${p.source.title}” · ${p.source.date}` : `Your words · ${p.source.date}`}
        </span>
        <div className="row" style={{ marginLeft: 'auto', flex: 'none' }}>
          <button className="btn btn-quiet" onClick={() => api.importer.reject(p.key)}>
            Discard
          </button>
          <button className="btn btn-quiet" onClick={() => setEditing(!editing)}>
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <button className="btn btn-primary" onClick={() => api.importer.accept(p.key, editing ? { title, text } : undefined)}>
            Keep
          </button>
        </div>
      </div>
    </article>
  )
}
