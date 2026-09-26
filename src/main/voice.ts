import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { VoiceHealth } from '../core/types'

const PORT = 47821
const BASE = `http://127.0.0.1:${PORT}`
/** Must match VERSION in voice/server.py. */
const SIDECAR_VERSION = 5

/** Manages the local Python voice sidecar (Whisper STT + Kokoro TTS on MLX). */
export class VoiceService {
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  health: VoiceHealth = { state: 'off', detail: 'Voice is off' }

  constructor(
    private onHealth: (h: VoiceHealth) => void,
    private voice: () => string
  ) {}

  private set(h: VoiceHealth) {
    this.health = h
    this.onHealth(h)
  }

  private async alive(): Promise<boolean> {
    return (await this.version()) !== null
  }

  private async version(): Promise<number | null> {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) })
      return r.ok ? (((await r.json()) as { version?: number }).version ?? 1) : null
    } catch {
      return null
    }
  }

  start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = (async () => {
      const running = await this.version()
      if (running === SIDECAR_VERSION) {
        this.set({ state: 'ready', detail: 'Local voice ready' })
        return
      }
      if (running !== null) {
        // An older sidecar (from before an update) is still up; replace it.
        await fetch(`${BASE}/shutdown`, { method: 'POST' }).catch(() => null)
        for (let i = 0; i < 20 && (await this.alive()); i++) await new Promise((r) => setTimeout(r, 250))
      }
      this.set({ state: 'starting', detail: 'Starting local voice (first run downloads models)' })
      const script = app.isPackaged ? join(process.resourcesPath, 'voice', 'server.py') : join(app.getAppPath(), 'voice', 'server.py')
      let stderr = ''
      this.child = spawn('uv', ['run', '--quiet', script], { env: { ...process.env, BLUEVIS_VOICE_PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'pipe'] })
      this.child.stderr!.setEncoding('utf8')
      this.child.stderr!.on('data', (s: string) => (stderr = (stderr + s).slice(-2000)))
      this.child.on('error', () => this.set({ state: 'error', detail: 'uv is not installed, so local voice cannot start' }))
      this.child.on('exit', (code) => {
        this.child = null
        this.starting = null
        if (this.health.state !== 'off') this.set({ state: 'error', detail: `Voice stopped (${code}). ${stderr.trim().split('\n').at(-1) ?? ''}` })
      })
      for (let i = 0; i < 600 && this.child; i++) {
        if (await this.alive()) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!(await this.alive())) return
      this.set({ state: 'starting', detail: 'Loading voice models' })
      const warm = await fetch(`${BASE}/warm`, { method: 'POST', body: JSON.stringify({ voice: this.voice() }), headers: { 'Content-Type': 'application/json' } }).catch(() => null)
      if (warm?.ok) this.set({ state: 'ready', detail: 'Local voice ready' })
      else this.set({ state: 'error', detail: 'Voice models failed to load' })
    })()
    return this.starting
  }

  stop() {
    this.set({ state: 'off', detail: 'Voice is off' })
    this.child?.kill()
    this.child = null
    this.starting = null
  }

  /** Calls the sidecar; if it has gone away (crash, or a previous app instance killed it), restart it. */
  private async call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${BASE}${path}`, init)
    } catch {
      this.starting = null
      this.set({ state: 'starting', detail: 'Voice restarted after the local service stopped' })
      void this.start()
      throw new Error('The local voice service stopped and is restarting. Try again in a few seconds.')
    }
  }

  /** Local text embeddings for retrieval; null when the sidecar is not running (callers fall back to keywords). */
  async embed(texts: string[], query = false): Promise<number[][] | null> {
    if (this.health.state !== 'ready' || !texts.length) return null
    try {
      const r = await fetch(`${BASE}/embed`, { method: 'POST', body: JSON.stringify({ texts, query }), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) })
      if (!r.ok) return null
      return ((await r.json()) as { vectors: number[][] }).vectors
    } catch {
      return null
    }
  }

  async transcribe(wav: ArrayBuffer): Promise<string> {
    const r = await this.call('/stt', { method: 'POST', body: Buffer.from(wav), headers: { 'Content-Type': 'audio/wav' } })
    const j = (await r.json()) as { text?: string; error?: string }
    if (!r.ok) throw new Error(j.error ?? 'Transcription failed')
    return j.text ?? ''
  }

  async speak(text: string, voice: string, speed: number): Promise<ArrayBuffer> {
    const r = await this.call('/tts', { method: 'POST', body: JSON.stringify({ text, voice, speed }), headers: { 'Content-Type': 'application/json' } })
    if (!r.ok) throw new Error('Speech synthesis failed')
    return r.arrayBuffer()
  }
}
