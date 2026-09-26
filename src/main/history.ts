import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexMeta, fallbackTitle, parseClaudeThread, parseCodexThread, type HistoryProvider, type ThreadItem, type ThreadSummary } from '../core/history'

const CODEX = join(homedir(), '.codex')
const CLAUDE = join(homedir(), '.claude', 'projects')
// Claude Code folders that hold Vesper's own runs or throwaway scratch sessions, not the user's work.
const CLAUDE_SKIP = /Application-Support-(?:Vesper|Bluevis)|Application-Support-Claude-scratch|^-private-tmp/

function head(path: string, bytes: number, fromEnd = false): string {
  const size = statSync(path).size
  const len = Math.min(size, bytes)
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, fromEnd ? size - len : 0)
  closeSync(fd)
  return buf.toString('utf8')
}

function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
}

/** Lists past threads cheaply (first and last bytes only), cached by file mtime. */
export class HistoryService {
  private cache = new Map<string, { mtime: number; summary: ThreadSummary | null }>()

  list(): ThreadSummary[] {
    const out: ThreadSummary[] = []
    const titles = this.codexTitles()
    const files: { file: string; provider: HistoryProvider }[] = []
    if (existsSync(join(CODEX, 'sessions'))) {
      const f: string[] = []
      walk(join(CODEX, 'sessions'), f)
      files.push(...f.map((file) => ({ file, provider: 'codex' as const })))
    }
    if (existsSync(CLAUDE)) {
      for (const d of readdirSync(CLAUDE)) {
        if (CLAUDE_SKIP.test(d)) continue
        const dir = join(CLAUDE, d)
        if (!statSync(dir).isDirectory()) continue
        for (const n of readdirSync(dir)) if (n.endsWith('.jsonl')) files.push({ file: join(dir, n), provider: 'claude' })
      }
    }
    for (const { file, provider } of files) {
      const mtime = statSync(file).mtimeMs
      let hit = this.cache.get(file)
      if (!hit || hit.mtime !== mtime) {
        hit = { mtime, summary: provider === 'codex' ? this.codexSummary(file, mtime) : this.claudeSummary(file, mtime) }
        this.cache.set(file, hit)
      }
      if (hit.summary) out.push(provider === 'codex' ? { ...hit.summary, title: titles.get(hit.summary.id) ?? hit.summary.title } : hit.summary)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  read(file: string): { items: ThreadItem[]; model?: string; effort?: string } {
    if (!this.cache.has(file)) throw new Error('Unknown thread')
    const text = readFileSync(file, 'utf8')
    return this.cache.get(file)!.summary!.provider === 'codex' ? parseCodexThread(text) : parseClaudeThread(text)
  }

  private codexTitles(): Map<string, string> {
    const m = new Map<string, string>()
    try {
      for (const l of readFileSync(join(CODEX, 'session_index.jsonl'), 'utf8').split('\n')) {
        if (!l) continue
        const d = JSON.parse(l)
        if (d.id && d.thread_name) m.set(d.id, d.thread_name)
      }
    } catch {
      // No index yet; titles fall back to the first request.
    }
    return m
  }

  private codexSummary(file: string, mtime: number): ThreadSummary | null {
    const start = head(file, 256 * 1024)
    const meta = codexMeta(start.slice(0, start.indexOf('\n')))
    if (!meta) return null
    const { items } = parseCodexThread(start)
    if (!items.some((i) => i.kind === 'user')) return null
    return { id: meta.id, provider: 'codex', title: fallbackTitle(items), cwd: meta.cwd, updatedAt: mtime, file }
  }

  private claudeSummary(file: string, mtime: number): ThreadSummary | null {
    const start = parseClaudeThread(head(file, 256 * 1024))
    if (!start.id || !start.items.some((i) => i.kind === 'user')) return null
    // Titles are appended as the thread goes on; the newest one is near the end.
    const end = parseClaudeThread(head(file, 128 * 1024, true).split('\n').slice(1).join('\n'))
    return { id: start.id, provider: 'claude', title: end.title ?? start.title ?? fallbackTitle(start.items), cwd: start.cwd ?? '', updatedAt: mtime, file }
  }
}
