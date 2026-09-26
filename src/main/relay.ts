import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { challengePrompt, consolidatePrompt, devpostRoot, htmlToText, ideatePrompt, relayTitle, type RelayRun, type StageRun } from '../core/relay'
import type { AgentEvent, ModelChoice } from '../core/types'
import { runProvider, type RunHandle } from './providers'
import type { Vault } from './vault'

const OPUS: ModelChoice = { provider: 'claude', model: 'opus', effort: 'high' }
const ASTRA: ModelChoice = { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }

/** Runs hackathon relays: fetch the page, Opus ideates, Astra challenges, Opus consolidates. */
export class RelayManager {
  private runs = new Map<string, RelayRun>()
  private handles = new Map<string, RunHandle>()
  private stopped = new Set<string>()
  private timers = new Map<string, NodeJS.Timeout>()

  private file = join(app.getPath('userData'), 'relays.json')

  constructor(
    private vault: Vault,
    private onUpdate: (r: RelayRun) => void,
    private onDone: (r: RelayRun) => void
  ) {
    // Finished relays survive restarts; one that was mid-flight when the app quit is marked stopped.
    try {
      for (const r of JSON.parse(readFileSync(this.file, 'utf8')) as RelayRun[]) {
        if (r.status === 'running') {
          r.status = 'stopped'
          for (const st of r.stages) if (st.status === 'running' || st.status === 'waiting') st.status = 'stopped'
        }
        this.runs.set(r.id, r)
      }
    } catch {
      // No saved relays yet.
    }
  }

  get(id: string): RelayRun | undefined {
    return this.runs.get(id)
  }

  list(): RelayRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  private emit(run: RelayRun, now = false) {
    if (now) {
      writeFileSync(this.file, JSON.stringify(this.list()))
      clearTimeout(this.timers.get(run.id))
      this.timers.delete(run.id)
      return this.onUpdate(structuredClone(run))
    }
    if (this.timers.has(run.id)) return
    this.timers.set(
      run.id,
      setTimeout(() => {
        this.timers.delete(run.id)
        this.onUpdate(structuredClone(run))
      }, 90)
    )
  }

  start(url: string, note?: string): RelayRun {
    const stage = (label: string, actor: string, choice?: ModelChoice): StageRun => ({ id: randomUUID(), label, actor, choice, status: 'waiting', text: '', events: [] })
    const run: RelayRun = {
      id: randomUUID(),
      kind: 'hackathon',
      title: 'Hackathon relay',
      url,
      note,
      status: 'running',
      startedAt: Date.now(),
      stages: [
        stage('Read the page', 'Vesper'),
        stage('Ideate', 'Claude Opus · high', OPUS),
        stage('Challenge', 'GPT-6-Astra · high', ASTRA),
        stage('Consolidate', 'Claude Opus · high', OPUS)
      ]
    }
    this.runs.set(run.id, run)
    this.emit(run, true)
    void this.execute(run)
    return run
  }

  stop(id: string) {
    const run = this.runs.get(id)
    if (!run || run.status !== 'running') return
    this.stopped.add(id)
    this.handles.get(id)?.stop()
  }

  private async execute(run: RelayRun) {
    const [read, ideate, challenge, consolidate] = run.stages
    try {
      const page = await this.fetchPage(run, read)
      const about = (
        await this.vault.context('hackathon strategy awards competition style projects strengths', { allowPrivate: false, limit: 5, maxChars: 5000 })
      ).text
      const ideation = await this.model(run, ideate, ideatePrompt(page, about, run.note), `The page (${page.length.toLocaleString()} chars) and your background from the vault (${about.length.toLocaleString()} chars: Core, hackathon history, strengths).`)
      const critique = await this.model(run, challenge, challengePrompt(page, ideation, run.note), `Opus's ideation (${ideation.length.toLocaleString()} chars) and the page. Asked to find what is wrong or generic and push further.`)
      await this.model(run, consolidate, consolidatePrompt(page, ideation, critique, run.note), `Its own ideation plus Astra's challenge (${critique.length.toLocaleString()} chars). Asked to concede where Astra is right and write the final plan.`)
      run.status = 'done'
      run.outputPath = await this.save(run)
    } catch (e) {
      const stopped = this.stopped.has(run.id)
      run.status = stopped ? 'stopped' : 'failed'
      for (const s of run.stages) {
        if (s.status === 'running') {
          s.status = stopped ? 'stopped' : 'failed'
          s.error = stopped ? undefined : (e as Error).message
          s.endedAt = Date.now()
        }
      }
    }
    run.endedAt = Date.now()
    this.handles.delete(run.id)
    this.emit(run, true)
    this.onDone(structuredClone(run))
  }

  private async fetchPage(run: RelayRun, s: StageRun): Promise<string> {
    s.status = 'running'
    s.startedAt = Date.now()
    this.emit(run, true)
    const root = devpostRoot(run.url)
    const urls = root ? [root, `${root}/rules`] : [run.url]
    const parts: string[] = []
    for (const u of urls) {
      try {
        const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Vesper' }, signal: AbortSignal.timeout(20000) })
        const text = r.ok ? htmlToText(await r.text(), 16000) : ''
        s.events.push({ at: Date.now(), label: `GET ${u.replace('https://', '')} · ${r.status}${text ? ` · ${text.length.toLocaleString()} chars` : ''}` })
        if (text) parts.push(`# Source: ${u}\n\n${text}`)
      } catch (e) {
        s.events.push({ at: Date.now(), label: `GET ${u.replace('https://', '')} · failed (${(e as Error).message})` })
      }
      this.emit(run)
    }
    if (!parts.length) throw new Error('Could not read the page. Check the link, or paste the details as a note.')
    const page = parts.join('\n\n')
    run.title = relayTitle(parts[0].split('\n\n').slice(1).join('\n\n'), run.url)
    s.text = page
    s.status = 'done'
    s.endedAt = Date.now()
    this.emit(run, true)
    return page
  }

  private model(run: RelayRun, s: StageRun, prompt: string, handoff: string): Promise<string> {
    if (this.stopped.has(run.id)) return Promise.reject(new Error('Stopped'))
    s.status = 'running'
    s.startedAt = Date.now()
    s.handoff = handoff
    this.emit(run, true)
    return new Promise((resolve, reject) => {
      let final = ''
      let failed: string | null = null
      const h = runProvider({
        choice: s.choice!,
        prompt,
        cwd: join(app.getPath('userData'), 'workspace'),
        role: 'brain',
        onEvent: (e: AgentEvent) => {
          if (e.kind === 'text-delta') s.text += e.text
          else if (e.kind === 'message') final = final ? `${final}\n\n${e.text}` : e.text
          else if (e.kind === 'reasoning') s.events.push({ at: Date.now(), label: `thinking: ${e.text.replace(/\*\*/g, '').split('\n')[0].slice(0, 140)}` })
          else if (e.kind === 'tool' && e.name) s.events.push({ at: Date.now(), label: `${e.name}${e.detail ? ` · ${String(e.detail).slice(0, 100)}` : ''}` })
          else if (e.kind === 'command' && e.status === 'running') s.events.push({ at: Date.now(), label: `$ ${e.command.slice(0, 120)}` })
          else if (e.kind === 'progress') {
            const last = s.events.at(-1)
            if (last?.progress) last.label = e.label
            else s.events.push({ at: Date.now(), label: e.label, progress: true })
          } else if (e.kind === 'error') failed = e.message
          this.emit(run)
        }
      })
      this.handles.set(run.id, h)
      void h.done.then(() => {
        if (final) s.text = final
        s.endedAt = Date.now()
        if (failed || this.stopped.has(run.id)) {
          s.status = this.stopped.has(run.id) ? 'stopped' : 'failed'
          s.error = failed ?? undefined
          this.emit(run, true)
          return reject(new Error(failed ?? 'Stopped'))
        }
        s.status = 'done'
        this.emit(run, true)
        resolve(s.text)
      })
    })
  }

  /** The consolidated plan becomes a vault output, with the full relay kept as an appendix. */
  private async save(run: RelayRun): Promise<string> {
    const [read, ideate, challenge, consolidate] = run.stages
    const mins = (s: StageRun) => (s.startedAt && s.endedAt ? `${Math.max(1, Math.round((s.endedAt - s.startedAt) / 60000))} min` : '')
    const body = `# ${run.title}: relay plan

> Relay output, ${new Date(run.startedAt).toLocaleDateString('en-CA')}. Source: ${run.url}. Ideas and judgments below are model-generated and unverified; prizes and rules come from the page as fetched.${run.note ? `\n> Anuj's note: ${run.note}` : ''}

${consolidate.text}

## Relay record

| Stage | Who | Time |
| --- | --- | --- |
${run.stages.map((s) => `| ${s.label} | ${s.actor} | ${mins(s)} |`).join('\n')}

### Ideation (${ideate.actor})

${ideate.text}

### Challenge (${challenge.actor})

${challenge.text}

### Page as fetched

${read.events.map((e) => `- ${e.label}`).join('\n')}
`
    return this.vault.writeOutput(`Hackathons/${new Date(run.startedAt).toLocaleDateString('en-CA')} ${run.title}`, body, {
      type: 'relay',
      status: 'exploratory',
      source: run.url
    })
  }
}
