import { encodeWav, downsample } from './voice'

/** "Vesper" as Whisper tends to hear it, optionally after "hey"/"ok", then whatever followed. */
const WAKE = /^\s*(?:(?:hey|hay|hi|ok|okay|yo)[\s,]+)?(?:vesper|vespa|vespers|vesber|jesper|bluevis)\b[\s,.!:?-]*(.*)$/is

export function wakeCommand(transcript: string): string | null {
  const m = transcript.trim().match(WAKE)
  return m ? m[1].trim() : null
}

/**
 * Always-on wake listening. Keeps one microphone stream open and cuts it into utterances with an
 * adaptive energy gate. Only the first two seconds of each utterance are transcribed to look for
 * "Vesper"; the whole utterance is transcribed only when the wake word is there. Audio never leaves
 * the Mac, and nothing is kept.
 */
export class WakeListener {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private paused = false

  constructor(
    private stt: (wav: ArrayBuffer) => Promise<string>,
    /** Called with what followed the wake word ("" when "Vesper" was said alone). */
    private onWake: (command: string) => void,
    /** True while Vesper itself is talking or push-to-talk is active, so neither is mistaken for a wake. */
    private busy: () => boolean
  ) {}

  get running() {
    return !!this.ctx
  }

  pause(p: boolean) {
    this.paused = p
  }

  async start() {
    if (this.ctx) return
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    this.ctx = new AudioContext()
    const rate = this.ctx.sampleRate
    const src = this.ctx.createMediaStreamSource(this.stream)
    const proc = this.ctx.createScriptProcessor(2048, 1, 1)
    const preroll: Float32Array[] = []
    let chunks: Float32Array[] = []
    let noise = 0.008
    let inSpeech = false
    let silentFor = 0
    let length = 0
    proc.onaudioprocess = (e) => {
      if (this.paused || this.busy()) {
        inSpeech = false
        chunks = []
        return
      }
      const data = new Float32Array(e.inputBuffer.getChannelData(0))
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      const dt = data.length / rate
      const speaking = rms > Math.max(0.02, noise * 2.8)
      if (!inSpeech) {
        noise = noise * 0.97 + rms * 0.03
        preroll.push(data)
        if (preroll.length > 6) preroll.shift()
        if (speaking) {
          inSpeech = true
          chunks = [...preroll]
          length = 0
          silentFor = 0
        }
        return
      }
      chunks.push(data)
      length += dt
      silentFor = speaking ? 0 : silentFor + dt
      if (silentFor > 0.9 || length > 20) {
        inSpeech = false
        const utterance = chunks
        chunks = []
        // Too short to be "hey Vesper"; too long to be a command.
        if (length > 0.35 && length <= 20) void this.check(utterance, rate)
      }
    }
    src.connect(proc)
    proc.connect(this.ctx.destination)
  }

  private async check(chunks: Float32Array[], rate: number) {
    const all = concat(chunks)
    const head = all.subarray(0, Math.min(all.length, rate * 2.2))
    try {
      const start = await this.stt(encodeWav(downsample(head, rate, 16000), 16000))
      if (wakeCommand(start) === null) return
      const full = all.length > head.length ? await this.stt(encodeWav(downsample(all, rate, 16000), 16000)) : start
      this.onWake(wakeCommand(full) ?? wakeCommand(start) ?? '')
    } catch {
      // The voice service restarting is not worth surfacing for a background check.
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.ctx = null
    this.stream = null
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}
