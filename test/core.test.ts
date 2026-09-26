import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanCommand, extractError, LineBuffer, parseClaudeLine, parseCodexLine, parseOpenAISSELine } from '../src/core/parsers'
import { applyTaskEvent, newTask } from '../src/core/taskState'
import { matchProject, route } from '../src/core/router'
import { parseReply, speakable, splitSentences } from '../src/core/reply'
import { parseNote, rank, serializeNote, slugify } from '../src/core/notes'
import type { AgentEvent } from '../src/core/types'
import { DEFAULT_ACCENT, tint } from '../src/core/color'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8').split('\n')

describe('codex parser', () => {
  const events = fixture('codex.jsonl').flatMap(parseCodexLine)

  it('reads session, commands, final message and completion from a real run', () => {
    expect(events[0]).toEqual({ kind: 'session', id: '01a0d6df-9327-7753-97d5-520a14d6ec57' })
    const cmds = events.filter((e) => e.kind === 'command')
    expect(cmds.map((c) => c.kind === 'command' && c.status)).toEqual(['running', 'done', 'running', 'done'])
    expect(cmds[0].kind === 'command' && cmds[0].command).toBe('ls')
    expect(events).toContainEqual({ kind: 'message', text: 'done' })
    expect(events.at(-1)).toEqual({ kind: 'done' })
  })

  it('treats feature notices as warnings, not failures', () => {
    expect(events.some((e) => e.kind === 'warning')).toBe(true)
    expect(events.some((e) => e.kind === 'error')).toBe(false)
  })

  it('surfaces nested API error messages', () => {
    const line = JSON.stringify({ type: 'turn.failed', error: { message: JSON.stringify({ error: { message: 'model not supported' } }) } })
    expect(parseCodexLine(line)).toEqual([{ kind: 'error', message: 'model not supported' }])
    expect(extractError('plain')).toBe('plain')
  })

  it('unwraps login-shell commands', () => {
    expect(cleanCommand('/bin/zsh -lc "npm test"')).toBe('npm test')
    expect(cleanCommand("/bin/zsh -lc 'echo \"hi\"'")).toBe('echo "hi"')
    expect(cleanCommand('git status')).toBe('git status')
  })
})

describe('claude parser', () => {
  const events = fixture('claude.jsonl').flatMap(parseClaudeLine)

  it('streams text deltas and reports tools and completion', () => {
    expect(events[0].kind).toBe('session')
    const text = events.filter((e) => e.kind === 'text-delta').map((e) => (e.kind === 'text-delta' ? e.text : '')).join('')
    expect(text).toContain('hello')
    expect(events.some((e) => e.kind === 'tool' && e.name === 'Read')).toBe(true)
    expect(events.at(-1)).toEqual({ kind: 'done' })
  })
})

describe('openai sse parser', () => {
  it('parses deltas and done', () => {
    expect(parseOpenAISSELine('data: {"choices":[{"delta":{"content":"Hi"}}]}')).toEqual([{ kind: 'text-delta', text: 'Hi' }])
    expect(parseOpenAISSELine('data: [DONE]')).toEqual([{ kind: 'done' }])
    expect(parseOpenAISSELine('data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":312}}')).toEqual([{ kind: 'usage', input: 40, output: 312 }])
    expect(parseOpenAISSELine(': keepalive')).toEqual([])
  })
})

describe('line buffer', () => {
  it('reassembles split lines', () => {
    const b = new LineBuffer()
    expect(b.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(b.push(':2}\n')).toEqual(['{"b":2}'])
    expect(b.flush()).toEqual([])
  })
})

describe('task state', () => {
  const base = () => newTask({ id: 't', title: 't', prompt: 'p', choice: { provider: 'codex', model: 'm' }, cwd: '/x' }, 0)
  const run = (evs: AgentEvent[]) => evs.reduce((t, e) => applyTaskEvent(t, e, 1), base())

  it('marks verified only when a passing check follows the last edit', () => {
    const t = run([
      { kind: 'file-change', id: 'f', changes: [{ path: 'src/a.ts', kind: 'update' }] },
      { kind: 'command', id: 'c', command: 'npm test', status: 'running' },
      { kind: 'command', id: 'c', command: 'npm test', status: 'done', exitCode: 0 },
      { kind: 'done' }
    ])
    expect(t.status).toBe('completed-verified')
    expect(t.filesChanged).toEqual(['src/a.ts'])
    expect(t.steps).toHaveLength(2)
  })

  it('stays unverified when edits happen after the last check', () => {
    const t = run([
      { kind: 'command', id: 'c', command: 'npm test', status: 'done', exitCode: 0 },
      { kind: 'file-change', id: 'f', changes: [{ path: 'a', kind: 'update' }] },
      { kind: 'done' }
    ])
    expect(t.status).toBe('completed-unverified')
  })

  it('stays unverified when the last check failed', () => {
    const t = run([
      { kind: 'file-change', id: 'f', changes: [{ path: 'a', kind: 'update' }] },
      { kind: 'command', id: 'c1', command: 'npm test', status: 'done', exitCode: 0 },
      { kind: 'command', id: 'c2', command: 'npx vitest', status: 'failed', exitCode: 1 },
      { kind: 'done' }
    ])
    expect(t.status).toBe('completed-unverified')
  })

  it('reflects live phases', () => {
    const t = base()
    applyTaskEvent(t, { kind: 'command', id: 'a', command: 'rg foo', status: 'running' })
    expect(t.status).toBe('investigating')
    applyTaskEvent(t, { kind: 'command', id: 'b', command: 'pytest -q', status: 'running' })
    expect(t.status).toBe('testing')
    applyTaskEvent(t, { kind: 'error', message: 'boom' })
    expect(t.status).toBe('failed')
  })
})

describe('router', () => {
  const projects = ['Yonder', 'Blues Basketball', 'Bluevis']

  it('delegates to named agents with project extraction', () => {
    expect(route('Have Codex investigate the failing purchase test in Yonder', projects)).toEqual({
      type: 'delegate',
      agent: 'codex',
      model: undefined,
      prompt: 'investigate the failing purchase test',
      project: 'Yonder'
    })
    expect(route('let opus review the approach', projects)).toMatchObject({ type: 'delegate', agent: 'claude', model: 'opus' })
    expect(route('claude: fix the lint errors', projects)).toMatchObject({ type: 'delegate', agent: 'claude', prompt: 'fix the lint errors' })
  })

  it('strips the wake word', () => {
    expect(route('Hey Bluevis, status?', projects)).toEqual({ type: 'status' })
    expect(route('Good morning', projects)).toEqual({ type: 'brief' })
    expect(route("what's my day look like?", projects)).toEqual({ type: 'brief' })
    expect(route('brief me', projects)).toEqual({ type: 'brief' })
  })

  it('handles sessions and memory', () => {
    expect(route('where did I leave off on blues', projects)).toEqual({ type: 'resume', project: 'Blues Basketball' })
    expect(route("I'm done with Yonder for tonight", projects)).toEqual({ type: 'end-session', project: 'Yonder' })
    expect(route('Save that as an idea: map clustering for bounties', projects)).toMatchObject({ type: 'remember', kind: 'idea', text: 'map clustering for bounties' })
    expect(route('Remember that I prefer pnpm, but keep it out of cloud-agent handoffs', projects)).toEqual({
      type: 'remember',
      kind: 'fact',
      text: 'I prefer pnpm',
      private: true
    })
  })

  it('distinguishes stopping speech from stopping work', () => {
    expect(route('stop', projects)).toEqual({ type: 'stop-speech' })
    expect(route('stop the agent', projects)).toEqual({ type: 'stop-task', agent: undefined })
    expect(route('cancel codex', projects)).toEqual({ type: 'stop-task', agent: 'codex' })
  })

  it('starts a relay for Devpost links and keeps the rest as a note', () => {
    expect(route('brainstorm https://hacknyu-2025.devpost.com/ we want fintech', projects)).toEqual({
      type: 'relay',
      url: 'https://hacknyu-2025.devpost.com/',
      note: 'we want fintech'
    })
    expect(route('https://treehacks-2025.devpost.com/rules', projects)).toEqual({ type: 'relay', url: 'https://treehacks-2025.devpost.com/rules', note: undefined })
  })

  it('sends email questions to the mail path', () => {
    expect(route('any OAs due this week?', projects)).toEqual({ type: 'mail', text: 'any OAs due this week?' })
    expect(route('what did the Wells Fargo recruiter email say', projects)).toMatchObject({ type: 'mail' })
    expect(route('remember that I check email at 9', projects)).toMatchObject({ type: 'remember' })
  })

  it('sends schedule questions to the agenda path', () => {
    expect(route("what's on my calendar tomorrow?", projects)).toMatchObject({ type: 'agenda' })
    expect(route('any assignments due this week', projects)).toMatchObject({ type: 'agenda' })
  })

  it('opens known projects; other opening and arranging goes to Mac commands', () => {
    expect(route('open yonder', projects)).toEqual({ type: 'open', target: 'Yonder' })
    expect(route('open claude and vesper side by side', projects)).toEqual({ type: 'mac', text: 'open claude and vesper side by side' })
    expect(route('split chrome and vs code', projects)).toMatchObject({ type: 'mac' })
    expect(route("why isn't this working?", projects)).toMatchObject({ type: 'chat' })
  })

  it('matches project fragments', () => {
    expect(matchProject('blues', projects)).toBe('Blues Basketball')
    expect(matchProject('nothing', projects)).toBeUndefined()
  })
})

describe('reply parsing', () => {
  it('splits spoken and shown text and extracts directives', () => {
    const r = parseReply(
      'The purchase test fails on a null price.\n---\nDetails:\n- `price` is undefined\nACTION: {"type":"delegate","agent":"codex","project":"Yonder","prompt":"Fix null price"}\nMEMORY: {"kind":"decision","title":"Price validation","text":"Validate price server-side"}'
    )
    expect(r.spoken).toBe('The purchase test fails on a null price.')
    expect(r.shown).toContain('price')
    expect(r.shown).not.toContain('ACTION')
    expect(r.actions).toEqual([{ type: 'delegate', agent: 'codex', project: 'Yonder', prompt: 'Fix null price' }])
    expect(r.memories[0]).toMatchObject({ kind: 'decision', title: 'Price validation' })
  })

  it('reads a short reply whole, a long one by its opening, and never code', () => {
    const r = parseReply('One. Two.\n\nThree. Four.\n\n```js\nx()\n```')
    expect(r.spoken).toBe('One. Two. Three. Four.')
    const long = parseReply(`One. Two. Three. Four.\n\n${'word '.repeat(70)}.`)
    expect(long.spoken).toBe('One. Two. Three.')
    expect(speakable('Run `npm test` and see [docs](http://x)')).toBe('Run npm test and see docs')
  })

  it('splits sentences safely', () => {
    expect(splitSentences('Costs 3.5 dollars, e.g. cheap. Done! Next')).toEqual(['Costs 3.5 dollars, e.g. cheap.', 'Done!', 'Next'])
  })
})

describe('notes', () => {
  it('round-trips frontmatter', () => {
    const text = serializeNote({ title: 'Yonder', status: 'needs-review', tags: ['project', 'hackathon'], source: 'PRD: 2026-09-25' }, '# Yonder\n\nBody')
    const n = parseNote(text)
    expect(n.data).toEqual({ title: 'Yonder', status: 'needs-review', tags: ['project', 'hackathon'], source: 'PRD: 2026-09-25' })
    expect(n.body.trim()).toBe('# Yonder\n\nBody')
    expect(parseNote('---\ntags: [a, b]\n---\nx').data.tags).toEqual(['a', 'b'])
    expect(parseNote('no frontmatter').body).toBe('no frontmatter')
  })

  it('slugifies', () => {
    expect(slugify("Anuj's Blues Basketball!")).toBe('anujs-blues-basketball')
  })

  it('ranks by title, tags, then body', () => {
    const notes = [
      { path: 'a', title: 'Communication', body: 'no em dashes, concise', tags: ['preference'] },
      { path: 'b', title: 'Yonder', body: 'bounties map questions', tags: ['project'] },
      { path: 'c', title: 'Random', body: 'yonder mentioned once' }
    ]
    expect(rank('what do you know about yonder', notes).map((n) => n.path)).toEqual(['b', 'c'])
    expect(rank('the', notes)).toEqual([])
  })
})

import { SpeechStream } from '../src/core/reply'

describe('speech stream', () => {
  it('speaks sentences as they complete and stops at the separator', () => {
    const out: string[] = []
    const s = new SpeechStream((x) => out.push(x))
    s.feed('Your test')
    expect(out).toEqual([])
    s.feed('Your test is failing. The price is')
    expect(out).toEqual(['Your test is failing.'])
    s.feed('Your test is failing. The price is null.\n---\n- detail one. more.')
    expect(out).toEqual(['Your test is failing.', 'The price is null.'])
    s.finish('Your test is failing. The price is null.')
    expect(out).toHaveLength(2)
  })

  it('caps at three sentences without a separator and never speaks directives', () => {
    const out: string[] = []
    const s = new SpeechStream((x) => out.push(x))
    s.feed('One. Two. Three. Four. Five. Six')
    expect(out).toEqual(['One.', 'Two.', 'Three.'])
    const t = new SpeechStream((x) => out.push(x))
    out.length = 0
    t.feed('Done.\nMEMORY: {"kind":"fact"}\n')
    t.finish('Done.')
    expect(out).toEqual(['Done.'])
  })

  it('reads everything, separator and all, in full narration', () => {
    const out: string[] = []
    const s = new SpeechStream((x) => out.push(x), 3, true)
    s.feed('One. Two. Three. Four.\n---\n- Detail. More')
    expect(out).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Detail.'])
    s.finish(speakable('One. Two. Three. Four.\n\n- Detail. More'))
    expect(out.at(-1)).toBe('More')
  })
})

import { needsMemory } from '../src/core/router'

describe('memory gate', () => {
  it('skips the vault for general questions', () => {
    for (const q of ["what's the best AI news this week?", 'what is a pointer in C', 'tell me a joke', 'summarize transformers']) expect(needsMemory(q)).toBe(false)
  })
  it('uses the vault for personal, schedule, work and project questions', () => {
    for (const q of ['what did I decide about pricing', 'any assignments due', 'help me write to my manager', 'how are we doing on it'])
      expect(needsMemory(q)).toBe(true)
    expect(needsMemory('ideas for Yonder monetization', ['Yonder'])).toBe(true)
  })
})

describe('accent tint', () => {
  const blue: [number, number, number] = [0x38 / 255, 0x62 / 255, 0xb8 / 255]
  it('leaves blue unchanged at the default accent', () => {
    tint(blue, DEFAULT_ACCENT).forEach((v, i) => expect(v).toBeCloseTo(blue[i], 3))
  })
  it('turns blue red and keeps amber amber', () => {
    const [r, g, b] = tint(blue, { hue: 25, chroma: 1 })
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
    expect(tint([1, 0.71, 0.28], { hue: 25, chroma: 1 })).toEqual([1, 0.71, 0.28])
  })
  it('goes grey at zero chroma', () => {
    const [r, g, b] = tint(blue, { hue: 25, chroma: 0 })
    expect(Math.abs(r - b)).toBeLessThan(0.01)
    expect(Math.abs(r - g)).toBeLessThan(0.01)
  })
})

describe('web routes', () => {
  it('sends "research" to in-app research and "search" to the browser', () => {
    expect(route('research the best local speech models')).toEqual({ type: 'research', query: 'the best local speech models' })
    expect(route('look into Splash benchmarks')).toEqual({ type: 'research', query: 'Splash benchmarks' })
    expect(route('search for hackru prizes')).toEqual({ type: 'web-search', query: 'hackru prizes' })
    expect(route('google weather new brunswick')).toEqual({ type: 'web-search', query: 'weather new brunswick' })
    expect(route('search my notes for yonder').type).not.toBe('web-search')
  })
})

import { wakeCommand } from '../src/renderer/src/wake'

describe('wake word', () => {
  it('finds "Vesper" as Whisper hears it and keeps the command', () => {
    expect(wakeCommand('Hey Vesper, open Claude.')).toBe('open Claude.')
    expect(wakeCommand('Vespa transcribe this for me')).toBe('transcribe this for me')
    expect(wakeCommand('Hey, Vesper.')).toBe('')
    expect(wakeCommand('Hay Vesper open Claude')).toBe('open Claude')
    expect(wakeCommand('I was reading about vesper sparrows')).toBeNull()
  })
})
