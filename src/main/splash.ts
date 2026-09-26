import { powerMonitor } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import type { ModelChoice } from '../core/types'
import { getSettings } from './settings'

/**
 * Two Splash servers at most. `main` serves the conversation model at the local URL. `heavy` serves
 * the smarter dense model one port up, only while research or an agent team needs it; it is loaded
 * on demand and unloaded after a few idle minutes, so most of the time only the fast model holds memory.
 */
export const HEAVY_MODEL = 'incoai/Qwen3.8-27B-Splash'
const HEAVY_IDLE = 5 * 60_000

type Slot = 'main' | 'heavy'
const servers: Record<Slot, { proc: ChildProcess; model: string } | null> = { main: null, heavy: null }
const lastUse: Record<Slot, number> = { main: Date.now(), heavy: 0 }

async function models(base: string): Promise<string[]> {
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1500) })
    return ((await r.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? []
  } catch {
    return []
  }
}

const isSplash = (c: ModelChoice) => c.provider === 'local' && c.model.endsWith('-Splash')
const splashBrain = () => isSplash(getSettings().brain)

/** Research and agent teams run on the dense model when conversation runs on a Splash model. */
export function heavy(c: ModelChoice): ModelChoice {
  return isSplash(c) ? { ...c, model: HEAVY_MODEL } : c
}

function slotFor(model: string): Slot {
  return model === getSettings().brain.model ? 'main' : 'heavy'
}

function baseFor(slot: Slot): string {
  const base = getSettings().localBaseUrl.replace(/\/$/, '')
  if (slot === 'main') return base
  const u = new URL(base)
  u.port = String(Number(u.port || 8000) + 1)
  return u.toString().replace(/\/$/, '')
}

async function start(slot: Slot, model: string) {
  const base = baseFor(slot)
  // Ours and already serving (or loading) the right model.
  if (servers[slot]?.model === model) return
  const serving = await models(base)
  if (serving.includes(model)) return
  // Switching models in a slot means one server out, the other in.
  if (servers[slot]) await stopAndWait(slot)
  else if (serving.length) return
  const port = new URL(base).port || '8000'
  // A busy server can miss the models check; if anything holds the port, never start a second copy of the model.
  if (await listening(Number(port))) return
  const proc = spawn('splash', ['serve', '--model', model, '--port', port, '--no-webui'], { stdio: 'ignore', detached: true })
  servers[slot] = { proc, model }
  // Not installed (spawn error) or exited: allow a later retry.
  const gone = () => servers[slot]?.proc === proc && (servers[slot] = null)
  proc.on('error', gone)
  proc.on('exit', gone)
}

/**
 * Start the Splash server when conversation uses a Splash model and nothing answers at the local URL yet.
 * On battery it is not started ahead of time (`onDemand` starts it for a request). It stops when Vesper quits.
 */
export async function ensureSplash(onDemand = false) {
  if (!splashBrain() || (!onDemand && powerMonitor.isOnBatteryPower())) return
  // A conversation model switched to the dense one no longer needs a separate heavy server.
  if (servers.heavy?.model === getSettings().brain.model) stop('heavy')
  await start('main', getSettings().brain.model)
}

async function stopAndWait(slot: Slot) {
  stop(slot)
  for (let i = 0; i < 40 && (await models(baseFor(slot))).length; i++) await new Promise((r) => setTimeout(r, 250))
}

/**
 * Before a local request: make sure its model is loaded, starting it if needed, and return the URL
 * that serves it. `onLoading` fires only when it has to wait.
 */
export async function readySplash(c: ModelChoice, onLoading?: () => void): Promise<string> {
  if (!isSplash(c)) return getSettings().localBaseUrl.replace(/\/$/, '')
  const slot = slotFor(c.model)
  const base = baseFor(slot)
  lastUse[slot] = Date.now()
  if ((await models(base)).includes(c.model)) return base
  onLoading?.()
  if (slot === 'main') await ensureSplash(true)
  else await start('heavy', c.model)
  for (const until = Date.now() + 120_000; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 500))
    lastUse[slot] = Date.now()
    if ((await models(base)).includes(c.model)) return base
  }
  throw new Error('The local model did not finish loading in two minutes.')
}

/** Start loading the dense model now, so it is ready by the time research has read its sources. */
export function warmHeavy(c: ModelChoice) {
  const h = heavy(c)
  if (h !== c && slotFor(h.model) === 'heavy') {
    lastUse.heavy = Date.now()
    void start('heavy', h.model)
  }
}

function stop(slot: Slot) {
  // `splash` hands off to a Python server; signal the whole process group so the model's memory is freed.
  const pid = servers[slot]?.proc.pid
  if (pid) process.kill(-pid, 'SIGTERM')
  servers[slot] = null
}

export function stopSplash() {
  stop('main')
  stop('heavy')
}

/**
 * Plugged in: keep the conversation model loaded. On battery: unload at once, load again only when
 * asked, and unload again after ten minutes without use. The dense model leaves after five idle minutes either way.
 */
export function managePower() {
  powerMonitor.on('on-battery', stopSplash)
  powerMonitor.on('on-ac', () => void ensureSplash())
  setInterval(() => {
    if (servers.main && powerMonitor.isOnBatteryPower() && Date.now() - lastUse.main > 10 * 60_000) stop('main')
    if (servers.heavy && Date.now() - lastUse.heavy > HEAVY_IDLE) stop('heavy')
  }, 60_000)
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1')
    sock.once('connect', () => (sock.destroy(), resolve(true)))
    sock.once('error', () => resolve(false))
  })
}
