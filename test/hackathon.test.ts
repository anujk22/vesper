import { describe, expect, it } from 'vitest'
import { formatLeft, hackLine, hackStatus, parseExtract, type Hackathon } from '../src/core/hackathon'

const h0 = 1_800_000_000_000
const hack = (over: Partial<Hackathon> = {}): Hackathon => ({
  id: 'h',
  title: 'HackNYU',
  url: 'https://x.devpost.com',
  plan: '',
  hook: '',
  startedAt: h0,
  deadline: h0 + 36 * 3600_000,
  milestones: [
    { id: 'a', title: 'Core loop', hour: 6, done: true },
    { id: 'b', title: 'Camera works', hour: 12, done: false },
    { id: 'c', title: 'Polish', hour: 30, done: false }
  ],
  criteria: [],
  active: true,
  ...over
})

describe('hackathon', () => {
  it('knows what is behind and next', () => {
    const s = hackStatus(hack(), h0 + 14 * 3600_000)
    expect(s.behind.map((m) => m.id)).toEqual(['b'])
    expect(s.next?.id).toBe('c')
    expect(s.left).toBe(22 * 3600_000)
    expect(hackLine(hack(), h0 + 14 * 3600_000)).toContain('Behind on: Camera works (due hour 12)')
  })

  it('formats time left', () => {
    expect(formatLeft(22 * 3600_000 + 5 * 60_000)).toBe('22:05 left')
    expect(formatLeft(-1)).toBe('past deadline')
    expect(formatLeft(72 * 3600_000)).toBe('3d left')
  })

  it('parses fenced or bare JSON and drops malformed rows', () => {
    const r = parseExtract('Here:\n```json\n{"deadline":null,"hook":"x","milestones":[{"hour":4,"title":"A"},{"title":"no hour"}],"criteria":[{"name":"Impact","detail":"d"}]}\n```')
    expect(r?.milestones).toEqual([{ hour: 4, title: 'A' }])
    expect(r?.criteria[0].name).toBe('Impact')
    expect(parseExtract('no json')).toBeNull()
  })
})

import { allowanceNudge } from '../src/core/usage'

describe('allowance nudge', () => {
  it('nudges only when a real share of the week resets soon', () => {
    const now = Date.now()
    const snap = (used: number, inH: number) => ({ provider: 'codex' as const, observedAt: now, windows: [{ name: 'weekly', usedPercent: used, resetsAt: now + inH * 3600_000 }] })
    expect(allowanceNudge(snap(60, 4), now)).toEqual({ left: 40, hours: 4 })
    expect(allowanceNudge(snap(90, 4), now)).toBeNull()
    expect(allowanceNudge(snap(60, 40), now)).toBeNull()
  })
})
