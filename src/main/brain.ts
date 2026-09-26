import { app, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseReply, speakable, SpeechStream, type MemoryWrite } from '../core/reply'
import { matchProject, needsMemory, route, type Intent } from '../core/router'
import type { RelayRun } from '../core/relay'
import type { AgentTask, ModelChoice, Project, Settings, Turn, TurnAction } from '../core/types'
import { PERSONA, RESUME_PROMPT, SESSION_PROMPT, ULTRA } from './persona'
import { agendaText } from './calendar'
import { canvasBrief } from './canvas'
import type { TerminalManager } from './terminals'
import type { HackathonManager } from './hackathon'
import { hackLine } from '../core/hackathon'
import { asksAboutTerminal } from '../core/terminal'
import { discoverProjects } from './projects'
import { runProvider, localModels, type RunHandle } from './providers'
import { getSettings, updateSettings } from './settings'
import { run } from './shell'
import type { RelayManager } from './relay'
import type { TaskManager } from './tasks'
import { ChatStore } from './chats'
import { SwarmManager } from './swarm'
import type { Swarm } from '../core/swarm'
import { webFetch, webSearch } from './search'
import { findApp, installedApps, openApp, placeApp, quitApp, typeText, type Region } from './mac'
import type { Vault } from './vault'

export interface BrainEvents {
  turn: (t: Turn) => void
  reset: () => void
  busy: (busy: boolean) => void
  speak: (turnId: string, text: string) => void
  /** One more sentence for the reply currently being spoken (streaming speech). */
  speakChunk: (turnId: string, sentence: string) => void
  stopSpeech: () => void
  context: (c: { activeProject?: string; brain: ModelChoice }) => void
  swarm: (s: Swarm) => void
  /** Bring the window forward (research started by voice while it was hidden). */
  show?: () => void
  settings: (s: Settings) => void
}

const GMAIL = (t: string[]) => t.map((x) => `mcp__claude_ai_Gmail__${x}`)
const GMAIL_READ = GMAIL(['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft'])
// Everything that changes the mailbox is refused outright, even if a prompt asks for it.
const GMAIL_WRITE = GMAIL([
  'send_message', 'reply', 'forward', 'create_draft', 'update_draft', 'delete_draft', 'trash_message', 'trash_thread', 'untrash_message', 'untrash_thread',
  'label_message', 'label_thread', 'unlabel_message', 'unlabel_thread', 'update_message_labels', 'create_label', 'update_label', 'delete_label',
  'mark_message_spam', 'mark_thread_spam', 'unmark_message_spam', 'unmark_thread_spam', 'apply_sensitive_message_label', 'apply_sensitive_thread_label'
])

const IDENTITY = "You're talking with Anuj Kakumanu, a Rutgers CS sophomore and product-minded builder. Be direct and concise, no em dashes. (No personal notes were loaded for this question.)"

const BRAIN_DEFAULTS: Record<ModelChoice['provider'], ModelChoice> = {
  codex: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' },
  claude: { provider: 'claude', model: 'haiku' },
  local: { provider: 'local', model: '', effort: 'low' }
}

/** Tokens per second for a streaming reply: estimated per delta while it streams, exact from the final usage report. */
function meter(turn: Turn) {
  let first = 0
  let n = 0
  return {
    tick() {
      const now = Date.now()
      if (!first) first = now
      n++
      const secs = (now - first) / 1000
      if (secs > 0.5 && n % 6 === 0) turn.tps = Math.round(n / secs)
    },
    done(output?: number) {
      const secs = (Date.now() - first) / 1000
      if (first && secs > 0.2) turn.tps = Math.round((output ?? n) / secs)
    }
  }
}

/** Owns the conversation: routes intents, builds scoped context, runs the brain, and applies its directives. */
export class Brain {
  turns: Turn[] = []
  chats = new ChatStore()
  swarms: SwarmManager
  private chatId: string = randomUUID()
  private saveTimer: NodeJS.Timeout | null = null
  private sessions: Partial<Record<ModelChoice['provider'], string>> = {}
  private current: RunHandle | null = null
  private activeProject?: Project
  private workspace = join(app.getPath('userData'), 'workspace')
  relays!: RelayManager
  terminals?: TerminalManager
  hackathons?: HackathonManager

  constructor(
    private vault: Vault,
    private tasks: TaskManager,
    private ev: BrainEvents
  ) {
    mkdirSync(this.workspace, { recursive: true })
    this.swarms = new SwarmManager(
      this.workspace,
      (s) => {
        this.ev.swarm(s)
        if (s.chatId === this.chatId) this.persist()
      },
      (s) => void this.moderate(s)
    )
  }

  private push(t: Omit<Turn, 'id' | 'at'> & Partial<Pick<Turn, 'id' | 'at'>>): Turn {
    const turn: Turn = { id: randomUUID(), at: Date.now(), ...t }
    this.turns.push(turn)
    this.ev.turn(turn)
    this.persist()
    return turn
  }

  private update(turn: Turn) {
    // A reply stopped by switching chats must not land in the next one.
    if (!this.turns.includes(turn)) return
    this.ev.turn({ ...turn })
    this.persist()
  }

  /** Write any pending save now, before the conversation changes. */
  private flush() {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.chats.save(this.chatId, this.turns, this.sessions, this.swarms.forChat(this.chatId))
  }

  /** Save the chat shortly after it changes; streaming updates coalesce into one write. */
  private persist() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.chats.save(this.chatId, this.turns, this.sessions, this.swarms.forChat(this.chatId))
    }, 800)
  }

  /** A reply or a team is in progress. */
  get busy() {
    return !!this.current || this.swarms.running()
  }

  get currentChat() {
    return this.chatId
  }

  /** Reopen a saved chat; continuing it resumes the same Codex/Claude sessions. */
  openChat(id: string): Turn[] {
    const c = this.chats.load(id)
    this.stop()
    this.flush()
    this.ev.stopSpeech()
    this.chatId = c.id
    this.turns = c.turns
    this.sessions = c.sessions ?? {}
    this.swarms.load(c.swarms ?? [])
    for (const sw of c.swarms ?? []) this.ev.swarm(structuredClone(sw))
    return this.turns
  }

  private say(text: string, extra: Partial<Turn> = {}, speak = true): Turn {
    const turn = this.push({ speaker: 'bluevis', text, ...extra })
    if (speak) this.ev.speak(turn.id, extra.spoken ?? text)
    return turn
  }

  private async projects(): Promise<Project[]> {
    return discoverProjects(getSettings().projectRoots, false, this.vault.projectLinks())
  }

  context() {
    return { activeProject: this.activeProject?.name, brain: getSettings().brain }
  }

  private setProject(p?: Project) {
    this.activeProject = p
    this.ev.context(this.context())
  }

  async setActiveProject(name?: string) {
    const p = name ? (await this.projects()).find((x) => x.name === name) : undefined
    this.setProject(p)
  }

  async handle(text: string, opts: { via: 'voice' | 'text'; screenshot?: string }): Promise<void> {
    const projects = await this.projects()
    const names = projects.map((p) => p.name)
    const intent = route(text, names)
    if (intent.type === 'stop-speech') {
      this.ev.stopSpeech()
      return
    }
    // A spoken question opens Vesper so the answer is on screen; quick actions stay out of the way.
    if (opts.via === 'voice' && !['mac', 'web-search', 'open', 'stop-task', 'switch-brain', 'new-conversation'].includes(intent.type)) this.ev.show?.()
    this.push({ speaker: 'user', text, via: opts.via, attachments: opts.screenshot ? [opts.screenshot] : undefined })
    // A message that names a project makes it the active context.
    const mentioned = projects.find((p) => new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
    if (mentioned && mentioned.name !== this.activeProject?.name) this.setProject(mentioned)
    try {
      await this.dispatch(intent, projects, opts)
    } catch (e) {
      this.say(`That failed: ${(e as Error).message}`, { error: true }, false)
    }
  }

  private async dispatch(intent: Intent, projects: Project[], opts: { via: 'voice' | 'text'; screenshot?: string }) {
    switch (intent.type) {
      case 'chat':
        return this.chat(intent.text, opts.screenshot, this.terminalBlock(intent.text))
      case 'delegate':
        return this.delegate({ kind: 'delegate', agent: intent.agent, model: intent.model, project: intent.project, prompt: intent.prompt, state: 'proposed' }, projects, true)
      case 'swarm':
        return this.launchSwarm(intent.goal, intent.count)
      case 'research':
        this.ev.show?.()
        return this.research(intent.query)
      case 'mac':
        return this.macCommand(intent.text)
      case 'web-search':
        void shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(intent.query)}`)
        return this.say(`Searching Google for ${intent.query}.`)
      case 'open':
        return this.open(projects.find((p) => p.name === intent.target)!)
      case 'resume':
        return this.resume(intent.project ? projects.find((p) => p.name === matchProject(intent.project!, projects.map((x) => x.name))) : this.activeProject)
      case 'end-session':
        return this.endSession(intent.project)
      case 'remember': {
        const pref = /^(i (prefer|like|love|hate|don'?t like|want|always|never|use))\b|^(always|never)\b/i.test(intent.text)
        const kind: MemoryWrite['kind'] = intent.kind === 'idea' ? 'idea' : pref ? 'preference' : 'fact'
        const title = intent.text.split(/[.,;:]/)[0].slice(0, 60)
        return this.remember({ kind, title, text: intent.text, project: this.activeProject?.name }, 'Anuj, explicitly', intent.private)
      }
      case 'status':
        return this.status()
      case 'brief':
        return this.brief()
      case 'stop-task': {
        const running = this.tasks.active().filter((t) => !intent.agent || t.choice.provider === intent.agent)
        if (!running.length) return this.say('Nothing is running.')
        running.forEach((t) => this.tasks.stop(t.id))
        return this.say(
          `Stopped ${running.map((t) => `${label(t.choice)}${t.project ? ` on ${t.project}` : ''}`).join(' and ')}. Any edits already made are still in the working tree.`
        )
      }
      case 'switch-brain': {
        let choice = BRAIN_DEFAULTS[intent.provider]
        if (intent.provider === 'local') {
          const models = await localModels(getSettings().localBaseUrl)
          if (!models.length) return this.say(`The local model server isn't answering at ${getSettings().localBaseUrl}. Staying on ${label(getSettings().brain)}.`)
          choice = { provider: 'local', model: models[0], effort: 'low' }
        }
        this.ev.settings(updateSettings({ brain: choice }))
        this.ev.context(this.context())
        return this.say(`Switched to ${label(choice)} for conversation.`)
      }
      case 'new-conversation':
        this.reset()
        return
      case 'mail':
        return this.mail(intent.text)
      case 'agenda': {
        const [cal, canvas] = await Promise.all([agendaText(), canvasBrief()])
        const ctx = `<calendar source="your ICS feeds, fetched just now">\n${cal}\n</calendar>${canvas ? `\n\n<canvas source="Canvas API, fetched just now">\n${canvas}\n</canvas>` : ''}`
        return this.chat(intent.text, undefined, ctx)
      }
      case 'relay': {
        const run = this.relays.start(intent.url, intent.note)
        return this.say('Relay started. Opus ideates, Astra challenges, then Opus consolidates. You can watch every step.', { relayId: run.id })
      }
    }
  }

  reset() {
    this.stop()
    this.flush()
    this.turns = []
    this.sessions = {}
    this.chatId = randomUUID()
    this.ev.reset()
  }

  stop() {
    this.current?.stop()
    this.current = null
  }

  /** Run one brain turn and resolve with the final text (or throw). */
  private runBrain(prompt: string, o: { images?: string[]; fresh?: boolean; onDelta?: (text: string) => void; onThinking?: (text: string) => void; onProgress?: (label: string) => void; onUsage?: (output: number) => void } = {}): Promise<string> {
    const s = getSettings()
    const choice = s.brain
    const cwd = this.activeProject?.path ?? this.workspace
    const history = this.turns
      .filter((t) => (t.speaker === 'user' || t.speaker === 'bluevis') && !t.pending && !t.error)
      .slice(-12, -1)
      .map((t) => ({ role: t.speaker === 'user' ? ('user' as const) : ('assistant' as const), content: t.text }))
    return new Promise((resolve, reject) => {
      let text = ''
      let streamed = ''
      let failed: string | null = null
      const handle = runProvider({
        choice,
        prompt,
        cwd,
        role: 'brain',
        system: s.ultra ? PERSONA + ULTRA : PERSONA,
        images: o.images,
        sessionId: o.fresh ? undefined : this.sessions[choice.provider],
        history: choice.provider === 'local' && !o.fresh ? history : undefined,
        localBaseUrl: s.localBaseUrl,
        onEvent: (e) => {
          if (e.kind === 'session' && !o.fresh) this.sessions[choice.provider] = e.id
          if (e.kind === 'text-delta') {
            streamed += e.text
            o.onDelta?.(streamed)
          }
          if (e.kind === 'thinking-delta') o.onThinking?.(e.text)
          if (e.kind === 'progress') o.onProgress?.(e.label)
          if (e.kind === 'usage') o.onUsage?.(e.output)
          if (e.kind === 'reasoning') o.onThinking?.(`${e.text}\n\n`)
          if (e.kind === 'message') text = text ? `${text}\n\n${e.text}` : e.text
          if (e.kind === 'error') failed = e.message
        }
      })
      this.current = handle
      void handle.done.then(() => {
        if (this.current === handle) this.current = null
        if (failed) reject(new Error(failed))
        else resolve(text || streamed)
      })
    })
  }

  private async chat(text: string, screenshot?: string, extra = '') {
    const s = getSettings()
    const choice = s.brain
    const allowPrivate = choice.provider === 'local'
    // General questions get a one-line identity; the vault is only consulted when the question is about Anuj's life or work.
    const projects = await this.projects()
    // A local model always gets its memory: nothing leaves the Mac, and it lets it connect things Anuj did not flag as personal.
    const personal = allowPrivate || needsMemory(text, projects.map((p) => p.name)) || !!screenshot
    const { text: knowledge, used } = personal
      ? await this.vault.context(text, { allowPrivate, project: this.activeProject?.name })
      : { text: IDENTITY, used: [] }
    const running = this.tasks.active()
    const env = [
      `Now: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })} (America/New_York)`,
      this.activeProject
        ? `Active project: ${this.activeProject.name} at ${this.activeProject.path} (branch ${this.activeProject.branch ?? '?'}, ${this.activeProject.dirty ?? 0} uncommitted files). You may read its files.`
        : 'No active project.',
      `Known projects: ${projects.map((p) => p.name).join(', ') || 'none found'}`,
      this.hackathons?.active() ? hackLine(this.hackathons.active()!, Date.now()) : '',
      running.length ? `Running agents: ${running.map((t) => `${label(t.choice)} on ${t.project ?? t.cwd}: ${t.status}`).join('; ')}` : 'No agents running.',
      screenshot ? 'A screenshot of Anuj’s screen, captured just now at Anuj’s request, is attached.' : ''
    ]
      .filter(Boolean)
      .join('\n')
    // Earlier chats stay on the Mac, so only a local model sees them.
    const recalled = allowPrivate ? await this.chats.recall(text, this.chatId).catch(() => '') : ''
    const earlier = recalled ? `\n<earlier_chats note="From Anuj's other recent chats with you. Use only if relevant; do not bring up otherwise.">\n${recalled}\n</earlier_chats>\n` : ''
    const prompt = `<situation>\n${env}\n</situation>\n${extra ? `\n${extra}\n` : ''}${earlier}\n<knowledge>\n${knowledge || '(nothing relevant in the vault)'}\n</knowledge>\n\nAnuj${screenshot ? ' (looking at the screen)' : ''}: ${text}`

    const turn = this.push({ speaker: 'bluevis', text: '', pending: true, model: label(choice), sources: used })
    this.ev.busy(true)
    const full = s.voice.narrate === 'full'
    const speech = new SpeechStream((sentence) => this.ev.speakChunk(turn.id, sentence), 3, full)
    const speed = meter(turn)
    let output: number | undefined
    try {
      const raw = await this.runBrain(prompt, {
        images: screenshot ? [screenshot] : undefined,
        onUsage: (n) => (output = n),
        onThinking: (t) => {
          speed.tick()
          turn.thinking = (turn.thinking ?? '') + t
          this.update(turn)
        },
        onProgress: (label) => {
          turn.status = label
          this.update(turn)
        },
        onDelta: (partial) => {
          speed.tick()
          if (turn.thinking && turn.thoughtMs === undefined) turn.thoughtMs = Date.now() - turn.at
          turn.text = parseReply(partial).shown
          this.update(turn)
          speech.feed(partial)
        }
      })
      const reply = parseReply(raw)
      speed.done(output)
      turn.text = reply.shown || '(no reply)'
      turn.spoken = reply.spoken
      turn.pending = false
      this.update(turn)
      speech.finish(full ? speakable(reply.shown) : reply.spoken)
      for (const sw of s.ultra ? reply.swarms.slice(0, 1) : []) void this.launchSwarm(sw.goal, sw.count)
      for (const a of reply.actions) this.push({ speaker: 'system', text: '', action: { kind: 'delegate', agent: a.agent, project: a.project, prompt: a.prompt, state: 'proposed' } })
      for (const m of reply.memories) await this.remember(m, 'inferred from conversation', false, true)
    } catch (e) {
      turn.pending = false
      turn.error = true
      turn.text = friendlyError((e as Error).message, choice)
      this.update(turn)
    } finally {
      this.ev.busy(false)
    }
  }

  /** Email questions run through Claude with Anuj's Gmail connector, read-only, with every search shown. */
  private async mail(text: string) {
    const { text: knowledge, used } = await this.vault.context(`${text} applications assessments recruiting`, { allowPrivate: false, limit: 4, maxChars: 4000 })
    const turn = this.push({ speaker: 'bluevis', text: '', pending: true, model: 'Claude Sonnet · Gmail (read-only)', sources: used, activity: [] })
    this.ev.busy(true)
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })
    const prompt = `Now: ${now} (America/New_York).

Answer Anuj's question using the Gmail tools (read-only). Search precisely with Gmail query syntax (from:, subject:, newer_than:, after:). Prefer a few targeted searches over many broad ones.

For every email you rely on, give sender, date and subject. Distinguish application acknowledgments, assessment invitations (with the real deadline, in America/New_York), interview requests, rejections and marketing. An invitation is not a completed assessment. If nothing matches, say exactly what you searched and that it found nothing; never imply you checked more than you did.

<vault_context>
${knowledge}
</vault_context>

Anuj: ${text}`
    let raw = ''
    let failed: string | null = null
    const handle = runProvider({
      choice: { provider: 'claude', model: 'sonnet', effort: 'low' },
      prompt,
      cwd: this.workspace,
      role: 'brain',
      system: PERSONA,
      tools: GMAIL_READ,
      denyTools: GMAIL_WRITE,
      onEvent: (e) => {
        if (e.kind === 'tool' && e.name.startsWith('mcp__claude_ai_Gmail__')) {
          turn.activity!.push(`Gmail ${e.name.replace('mcp__claude_ai_Gmail__', '').replace(/_/g, ' ')}${e.detail ? ` · ${e.detail}` : ''}`)
          this.update(turn)
        }
        if (e.kind === 'text-delta') {
          raw += e.text
          turn.text = parseReply(raw).shown
          this.update(turn)
        }
        if (e.kind === 'message') raw = e.text
        if (e.kind === 'error') failed = e.message
      }
    })
    this.current = handle
    await handle.done
    this.ev.busy(false)
    turn.pending = false
    if (failed) {
      turn.error = true
      turn.text = /Gmail|mcp/i.test(failed) ? `Gmail isn't reachable through Claude right now (${failed}). Check the Gmail connector at claude.ai.` : failed
      return this.update(turn)
    }
    const reply = parseReply(raw)
    turn.text = reply.shown || 'No answer came back.'
    turn.spoken = reply.spoken
    this.update(turn)
    if (reply.spoken) this.ev.speak(turn.id, reply.spoken)
  }

  async remember(m: MemoryWrite, origin: string, isPrivate: boolean, quiet = false) {
    const res = await this.vault.remember({ ...m, origin, private: isPrivate })
    this.push({
      speaker: 'system',
      text: '',
      memory: { path: res.path, title: m.title, hash: res.hash },
      evidence: origin.startsWith('inferred') ? 'inferred' : 'observed'
    })
    if (!quiet) this.say(m.kind === 'idea' ? 'Saved as an idea, not a commitment.' : isPrivate ? 'Noted, and kept out of cloud handoffs.' : 'Noted.')
  }

  async undoMemory(turnId: string) {
    const t = this.turns.find((x) => x.id === turnId)
    if (!t?.memory?.hash || t.memory.undone) return
    if (await this.vault.undo(t.memory.hash)) {
      t.memory.undone = true
      this.update(t)
    }
  }

  /** The focused Work terminal's recent output, when the request is about it (and, for agents, in the same project). */
  private terminalBlock(text: string, within?: string): string {
    const t = asksAboutTerminal(text) ? this.terminals?.focusedTail() : null
    if (!t || (within && !t.cwd.startsWith(within))) return ''
    return `\n\n<terminal title="${t.title}" cwd="${t.cwd}" note="recent output of the terminal Anuj is looking at in Vesper; credentials masked">\n${t.text}\n</terminal>`
  }

  /** Start (or ask about) a delegated agent task. */
  async delegate(action: TurnAction, projects?: Project[], explicit = false, turnId?: string) {
    projects ??= await this.projects()
    const project = action.project ? projects.find((p) => p.name === matchProject(action.project!, projects!.map((x) => x.name))) : this.activeProject
    if (!project) {
      this.push({ speaker: 'system', text: '', action: { ...action, state: 'proposed', choices: projects.slice(0, 6).map((p) => p.name) } })
      this.say('Which project should it work in?')
      return
    }
    const s = getSettings()
    const choice: ModelChoice =
      action.agent === 'claude'
        ? { provider: 'claude', model: action.model ?? 'opus' }
        : { provider: 'codex', model: action.model ?? (s.worker.provider === 'codex' ? s.worker.model : 'gpt-6-sol'), effort: s.worker.effort ?? 'medium' }
    const brief = (await this.handoffBrief(project, action.prompt, choice)) + this.terminalBlock(action.prompt, project.path)
    const title = action.prompt.charAt(0).toUpperCase() + action.prompt.slice(1, 90)
    const task = this.tasks.start({ title, prompt: brief, choice, cwd: project.path, project: project.name })
    if (turnId) {
      const t = this.turns.find((x) => x.id === turnId)
      if (t?.action) {
        t.action = { ...t.action, state: 'started', project: project.name }
        t.taskId = task.id
        this.update(t)
      }
    }
    this.setProject(project)
    const who = label(choice)
    this.say(explicit ? `${who} is on it in ${project.name}.` : `Started ${who} in ${project.name}.`, { taskId: task.id })
  }

  /** A scoped context brief for the agent: objective, project knowledge, constraints. Never local-only notes. */
  private async handoffBrief(project: Project, objective: string, choice: ModelChoice): Promise<string> {
    const { text: knowledge } = await this.vault.context(objective, { allowPrivate: choice.provider === 'local', project: project.name, maxChars: 5000 })
    return `${objective}

<handoff from="Vesper">
Project: ${project.name} (${project.path}, branch ${project.branch ?? 'unknown'})
Relevant knowledge (status "needs-review" means unconfirmed background):
${knowledge || '(none)'}

Constraints:
- Stay inside this repository. Do not push, publish, or change git history.
- Prefer small, verifiable changes. Run the relevant tests or build if they exist and report the actual result.
- End with a short summary: what you changed, what you verified (with the command and outcome), and what remains uncertain.
</handoff>`
  }

  onTaskFinished(t: AgentTask) {
    const outcome: Record<string, string> = {
      'completed-verified': 'finished, and a check passed after its last edit',
      'completed-unverified': 'finished, but I saw no passing check after its edits',
      failed: 'failed',
      stopped: 'was stopped'
    }
    const what = outcome[t.status] ?? t.status
    const files = t.filesChanged.length ? ` It changed ${t.filesChanged.length} file${t.filesChanged.length > 1 ? 's' : ''}.` : ''
    this.say(`${label(t.choice)} ${what}${t.project ? ` on ${t.project}` : ''}.${files}`, { taskId: t.id, evidence: t.status === 'completed-verified' ? 'observed' : 'reported' })
    void this.vault.writeAgentRun(t)
  }

  onRelayFinished(r: RelayRun) {
    if (r.status !== 'done') {
      this.say(`The ${r.title} relay ${r.status === 'stopped' ? 'was stopped' : 'failed'}. Completed stages are kept.`, { relayId: r.id, error: r.status === 'failed' })
      return
    }
    const plan = r.stages.at(-1)!.text
    const verdict = plan.split(/##\s*Verdict/i)[1]?.split(/\n##\s/)[0]?.trim()
    const spoken = verdict ? verdict.split(/(?<=[.!?])\s/).slice(0, 2).join(' ') : 'The plan is ready.'
    this.say(`The ${r.title} relay is done. ${spoken}\n\nSaved to \`${r.outputPath}\`.`, { relayId: r.id, spoken: `The ${r.title} relay is done. ${spoken}` })
  }

  private async open(p: Project) {
    const editor = getSettings().editor
    const r = await run('open', ['-a', editor, p.path])
    if (r.code !== 0) await run('open', [p.path])
    this.setProject(p)
    this.say(r.code === 0 ? `Opened ${p.name} in ${editor}.` : `Opened ${p.name} in Finder. ${editor} wasn't available.`)
  }

  /** One model call outside the conversation, streaming its thinking and text. */
  private think(prompt: string, o: { effort?: ModelChoice['effort'] | 'none'; onThinking?: (t: string) => void; onText?: (t: string) => void; onProgress?: (label: string) => void; onUsage?: (output: number) => void } = {}): Promise<string> {
    const s = getSettings()
    const { effort: _, ...base } = s.brain
    const effort = o.effort ?? s.brain.effort
    const choice: ModelChoice = s.brain.provider === 'local' ? (effort === 'none' || !effort ? base : { ...base, effort }) : s.brain
    return new Promise((resolve, reject) => {
      let text = ''
      let streamed = ''
      let failed: string | null = null
      const handle = runProvider({
        choice,
        prompt,
        cwd: this.workspace,
        role: 'brain',
        system: 'You are Vesper, Anuj\'s research assistant. Be accurate, specific and concise. No em dashes.',
        localBaseUrl: s.localBaseUrl,
        onEvent: (e) => {
          if (e.kind === 'thinking-delta') o.onThinking?.(e.text)
          if (e.kind === 'progress') o.onProgress?.(e.label)
          if (e.kind === 'usage') o.onUsage?.(e.output)
          if (e.kind === 'text-delta') o.onText?.((streamed += e.text))
          if (e.kind === 'message') text = e.text
          if (e.kind === 'error') failed = e.message
        }
      })
      this.current = handle
      void handle.done.then(() => {
        if (this.current === handle) this.current = null
        if (failed && !text && !streamed) reject(new Error(failed))
        else resolve(text || streamed)
      })
    })
  }

  /**
   * Research on the open web: plan searches, run them on free engines in parallel, read the best pages,
   * then write a sourced answer. Every search and page read is shown as it happens.
   */
  private async research(question: string) {
    const turn = this.push({ speaker: 'bluevis', text: '', pending: true, model: `${label(getSettings().brain)} · research`, activity: [], web: [] })
    this.ev.busy(true)
    const log = (line: string) => {
      turn.activity = [...(turn.activity ?? []), line]
      this.update(turn)
    }
    const onThinking = (t: string) => {
      turn.thinking = (turn.thinking ?? '') + t
      this.update(turn)
    }
    try {
      const now = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', dateStyle: 'long' })
      const plan = await this.think(
        `Today is ${now}. Plan web searches to answer this well:\n\n${question}\n\nReply with only JSON: {"queries": [2 to 4 short, distinct search queries]}`,
        { effort: 'low', onThinking, onProgress: (label) => ((turn.status = label), this.update(turn)) }
      )
      const queries = ((): string[] => {
        try {
          const q = JSON.parse(plan.match(/\{[\s\S]*\}/)?.[0] ?? '{}').queries
          return Array.isArray(q) && q.length ? q.slice(0, 4).map(String) : [question]
        } catch {
          return [question]
        }
      })()
      const found = await Promise.all(
        queries.map((q) =>
          webSearch(q, 6).then(
            (r) => (log(`Searched "${q}" · ${r.length} results`), r),
            (e: Error) => (log(`Search "${q}" failed: ${e.message}`), [])
          )
        )
      )
      const seen = new Set<string>()
      const results = found.flat().filter((r) => !seen.has(r.url) && seen.add(r.url)).slice(0, 12)
      if (!results.length) throw new Error('No search engine answered. Check the connection and try again.')
      // Read the top pages in full; the rest contribute their excerpts.
      const top = results.slice(0, 4)
      const pages = await webFetch(
        top.map((r) => r.url),
        question
      ).catch(() => [])
      for (const r of top) log(`Read ${new URL(r.url).hostname.replace(/^www\./, '')}`)
      log(`Found in ${Math.round((Date.now() - turn.at) / 1000)}s · writing the answer`)
      turn.web = results.map((r) => ({ title: r.title || new URL(r.url).hostname, url: r.url }))
      this.update(turn)
      const sources = results
        .map((r, i) => {
          const full = pages.find((p) => p.url === r.url)?.text
          return `[${i + 1}] ${r.title}\n${r.url}\n${(full || r.text).slice(0, full ? 6000 : 1500)}`
        })
        .join('\n\n---\n\n')
      const narrate = getSettings().voice.narrate
      const speech = new SpeechStream((sentence) => this.ev.speakChunk(turn.id, sentence), 3, narrate === 'full')
      turn.thinking = (turn.thinking ?? '') + '\n\n'
      const speed = meter(turn)
      let output: number | undefined
      const answer = await this.think(
        `Today is ${now}. Question: ${question}

Answer from the sources below. Lead with a direct two or three sentence answer, then '---' on its own line, then the useful detail as tight markdown in at most 250 words (short sections or bullets, specific numbers, dates and names). Cite sources inline as [n]. Say plainly where sources disagree or where the answer is uncertain. Do not add a sources list; it is shown separately. No em dashes.

<sources>
${sources}
</sources>`,
        {
          effort: 'low',
          onUsage: (n) => (output = n),
          onThinking: (t) => (speed.tick(), onThinking(t)),
          onText: (partial) => {
            speed.tick()
            if (turn.thinking && turn.thoughtMs === undefined) turn.thoughtMs = Date.now() - turn.at
            turn.text = parseReply(partial).shown
            this.update(turn)
            speech.feed(partial)
          }
        }
      )
      const reply = parseReply(answer)
      speed.done(output)
      turn.text = reply.shown || '(no answer)'
      turn.spoken = reply.spoken
      turn.pending = false
      this.update(turn)
      speech.finish(narrate === 'full' ? speakable(reply.shown) : reply.spoken)
    } catch (e) {
      turn.pending = false
      turn.error = true
      turn.text = (e as Error).message === 'Stopped' ? 'Stopped.' : `Research failed: ${(e as Error).message}`
      this.update(turn)
    } finally {
      this.ev.busy(false)
    }
  }

  /**
   * Mac commands. Plain "open X and Y" runs at once; anything else (placing windows, several steps)
   * is planned by the model as a short list of actions. Not a Mac action: answered as chat.
   */
  private async macCommand(text: string) {
    const names = text.replace(/^(?:please\s+)?(?:open|launch|start up)\s+/i, '').split(/\s*(?:,|\band\b)\s*/i).filter(Boolean)
    if (/^(?:please\s+)?(?:open|launch|start up)\s/i.test(text) && names.every((n) => findApp(n))) {
      const opened = await Promise.all(names.map((n) => openApp(n)))
      return this.say(`Opened ${opened.join(' and ')}.`)
    }
    const plan = await this.think(
      `Turn Anuj's request into Mac actions.

Installed apps: ${installedApps().join(', ')}. You are the app named Vesper.
Actions:
{"do":"open","app":name} | {"do":"quit","app":name} | {"do":"place","app":name,"region":"left|right|full|top|bottom|left-third|center-third|right-third|center"} | {"do":"url","url":string} | {"do":"search","query":string}
"place" opens the app too. For "split", "side by side" or "left and right", place the first app left and the second right.

Request: ${text}

Reply with only JSON: {"actions":[...],"say":"one short sentence confirming what you did"}. If the request is not something to do on the Mac, reply {"actions":[]}.`,
      { effort: 'none' }
    )
    let parsed: { actions?: { do: string; app?: string; region?: Region; url?: string; query?: string }[]; say?: string } = {}
    try {
      parsed = JSON.parse(plan.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
    } catch {
      // Not JSON: treat as chat below.
    }
    if (!parsed.actions?.length) return this.chat(text)
    const failed: string[] = []
    for (const a of parsed.actions) {
      try {
        if (a.do === 'open' && a.app) await openApp(a.app)
        else if (a.do === 'quit' && a.app) await quitApp(a.app)
        else if (a.do === 'place' && a.app) await placeApp(a.app, a.region ?? 'full')
        else if (a.do === 'url' && a.url && /^https?:\/\//.test(a.url)) await shell.openExternal(a.url)
        else if (a.do === 'search' && a.query) await shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(a.query)}`)
      } catch (e) {
        failed.push((e as Error).message)
      }
    }
    if (failed.length) return this.say(`${failed[0]}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`, { error: true })
    return this.say(parsed.say || 'Done.')
  }

  /** Clean up dictated text (punctuation, filler words, "scratch that") and type it where the cursor is. */
  async dictate(raw: string) {
    let text = raw.trim()
    if (!text) return
    if (text.split(/\s+/).length > 5) {
      const cleaned = await this.think(
        `Clean up this dictation. Fix punctuation and capitalization, drop filler words (um, uh, like as filler), and apply spoken corrections ("scratch that", "I mean", "actually no"). Keep the wording otherwise. Reply with only the cleaned text.\n\n${text}`,
        { effort: 'none' }
      ).catch(() => '')
      if (cleaned.trim()) text = cleaned.trim().replace(/^"|"$/g, '')
    }
    await typeText(text)
  }

  /** Launch a team of parallel agents from the main chat, which stays the main chat. */
  async launchSwarm(goal: string, count?: number) {
    this.ev.show?.()
    const turn = this.push({ speaker: 'bluevis', text: '', pending: true, status: 'Putting a team together' })
    try {
      const s = await this.swarms.start(this.chatId, goal, count)
      const names = s.agents.map((a) => a.name)
      turn.swarmId = s.id
      turn.pending = false
      delete turn.status
      turn.text = `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are on it. ${s.mode === 'debate' ? `They will debate over ${s.rounds} rounds, then I will give you the verdict.` : 'Each takes a part; I will pull it together when they finish.'}`
      turn.spoken = turn.text
      this.update(turn)
      this.ev.speak(turn.id, turn.text)
    } catch (e) {
      turn.pending = false
      turn.error = true
      turn.text = (e as Error).message
      this.update(turn)
    }
  }

  /** The main chat's verdict once a team finishes: agreement, disagreement, and a call. */
  private async moderate(s: Swarm) {
    if (s.chatId !== this.chatId) return
    const transcript = s.agents
      .map((a) => `## ${a.name} (${a.persona})\n${a.messages.filter((m) => m.from === 'agent' && !m.error && m.text).map((m) => `${m.round ? `Round ${m.round}` : 'Reply'}: ${m.text}`).join('\n\n')}`)
      .join('\n\n')
    const turn = this.push({ speaker: 'bluevis', text: '', pending: true, model: `${label(getSettings().brain)} · verdict`, swarmId: s.id })
    this.ev.busy(true)
    const speech = new SpeechStream((sentence) => this.ev.speakChunk(turn.id, sentence), 3, getSettings().voice.narrate === 'full')
    try {
      const raw = await this.think(
        `Your team just finished working on: "${s.goal}" (${s.mode}).

${transcript}

Give Anuj the verdict. Start with two or three spoken sentences: the bottom line. Then '---' and in at most 200 words of markdown: where they agreed, where they split and why, and your own call with reasons. Name the agents. No em dashes.`,
        {
          effort: 'medium',
          onThinking: (t) => ((turn.thinking = (turn.thinking ?? '') + t), this.update(turn)),
          onText: (partial) => {
            if (turn.thinking && turn.thoughtMs === undefined) turn.thoughtMs = Date.now() - turn.at
            turn.text = parseReply(partial).shown
            this.update(turn)
            speech.feed(partial)
          }
        }
      )
      const reply = parseReply(raw)
      turn.text = reply.shown || '(no verdict)'
      turn.spoken = reply.spoken
      speech.finish(reply.spoken)
    } catch (e) {
      turn.error = true
      turn.text = `The verdict failed: ${(e as Error).message}`
    } finally {
      turn.pending = false
      this.update(turn)
      this.ev.busy(false)
    }
  }

  private lastBriefAt = 0

  /** The day in under a minute: calendar, Canvas, finished agents, hackathon. Sources are fetched in parallel. */
  private async brief() {
    this.ev.busy(true)
    const since = this.lastBriefAt || Date.now() - 16 * 3600_000
    const [cal, canvas] = await Promise.all([agendaText(2), canvasBrief()])
    const finished = this.tasks.list().filter((t) => (t.endedAt ?? 0) > since)
    const agents = finished.length
      ? finished.map((t) => `- ${t.title} (${label(t.choice)}, ${t.project ?? t.cwd}): ${t.status}${t.finalMessage ? `. ${t.finalMessage.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`).join('\n')
      : '(No agent runs finished since the last brief.)'
    this.lastBriefAt = Date.now()
    this.ev.busy(false)
    const ctx = [
      `<calendar source="ICS feeds, today and tomorrow">\n${cal}\n</calendar>`,
      canvas ? `<canvas source="Canvas API">\n${canvas}\n</canvas>` : '',
      `<agents_finished>\n${agents}\n</agents_finished>`
    ]
      .filter(Boolean)
      .join('\n\n')
    return this.chat(
      'Give me my brief. Speak it in under 45 seconds: the next thing on my calendar, anything due soon that I have not submitted, and what agents finished. Lead with whatever is most urgent. Skip empty sections. Put the full detail after the separator.',
      undefined,
      ctx
    )
  }

  private async status() {
    const all = this.tasks.list().slice(0, 6)
    if (!all.length) return this.say('No agents have run this session.')
    const running = all.filter((t) => ['starting', 'investigating', 'editing', 'testing'].includes(t.status))
    const lines = all.map((t) => {
      const last = t.steps.at(-1)
      const age = Math.round((Date.now() - t.lastEventAt) / 1000)
      return `- **${label(t.choice)}** on ${t.project ?? t.cwd}: ${t.status.replace(/-/g, ' ')}${last ? `, last seen \`${last.label.slice(0, 80)}\` ${age}s ago` : ''}`
    })
    const spoken = running.length
      ? `${running.length} agent${running.length > 1 ? 's are' : ' is'} running. ${running.map((t) => `${label(t.choice)} is ${t.status} on ${t.project ?? 'a folder'}`).join('. ')}.`
      : 'Nothing is running right now.'
    this.say(`${spoken}\n\n${lines.join('\n')}`, { spoken, evidence: 'observed' })
  }

  private async resume(project?: Project) {
    if (!project) {
      const projects = await this.projects()
      return this.say(`Which project? Recent ones: ${projects.slice(0, 4).map((p) => p.name).join(', ')}.`)
    }
    this.setProject(project)
    const [log, status] = await Promise.all([
      run('git', ['log', '-8', '--format=%h %ad %s', '--date=relative'], { cwd: project.path }),
      run('git', ['status', '--short'], { cwd: project.path })
    ])
    const session = this.vault.latestSession(project.name)
    const { text: note } = await this.vault.context(`${project.name} status progress next steps`, { allowPrivate: getSettings().brain.provider === 'local', project: project.name, maxChars: 4000 })
    const agentRuns = this.tasks.list().filter((t) => t.project === project.name).slice(0, 3)
    const evidence = `<evidence>
Project: ${project.name} at ${project.path}, branch ${project.branch ?? '?'}
Recent commits (observed):
${log.stdout.trim() || '(none)'}
Uncommitted changes (observed):
${status.stdout.trim() || '(clean)'}
Last session note (${session?.path ?? 'none'}):
${session?.body.slice(0, 2500) ?? '(no previous session recorded)'}
Agent runs this session: ${agentRuns.map((t) => `${label(t.choice)}: ${t.status}, ${t.finalMessage?.slice(0, 300) ?? ''}`).join(' | ') || 'none'}
Knowledge:
${note}
</evidence>`
    await this.chatWith(`${RESUME_PROMPT}\n\n${evidence}`, `Resuming ${project.name}`)
  }

  /** Run a one-off skill prompt through the brain and present it as a normal reply. */
  private async chatWith(prompt: string, labelText: string) {
    const turn = this.push({ speaker: 'bluevis', text: '', pending: true, model: label(getSettings().brain) })
    this.ev.busy(true)
    try {
      const raw = await this.runBrain(prompt, { fresh: true })
      const reply = parseReply(raw)
      turn.text = reply.shown
      turn.spoken = reply.spoken
      turn.pending = false
      this.update(turn)
      this.ev.speak(turn.id, reply.spoken)
    } catch (e) {
      turn.pending = false
      turn.error = true
      turn.text = `${labelText} failed. ${friendlyError((e as Error).message, getSettings().brain)}`
      this.update(turn)
    } finally {
      this.ev.busy(false)
    }
  }

  private async endSession(projectName?: string) {
    const projects = await this.projects()
    const match = projectName ? matchProject(projectName, projects.map((p) => p.name)) : undefined
    const project = match ? projects.find((p) => p.name === match) : this.activeProject
    const convo = this.turns.filter((t) => (t.speaker === 'user' || t.speaker === 'bluevis') && t.text && !t.error)
    const runs = this.tasks.list()
    if (convo.length < 3 && !runs.length) return this.say('Nothing worth recording this session. See you later.')
    const transcript = convo.map((t) => `${t.speaker === 'user' ? 'Anuj' : 'Vesper'}: ${t.text.slice(0, 1200)}`).join('\n')
    const agentLog = runs
      .map((t) => `- ${label(t.choice)} on ${t.project ?? t.cwd}: ${t.status}; files: ${t.filesChanged.join(', ') || 'none'}; said: ${t.finalMessage?.slice(0, 400) ?? '(nothing)'}`)
      .join('\n')
    const pending = this.push({ speaker: 'bluevis', text: 'Writing up the session…', pending: true })
    this.ev.busy(true)
    try {
      const md = await this.runBrain(`${SESSION_PROMPT}\n\n<transcript>\n${transcript}\n</transcript>\n\n<agent-runs>\n${agentLog || 'none'}\n</agent-runs>`, { fresh: true })
      const title = project?.name ?? 'Session'
      const res = await this.vault.writeSession(title, parseReply(md).shown, project?.name)
      pending.pending = false
      const still = this.tasks.active()
      const tail = still.length ? ` ${still.length} agent${still.length > 1 ? 's are' : ' is'} still running and will keep going unless you stop ${still.length > 1 ? 'them' : 'it'}.` : ''
      pending.text = `Session saved to ${res.path}.${tail}`
      pending.memory = { path: res.path, title: `Session: ${title}`, hash: res.hash }
      this.update(pending)
      this.ev.speak(pending.id, `Session saved.${tail}`)
    } catch (e) {
      pending.pending = false
      pending.error = true
      pending.text = `Couldn't write the session summary: ${(e as Error).message}`
      this.update(pending)
    } finally {
      this.ev.busy(false)
    }
  }

  dismissAction(turnId: string) {
    const t = this.turns.find((x) => x.id === turnId)
    if (t?.action) {
      t.action.state = 'dismissed'
      this.update(t)
    }
  }

  async approveAction(turnId: string, project?: string, prompt?: string) {
    const t = this.turns.find((x) => x.id === turnId)
    if (!t?.action || t.action.state !== 'proposed') return
    await this.delegate({ ...t.action, project: project ?? t.action.project, prompt: prompt ?? t.action.prompt }, undefined, false, turnId)
  }
}

export function label(c: ModelChoice): string {
  if (c.provider === 'codex') return c.model.replace(/^gpt-/, 'GPT-').replace(/-(\w)/g, (_, x: string) => `-${x.toUpperCase()}`)
  if (c.provider === 'claude') return `Claude ${c.model[0].toUpperCase()}${c.model.slice(1)}`
  return c.model ? c.model.split('/').pop()!.replace(/-Splash$/, '').slice(0, 24) : 'Local model'
}

function friendlyError(message: string, choice: ModelChoice): string {
  if (/not found|ENOENT|Could not start/i.test(message)) return `I couldn't start ${choice.provider}. Is its CLI installed and signed in?`
  if (/rate|limit|quota/i.test(message)) return `${label(choice)} is rate limited right now. Try again shortly, or say "switch to Claude".`
  if (/Stopped/.test(message)) return 'Stopped.'
  return message
}
