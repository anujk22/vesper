// Past Codex and Claude Code conversations, read from the files each tool keeps on disk.

export type HistoryProvider = 'codex' | 'claude'

export interface ThreadSummary {
  id: string
  provider: HistoryProvider
  title: string
  cwd: string
  updatedAt: number
  file: string
  /** Model the thread last ran with, used to continue it the same way. */
  model?: string
  effort?: string
}

export interface ThreadItem {
  kind: 'user' | 'assistant' | 'command' | 'edit' | 'tool'
  text: string
  at: number
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

function lines(jsonl: string): any[] {
  const out: any[] = []
  for (const l of jsonl.split('\n')) {
    if (!l) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      // A thread being written right now can end in a partial line.
    }
  }
  return out
}

/** Pasted files and injected context sit before "## My request:" in desktop messages; show only the request. */
function userText(s: string): string {
  const i = s.indexOf('## My request:')
  return (i >= 0 ? s.slice(i + 14) : s).trim()
}

/** Metadata from a Codex session's first line, or null for threads that are not the user's own (subagents, Vesper runs). */
export function codexMeta(firstLine: string): { id: string; cwd: string; at: number } | null {
  try {
    const p = JSON.parse(firstLine)?.payload
    if (!p?.id || typeof p.source !== 'string' || p.originator === 'codex_exec') return null
    return { id: p.id, cwd: p.cwd ?? '', at: Date.parse(p.timestamp) || 0 }
  } catch {
    return null
  }
}

export function parseCodexThread(jsonl: string): { items: ThreadItem[]; model?: string; effort?: string } {
  const items: ThreadItem[] = []
  let model: string | undefined
  let effort: string | undefined
  for (const d of lines(jsonl)) {
    const at = Date.parse(d.timestamp) || 0
    if (d.type === 'turn_context') {
      model = d.payload?.model ?? model
      effort = d.payload?.effort ?? effort
    }
    if (d.type !== 'event_msg' || d.payload?.type !== 'item_completed') continue
    const it = d.payload.item
    const text = (it.content ?? [])
      .map((c: { text?: string }) => c.text ?? '')
      .join('')
    if (it.type === 'UserMessage') items.push({ kind: 'user', text: userText(text), at })
    else if (it.type === 'AgentMessage') items.push({ kind: 'assistant', text: text.trim(), at })
    else if (it.type === 'CommandExecution') items.push({ kind: 'command', text: clip(it.parsed_cmd?.[0]?.cmd ?? it.command?.at(-1) ?? '', 200), at })
    else if (it.type === 'FileChange') for (const f of Object.keys(it.changes ?? {})) items.push({ kind: 'edit', text: f, at })
    else if (it.type === 'McpToolCall') items.push({ kind: 'tool', text: it.arguments?.title ?? `${it.server}.${it.tool}`, at })
  }
  return { items: items.filter((i) => i.text), model, effort }
}

export function parseClaudeThread(jsonl: string): { items: ThreadItem[]; title?: string; cwd?: string; id?: string; model?: string } {
  const items: ThreadItem[] = []
  let title: string | undefined
  let aiTitle: string | undefined
  let cwd: string | undefined
  let id: string | undefined
  let model: string | undefined
  for (const d of lines(jsonl)) {
    if (d.type === 'custom-title') title = d.customTitle
    if (d.type === 'ai-title') aiTitle = d.aiTitle
    if (d.isSidechain || (d.type !== 'user' && d.type !== 'assistant')) continue
    cwd ??= d.cwd
    id ??= d.sessionId
    const at = Date.parse(d.timestamp) || 0
    const content = d.message?.content
    if (d.type === 'user') {
      // Tool results come back as user turns; only typed prompts count.
      if (typeof content === 'string' && !content.startsWith('<')) items.push({ kind: 'user', text: content.trim(), at })
      continue
    }
    model = d.message?.model ?? model
    for (const c of Array.isArray(content) ? content : []) {
      if (c.type === 'text' && c.text?.trim()) items.push({ kind: 'assistant', text: c.text.trim(), at })
      if (c.type === 'tool_use') {
        const inp = c.input ?? {}
        if (c.name === 'Bash') items.push({ kind: 'command', text: clip(inp.command ?? '', 200), at })
        else if (c.name === 'Edit' || c.name === 'Write') items.push({ kind: 'edit', text: inp.file_path ?? '', at })
        else items.push({ kind: 'tool', text: c.name, at })
      }
    }
  }
  return { items: items.filter((i) => i.text), title: title ?? aiTitle, cwd, id, model }
}

/** A readable title when the tool did not name the thread. */
export function fallbackTitle(items: ThreadItem[]): string {
  const first = items.find((i) => i.kind === 'user')?.text ?? 'Untitled'
  return clip(first.replace(/\s+/g, ' '), 70)
}
