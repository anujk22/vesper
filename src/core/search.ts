// Parsers for the free, keyless web search engines (Exa and Parallel public MCP endpoints,
// DuckDuckGo and Bing result pages). Kept pure so they are tested against real payloads.

export interface WebResult {
  url: string
  title: string
  /** Page excerpts relevant to the query, when the engine returns them. */
  text: string
  engine: string
}

/** One JSON-RPC reply from an MCP endpoint, which may arrive as plain JSON or as an SSE frame. */
export function mcpPayload(body: string): { text: string; error?: string } {
  let json: { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message?: string } } | null = null
  try {
    json = JSON.parse(body)
  } catch {
    for (const line of body.split('\n'))
      if (line.startsWith('data: '))
        try {
          json = JSON.parse(line.slice(6))
          break
        } catch {
          // Keep looking for the data frame.
        }
  }
  if (!json) return { text: '', error: 'no data' }
  const text = (json.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  if (json.error || json.result?.isError) return { text, error: json.error?.message ?? (text.slice(0, 200) || 'tool call failed') }
  return { text }
}

/** Exa's web_search_exa text: blocks of "Title: / URL: / Highlights:" separated by "---". */
export function parseExa(text: string): WebResult[] {
  return text
    .split(/\n---\n|\n(?=Title: )/)
    .map((block) => {
      const url = block.match(/^URL: (\S+)$/m)?.[1]
      const title = block.match(/^Title: (.+)$/m)?.[1] ?? ''
      const body = block.split(/^Highlights:\s*$/m)[1] ?? ''
      return url ? { url, title, text: body.replace(/\n\.\.\.\n/g, '\n').trim(), engine: 'Exa' } : null
    })
    .filter((r): r is WebResult => !!r)
}

/** Parallel's web_search / web_fetch text: JSON with results[].excerpts. */
export function parseParallel(text: string): WebResult[] {
  try {
    const d = JSON.parse(text) as { results?: { url: string; title?: string; excerpts?: string[] }[] }
    return (d.results ?? []).filter((r) => r.url).map((r) => ({ url: r.url, title: r.title ?? '', text: (r.excerpts ?? []).join('\n\n').trim(), engine: 'Parallel' }))
  } catch {
    return []
  }
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** DuckDuckGo's HTML results page. Links go through a redirect that carries the real URL in `uddg`. */
export function parseDuckDuckGo(html: string): WebResult[] {
  const out: WebResult[] = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const href = decode(m[1])
    const url = href.includes('uddg=') ? decodeURIComponent(href.split('uddg=')[1].split('&')[0]) : href.startsWith('//') ? `https:${href}` : href
    if (/duckduckgo\.com\/y\.js/.test(url)) continue // ads
    out.push({ url, title: decode(m[2]), text: decode(m[3] ?? ''), engine: 'DuckDuckGo' })
  }
  return out
}

/** Bing's results page: each organic result is an li.b_algo with an h2 link and a caption paragraph. */
export function parseBing(html: string): WebResult[] {
  return html
    .split('<li class="b_algo"')
    .slice(1)
    .map((block) => {
      const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
      return a && /^https?:/.test(a[1]) ? { url: decode(a[1]), title: decode(a[2]), text: decode(p?.[1] ?? ''), engine: 'Bing' } : null
    })
    .filter((r): r is WebResult => !!r)
}

/** Same page from several engines: keep one entry, with the longest excerpt. */
export function mergeResults(lists: WebResult[][], limit: number): WebResult[] {
  const key = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/$/, '')
  const seen = new Map<string, WebResult>()
  // Interleave so each engine's best results come first.
  const longest = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < longest; i++)
    for (const list of lists) {
      const r = list[i]
      if (!r) continue
      const k = key(r.url)
      const prev = seen.get(k)
      if (!prev) seen.set(k, r)
      else if (r.text.length > prev.text.length) seen.set(k, { ...r, title: prev.title || r.title })
    }
  return [...seen.values()].slice(0, limit)
}
