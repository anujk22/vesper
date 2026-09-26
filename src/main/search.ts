import { mcpPayload, mergeResults, parseBing, parseDuckDuckGo, parseExa, parseParallel, type WebResult } from '../core/search'

// Free web search with no account or key. Exa and Parallel run public MCP endpoints that return page
// excerpts, not just links; both are queried at once. DuckDuckGo and Bing result pages are the fallback.
// Only the query leaves the Mac.
const EXA = 'https://mcp.exa.ai/mcp'
const PARALLEL = 'https://search.parallel.ai/mcp'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

async function mcp(url: string, name: string, args: object, ms: number): Promise<string> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(ms)
  })
  if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`)
  const { text, error } = mcpPayload(await r.text())
  if (error) throw new Error(error)
  return text
}

const page = async (url: string, init: RequestInit = {}) => {
  const r = await fetch(url, { ...init, headers: { 'user-agent': UA, 'accept-language': 'en-US', ...init.headers }, signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`)
  return r.text()
}

const engines = {
  exa: async (q: string) => parseExa(await mcp(EXA, 'web_search_exa', { query: q, numResults: 8 }, 15000)),
  parallel: async (q: string) => parseParallel(await mcp(PARALLEL, 'web_search', { objective: q, search_queries: [q] }, 15000)),
  ddg: async (q: string) => parseDuckDuckGo(await page('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `q=${encodeURIComponent(q)}` })),
  bing: async (q: string) => parseBing(await page(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en`))
}

const cache = new Map<string, { at: number; results: WebResult[] }>()

/** Search the web: the two excerpt engines in parallel, the result pages only if both come back empty. */
export async function webSearch(query: string, limit = 8): Promise<WebResult[]> {
  const hit = cache.get(query)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.results
  const primary = await Promise.allSettled([engines.exa(query), engines.parallel(query)])
  let lists = primary.flatMap((p) => (p.status === 'fulfilled' ? [p.value] : []))
  if (!lists.some((l) => l.length)) {
    for (const f of [engines.ddg, engines.bing]) {
      const r = await f(query).catch(() => [])
      if (r.length) {
        lists = [r]
        break
      }
    }
  }
  const results = mergeResults(lists, limit)
  if (!results.length) throw new Error(primary.map((p) => (p.status === 'rejected' ? (p.reason as Error).message : 'no results')).join('; '))
  cache.set(query, { at: Date.now(), results })
  if (cache.size > 50) cache.delete(cache.keys().next().value!)
  return results
}

/** Read full pages. Exa returns clean markdown; Parallel is the fallback. */
export async function webFetch(urls: string[], objective: string): Promise<{ url: string; text: string }[]> {
  try {
    const text = await mcp(EXA, 'web_fetch_exa', { urls, maxCharacters: 8000 }, 20000)
    // One markdown document per URL, each starting with its "URL:" line.
    const docs = text.split(/\n(?=# .+\nURL: )/)
    return urls.map((url) => ({ url, text: docs.find((d) => d.includes(`URL: ${url}`)) ?? '' })).filter((d) => d.text)
  } catch {
    const r = parseParallel(await mcp(PARALLEL, 'web_fetch', { urls, objective, full_content: false }, 20000))
    return r.map((x) => ({ url: x.url, text: x.text }))
  }
}
