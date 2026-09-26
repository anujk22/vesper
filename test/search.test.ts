import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mcpPayload, mergeResults, parseBing, parseDuckDuckGo, parseExa, parseParallel } from '../src/core/search'

const fx = (f: string) => readFileSync(`test/fixtures/search/${f}`, 'utf8')

describe('keyless search parsers', () => {
  it('reads Exa MCP results with highlights', () => {
    const r = parseExa(mcpPayload(fx('exa.txt')).text)
    expect(r.length).toBeGreaterThanOrEqual(3)
    expect(r[0].url).toMatch(/^https?:\/\//)
    expect(r.every((x) => x.title && x.text.length > 20)).toBe(true)
  })

  it('reads Parallel MCP results with excerpts', () => {
    const r = parseParallel(mcpPayload(fx('parallel.txt')).text)
    expect(r.length).toBeGreaterThanOrEqual(3)
    expect(r.some((x) => x.url.includes('github.com/incoai/splash'))).toBe(true)
    expect(r[0].text.length).toBeGreaterThan(100)
  })

  it('reads DuckDuckGo and Bing result pages', () => {
    const d = parseDuckDuckGo(fx('ddg.html'))
    expect(d.length).toBeGreaterThanOrEqual(5)
    expect(d.every((x) => /^https?:\/\//.test(x.url) && !x.url.includes('duckduckgo.com'))).toBe(true)
    const b = parseBing(fx('bing.html'))
    expect(b.length).toBeGreaterThanOrEqual(3)
    expect(b[0].title).not.toMatch(/</)
  })

  it('merges one page seen by two engines, keeping the longer excerpt', () => {
    const m = mergeResults(
      [
        [{ url: 'https://www.a.com/x/', title: 'A', text: 'short', engine: 'Exa' }],
        [{ url: 'https://a.com/x?ref=1', title: '', text: 'much longer excerpt', engine: 'Parallel' }, { url: 'https://b.com', title: 'B', text: '', engine: 'Parallel' }]
      ],
      5
    )
    expect(m).toHaveLength(2)
    expect(m[0]).toMatchObject({ title: 'A', text: 'much longer excerpt' })
  })

  it('surfaces MCP tool errors', () => {
    expect(mcpPayload('event: message\ndata: {"jsonrpc":"2.0","error":{"message":"rate limited"}}').error).toBe('rate limited')
  })
})
