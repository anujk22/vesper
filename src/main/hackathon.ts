import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractPrompt, parseExtract, slug, type Hackathon } from '../core/hackathon'
import type { RelayRun } from '../core/relay'
import type { AgentTask, ModelChoice } from '../core/types'
import { runProvider } from './providers'
import { getSettings } from './settings'
import { run } from './shell'
import type { TaskManager } from './tasks'
import type { Vault } from './vault'

// Extraction and the submission kit need reliable JSON and judgment, not speed.
const SONNET: ModelChoice = { provider: 'claude', model: 'sonnet' }
// Test profiles build inside the profile, never in the real Hackathons folder.
const hackRoot = () => (process.env.BLUEVIS_PROFILE_DIR ? join(app.getPath('userData'), 'Hackathons') : join(homedir(), 'Documents', 'Coding', 'Hackathons'))

/** One non-agentic model call (read-only, no tools beyond reading) that resolves with the full reply. */
function ask(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    let failed: string | null = null
    const h = runProvider({
      choice: SONNET,
      prompt,
      cwd,
      role: 'brain',
      tools: ['Read'],
      onEvent: (e) => {
        if (e.kind === 'message') text = text ? `${text}\n\n${e.text}` : e.text
        if (e.kind === 'error') failed = e.message
      }
    })
    void h.done.then(() => (failed && !text ? reject(new Error(failed)) : resolve(text)))
  })
}

export class HackathonManager {
  private file = join(app.getPath('userData'), 'hackathons.json')
  private items: Hackathon[] = []
  private workspace = join(app.getPath('userData'), 'workspace')

  constructor(
    private tasks: TaskManager,
    private vault: Vault,
    private emit: (list: Hackathon[]) => void
  ) {
    try {
      this.items = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      this.items = []
    }
  }

  list(): Hackathon[] {
    return structuredClone(this.items).sort((a, b) => b.startedAt - a.startedAt)
  }

  active(): Hackathon | undefined {
    return this.items.find((h) => h.active)
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.items, null, 1))
    this.emit(this.list())
  }

  private get(id: string): Hackathon {
    const h = this.items.find((x) => x.id === id)
    if (!h) throw new Error('Unknown hackathon')
    return h
  }

  /** Turn a finished relay into an active hackathon: deadline, milestones and judging criteria pulled from the plan and page. */
  async fromRelay(relay: RelayRun): Promise<Hackathon> {
    const plan = relay.stages.at(-1)?.text ?? ''
    const page = relay.stages[0]?.text ?? ''
    if (!plan.trim()) throw new Error('This relay has no final plan yet.')
    mkdirSync(this.workspace, { recursive: true })
    const extracted = parseExtract(await ask(extractPrompt(plan, page), this.workspace))
    const now = Date.now()
    const deadline = extracted?.deadline ? Date.parse(extracted.deadline) : NaN
    const h: Hackathon = {
      id: randomUUID(),
      title: relay.title,
      url: relay.url,
      relayId: relay.id,
      plan,
      hook: extracted?.hook ?? '',
      startedAt: now,
      // Without a stated deadline, assume a 36 hour event; the dashboard lets Anuj correct it.
      deadline: Number.isFinite(deadline) && deadline > now ? deadline : now + 36 * 3600_000,
      milestones: (extracted?.milestones ?? []).map((m) => ({ id: randomUUID(), title: m.title, hour: m.hour, done: false })),
      criteria: (extracted?.criteria ?? []).map((c) => ({ id: randomUUID(), name: c.name, detail: c.detail, coveredBy: '' })),
      active: true
    }
    for (const x of this.items) x.active = false
    this.items.push(h)
    this.save()
    return structuredClone(h)
  }

  update(id: string, patch: Partial<Pick<Hackathon, 'deadline' | 'milestones' | 'criteria' | 'active' | 'kit' | 'title'>>): Hackathon {
    const h = this.get(id)
    if (patch.active) for (const x of this.items) x.active = false
    Object.assign(h, patch)
    this.save()
    return structuredClone(h)
  }

  /** Create (or adopt) the project folder: git repo with the plan and an agent brief. Never overwrites existing files. */
  async scaffold(id: string): Promise<Hackathon> {
    const h = this.get(id)
    const path = h.projectPath ?? join(hackRoot(), slug(h.title))
    mkdirSync(path, { recursive: true })
    if (!existsSync(join(path, '.git'))) await run('git', ['init', '-b', 'main'], { cwd: path })
    if (!existsSync(join(path, 'PLAN.md'))) writeFileSync(join(path, 'PLAN.md'), `# ${h.title}\n\n${h.url}\n\n${h.plan}\n`)
    if (!existsSync(join(path, 'AGENTS.md')))
      writeFileSync(
        join(path, 'AGENTS.md'),
        `# ${h.title}\n\nHackathon build. Read PLAN.md first: it holds the chosen project, the demo moment, and the build plan.\n\n- Ship the minimum demo path first; polish later.\n- Keep the app runnable after every change.\n- Commit small, working steps.\n`
      )
    const log = await run('git', ['log', '-1'], { cwd: path })
    if (log.code !== 0) {
      await run('git', ['add', '-A'], { cwd: path })
      await run('git', ['commit', '-m', 'Plan and agent brief'], { cwd: path })
    }
    h.projectPath = path
    this.save()
    return structuredClone(h)
  }

  /** Start one agent per milestone, each on its own branch in its own git worktree so they never edit the same files. */
  async agents(id: string, milestoneIds: string[], agent: 'codex' | 'claude'): Promise<AgentTask[]> {
    const h = await this.scaffold(id).then(() => this.get(id))
    const root = h.projectPath!
    const s = getSettings()
    const choice: ModelChoice =
      agent === 'claude' ? { provider: 'claude', model: 'opus' } : { provider: 'codex', model: s.worker.provider === 'codex' ? s.worker.model : 'gpt-6-sol', effort: s.worker.effort ?? 'medium' }
    const started: AgentTask[] = []
    for (const m of h.milestones.filter((x) => milestoneIds.includes(x.id))) {
      const branch = `hack/${slug(m.title)}`
      const wt = join(`${root}-worktrees`, slug(m.title))
      if (!existsSync(wt)) {
        mkdirSync(`${root}-worktrees`, { recursive: true })
        const r = await run('git', ['worktree', 'add', '-b', branch, wt], { cwd: root })
        if (r.code !== 0) throw new Error(`Could not create a worktree for "${m.title}": ${r.stderr.trim()}`)
      }
      const prompt = `You are one of several agents building "${h.title}" for a hackathon, each on its own branch. Read PLAN.md and AGENTS.md first.

Your milestone: ${m.title} (should work by hour ${m.hour} of the build).

Build only this milestone, as the smallest version that demos well. Run whatever check the project has (build, typecheck, tests) before you finish, and commit your work on this branch (${branch}). Summarize what works, how to run it, and anything the other branches need to know to merge it.`
      const task = this.tasks.start({ title: `${h.title}: ${m.title}`, prompt, choice, cwd: wt, project: h.title })
      m.taskId = task.id
      started.push(task)
    }
    this.save()
    return started
  }

  /** Devpost write-up, a 90 second demo script, and a submission checklist, from the plan, criteria and what was actually built. */
  async kit(id: string): Promise<Hackathon> {
    const h = this.get(id)
    const cwd = h.projectPath ?? this.workspace
    const commits = h.projectPath ? (await run('git', ['log', '--all', '--oneline', '-60'], { cwd })).stdout.trim() : ''
    const readme = h.projectPath && existsSync(join(cwd, 'README.md')) ? readFileSync(join(cwd, 'README.md'), 'utf8').slice(0, 6000) : ''
    const reply = await ask(
      `Write the submission kit for Anuj's hackathon project. No em dashes. Only claim features that the commits or README show exist; where unsure, write [confirm].

Return only JSON: {"writeup": markdown string, "script": markdown string, "checklist": [string]}
- writeup: a Devpost write-up with these sections: Inspiration, What it does, How we built it, Challenges, Accomplishments, What we learned, What's next.
- script: a 90 second demo script with timestamps, built around the hook, hitting each judging criterion.
- checklist: 8 to 14 concrete submission steps for this event (repo public, video length, tracks and prizes to tag, required fields), taken from the event page where stated.

<hook>${h.hook}</hook>
<judging>
${h.criteria.map((c) => `- ${c.name}: ${c.detail}${c.coveredBy ? ` | covered by: ${c.coveredBy}` : ''}`).join('\n')}
</judging>
<plan>
${h.plan.slice(0, 12000)}
</plan>
<commits>
${commits || '(no repository yet)'}
</commits>
<readme>
${readme || '(none)'}
</readme>`,
      cwd
    )
    const m = reply.match(/```(?:json)?\s*([\s\S]*?)```/) ?? reply.match(/(\{[\s\S]*\})/)
    const d = m ? JSON.parse(m[1]) : null
    if (!d?.writeup) throw new Error('The kit came back malformed. Try again.')
    h.kit = { writeup: d.writeup, script: d.script ?? '', checklist: (d.checklist ?? []).map((text: string) => ({ text, done: false })), generatedAt: Date.now() }
    await this.vault.writeOutput(`Hackathons/${h.title} submission kit`, `## Write-up\n\n${h.kit.writeup}\n\n## Demo script\n\n${h.kit.script}\n\n## Checklist\n\n${h.kit.checklist.map((c) => `- [ ] ${c.text}`).join('\n')}\n`, {
      tags: ['hackathon', 'submission'],
      source: h.url
    })
    this.save()
    return structuredClone(h)
  }
}
