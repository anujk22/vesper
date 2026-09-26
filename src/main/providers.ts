import type { ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeLine, parseCodexLine, parseOpenAISSELine, LineBuffer } from '../core/parsers'
import type { AgentEvent, ModelChoice, ProviderHealth } from '../core/types'
import { run, spawnLines } from './shell'
import { readySplash } from './splash'

export interface RunOptions {
  choice: ModelChoice
  prompt: string
  cwd: string
  /** brain = read-only conversational turns; worker = sandboxed agent that may edit its workspace. */
  role: 'brain' | 'worker'
  sessionId?: string
  images?: string[]
  /** Persona / system instructions. Codex receives them inline on the first turn. */
  system?: string
  /** Prior turns, used by the stateless local provider. */
  history?: { role: 'user' | 'assistant'; content: string }[]
  localBaseUrl?: string
  /** Claude only: exact tool allowlist for this run (replaces the brain's default read-only set). */
  tools?: string[]
  /** Claude only: tools to refuse outright, as a second line of defense. */
  denyTools?: string[]
  /** JSON Schema for the final reply. Codex enforces it; other providers are asked for JSON. */
  schema?: object
  onEvent: (e: AgentEvent) => void
}

export interface RunHandle {
  stop: () => void
  done: Promise<void>
}

let limitsHook: ((raw: unknown) => void) | null = null
/** Every run reports provider rate-limit events here, whoever started it. */
export function onRateLimits(fn: (raw: unknown) => void) {
  limitsHook = fn
}

export function runProvider(o: RunOptions): RunHandle {
  if (o.choice.provider === 'codex') return runCodex(o)
  if (o.choice.provider === 'claude') return runClaude(o)
  return runLocal(o)
}

function cliRun(cmd: string, args: string[], o: RunOptions, parse: (l: string) => AgentEvent[], stdin: string): RunHandle {
  let child: ChildProcess
  let stderr = ''
  let finished = false
  let stopped = false
  const done = new Promise<void>((resolve) => {
    child = spawnLines(cmd, args, {
      cwd: o.cwd,
      env: process.env,
      stdin,
      onLine: (line) => {
        for (const ev of parse(line)) {
          if (ev.kind === 'limits') {
            limitsHook?.(ev.raw)
            continue
          }
          if (ev.kind === 'done' || ev.kind === 'error') finished = true
          o.onEvent(ev)
        }
      },
      onStderr: (s) => {
        stderr = (stderr + s).slice(-4000)
      }
    })
    child.on('error', (err) => {
      finished = true
      o.onEvent({ kind: 'error', message: `Could not start ${cmd}: ${err.message}` })
      resolve()
    })
    child.on('close', (code) => {
      if (!finished) {
        if (stopped) o.onEvent({ kind: 'error', message: 'Stopped' })
        else o.onEvent({ kind: 'error', message: lastLine(stderr) || `${cmd} exited with code ${code}` })
      }
      resolve()
    })
  })
  return {
    stop: () => {
      stopped = true
      child?.kill('SIGINT')
      setTimeout(() => child?.exitCode === null && child.kill('SIGKILL'), 3000)
    },
    done
  }
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? ''
}

function runCodex(o: RunOptions): RunHandle {
  const sandbox = o.role === 'brain' ? 'read-only' : 'workspace-write'
  const args = ['exec']
  if (o.sessionId) args.push('resume', o.sessionId)
  args.push('--json', '--skip-git-repo-check')
  for (const img of o.images ?? []) args.push('-i', img)
  args.push('-m', o.choice.model)
  if (o.choice.effort) args.push('-c', `model_reasoning_effort="${o.choice.effort}"`)
  if (o.schema) {
    const file = join(tmpdir(), `bluevis-schema-${process.pid}-${Date.now()}.json`)
    writeFileSync(file, JSON.stringify(o.schema))
    args.push('--output-schema', file)
  }
  if (o.sessionId) args.push('-c', `sandbox_mode="${sandbox}"`)
  else args.push('-s', sandbox, '-C', o.cwd)
  args.push('-')
  const prompt = !o.sessionId && o.system ? `<instructions>\n${o.system}\n</instructions>\n\n${o.prompt}` : o.prompt
  return cliRun('codex', args, o, parseCodexLine, prompt)
}

function runClaude(o: RunOptions): RunHandle {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', o.choice.model]
  if (o.choice.effort) args.push('--effort', o.choice.effort === 'minimal' ? 'low' : o.choice.effort)
  if (o.sessionId) args.push('--resume', o.sessionId)
  if (o.system) args.push('--append-system-prompt', o.system)
  if (o.role === 'brain') {
    args.push('--permission-mode', 'default', '--allowedTools', ...(o.tools ?? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']))
    if (o.denyTools?.length) args.push('--disallowedTools', ...o.denyTools)
  } else {
    // Edits are accepted inside the workspace; shell commands run in Claude Code's sandbox.
    args.push('--permission-mode', 'acceptEdits', '--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }))
  }
  let prompt = o.prompt
  if (o.images?.length) prompt += `\n\n[Attached screenshot(s), read with the Read tool: ${o.images.join(', ')}]`
  if (o.images?.length) for (const img of o.images) args.push('--add-dir', img.replace(/\/[^/]+$/, ''))
  return cliRun('claude', args, o, parseClaudeLine, prompt)
}

/** Forward streamed text deltas and return the full text. Stream errors are thrown. */
async function streamSSE(body: ReadableStream<Uint8Array>, parse: (line: string) => AgentEvent[], o: RunOptions): Promise<string> {
  const buf = new LineBuffer()
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    for (const line of buf.push(decoder.decode(chunk, { stream: true }))) {
      for (const ev of parse(line)) {
        if (ev.kind === 'error') throw new Error(ev.message)
        if (ev.kind === 'text-delta') {
          text += ev.text
          o.onEvent(ev)
        }
        if (ev.kind === 'thinking-delta' || ev.kind === 'usage') o.onEvent(ev)
      }
    }
  }
  return text
}

function runLocal(o: RunOptions): RunHandle {
  const controller = new AbortController()
  let base = (o.localBaseUrl ?? '').replace(/\/$/, '')
  const done = (async () => {
    try {
      const messages = [
        ...(o.system ? [{ role: 'system', content: o.system }] : []),
        ...(o.history ?? []),
        {
          role: 'user',
          content: o.images?.length
            ? [...o.images.map((p) => ({ type: 'image_url', image_url: { url: `data:image/${p.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(p).toString('base64')}` } })), { type: 'text', text: o.prompt }]
            : o.prompt
        }
      ]
      base = await readySplash(o.choice, () => o.onEvent({ kind: 'progress', label: `Loading ${o.choice.model.split('/').pop()!.replace(/-Splash$/, '')}` }))
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Qwen thinks by default, which delays the first spoken word by seconds; conversation turns it off unless an effort is chosen.
        body: JSON.stringify({ model: o.choice.model, messages, stream: true, stream_options: { include_usage: true }, reasoning_effort: o.choice.effort ?? 'none' }),
        signal: controller.signal
      })
      if (!res.ok || !res.body) throw new Error(`Local model returned ${res.status}`)
      const text = await streamSSE(res.body, parseOpenAISSELine, o)
      // Reasoning models may wrap thoughts in <think>; never show or speak them.
      o.onEvent({ kind: 'message', text: text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() })
      o.onEvent({ kind: 'done' })
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'Stopped' : `Local model unavailable at ${base} (${(e as Error).message})`
      o.onEvent({ kind: 'error', message: msg })
    }
  })()
  return { stop: () => controller.abort(), done }
}

export async function providerHealth(localBaseUrl: string): Promise<ProviderHealth[]> {
  const [codex, claude, local] = await Promise.all([
    run('codex', ['--version'], { timeout: 8000 }),
    run('claude', ['--version'], { timeout: 8000 }),
    fetch(`${localBaseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1500) })
      .then(async (r) => (r.ok ? ((await r.json()) as { data?: { id: string }[] }) : null))
      .catch(() => null)
  ])
  return [
    { provider: 'codex', ok: codex.code === 0, detail: codex.code === 0 ? codex.stdout.trim() : 'codex CLI not found' },
    { provider: 'claude', ok: claude.code === 0, detail: claude.code === 0 ? claude.stdout.trim() : 'claude CLI not found' },
    {
      provider: 'local',
      ok: !!local,
      detail: local ? (local.data?.map((m) => m.id).slice(0, 3).join(', ') || 'online') : `offline at ${localBaseUrl}`
    }
  ]
}

export async function localModels(localBaseUrl: string): Promise<string[]> {
  try {
    const r = await fetch(`${localBaseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1500) })
    const j = (await r.json()) as { data?: { id: string }[] }
    return j.data?.map((m) => m.id) ?? []
  } catch {
    return []
  }
}
