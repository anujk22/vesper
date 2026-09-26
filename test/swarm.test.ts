import { describe, expect, it } from 'vitest'
import { parseSwarmPlan, peerDigest, type Swarm } from '../src/core/swarm'

describe('agent teams', () => {
  it('reads a plan, trimming nicknames and honoring the requested count', () => {
    const p = parseSwarmPlan('```json\n{"mode":"debate","rounds":5,"research":true,"agents":[{"name":"Ada Lovelace","persona":"pragmatist","task":"a"},{"name":"Rex","persona":"skeptic","task":"b"},{"name":"Juno","persona":"optimist","task":"c"}]}\n```', 2)
    expect(p).toEqual({ mode: 'debate', rounds: 3, research: true, agents: [{ name: 'Ada', persona: 'pragmatist', task: 'a' }, { name: 'Rex', persona: 'skeptic', task: 'b' }] })
    expect(parseSwarmPlan('{"mode":"parallel","agents":[{"name":"A"},{"name":"B"}]}')?.rounds).toBe(1)
    expect(parseSwarmPlan('{"agents":[{"name":"Solo"}]}')).toBeNull()
    expect(parseSwarmPlan('not json')).toBeNull()
  })

  it("shows each agent the others' latest finished message, never its own", () => {
    const msg = (text: string, pending = false) => ({ id: text, from: 'agent' as const, text, at: 0, pending })
    const s = {
      agents: [
        { id: 'a', name: 'Ada', persona: 'p1', messages: [msg('old'), msg('mine')] },
        { id: 'b', name: 'Rex', persona: 'p2', messages: [msg('rex final'), msg('still writing', true)] }
      ]
    } as unknown as Swarm
    const d = peerDigest(s, 'a')
    expect(d).toContain('Rex (p2):\nrex final')
    expect(d).not.toContain('mine')
    expect(d).not.toContain('still writing')
  })
})

import { route } from '../src/core/router'
import { parseReply } from '../src/core/reply'

describe('launching teams', () => {
  it('routes "launch N agents" and reads the Ultra directive', () => {
    expect(route('launch 3 agents who research remote work from a manager, employee and economist view and debate')).toEqual({ type: 'swarm', goal: 'research remote work from a manager, employee and economist view and debate', count: 3 })
    expect(route('spin up two agents to compare Svelte and React').type).toBe('swarm')
    const r = parseReply('Setting up a team.\nSWARM: {"goal":"compare the options","count":3}')
    expect(r.swarms).toEqual([{ goal: 'compare the options', count: 3 }])
    expect(r.shown).toBe('Setting up a team.')
  })
})

import { nearDuplicates } from '../src/core/consolidate'

describe('memory consolidation', () => {
  it('groups only close matches, largest group first', () => {
    const g = nearDuplicates([
      { path: 'a', vec: [1, 0, 0] },
      { path: 'b', vec: [0.99, 0.05, 0] },
      { path: 'c', vec: [0, 1, 0] },
      { path: 'd', vec: [0.98, 0.1, 0] },
      { path: 'e', vec: [0, 0.98, 0.1] }
    ])
    expect(g).toEqual([['a', 'b', 'd'], ['c', 'e']])
    expect(nearDuplicates([{ path: 'x', vec: [1, 0] }, { path: 'y', vec: [0, 1] }])).toEqual([])
  })
})

describe('screenshot intent', () => {
  it('saves a screenshot for short spoken requests', () => {
    for (const t of ['Hey Vesper, take a screenshot.', 'screenshot', 'screenshot this', 'grab a screen shot please', 'remember this', 'save this screen'])
      expect(route(t)).toEqual({ type: 'screenshot' })
  })
  it('leaves remembering facts and questions about screenshots alone', () => {
    expect(route('remember that the demo is at 3pm')).toMatchObject({ type: 'remember' })
    expect(route('how do I take a screenshot on Windows')).toMatchObject({ type: 'chat' })
  })
})
