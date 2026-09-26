import { describe, expect, it } from 'vitest'
import { asksAboutTerminal, plainText, redact, terminalTail } from '../src/core/terminal'

describe('terminal text', () => {
  it('strips colors and applies carriage returns and backspaces', () => {
    expect(plainText('\x1b[31mError:\x1b[0m bad\r\n')).toBe('Error: bad\n')
    expect(plainText('progress 10%\rprogress 100%')).toBe('progress 100%')
    expect(plainText('abc\x08\x08X')).toBe('aX')
    expect(plainText('\x1b]0;title\x07ok')).toBe('ok')
  })

  it('masks credentials', () => {
    const out = redact(['OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv', 'token ghp_abcdefghijklmnopqrstuvwxyz123', 'postgres://me:hunter2@db:5432/x', 'PORT=3000'].join('\n'))
    expect(out).not.toMatch(/sk-abc|ghp_abc|hunter2/)
    expect(out).toContain('PORT=3000')
    expect(out).toContain('postgres://me:[redacted]@db')
  })

  it('keeps the tail and spots terminal questions', () => {
    expect(terminalTail('a\nb\nc\n\n', 2)).toBe('b\nc')
    expect(asksAboutTerminal('why did the build fail?')).toBe(true)
    expect(asksAboutTerminal("what's the best ai news")).toBe(false)
  })
})
