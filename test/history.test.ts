import { describe, expect, it } from 'vitest'
import { codexMeta, fallbackTitle, parseClaudeThread, parseCodexThread } from '../src/core/history'

const j = (o: object) => JSON.stringify(o)
const ts = '2026-09-01T10:00:00.000Z'

describe('codex threads', () => {
  it('keeps user threads and skips subagents and exec runs', () => {
    expect(codexMeta(j({ payload: { id: 'a', cwd: '/p', source: 'vscode', originator: 'Codex Desktop', timestamp: ts } }))?.id).toBe('a')
    expect(codexMeta(j({ payload: { id: 'b', source: { subagent: 'guardian' }, timestamp: ts } }))).toBeNull()
    expect(codexMeta(j({ payload: { id: 'c', source: 'exec', originator: 'codex_exec', timestamp: ts } }))).toBeNull()
  })
  it('reads messages, commands, edits and the last model', () => {
    const item = (it: object) => j({ timestamp: ts, type: 'event_msg', payload: { type: 'item_completed', item: it } })
    const file = [
      j({ timestamp: ts, type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high' } }),
      item({ type: 'UserMessage', content: [{ type: 'text', text: '# Files pasted\n\n## My request:\nShip it' }] }),
      item({ type: 'CommandExecution', parsed_cmd: [{ cmd: 'npm test' }] }),
      item({ type: 'FileChange', changes: { '/p/a.ts': {} } }),
      item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'Done.' }] }),
      '{"partial'
    ].join('\n')
    const r = parseCodexThread(file)
    expect(r.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'Ship it'],
      ['command', 'npm test'],
      ['edit', '/p/a.ts'],
      ['assistant', 'Done.']
    ])
    expect(r.model).toBe('gpt-6-astra')
    expect(r.effort).toBe('high')
  })
})

describe('claude threads', () => {
  it('reads prompts, replies, tool use and the newest title', () => {
    const file = [
      j({ type: 'user', sessionId: 's1', cwd: '/p', timestamp: ts, message: { content: 'Fix the bug' } }),
      j({ type: 'assistant', timestamp: ts, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
      j({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result' }] } }),
      j({ type: 'assistant', isSidechain: true, timestamp: ts, message: { content: [{ type: 'text', text: 'hidden' }] } }),
      j({ type: 'ai-title', aiTitle: 'Old' }),
      j({ type: 'custom-title', customTitle: 'Bug fix' })
    ].join('\n')
    const r = parseClaudeThread(file)
    expect(r.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'command'])
    expect(r).toMatchObject({ id: 's1', cwd: '/p', title: 'Bug fix', model: 'claude-opus-5-5' })
    expect(fallbackTitle(r.items)).toBe('Fix the bug')
  })
})
