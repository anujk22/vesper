import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTask, ModelChoice, OrbMode, Settings, Turn, VoiceHealth } from '../../core/types'
import { Search } from './components/icons'
import { UsageChips, useUsage } from './components/Usage'
import { AccountMenu, AttentionMenu, ModelMenu, type AttentionItem } from './components/HeaderMenus'
import { allowanceNudge } from '../../core/usage'
import { Orb } from './orb/Orb'
import { Listener, Speaker } from './voice'
import { WakeListener } from './wake'
import { levelPatch } from './components/ThinkingRail'
import { Talk } from './views/Talk'
import { Agents } from './views/Agents'
import { Memory } from './views/Memory'
import { SettingsView } from './views/Settings'
import { Relays } from './views/Relays'
import { History } from './views/History'
import type { TerminalInfo } from '../../core/terminal'
import type { RelayRun } from '../../core/relay'
import type { Swarm } from '../../core/swarm'
import { BASE_HUE, DEFAULT_ACCENT, type Accent } from '../../core/color'
import { formatLeft, hackStatus, type Hackathon } from '../../core/hackathon'

const LOCKED_IN: Accent = { hue: 25, chroma: 1.6 }

export type View = 'talk' | 'agents' | 'history' | 'relays' | 'memory' | 'settings'
const NAV: [View, string][] = [
  ['talk', 'Talk'],
  ['agents', 'Work'],
  ['history', 'History'],
  ['relays', 'Hackathon'],
  ['memory', 'Memory']
]
export interface Ctx {
  activeProject?: string
  brain?: ModelChoice
  brainLabel?: string
}
export interface Shot {
  path: string
  preview: string
}

const ACTIVE = new Set(['starting', 'investigating', 'editing', 'testing', 'awaiting-approval'])

/** A short soft tone: high when Vesper starts listening, lower when it is done. */
function cue(freq: number) {
  try {
    const ctx = new AudioContext()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = freq
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.2)
    o.onended = () => void ctx.close()
  } catch {
    // No audio output is not worth a notice.
  }
}

export function App() {
  const api = window.bluevis
  const [turns, setTurns] = useState<Turn[]>([])
  const [swarms, setSwarms] = useState<Record<string, Swarm>>({})
  const [tasks, setTasks] = useState<Record<string, AgentTask>>({})
  const [busy, setBusy] = useState(false)
  const [ctx, setCtx] = useState<Ctx>({})
  const [settings, setSettings] = useState<Settings | null>(null)
  const [voice, setVoice] = useState<VoiceHealth>({ state: 'off', detail: '' })
  const [winMode, setWinMode] = useState<'compact' | 'expanded'>('expanded')
  const [view, setView] = useState<View>('talk')
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [shot, setShot] = useState<Shot | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [focusTask, setFocusTask] = useState<string | null>(null)
  const [terms, setTerms] = useState<TerminalInfo[]>([])
  const [termFocus, setTermFocus] = useState<string | null>(null)
  const usage = useUsage()
  const [searchFocus, setSearchFocus] = useState(0)
  const [relays, setRelays] = useState<Record<string, RelayRun>>({})
  const [hacks, setHacks] = useState<Hackathon[]>([])
  const [focusRelay, setFocusRelay] = useState<string | null>(null)

  const hack = hacks.find((h) => h.active)
  // Hackathon mode locks the app into red without touching the saved accent.
  const accent = hack ? LOCKED_IN : (settings?.accent ?? DEFAULT_ACCENT)
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    if (!hack) return
    const id = setInterval(() => setClock(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [hack?.id])
  // The heartbeat quickens over the last twelve hours before the deadline.
  const behind = hack ? hackStatus(hack, clock).behind.length : 0
  const nudge = allowanceNudge(usage.codex, Date.now())
  const attention: AttentionItem[] = [
    ...(hack && behind ? [{ key: 'hack-behind', label: `Behind schedule · ${hack.title}`, detail: hackStatus(hack, clock).behind.map((m) => m.title).join(', '), go: () => (setFocusRelay(hack.id), setView('relays')), tone: 'warm' as const }] : []),
    ...(nudge
      ? [{ key: 'allowance', label: `${nudge.left}% of your Codex week resets in ${nudge.hours}h`, detail: 'Start an agent in Work to use it before it resets.', go: () => setView('agents'), tone: 'warm' as const }]
      : [])
  ]
  const urgency = hack ? Math.min(1, Math.max(0, 1 - (hack.deadline - clock) / (12 * 3600_000))) : 0
  useEffect(() => {
    // The stylesheet rotates its blues by --dh and scales their chroma by --c; both transition smoothly.
    document.documentElement.style.setProperty('--dh', String((((accent.hue - BASE_HUE) % 360) + 540) % 360 - 180))
    document.documentElement.style.setProperty('--c', String(accent.chroma))
  }, [accent.hue, accent.chroma])

  const listener = useRef<Listener | null>(null)
  const speaker = useMemo(() => new Speaker((text) => api.voice.tts(text) as Promise<ArrayBuffer>), [api])
  const voiceRef = useRef(voice)
  voiceRef.current = voice

  useEffect(() => {
    speaker.onChange = setSpeaking
    void api.chat.turns().then((t) => setTurns(t as Turn[]))
    void api.tasks.list().then((l) => setTasks(Object.fromEntries((l as AgentTask[]).map((t) => [t.id, t]))))
    void api.chat.context().then((c) => setCtx(c as Ctx))
    void api.relays.list().then((l) => setRelays(Object.fromEntries((l as RelayRun[]).map((r) => [r.id, r]))))
    void api.hackathons.list().then((l) => setHacks(l as Hackathon[]))
    void api.settings.get().then((s) => setSettings(s as Settings))
    void api.terminals.list().then((l) => setTerms(l as TerminalInfo[]))
    void api.voice.health().then((h) => setVoice(h as VoiceHealth))
    void api.window.getMode().then((m) => setWinMode(m as 'compact' | 'expanded'))
    const offs = [
      api.on('turn', (t) =>
        setTurns((prev) => {
          const turn = t as Turn
          const i = prev.findIndex((x) => x.id === turn.id)
          if (i < 0) return [...prev, turn]
          const next = prev.slice()
          next[i] = turn
          return next
        })
      ),
      api.on('reset', () => (setTurns([]), setSwarms({}))),
      api.on('swarm', (s) => setSwarms((prev) => ({ ...prev, [(s as Swarm).id]: s as Swarm }))),
      api.on('hackathons', (l) => setHacks(l as Hackathon[])),
      api.on('relay', (r) => setRelays((prev) => ({ ...prev, [(r as RelayRun).id]: r as RelayRun }))),
      api.on('busy', (b) => setBusy(b as boolean)),
      api.on('task', (t) => setTasks((prev) => ({ ...prev, [(t as AgentTask).id]: t as AgentTask }))),
      api.on('context', (c) => setCtx(c as Ctx)),
      api.on('settings', (s) => setSettings(s as Settings)),
      api.on('term:list', (l) => setTerms(l as TerminalInfo[])),
      api.on('voice:health', (h) => setVoice(h as VoiceHealth)),
      api.on('window:mode', (m) => setWinMode(m as 'compact' | 'expanded')),
      api.on('speak', (_id, text) => {
        if (voiceRef.current.state === 'ready') void speaker.speak(text as string).catch(() => setNotice('Speech failed. Replies stay on screen.'))
      }),
      api.on('speak-chunk', (id, text) => {
        if (voiceRef.current.state === 'ready') void speaker.append(id as string, text as string).catch(() => setNotice('Speech failed. Replies stay on screen.'))
      }),
      api.on('speech:stop', () => speaker.stop()),
      // The pill's close button: drop what is being heard, or stop talking.
      api.on('pill:close', () => {
        if (listener.current) listener.current.cancel()
        else speaker.stop()
      }),
      api.on('hotkey:talk', () => toggleListen()),
      api.on('hotkey:dictate', () => void dictateRef.current()),
      api.on('screen:attached', (s) => {
        const r = s as Shot | { error: string }
        if ('error' in r) setNotice(r.error)
        else setShot(r)
        setView('talk')
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const send = useCallback(
    async (text: string, via: 'voice' | 'text' = 'text') => {
      const t = text.trim()
      if (!t) return
      speaker.stop()
      setNotice(null)
      const attached = shot
      setShot(null)
      setView('talk')
      await api.chat.send(t, { via, screenshot: attached?.path })
    },
    [api, shot, speaker]
  )
  const sendRef = useRef(send)
  sendRef.current = send

  // Morning brief: the first time the full window is up between 5am and noon, once per day.
  useEffect(() => {
    if (!settings?.morningBrief || winMode !== 'expanded') return
    const now = new Date()
    const today = now.toDateString()
    if (now.getHours() < 5 || now.getHours() >= 12) return
    try {
      if (localStorage.getItem('bluevis:lastBrief') === today) return
      localStorage.setItem('bluevis:lastBrief', today)
    } catch {
      return
    }
    void sendRef.current('Brief me')
  }, [settings?.morningBrief, winMode])

  // The pill at the bottom of the screen, in the current accent; remembers what it shows so timers do not hide the wrong state.
  const accentRef = useRef(accent)
  accentRef.current = accent
  const pillState = useRef('hidden')
  const showPill = useCallback(
    (p: { state: string; text?: string; startedAt?: number }) => {
      pillState.current = p.state
      api.overlay.set({ ...p, accent: accentRef.current })
    },
    [api]
  )

  /** Record one utterance and transcribe it locally. Null when nothing usable was said. */
  const capture = useCallback(
    async (opts: { silence?: number; maxSeconds?: number } = {}, pill?: 'listening' | 'dictating'): Promise<string | null> => {
      if (voiceRef.current.state !== 'ready') {
        setNotice(voiceRef.current.state === 'starting' ? 'Voice is still loading. Type for now, or try again in a moment.' : `Voice is unavailable: ${voiceRef.current.detail || 'turn it on in Settings'}.`)
        return null
      }
      speaker.stop()
      const l = new Listener()
      listener.current = l
      setListening(true)
      // Voice started from anywhere (wake word, dictation shortcut) shows the pill with live bars and a timer.
      let pump: number | undefined
      if (pill) {
        showPill({ state: pill, startedAt: Date.now() })
        pump = window.setInterval(() => api.overlay.level(l.level), 50)
      }
      const res = await l.listen(opts)
      clearInterval(pump)
      listener.current = null
      setListening(false)
      if ('cancelled' in res) {
        if (pill) showPill({ state: 'hidden' })
        if (res.reason === 'error') setNotice(res.message ?? 'Microphone unavailable')
        return null
      }
      if (pill) showPill({ state: 'transcribing' })
      try {
        const text = ((await api.voice.stt(res.wav)) as string).trim() || null
        if (pill && !text) showPill({ state: 'hidden' })
        return text
      } catch (e) {
        if (pill) showPill({ state: 'hidden' })
        setNotice(`Transcription failed: ${(e as Error).message}`)
        return null
      }
    },
    [api, speaker, showPill]
  )
  /** Show what was heard in the pill for a moment, then tuck it away. */
  const heard = useCallback(
    (text: string) => {
      showPill({ state: 'heard', text })
      window.setTimeout(() => pillState.current === 'heard' && showPill({ state: 'hidden' }), 1800)
    },
    [showPill]
  )

  // When Vesper talks while its window is out of sight, the orb comes to the pill and moves with its voice.
  useEffect(() => {
    if (speaking && document.visibilityState === 'hidden' && !listener.current) {
      showPill({ state: 'speaking' })
      const id = window.setInterval(() => api.overlay.level(speaker.level()), 50)
      return () => {
        clearInterval(id)
        if (pillState.current === 'speaking') showPill({ state: 'hidden' })
      }
    }
  }, [speaking, api, speaker, showPill])

  const toggleListen = useCallback(async () => {
    if (listener.current) return listener.current.stop()
    const text = await capture()
    if (text) await sendRef.current(text, 'voice')
  }, [capture])

  // Dictation types into whatever app has focus. The shortcut starts it and, pressed again, ends it early.
  const dictate = useCallback(
    async (said?: string) => {
      if (!said && listener.current) return listener.current.stop()
      if (!said) cue(880)
      const text = said ?? (await capture({ silence: 2, maxSeconds: 180 }, 'dictating'))
      if (!text) return
      cue(660)
      heard(text)
      await api.chat.dictate(text).catch((e: Error) => setNotice(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
    },
    [api, capture, heard]
  )
  const dictateRef = useRef(dictate)
  dictateRef.current = dictate

  // "Hey Vesper": "transcribe ..." dictates, anything else is a command; "Vesper" alone waits for one.
  const onWake = useCallback(
    async (command: string) => {
      cue(880)
      const said = command || (await capture({}, 'listening'))
      if (!said) return
      const t = said.match(/^(?:transcribe|dictate|type(?: this)?)\b[\s:,.-]*(.*)$/is)
      if (t) return dictate(t[1].trim() || undefined)
      heard(said)
      await sendRef.current(said, 'voice')
    },
    [capture, dictate, heard]
  )
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake
  const wake = useRef<WakeListener | null>(null)
  useEffect(() => {
    // On by default for as long as Vesper runs; Settings can turn it off.
    const want = !!settings && settings.wake !== false && voice.state === 'ready'
    if (want && !wake.current) {
      const w = new WakeListener(
        async (wav) => (await api.voice.stt(wav)) as string,
        (c) => void onWakeRef.current(c),
        () => !!listener.current || speaker.speaking
      )
      wake.current = w
      w.start().catch((e: Error) => {
        wake.current = null
        setNotice(`Wake listening is off: ${e.message}`)
      })
    } else if (!want && wake.current) {
      wake.current.stop()
      wake.current = null
    }
  }, [api, speaker, settings?.wake, voice.state])

  const taskList = useMemo(() => Object.values(tasks).sort((a, b) => b.startedAt - a.startedAt), [tasks])
  const relayList = useMemo(() => Object.values(relays).sort((a, b) => b.startedAt - a.startedAt), [relays])
  const relaysRunning = relayList.filter((r) => r.status === 'running').length
  // Satellites count every live worker: agents and relays.
  const running = taskList.filter((t) => ACTIVE.has(t.status))
  const workers = running.length + relaysRunning
  const lastVesper = [...turns].reverse().find((t) => t.speaker === 'bluevis')
  const pendingProposal = turns.some((t) => t.action?.state === 'proposed')
  const [errorFresh, setErrorFresh] = useState(false)
  useEffect(() => {
    if (!lastVesper?.error) return setErrorFresh(false)
    setErrorFresh(true)
    const id = setTimeout(() => setErrorFresh(false), 4000)
    return () => clearTimeout(id)
  }, [lastVesper?.id, lastVesper?.error])

  const orbMode: OrbMode = listening
    ? 'listening'
    : speaking
      ? 'speaking'
      : busy
        ? 'thinking'
        : errorFresh
          ? 'error'
          : pendingProposal
            ? 'approval'
            : workers
              ? 'acting'
              : 'idle'

  const level = useCallback(() => (listener.current ? listener.current.level : speaker.level()), [speaker])

  const openTask = (id: string) => {
    setFocusTask(id)
    setView('agents')
  }

  if (winMode === 'compact') {
    return (
      <div className="compact">
        <button className="stage-orb" onClick={() => api.window.setMode('expanded')} aria-label="Open Vesper">
          <Orb mode={orbMode} level={level} moons={Math.min(workers, 4)} size={176} radius={0.6} accent={accent} heartbeat={hack ? urgency : undefined} />
        </button>
        {orbMode !== 'idle' && <span className="compact-dot mono">{caption(orbMode, workers)}</span>}
      </div>
    )
  }

  /** Continue a Codex or Claude thread interactively in a Work terminal. */
  const openTerminal = async (o: { cwd: string; title: string; command?: string }) => {
    const t = (await api.terminals.create(o)) as TerminalInfo
    setTermFocus(t.id)
    setView('agents')
  }
  const openResume = (provider: 'codex' | 'claude', id: string, cwd: string, title: string) =>
    openTerminal({ cwd, title, command: provider === 'codex' ? `codex resume ${id}` : `claude --resume ${id}` })

  const empty = view === 'talk' && turns.length === 0
  return (
    <div className="shell" data-empty={empty}>
      <header className="header glass">
        <div className="header-left">
          <div className="wordmark">vesper</div>
          <UsageChips usage={usage} onOpen={() => setView('settings')} />
        </div>
        <nav className="nav" aria-label="Sections">
          {NAV.map(([v, name]) => (
            <button key={v} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>
              {name}
              {v === 'agents' && running.length > 0 && <span className="count">{running.length}</span>}
              {v === 'relays' && relaysRunning > 0 && <span className="count">{relaysRunning}</span>}
            </button>
          ))}
        </nav>
        <div className="header-right">
          {hack && (
            <button
              className="chip hack-chip"
              data-behind={behind > 0}
              title={`${hack.title}: ${behind ? `${behind} checkpoint${behind > 1 ? 's' : ''} overdue, ` : ''}submission deadline`}
              onClick={() => (setFocusRelay(hack.id), setView('relays'))}
            >
              <span className="dot" />
              {behind > 0 && `${behind} behind · `}
              {formatLeft(hack.deadline - clock)}
            </button>
          )}
          {ctx.activeProject && (
            <button className="chip" title="Active project. Click to clear." onClick={() => api.projects.activate()}>
              <span className="dot" />
              {ctx.activeProject}
            </button>
          )}
          <ModelMenu settings={settings} label={ctx.brainLabel} usage={usage} onChange={setSettings} />
          <button
            className="icon-btn"
            aria-label="Search your vault"
            title="Search your vault"
            onClick={() => {
              setSearchFocus((n) => n + 1)
              setView('memory')
            }}
          >
            <Search />
          </button>
          <AttentionMenu
            turns={turns}
            tasks={taskList}
            relays={relayList}
            extra={attention}
            onGo={(where, id) => {
              if (where === 'agents' && id) setFocusTask(id)
              if (where === 'relays' && id) setFocusRelay(id)
              setView(where)
            }}
          />
          <AccountMenu onSettings={() => setView('settings')} />
        </div>
      </header>
      <main className="view" key={view}>
        {view === 'talk' && (
          <Talk
            turns={turns}
            tasks={tasks}
            busy={busy}
            orb={<Orb mode={orbMode} level={level} moons={Math.min(workers, 4)} size={empty ? 460 : 440} radius={empty ? 0.43 : 0.52} accent={accent} heartbeat={hack ? urgency : undefined} className="stage-orb" />}
            caption={caption(orbMode, workers, ctx.brainLabel)}
            live={orbMode !== 'idle'}
            listening={listening}
            shot={shot}
            notice={notice}
            voice={voice}
            onSend={send}
            onListen={toggleListen}
            onOrb={() => (speaking ? speaker.stop() : toggleListen())}
            onShot={async () => {
              if (shot) {
                void api.screen.discard(shot.path)
                return setShot(null)
              }
              const r = (await api.screen.capture()) as Shot | { error: string }
              if ('error' in r) setNotice(r.error)
              else setShot(r)
            }}
            onStop={() => {
              speaker.stop()
              void api.chat.stop()
            }}
            onOpenTask={openTask}
            relays={relays}
            narrate={settings?.voice.narrate ?? 'brief'}
            onNarrate={async (narrate) => {
              if (!settings) return
              if (narrate === 'mute') speaker.stop()
              setSettings((await api.settings.set({ voice: { ...settings.voice, narrate } })) as Settings)
            }}
            onOpenChat={async (id) => {
              speaker.stop()
              setSwarms({})
              setTurns((await api.chat.open(id)) as Turn[])
              const list = (await api.swarm.list()) as Swarm[]
              setSwarms(Object.fromEntries(list.map((s) => [s.id, s])))
            }}
            onNewChat={() => void api.chat.reset()}
            settings={settings}
            swarms={Object.values(swarms)}
            onThink={async (level) => settings && setSettings((await api.settings.set(levelPatch(settings, level))) as Settings)}
            onOpenRelay={(id) => {
              setFocusRelay(id)
              setView('relays')
            }}
          />
        )}
        {view === 'history' && <History tasks={taskList} onOpenTerminal={openResume} />}
        {view === 'agents' && (
          <Agents
            tasks={taskList}
            focus={focusTask}
            onFocus={setFocusTask}
            settings={settings}
            terms={terms}
            termFocus={termFocus}
            onTermFocus={setTermFocus}
            onTakeOver={(t) => t.sessionId && openResume(t.choice.provider as 'codex' | 'claude', t.sessionId, t.cwd, t.title)}
          />
        )}
        {view === 'relays' && (
          <Relays
            runs={relayList}
            hacks={hacks}
            tasks={taskList}
            focus={focusRelay}
            onFocus={setFocusRelay}
            onOpenTerminal={(cwd, title) => openTerminal({ cwd, title })}
            onOpenTask={(id) => {
              setTermFocus(null)
              setFocusTask(id)
              setView('agents')
            }}
          />
        )}
        {view === 'memory' && <Memory searchFocus={searchFocus} />}
        {view === 'settings' && settings && <SettingsView settings={settings} voice={voice} usage={usage} onChange={setSettings} />}
      </main>
    </div>
  )
}

function caption(mode: OrbMode, running: number, model?: string): string {
  switch (mode) {
    case 'listening':
      return 'Listening'
    case 'speaking':
      return 'Speaking'
    case 'thinking':
      return model ? `Thinking · ${model}` : 'Thinking'
    case 'approval':
      return 'Waiting for your go-ahead'
    case 'error':
      return 'Something failed'
    case 'acting':
      return `${running} worker${running > 1 ? 's' : ''} running`
    default:
      return ''
  }
}
