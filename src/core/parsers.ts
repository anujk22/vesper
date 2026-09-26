import type { AgentEvent } from './types'


function safeJson(line: string): any | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Strip the login-shell wrapper Codex puts around commands. */
export function cleanCommand(command: string): string {
  const m = command.match(/^\/bin\/(?:zsh|bash|sh) -l?c (.*)$/s)
  if (!m) return command
  let inner = m[1]
  if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
    inner = inner.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return inner
}

/** Parse one line of `codex exec --json` output. */
export function parseCodexLine(line: string): AgentEvent[] {
  const d = safeJson(line)
  if (!d) return []
  switch (d.type) {
    case 'thread.started':
      return [{ kind: 'session', id: d.thread_id }]
    case 'turn.completed':
      return [
        { kind: 'usage', input: d.usage?.input_tokens ?? 0, output: d.usage?.output_tokens ?? 0 },
        { kind: 'done' }
      ]
    case 'turn.failed':
      return [{ kind: 'error', message: extractError(d.error?.message) }]
    case 'error':
      return [{ kind: 'error', message: extractError(d.message) }]
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return codexItem(d.item, d.type === 'item.completed')
    default:
      return []
  }
}

function codexItem(item: any, completed: boolean): AgentEvent[] {
  if (!item) return []
  switch (item.type) {
    case 'agent_message':
      return completed ? [{ kind: 'message', text: item.text ?? '' }] : []
    case 'reasoning':
      return completed && item.text ? [{ kind: 'reasoning', text: item.text }] : []
    case 'command_execution': {
      const status = item.status === 'in_progress' ? 'running' : item.exit_code === 0 ? 'done' : 'failed'
      return [
        {
          kind: 'command',
          id: item.id,
          command: cleanCommand(item.command ?? ''),
          status,
          exitCode: item.exit_code,
          output: item.aggregated_output
        }
      ]
    }
    case 'file_change':
      return [{ kind: 'file-change', id: item.id, changes: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind })) }]
    case 'mcp_tool_call':
      return [
        {
          kind: 'tool',
          id: item.id,
          name: `${item.server}.${item.tool}`,
          status: item.status === 'in_progress' ? 'running' : item.status === 'failed' ? 'failed' : 'done'
        }
      ]
    case 'web_search':
      return [{ kind: 'tool', id: item.id, name: 'web search', detail: item.query, status: completed ? 'done' : 'running' }]
    case 'todo_list':
      return [{ kind: 'plan', items: (item.items ?? []).map((i: any) => ({ text: i.text, done: !!i.completed })) }]
    case 'error':
      // Codex reports config/feature notices as error items; they are not failures.
      return [{ kind: 'warning', message: item.message ?? '' }]
    default:
      return []
  }
}

/** Codex nests API errors as JSON strings; surface the human-readable part. */
export function extractError(message: unknown): string {
  if (typeof message !== 'string') return 'Unknown error'
  const inner = safeJson(message)
  return inner?.error?.message ?? inner?.message ?? message
}

/** Parse one line of `claude -p --output-format stream-json --verbose --include-partial-messages`. */
export function parseClaudeLine(line: string): AgentEvent[] {
  const d = safeJson(line)
  if (!d) return []
  switch (d.type) {
    case 'system':
      if (d.subtype === 'init' && d.session_id) return [{ kind: 'session', id: d.session_id }]
      if (d.subtype === 'thinking_tokens' && typeof d.estimated_tokens === 'number') {
        return [{ kind: 'progress', label: `thinking · ~${d.estimated_tokens.toLocaleString('en-US')} tokens` }]
      }
      return []
    case 'stream_event': {
      const e = d.event
      if (d.parent_tool_use_id) return []
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') return [{ kind: 'text-delta', text: e.delta.text }]
      return []
    }
    case 'assistant': {
      if (d.parent_tool_use_id) return []
      const out: AgentEvent[] = []
      for (const block of d.message?.content ?? []) {
        if (block.type === 'text' && block.text) out.push({ kind: 'message', text: block.text })
        if (block.type === 'tool_use') out.push(claudeToolUse(block))
      }
      return out
    }
    case 'user': {
      const out: AgentEvent[] = []
      for (const block of d.message?.content ?? []) {
        if (block.type === 'tool_result') {
          out.push({ kind: 'tool', id: block.tool_use_id, name: '', status: block.is_error ? 'failed' : 'done' })
        }
      }
      return out
    }
    case 'rate_limit_event':
      return [{ kind: 'limits', raw: d }]
    case 'result':
      if (d.is_error || (d.subtype && d.subtype !== 'success')) {
        return [{ kind: 'error', message: d.result || d.subtype || 'Claude run failed' }]
      }
      return [
        {
          kind: 'usage',
          input: (d.usage?.input_tokens ?? 0) + (d.usage?.cache_read_input_tokens ?? 0) + (d.usage?.cache_creation_input_tokens ?? 0),
          output: d.usage?.output_tokens ?? 0
        },
        { kind: 'done' }
      ]
    default:
      return []
  }
}

function claudeToolUse(block: any): AgentEvent {
  const input = block.input ?? {}
  if (block.name === 'Bash') {
    return { kind: 'command', id: block.id, command: input.command ?? '', status: 'running' }
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name) && input.file_path) {
    return { kind: 'file-change', id: block.id, changes: [{ path: input.file_path, kind: block.name === 'Write' ? 'add' : 'update' }] }
  }
  const detail = input.file_path ?? input.pattern ?? input.query ?? input.q ?? input.thread_id ?? input.url ?? input.description
  return { kind: 'tool', id: block.id, name: block.name, detail, status: 'running' }
}

/** Parse one SSE line from an OpenAI-compatible /chat/completions stream. */
export function parseOpenAISSELine(line: string): AgentEvent[] {
  const t = line.trim()
  if (!t.startsWith('data:')) return []
  const payload = t.slice(5).trim()
  if (payload === '[DONE]') return [{ kind: 'done' }]
  const d = safeJson(payload)
  if (d?.usage?.completion_tokens) return [{ kind: 'usage', input: d.usage.prompt_tokens ?? 0, output: d.usage.completion_tokens }]
  const delta = d?.choices?.[0]?.delta
  if (delta?.content) return [{ kind: 'text-delta', text: delta.content }]
  const thought = delta?.reasoning_content ?? delta?.reasoning
  if (typeof thought === 'string' && thought) return [{ kind: 'thinking-delta', text: thought }]
  return []
}

/** Splits streaming line output into complete lines, buffering the remainder. */
export class LineBuffer {
  private rest = ''
  push(chunk: string): string[] {
    const text = this.rest + chunk
    const lines = text.split('\n')
    this.rest = lines.pop() ?? ''
    return lines
  }
  flush(): string[] {
    const r = this.rest
    this.rest = ''
    return r ? [r] : []
  }
}
