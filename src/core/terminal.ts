// Work terminals, and turning their raw output into something safe and compact to show a model.

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  /** Set when the terminal was opened to run one command, like resuming an agent thread. */
  command?: string
  exited?: number
  lastOutputAt: number
}

/** Remove ANSI escape sequences and apply carriage returns and backspaces the way a terminal would. */
export function plainText(raw: string): string {
  const noAnsi = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]|\x1b[=>78]/g, '')
  return noAnsi
    .split('\n')
    .map((line) => {
      // A carriage return rewrites the line from the start: keep what is visible last.
      const parts = line.replace(/\r$/, '').split('\r')
      let out = ''
      for (const p of parts) out = p + out.slice(p.length)
      while (/[^\x08]\x08/.test(out)) out = out.replace(/[^\x08]\x08/, '')
      return out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    })
    .join('\n')
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
]

/** Mask anything that looks like a credential before terminal text leaves the machine. */
export function redact(text: string): string {
  let t = text
  for (const re of SECRET_PATTERNS) t = t.replace(re, '[redacted]')
  // KEY=value lines, as printed by `cat .env` or `env`, when the name says it is secret.
  t = t.replace(/^(\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)[A-Z0-9_]*\s*[=:]\s*)\S.*$/gim, '$1[redacted]')
  t = t.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[redacted]@')
  return t
}

/** The last `lines` non-empty-tail lines of a terminal, plain and redacted. */
export function terminalTail(raw: string, lines = 150): string {
  const all = plainText(raw).replace(/\n+$/, '').split('\n')
  return redact(all.slice(-lines).join('\n'))
}

/** Questions that are probably about what just happened in the terminal. */
export function asksAboutTerminal(text: string): boolean {
  return /\b(errors?|fail(ed|ing|s|ure)?|crash(ed|es)?|stack ?trace|exception|terminal|output|logs?|build|compil\w*|tests?|broke|broken|warning|stuck|hang(ing|s)?|what happened|why (did|is|does|isn'?t|won'?t)|fix (it|this|that))\b/i.test(text)
}
