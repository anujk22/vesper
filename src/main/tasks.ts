import { randomUUID } from 'node:crypto'
import { applyTaskEvent, isActive, newTask } from '../core/taskState'
import type { AgentTask, ModelChoice } from '../core/types'
import { runProvider, type RunHandle } from './providers'
import { run } from './shell'

export interface StartTask {
  title: string
  prompt: string
  choice: ModelChoice
  cwd: string
  project?: string
  /** Continue an existing Codex or Claude Code thread instead of starting fresh. */
  sessionId?: string
}

/** Runs coding agents as sandboxed CLI processes and tracks their observed state. */
export class TaskManager {
  private tasks = new Map<string, AgentTask>()
  private handles = new Map<string, RunHandle>()
  private pending = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(
    private onUpdate: (t: AgentTask) => void,
    private onFinished: (t: AgentTask) => void
  ) {}

  list(): AgentTask[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string) {
    return this.tasks.get(id)
  }

  active(): AgentTask[] {
    return this.list().filter(isActive)
  }

  /** Coalesce bursts of stream events into at most ~8 UI updates per second. */
  private touch(id: string) {
    this.pending.add(id)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      for (const pid of this.pending) {
        const t = this.tasks.get(pid)
        if (t) this.onUpdate(structuredClone(t))
      }
      this.pending.clear()
    }, 120)
  }

  start(s: StartTask): AgentTask {
    const task = newTask({ id: randomUUID(), title: s.title, prompt: s.prompt, choice: s.choice, cwd: s.cwd, project: s.project })
    this.tasks.set(task.id, task)
    this.onUpdate(structuredClone(task))
    const handle = runProvider({
      choice: s.choice,
      prompt: s.prompt,
      cwd: s.cwd,
      role: 'worker',
      sessionId: s.sessionId,
      onEvent: (ev) => {
        if (task.status === 'stopped') return
        applyTaskEvent(task, ev)
        this.touch(task.id)
      }
    })
    this.handles.set(task.id, handle)
    void handle.done.then(async () => {
      this.handles.delete(task.id)
      if (task.status !== 'stopped') {
        const stat = await run('git', ['diff', '--stat'], { cwd: task.cwd })
        if (stat.code === 0 && stat.stdout.trim()) task.diffStat = stat.stdout.trim()
      }
      task.endedAt ??= Date.now()
      this.onUpdate(structuredClone(task))
      this.onFinished(structuredClone(task))
    })
    return task
  }

  /** Stops the agent process. Edits it already made stay in the working tree. */
  stop(id: string): boolean {
    const task = this.tasks.get(id)
    const handle = this.handles.get(id)
    if (!task || !handle) return false
    task.status = 'stopped'
    task.endedAt = Date.now()
    handle.stop()
    this.onUpdate(structuredClone(task))
    return true
  }

  stopAll(): void {
    for (const id of this.handles.keys()) this.stop(id)
  }
}
