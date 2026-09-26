import { useEffect, useRef } from 'react'
import { tint, type Accent, type RGB } from '../../../core/color'
import type { OrbMode } from '../../../core/types'
import { FRAG, VERT } from './shader'

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]

interface Look {
  core: RGB
  mid: RGB
  hi: RGB
  rim: RGB
  flow: number
  wobble: number
  levelWobble: number
  halo: number
  fil: number
}

// Pearl palette: deep sky core, pale body, near-white highlights, cool rim.
const PEARL = { core: hex('#3862b8'), mid: hex('#7fa6e6'), hi: hex('#e6f0ff'), rim: hex('#c4dcff') }

const LOOKS: Record<OrbMode, Look> = {
  idle: { ...PEARL, flow: 0.08, wobble: 0.006, levelWobble: 0, halo: 0.55, fil: 0.7 },
  listening: { ...PEARL, mid: hex('#9cc0f6'), rim: hex('#d4e6ff'), flow: 0.14, wobble: 0.01, levelWobble: 0.16, halo: 0.95, fil: 0.9 },
  thinking: { ...PEARL, core: hex('#355fc0'), flow: 0.55, wobble: 0.005, levelWobble: 0, halo: 0.75, fil: 1.3 },
  speaking: { ...PEARL, rim: hex('#cfe2ff'), flow: 0.18, wobble: 0.008, levelWobble: 0.11, halo: 0.85, fil: 1.0 },
  acting: { ...PEARL, flow: 0.18, wobble: 0.006, levelWobble: 0, halo: 0.62, fil: 0.9 },
  approval: { ...PEARL, hi: hex('#fff1dc'), rim: hex('#ffc46b'), flow: 0.12, wobble: 0.006, levelWobble: 0, halo: 0.8, fil: 0.8 },
  error: { core: hex('#2c3350'), mid: hex('#6f7896'), hi: hex('#ffd9da'), rim: hex('#ff7a7e'), flow: 0.05, wobble: 0.004, levelWobble: 0, halo: 0.55, fil: 0.4 }
}

// Shader constants: iridescent sheen, top light, and satellite color.
const SHEEN = { irid: [0.74, 0.68, 0.98] as RGB, top: [0.78, 0.94, 1.0] as RGB, moon: [0.78, 0.88, 1.0] as RGB }

function recolor(accent: Accent) {
  const looks = Object.fromEntries(
    Object.entries(LOOKS).map(([m, l]) => [m, { ...l, core: tint(l.core, accent), mid: tint(l.mid, accent), hi: tint(l.hi, accent), rim: tint(l.rim, accent) }])
  ) as Record<OrbMode, Look>
  return { looks, irid: tint(SHEEN.irid, accent), top: tint(SHEEN.top, accent), moon: tint(SHEEN.moon, accent) }
}

interface Props {
  mode: OrbMode
  /** Returns the current real audio level, 0..1 (mic while listening, TTS while speaking). */
  level: () => number
  moons: number
  size: number
  /** Orb radius as a fraction of half the canvas; the rest is room for the halo and satellites. */
  radius?: number
  accent: Accent
  /** Hackathon mode: a lub-dub pulse instead of a slow breath. 0 = calm, 1 = deadline imminent. */
  heartbeat?: number
  className?: string
}

export function Orb({ mode, level, moons, size, radius = 0.5, accent, heartbeat, className }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const target = useRef({ mode, moons, radius, heartbeat })
  target.current = { mode, moons, radius, heartbeat }
  const palette = useRef(recolor(accent))
  useEffect(() => {
    palette.current = recolor(accent)
  }, [accent.hue, accent.chroma])
  const levelRef = useRef(level)
  levelRef.current = level

  useEffect(() => {
    const c = canvas.current!
    const gl = c.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true })
    if (!gl) return
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s))
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'a')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    const U = {
      res: u('uRes'), time: u('uTime'), flowTime: u('uFlowTime'), level: u('uLevel'), wobble: u('uWobble'), halo: u('uHalo'), breath: u('uBreath'),
      fil: u('uFil'), core: u('uCore'), mid: u('uMid'), hi: u('uHi'), rim: u('uRim'), moons: u('uMoons'), radius: u('uRadius'), irid: u('uIrid'), top: u('uTop'), moon: u('uMoon')
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cur: Look = structuredClone(palette.current.looks[target.current.mode])
    const sheen = { irid: [...palette.current.irid] as RGB, top: [...palette.current.top] as RGB, moon: [...palette.current.moon] as RGB }
    let lvl = 0
    let flowTime = 0
    let curRadius = target.current.radius
    let errorFlash = 0
    let lastMode = target.current.mode
    let last = performance.now()
    let lastDraw = 0
    let raf = 0
    const start = last

    const mixTo = (a: number, b: number, k: number) => a + (b - a) * k
    const mixRGB = (a: RGB, b: RGB, k: number) => {
      for (let i = 0; i < 3; i++) a[i] = mixTo(a[i], b[i], k)
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const { mode: m, moons: mn, radius: rad, heartbeat: hb } = target.current
      // Idle orbs only need ~30fps; everything else runs at display rate.
      const calm = m === 'idle' && mn === 0 && lvl < 0.01 && hb === undefined
      if (calm && now - lastDraw < 32) return
      if (document.hidden) return
      lastDraw = now
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      if (m !== lastMode) {
        if (m === 'error') errorFlash = 1
        lastMode = m
      }
      errorFlash = Math.max(0, errorFlash - dt * 1.4)
      const goal = palette.current.looks[m]
      const k = 1 - Math.exp(-dt * 4)
      mixRGB(cur.core, goal.core, k)
      mixRGB(cur.mid, goal.mid, k)
      mixRGB(cur.hi, goal.hi, k)
      mixRGB(cur.rim, goal.rim, k)
      mixRGB(sheen.irid, palette.current.irid, k)
      mixRGB(sheen.top, palette.current.top, k)
      mixRGB(sheen.moon, palette.current.moon, k)
      cur.flow = mixTo(cur.flow, goal.flow, k)
      cur.wobble = mixTo(cur.wobble, goal.wobble, k)
      cur.levelWobble = mixTo(cur.levelWobble, goal.levelWobble, k)
      cur.halo = mixTo(cur.halo, goal.halo, k)
      cur.fil = mixTo(cur.fil, goal.fil, k)
      curRadius = mixTo(curRadius, rad, 1 - Math.exp(-dt * 6))

      const raw = m === 'listening' || m === 'speaking' ? Math.min(1, levelRef.current()) : 0
      lvl = raw > lvl ? mixTo(lvl, raw, 1 - Math.exp(-dt * 30)) : mixTo(lvl, raw, 1 - Math.exp(-dt * 7))
      const motion = reduced ? 0.25 : 1
      const t = (now - start) / 1000
      // Lub-dub: two quick pulses per beat, from ~54 to ~108 beats a minute as the deadline nears.
      let beat = 0
      if (hb !== undefined && !reduced) {
        const ph = (t * (0.9 + hb * 0.9)) % 1
        beat = Math.exp(-(((ph - 0.04) * 16) ** 2)) + 0.55 * Math.exp(-(((ph - 0.24) * 16) ** 2))
      }
      flowTime += dt * cur.flow * motion * (hb !== undefined ? 1.5 : 1)
      const breath = reduced ? 0 : (hb !== undefined ? beat * 0.016 : Math.sin(t * 0.9) * 0.012) + (m === 'approval' ? Math.sin(t * 3) * 0.01 : 0)

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.round(c.clientWidth * dpr)
      const h = Math.round(c.clientHeight * dpr)
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      gl.viewport(0, 0, w, h)
      gl.uniform2f(U.res, w, h)
      gl.uniform1f(U.time, t * motion)
      gl.uniform1f(U.flowTime, flowTime)
      gl.uniform1f(U.level, lvl)
      gl.uniform1f(U.wobble, (cur.wobble + cur.levelWobble * lvl) * motion)
      gl.uniform1f(U.halo, cur.halo + lvl * 0.45 + errorFlash * 0.6 + beat * 0.4)
      gl.uniform1f(U.breath, breath)
      gl.uniform1f(U.fil, cur.fil)
      gl.uniform3fv(U.core, cur.core)
      gl.uniform3fv(U.mid, cur.mid)
      gl.uniform3fv(U.hi, cur.hi)
      gl.uniform3fv(U.rim, cur.rim)
      gl.uniform3fv(U.irid, sheen.irid)
      gl.uniform3fv(U.top, sheen.top)
      gl.uniform3fv(U.moon, sheen.moon)
      gl.uniform1i(U.moons, mn)
      gl.uniform1f(U.radius, curRadius)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])

  return <canvas ref={canvas} className={className} style={{ width: size, height: size }} aria-hidden="true" />
}
