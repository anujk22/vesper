import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { parseNote, safeTitle, serializeNote, tokens, type Frontmatter } from '../core/notes'
import { BM25, chunkNote, cosine, fuse, stem, type Passage } from '../core/retrieval'
import { createHash } from 'node:crypto'
import type { MemoryWrite } from '../core/reply'
import type { AgentTask, Atlas, MemoryChange, NoteSummary, SourceRef } from '../core/types'
import { run } from './shell'

interface LoadedNote extends NoteSummary {
  body: string
  data: Frontmatter
  mtime: number
}

const today = () => new Date().toLocaleDateString('en-CA')

export class Vault {
  private cache = new Map<string, LoadedNote>()

  constructor(public root: string) {}

  /** Create the vault from the bundled template on first run and make it a local git repo for history/undo. */
  async ensure(): Promise<void> {
    const fresh = !existsSync(join(this.root, 'AGENTS.md'))
    if (fresh) {
      const template = app.isPackaged ? join(process.resourcesPath, 'vault-template') : join(app.getAppPath(), 'vault-template')
      mkdirSync(this.root, { recursive: true })
      cpSync(template, this.root, { recursive: true, force: false, errorOnExist: false })
    }
    if (!existsSync(join(this.root, '.git'))) {
      await this.git(['init', '-q', '-b', 'main'])
      await this.git(['config', 'user.name', 'Vesper'])
      await this.git(['config', 'user.email', 'bluevis@localhost'])
      writeFileSync(join(this.root, '.gitignore'), '.obsidian/workspace*.json\n.trash/\n')
    }
    await this.commit(fresh ? 'Create vault' : 'Record edits made outside Vesper')
  }

  private git(args: string[]) {
    return run('git', args, { cwd: this.root })
  }

  /** Commit everything pending. Returns the new commit hash, or undefined when nothing changed. */
  async commit(message: string): Promise<string | undefined> {
    await this.git(['add', '-A'])
    const r = await this.git(['commit', '-q', '-m', message])
    if (r.code !== 0) return undefined
    return (await this.git(['rev-parse', '--short', 'HEAD'])).stdout.trim()
  }

  load(): LoadedNote[] {
    const out: LoadedNote[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue
        const full = join(dir, name)
        const st = statSync(full)
        if (st.isDirectory()) walk(full)
        else if (name.endsWith('.md') && !['AGENTS.md', 'CLAUDE.md'].includes(name)) {
          const rel = relative(this.root, full)
          const hit = this.cache.get(rel)
          if (hit && hit.mtime === st.mtimeMs) {
            out.push(hit)
            continue
          }
          const { data, body } = parseNote(readFileSync(full, 'utf8'))
          const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : undefined)
          const note: LoadedNote = {
            path: rel,
            title: str('title') ?? name.replace(/\.md$/, ''),
            area: rel.includes('/') ? rel.split('/')[0] : 'Home',
            status: str('status'),
            updated: str('updated'),
            source: str('source'),
            summary: str('summary') ?? firstParagraph(body),
            tags: Array.isArray(data.tags) ? data.tags : undefined,
            body,
            data,
            mtime: st.mtimeMs
          }
          this.cache.set(rel, note)
          out.push(note)
        }
      }
    }
    if (existsSync(this.root)) walk(this.root)
    return out
  }

  /** Project notes that declare `path:` link a friendly name to a repo folder. */
  projectLinks(): { title: string; path: string }[] {
    return this.load()
      .filter((n) => n.area === 'Projects' && typeof n.data.path === 'string' && n.data.path)
      .map((n) => ({ title: n.title, path: (n.data.path as string).replace(/^~(?=\/)/, homedir()).replace(/\/$/, '') }))
  }

  async changes(limit = 40): Promise<MemoryChange[]> {
    const r = await this.git(['log', `-${limit}`, '--name-only', '--format=\x1e%h\x1f%ct\x1f%s'])
    if (r.code !== 0) return []
    return r.stdout
      .split('\x1e')
      .filter(Boolean)
      .map((block) => {
        const [head, ...files] = block.trim().split('\n')
        const [hash, at, subject] = head.split('\x1f')
        return { hash, at: Number(at) * 1000, subject, files: files.filter(Boolean) }
      })
  }

  async atlas(): Promise<Atlas> {
    const notes = this.load().map(({ body: _b, data: _d, mtime: _m, ...summary }) => summary)
    return { vaultPath: this.root, notes, changes: await this.changes() }
  }

  read(rel: string): string {
    return readFileSync(this.safePath(rel), 'utf8')
  }

  private safePath(rel: string): string {
    const full = join(this.root, rel)
    if (relative(this.root, full).startsWith('..')) throw new Error('Path escapes the vault')
    return full
  }

  private index: { sig: string; passages: Passage[]; bm25: BM25 } | null = null
  private vectors = new Map<string, number[]>()
  private vectorsLoaded = false
  private filling: Promise<void> | null = null
  /** Set by main once the local sidecar can embed text. */
  embedder: ((texts: string[], query: boolean) => Promise<number[][] | null>) | null = null

  private passages() {
    // Provenance records (Sources/) describe where knowledge came from; they are not knowledge to retrieve.
    const notes = this.load().filter((n) => String(n.data.index) !== 'false' && n.path !== 'Profile/Core.md' && n.area !== 'Sources')
    const sig = notes.map((n) => `${n.path}:${n.mtime}`).join('|')
    if (this.index?.sig !== sig) {
      const passages = notes.flatMap((n) =>
        chunkNote({ path: n.path, title: n.title, area: n.area, body: n.body, status: n.status, localOnly: n.data.share === 'local-only', aliases: Array.isArray(n.data.aliases) ? n.data.aliases : undefined })
      )
      this.index = { sig, passages, bm25: new BM25(passages) }
    }
    return this.index
  }

  private get vectorFile() {
    return join(app.getPath('userData'), 'embeddings.json')
  }

  private embedText(p: Passage) {
    return `${p.title}${p.aliases?.length ? ` (${p.aliases.join(', ')})` : ''}. ${p.heading}. ${p.text}`
  }

  private key(p: Passage) {
    return createHash('sha1').update(`${this.embedText(p)}`).digest('hex').slice(0, 16)
  }

  /** Embed any passages that changed since last time. Runs in the background; retrieval never waits on it. */
  refreshEmbeddings(): Promise<void> {
    if (this.filling || !this.embedder) return this.filling ?? Promise.resolve()
    this.filling = (async () => {
      if (!this.vectorsLoaded) {
        try {
          const saved = JSON.parse(readFileSync(this.vectorFile, 'utf8')) as Record<string, number[]>
          for (const [k, v] of Object.entries(saved)) this.vectors.set(k, v)
        } catch {
          // First run: nothing cached yet.
        }
        this.vectorsLoaded = true
      }
      const { passages } = this.passages()
      const missing = passages.filter((p) => !this.vectors.has(this.key(p)))
      for (let i = 0; i < missing.length; i += 64) {
        const batch = missing.slice(i, i + 64)
        const vecs = await this.embedder!(batch.map((p) => this.embedText(p)), false)
        if (!vecs) break
        batch.forEach((p, j) => this.vectors.set(this.key(p), vecs[j]))
      }
      const live = new Set(passages.map((p) => this.key(p)))
      writeFileSync(this.vectorFile, JSON.stringify(Object.fromEntries([...this.vectors].filter(([k]) => live.has(k)))))
    })().finally(() => (this.filling = null))
    return this.filling
  }

  /** Hybrid keyword + semantic passage search. Used for model context and the Memory search box. */
  async search(
    query: string,
    opts: { allowPrivate: boolean; project?: string; limit?: number; strict?: boolean }
  ): Promise<(Passage & { via: string; kw: number; sem: number })[]> {
    const { passages, bm25 } = this.passages()
    const allowed = (p: Passage) => opts.allowPrivate || !p.localOnly
    const keyword = bm25.scores(opts.project ? `${query} ${opts.project}` : query).map((s, i) => (allowed(passages[i]) ? s : 0))
    let semantic: number[] | null = null
    if (this.embedder) {
      const qv = (await this.embedder([query], true))?.[0]
      if (qv) semantic = passages.map((p) => (allowed(p) ? cosine(qv, this.vectors.get(this.key(p)) ?? []) : 0))
      void this.refreshEmbeddings()
    }
    // bge-small similarities cluster together, so only near-best semantic matches count.
    // Strict mode (model context) measured on the real vault: relevant passages score
    // 0.64-0.74, noise 0.40-0.62, so context requires a strong meaning match and keywords
    // only help ranking. Browsing (the Memory search box) stays looser.
    const best = semantic ? Math.max(...semantic) : 0
    const cutoff = opts.strict ? Math.max(0.63, best - 0.06) : Math.max(0.55, best - 0.08)
    if (opts.strict) {
      // Naming a note directly (its title or an Obsidian alias like "internship") also
      // qualifies, which catches vocabulary the embedding model maps poorly. Body-word
      // matches alone never do: they are what pulled unrelated notes in before.
      const q = new Set(tokens(query).map(stem))
      const named = (p: Passage) => tokens([p.title, ...(p.aliases ?? [])].join(' ')).some((t) => q.has(stem(t)))
      const keep = passages.map((p, i) => (semantic ? semantic[i] >= cutoff || (named(p) && semantic[i] >= 0.45) : named(p)))
      for (let i = 0; i < keyword.length; i++) {
        if (!keep[i]) {
          keyword[i] = 0
          if (semantic) semantic[i] = 0
        } else if (semantic && semantic[i] < cutoff) semantic[i] = cutoff
      }
    }
    // Generated outputs and session logs rank below real knowledge, and no note may crowd out others.
    const derived = (i: number) => /^(Outputs|Sessions)$/.test(passages[i].area)
    const perNote = new Map<string, number>()
    const picked = fuse(keyword, semantic, (opts.limit ?? 6) * 4, cutoff)
      .sort((a, b) => Number(derived(a)) - Number(derived(b)))
      .filter((i) => {
        const n = perNote.get(passages[i].path) ?? 0
        perNote.set(passages[i].path, n + 1)
        return n < 2
      })
      .slice(0, opts.limit ?? 6)
    const project = opts.project?.toLowerCase()
    const projectFirst = project ? passages.findIndex((p) => p.area === 'Projects' && p.title.toLowerCase() === project && allowed(p)) : -1
    if (projectFirst >= 0 && !picked.includes(projectFirst)) picked.unshift(projectFirst)
    return picked.map((i) => ({
      ...passages[i],
      kw: Math.round(keyword[i] * 100) / 100,
      sem: semantic ? Math.round(semantic[i] * 1000) / 1000 : 0,
      via: [keyword[i] > 0 && 'keywords', semantic && semantic[i] >= cutoff && 'meaning', i === projectFirst && 'active project'].filter(Boolean).join(' + ')
    }))
  }

  /**
   * Scoped context for one model turn: the Core card, the active project's note,
   * and the few passages most relevant to the query (keyword + semantic).
   * `share: local-only` material is excluded unless the model runs locally (PRD §10.9).
   */
  async context(query: string, opts: { allowPrivate: boolean; project?: string; maxChars?: number; limit?: number }): Promise<{ text: string; used: SourceRef[] }> {
    const budget = opts.maxChars ?? 7000
    const blocks: string[] = []
    const used: SourceRef[] = []
    let size = 0
    const add = (ref: SourceRef, meta: string, body: string) => {
      const block = `### ${ref.title}${ref.heading ? ` › ${ref.heading}` : ''} (${ref.path}${meta ? `; ${meta}` : ''})\n${body.trim()}`
      if (size + block.length > budget) return
      blocks.push(block)
      used.push(ref)
      size += block.length
    }
    const notes = this.load()
    const core = notes.find((n) => n.path === 'Profile/Core.md')
    if (core) add({ path: core.path, title: 'Core' }, '', core.body.replace(/^The always-loaded card.*$/m, ''))

    for (const p of await this.search(query, { allowPrivate: opts.allowPrivate, project: opts.project, limit: opts.limit ?? 4, strict: true })) {
      add({ path: p.path, title: p.title, heading: p.heading || undefined }, p.status ? `status: ${p.status}` : '', p.text)
    }
    return { text: blocks.join('\n\n'), used }
  }

  /** Persist a memory the brain proposed or the user asked for. Returns the note path and commit hash. */
  async remember(w: MemoryWrite & { private?: boolean; origin: string; status?: string }): Promise<{ path: string; hash?: string }> {
    const stamp = `(learned ${today()}; ${w.origin})`
    let rel: string
    if (w.kind === 'preference' || w.kind === 'goal') {
      rel = w.kind === 'preference' ? 'Profile/Preferences.md' : 'Profile/Goals.md'
      this.appendBullet(rel, { title: w.kind === 'preference' ? 'Preferences' : 'Goals and dated commitments', status: 'known' }, `${w.text} ${stamp}`)
    } else if (w.kind === 'project' && w.project) {
      rel = `Projects/${safeTitle(w.project)}.md`
      this.appendBullet(rel, { title: w.project, status: w.status ?? 'needs-review' }, `${w.title}: ${w.text} ${stamp}`, '## Log')
    } else {
      const folder = w.kind === 'decision' ? 'Decisions' : w.kind === 'idea' ? 'Ideas' : w.kind === 'person' ? 'People' : w.kind === 'project' ? 'Projects' : 'Inbox'
      rel = `${folder}/${safeTitle(w.title)}.md`
      const data: Frontmatter = {
        title: w.title,
        type: w.kind,
        status: w.status ?? (w.kind === 'decision' ? 'known' : w.kind === 'idea' ? 'exploratory' : 'needs-review'),
        source: w.origin,
        learned: today(),
        updated: today()
      }
      if (w.project) data.project = `[[${w.project}]]`
      if (w.private) data.share = 'local-only'
      const full = this.safePath(rel)
      if (existsSync(full)) {
        this.appendBullet(rel, data, `${w.text} ${stamp}`)
      } else {
        mkdirSync(dirname(full), { recursive: true })
        const hint =
          w.kind === 'idea' ? '\n\n> Exploratory. Not a commitment.' : w.kind === 'fact' ? '\n\n> Captured by Vesper. Review and move to the right note.' : ''
        writeFileSync(full, serializeNote(data, `# ${w.title}${hint}\n\n${w.text}`))
      }
    }
    const hash = await this.commit(`Remember: ${w.title}`)
    return { path: rel, hash }
  }

  private appendBullet(rel: string, defaults: Frontmatter, line: string, heading?: string) {
    const full = this.safePath(rel)
    let data: Frontmatter = defaults
    let body = `# ${defaults.title}\n`
    if (existsSync(full)) ({ data, body } = parseNote(readFileSync(full, 'utf8')))
    data.updated = today()
    if (heading && !body.includes(heading)) body = `${body.trimEnd()}\n\n${heading}\n`
    if (heading) {
      const i = body.indexOf(heading) + heading.length
      body = `${body.slice(0, i)}\n- ${line}${body.slice(i)}`
    } else body = `${body.trimEnd()}\n- ${line}\n`
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, serializeNote(data, body))
  }

  async writeSession(title: string, markdown: string, project?: string): Promise<{ path: string; hash?: string }> {
    const date = today()
    const rel = `Sessions/${date} ${safeTitle(title)}.md`
    const data: Frontmatter = { title: `${date} ${title}`, type: 'session', status: 'historical', source: 'Vesper session', updated: date }
    if (project) data.project = `[[${project}]]`
    mkdirSync(join(this.root, 'Sessions'), { recursive: true })
    writeFileSync(this.safePath(rel), serializeNote(data, markdown))
    return { path: rel, hash: await this.commit(`Session: ${title}`) }
  }

  /** Agent runs are outputs: kept with their prompt, observed status and changed files, never treated as evidence of their own claims. */
  async writeAgentRun(t: AgentTask): Promise<void> {
    const date = today()
    const rel = `Outputs/Agent runs/${date} ${safeTitle(`${t.project ?? 'folder'} ${t.title}`).slice(0, 70)}.md`
    const data: Frontmatter = {
      title: t.title,
      type: 'agent-run',
      status: t.status,
      agent: `${t.choice.provider}/${t.choice.model}`,
      source: 'Vesper agent run (agent self-report plus observed commands)',
      updated: date
    }
    if (t.project) data.project = `[[${t.project}]]`
    const steps = t.steps
      .filter((s) => s.kind === 'command' || s.kind === 'edit')
      .slice(-25)
      .map((s) => `- ${s.status === 'failed' ? '✗' : '✓'} ${s.kind === 'edit' ? 'edited' : 'ran'} \`${s.label.slice(0, 140)}\``)
    const body = [
      `# ${t.title}`,
      `> Status observed by Vesper: **${t.status}**. The summary below is the agent's own report.`,
      `## Request\n${t.prompt.split('<handoff')[0].trim()}`,
      t.finalMessage && `## Agent report\n${t.finalMessage}`,
      t.filesChanged.length && `## Files changed\n${t.filesChanged.map((f) => `- \`${f}\``).join('\n')}`,
      t.diffStat && `## Diff stat\n\`\`\`\n${t.diffStat}\n\`\`\``,
      steps.length && `## Observed steps\n${steps.join('\n')}`,
      t.error && `## Error\n${t.error}`
    ]
      .filter(Boolean)
      .join('\n\n')
    const full = this.safePath(rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, serializeNote(data, body))
    await this.commit(`Agent run: ${t.title.slice(0, 60)}`)
  }

  /** Save a deliverable under Outputs/. Outputs are not evidence for their own claims. */
  async writeOutput(name: string, body: string, fm: Frontmatter): Promise<string> {
    const rel = `Outputs/${name.split('/').map(safeTitle).join('/')}.md`
    const full = this.safePath(rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, serializeNote({ title: name.split('/').pop()!, ...fm, updated: today() }, body))
    await this.commit(`Output: ${name.split('/').pop()}`)
    return rel
  }

  latestSession(project?: string): { path: string; body: string } | undefined {
    const sessions = this.load()
      .filter((n) => n.area === 'Sessions' && (!project || String(n.data.project ?? '').toLowerCase().includes(project.toLowerCase())))
      .sort((a, b) => b.path.localeCompare(a.path))
    return sessions[0] && { path: sessions[0].path, body: sessions[0].body }
  }

  /** Auto-captured notes that have not been reviewed: the ones background consolidation may merge. */
  inbox(): { path: string; title: string; body: string }[] {
    return this.load()
      .filter((n) => n.area === 'Inbox' && n.status === 'needs-review' && n.data.share !== 'local-only')
      .map((n) => ({ path: n.path, title: n.title, body: n.body }))
  }

  /** Replace several notes with one merged note, as a single commit that can be undone. */
  async consolidate(paths: string[], title: string, body: string): Promise<string | undefined> {
    const rel = `Inbox/${safeTitle(title)}.md`
    for (const p of paths) rmSync(this.safePath(p), { force: true })
    const data: Frontmatter = { title, type: 'fact', status: 'needs-review', source: `merged by Vesper from ${paths.length} notes`, learned: today(), updated: today() }
    writeFileSync(this.safePath(rel), serializeNote(data, `# ${title}\n\n${body.trim().replace(/^#\s+.*\n+/, '')}\n\n> Merged from: ${paths.map((p) => p.replace(/^Inbox\/|\.md$/g, '')).join(', ')}. Undo this change in Memory if the merge lost something.\n`))
    this.cache.clear()
    return this.commit(`Consolidate memory: ${title} (from ${paths.length} notes)`)
  }

  async undo(hash: string): Promise<boolean> {
    const r = await this.git(['revert', '--no-edit', hash])
    return r.code === 0
  }
}

function firstParagraph(body: string): string | undefined {
  const p = body
    .replace(/^#.*$/gm, '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('>') && !s.startsWith('|'))
  return p
    ?.replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 220)
}
