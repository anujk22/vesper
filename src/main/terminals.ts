import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import { terminalTail, type TerminalInfo } from '../core/terminal'

const KEEP = 256 * 1024

/** Real login-shell terminals. Output streams to the renderer and a tail is kept so Vesper can read it. */
export class TerminalManager {
  private terms = new Map<string, { info: TerminalInfo; pty: IPty; buffer: string }>()
  private focused: string | null = null
  // Output is coalesced per frame so a flood (npm install) is a few IPC messages, not thousands.
  private outbox = new Map<string, string>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private send: (channel: string, ...args: unknown[]) => void) {}

  create(o: { cwd?: string; title?: string; command?: string; cols?: number; rows?: number }): TerminalInfo {
    const shell = process.env.SHELL || '/bin/zsh'
    const cwd = o.cwd || homedir()
    // A command runs inside an interactive login shell so PATH, aliases and nvm match the user's own terminal.
    const args = o.command ? ['-l', '-i', '-c', o.command] : ['-l', '-i']
    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: o.cols ?? 100,
      rows: o.rows ?? 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Vesper' } as Record<string, string>
    })
    const info: TerminalInfo = { id: randomUUID(), title: o.title ?? cwd.split('/').filter(Boolean).at(-1) ?? 'home', cwd, command: o.command, lastOutputAt: Date.now() }
    const t = { info, pty, buffer: '' }
    this.terms.set(info.id, t)
    pty.onData((d) => {
      t.buffer = (t.buffer + d).slice(-KEEP)
      info.lastOutputAt = Date.now()
      this.outbox.set(info.id, (this.outbox.get(info.id) ?? '') + d)
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = null
        for (const [id, chunk] of this.outbox) this.send('term:data', id, chunk)
        this.outbox.clear()
      }, 16)
    })
    pty.onExit(({ exitCode }) => {
      info.exited = exitCode
      this.send('term:list', this.list())
    })
    this.send('term:list', this.list())
    return info
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => ({ ...t.info }))
  }

  /** Everything the renderer needs to redraw a terminal it had not mounted yet. */
  replay(id: string): string {
    return this.terms.get(id)?.buffer ?? ''
  }

  write(id: string, data: string) {
    // The terminal Vesper reads is the one Anuj last typed in.
    this.focused = id
    this.terms.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id)
    if (t && t.info.exited === undefined && cols > 0 && rows > 0) t.pty.resize(cols, rows)
  }

  focus(id: string | null) {
    this.focused = id
  }

  kill(id: string) {
    const t = this.terms.get(id)
    if (!t) return
    if (t.info.exited === undefined) t.pty.kill()
    this.terms.delete(id)
    if (this.focused === id) this.focused = null
    this.send('term:list', this.list())
  }

  killAll() {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }

  /** The focused terminal's recent output, plain and with credentials masked, if it was active in the last half hour. */
  focusedTail(lines = 150): { title: string; cwd: string; text: string } | null {
    const t = this.focused ? this.terms.get(this.focused) : null
    if (!t || Date.now() - t.info.lastOutputAt > 30 * 60_000) return null
    const text = terminalTail(t.buffer, lines)
    return text.trim() ? { title: t.info.title, cwd: t.info.cwd, text } : null
  }
}
