import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, systemPreferences, Tray } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelChoice, Settings } from '../core/types'
import { Brain, label } from './brain'
import { Importer } from './importer'
import { RelayManager } from './relay'
import { discoverProjects } from './projects'
import { HistoryService } from './history'
import { TerminalManager } from './terminals'
import { HackathonManager } from './hackathon'
import { onRateLimits, providerHealth } from './providers'
import { UsageService } from './usage'
import { getSecret, setSecret } from './secrets'
import { DEFAULT_CANVAS, signInCanvas, signOutCanvas, verifyCanvas } from './canvas'
import { getSettings, updateSettings } from './settings'
import { adoptLoginShellPath, run } from './shell'
import { TaskManager } from './tasks'
import { Vault } from './vault'
import { VoiceService } from './voice'
import { ensureSplash, managePower, stopSplash } from './splash'
import { startIdleWork } from './idle'
import { Shots } from './shots'
import { self as macSelf } from './mac'

type Mode = 'compact' | 'expanded'

// Isolated profile (settings + vault) for tests and experiments; never touches the real vault.
if (process.env.BLUEVIS_PROFILE_DIR) app.setPath('userData', process.env.BLUEVIS_PROFILE_DIR)
// The app was called Bluevis; its own data (settings, chats, sign-ins) moves to the new name once.
// Electron creates the new folder before this runs, so items move one by one; browser caches stay behind.
else {
  const legacy = join(app.getPath('appData'), 'Bluevis')
  const current = app.getPath('userData')
  if (existsSync(join(legacy, 'settings.json')) && !existsSync(join(current, 'settings.json'))) {
    mkdirSync(current, { recursive: true })
    for (const f of readdirSync(legacy))
      if (/\.json$|^(chats|workspace|Hackathons|Partitions)$/.test(f) && !existsSync(join(current, f))) renameSync(join(legacy, f), join(current, f))
  }
}

// One Vesper per profile: launching it again brings the running one forward instead.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => setMode('expanded'))

let win: BrowserWindow | null = null
let takeShot: () => Promise<boolean> = async () => false
let mode: Mode = 'expanded'
let tray: Tray | null = null
// Events can fire during quit, after the window is gone; drop them instead of throwing.
const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
}

function boundsFor(m: Mode) {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (m === 'compact') {
    const size = 184
    return { width: size, height: size, x: workArea.x + workArea.width - size - 20, y: workArea.y + workArea.height - size - 20 }
  }
  const width = Math.min(1280, workArea.width - 80)
  const height = Math.min(820, workArea.height - 60)
  return { width, height, x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + (workArea.height - height) / 2) }
}

function setMode(m: Mode, focus = true) {
  if (!win) return
  mode = m
  send('window:mode', m)
  win.setAlwaysOnTop(m === 'compact', 'floating')
  win.setWindowButtonVisibility(m === 'expanded')
  win.setBounds(boundsFor(m), true)
  win.setResizable(m === 'expanded')
  if (!win.isVisible()) win.show()
  if (focus && m === 'expanded') win.focus()
}

let overlay: BrowserWindow | null = null
let overlayState: { state: string } = { state: 'hidden' }
/**
 * The listening pill: a tiny always-on-top window at the bottom of the screen the pointer is on.
 * It never takes focus (dictation types into whatever app has it) and lets clicks through, except
 * on its close button.
 */
function setOverlay(p: { state: string; text?: string; startedAt?: number; accent?: { hue: number; chroma: number } }) {
  overlayState = p
  if (p.state === 'hidden') {
    overlay?.webContents.send('overlay', p)
    setTimeout(() => overlay?.hide(), 300)
    return
  }
  if (!overlay || overlay.isDestroyed()) {
    overlay = new BrowserWindow({
      width: 600,
      height: 64,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      acceptFirstMouse: true,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, backgroundThrottling: false }
    })
    overlay.setIgnoreMouseEvents(true, { forward: true })
    overlay.setAlwaysOnTop(true, 'screen-saver')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    if (process.env.ELECTRON_RENDERER_URL) void overlay.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay.html`)
    else void overlay.loadFile(join(__dirname, '../renderer/overlay.html'))
  }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  overlay.setBounds({ x: Math.round(wa.x + (wa.width - 600) / 2), y: wa.y + wa.height - 64 - 20, width: 600, height: 64 })
  // A freshly created pill asks for the current state once it is listening ('overlay:ready').
  overlay.webContents.send('overlay', p)
  overlay.showInactive()
}

let dictationKey: string | null = null
/** The dictation shortcut is configurable; rebinding releases the old one. It never shows the window, so focus stays where the text goes. */
function bindDictation() {
  if (dictationKey) globalShortcut.unregister(dictationKey)
  dictationKey = getSettings().dictationHotkey || 'Alt+Shift+D'
  try {
    if (!globalShortcut.register(dictationKey, () => send('hotkey:dictate'))) dictationKey = null
  } catch {
    dictationKey = null
  }
}

function createWindow() {
  win = new BrowserWindow({
    ...boundsFor('expanded'),
    minWidth: 160,
    minHeight: 160,
    // Native traffic lights sit inside the glass header; the rest of the chrome is ours.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 32, y: 34 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, backgroundThrottling: false }
  })
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Capture the main display to `path` without Vesper in the shot. */
async function grab(path: string): Promise<boolean> {
  const wasVisible = win?.isVisible()
  win?.setOpacity(0)
  await new Promise((r) => setTimeout(r, 120))
  const r = await run('screencapture', ['-x', '-m', '-t', 'jpg', path])
  win?.setOpacity(1)
  if (wasVisible === false) win?.hide()
  return r.code === 0 && existsSync(path)
}

const CAPTURE_FAILED = 'Screen capture failed. Allow Vesper under System Settings → Privacy & Security → Screen Recording.'

/** Capture the main display without Vesper in the shot. Returns the file path and a preview data URL. */
async function captureScreen(): Promise<{ path: string; preview: string } | { error: string }> {
  const path = join(app.getPath('temp'), `bluevis-screen-${Date.now()}.jpg`)
  if (!(await grab(path))) return { error: CAPTURE_FAILED }
  const preview = `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`
  return { path, preview }
}

/** Menu bar presence: always there, so Vesper can be found, summoned and quit. */
function createTray(openVault: () => void) {
  const icon = nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'), 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Vesper')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Vesper', accelerator: 'Alt+Space', click: () => setMode('expanded') },
      { label: 'Talk', accelerator: 'Alt+Shift+Space', click: () => (setMode('expanded'), send('hotkey:talk')) },
      { label: 'Shrink to orb', click: () => setMode('compact', false) },
      { label: 'Hide', click: () => win?.hide() },
      { type: 'separator' },
      { label: 'Open vault', click: openVault },
      { label: 'Launch at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, enabled: app.isPackaged, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { type: 'separator' },
      { label: 'Quit Vesper', accelerator: 'Cmd+Q', click: () => app.quit() }
    ])
  )
}

app.whenReady().then(async () => {
  await adoptLoginShellPath()
  const settings = getSettings()
  const vault = new Vault(settings.vaultPath)
  await vault.ensure()

  const voice = new VoiceService((h) => {
    send('voice:health', h)
    if (h.state === 'ready') void vault.refreshEmbeddings()
  }, () => getSettings().voice.ttsVoice)
  vault.embedder = (texts, query) => voice.embed(texts, query)
  let brain: Brain
  const tasks = new TaskManager(
    (t) => send('task', t),
    (t) => brain.onTaskFinished(t)
  )
  brain = new Brain(vault, tasks, {
    turn: (t) => send('turn', t),
    reset: () => send('reset'),
    busy: (b) => send('busy', b),
    speak: (id, text) => getSettings().voice.narrate !== 'mute' && send('speak', id, text),
    speakChunk: (id, text) => getSettings().voice.narrate !== 'mute' && send('speak-chunk', id, text),
    stopSpeech: () => send('speech:stop'),
    context: (c) => send('context', { ...c, brainLabel: label(c.brain) }),
    settings: (s) => send('settings', s),
    show: () => setMode('expanded'),
    screenshot: () => takeShot(),
    swarm: (s) => send('swarm', s)
  })
  macSelf.place = (r) => {
    if (mode !== 'expanded') setMode('expanded', false)
    win?.setBounds(r, true)
  }
  brain.chats.embedder = (texts, query) => voice.embed(texts, query)

  const importer = new Importer(
    vault,
    (s) => send('import:state', s),
    (p) => send('import:proposals', p)
  )
  ipcMain.handle('import:state', () => importer.state)
  ipcMain.handle('import:proposals', () => importer.list())
  ipcMain.handle('import:chatgpt', async (_e, path?: string) => {
    if (path) return void importer.importChatGPT(path)
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose your ChatGPT export',
      message: 'Select the .zip from ChatGPT (Settings → Data controls → Export) or its conversations.json',
      properties: ['openFile'],
      filters: [{ name: 'ChatGPT export', extensions: ['zip', 'json'] }]
    })
    if (!r.canceled && r.filePaths[0]) void importer.importChatGPT(r.filePaths[0])
    return !r.canceled
  })
  ipcMain.handle('import:text', (_e, text: string) => importer.importText(text))
  ipcMain.handle('import:accept', (_e, key: string, edited?: { title?: string; text?: string }) => importer.accept(key, edited))
  ipcMain.handle('import:reject', (_e, key: string) => importer.reject(key))
  ipcMain.handle('import:stop', () => importer.stop())

  const relays = new RelayManager(
    vault,
    (r) => send('relay', r),
    (r) => brain.onRelayFinished(r)
  )
  brain.relays = relays
  ipcMain.handle('relays:list', () => relays.list())
  ipcMain.handle('relays:start', (_e, url: string, note?: string) => relays.start(url, note))
  ipcMain.handle('relays:stop', (_e, id: string) => relays.stop(id))

  const usage = new UsageService((u) => send('usage', u))
  onRateLimits((raw) => usage.recordClaude(raw))
  ipcMain.handle('usage:get', () => usage.get())
  // Claude only reports limits during a run; if the last reading is old, take one tiny reading at launch.
  const lastClaude = usage.get().claude
  if (!lastClaude || Date.now() - lastClaude.observedAt > 3 * 3600_000) usage.refreshClaude(join(app.getPath('userData'), 'workspace')).catch(() => {})
  ipcMain.handle('usage:refresh-claude', async () => {
    await usage.refreshClaude(join(app.getPath('userData'), 'workspace'))
    return usage.get()
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))

  ipcMain.handle('chat:send', (_e, text: string, opts: { via: 'voice' | 'text'; screenshot?: string }) => brain.handle(text, opts))
  ipcMain.handle('chat:stop', () => brain.stop())
  ipcMain.handle('chat:reset', () => brain.reset())
  ipcMain.handle('chat:turns', () => brain.turns)
  ipcMain.handle('chat:list', () => brain.chats.list())
  ipcMain.handle('swarm:list', () => brain.swarms.forChat(brain.currentChat))
  ipcMain.handle('swarm:ask', (_e, swarmId: string, agentId: string, text: string) => brain.swarms.ask(swarmId, agentId, text))
  ipcMain.handle('swarm:stop', (_e, swarmId: string) => brain.swarms.stop(swarmId))
  ipcMain.on('overlay', (_e, p: Parameters<typeof setOverlay>[0]) => setOverlay(p))
  ipcMain.on('overlay:ready', () => overlay?.webContents.send('overlay', overlayState))
  // The close button takes the mouse only while hovered; clicking it cancels listening or speech.
  ipcMain.on('overlay:hover', (_e, on: boolean) => overlay?.setIgnoreMouseEvents(!on, { forward: true }))
  ipcMain.on('overlay:close', () => send('pill:close'))
  ipcMain.on('overlay:level', (_e, level: number) => overlay?.webContents.send('overlay:level', level))
  ipcMain.handle('dictate:type', (_e, text: string) => brain.dictate(text))
  ipcMain.handle('chat:open', (_e, id: string) => brain.openChat(id))
  ipcMain.handle('chat:context', () => ({ ...brain.context(), brainLabel: label(brain.context().brain) }))
  ipcMain.handle('action:approve', (_e, id: string, project?: string, prompt?: string) => brain.approveAction(id, project, prompt))
  ipcMain.handle('action:dismiss', (_e, id: string) => brain.dismissAction(id))
  ipcMain.handle('memory:undo', (_e, id: string) => brain.undoMemory(id))
  ipcMain.handle('tasks:list', () => tasks.list())
  const hackathons = new HackathonManager(tasks, vault, (l) => send('hackathons', l))
  brain.hackathons = hackathons
  ipcMain.handle('hack:list', () => hackathons.list())
  ipcMain.handle('hack:from-relay', (_e, relayId: string) => {
    const r = relays.get(relayId)
    if (!r) throw new Error('Unknown relay')
    return hackathons.fromRelay(r)
  })
  ipcMain.handle('hack:update', (_e, id: string, patch: Parameters<HackathonManager['update']>[1]) => hackathons.update(id, patch))
  ipcMain.handle('hack:scaffold', (_e, id: string) => hackathons.scaffold(id))
  ipcMain.handle('hack:agents', (_e, id: string, ids: string[], agent: 'codex' | 'claude') => hackathons.agents(id, ids, agent))
  ipcMain.handle('hack:kit', (_e, id: string) => hackathons.kit(id))


  const terminals = new TerminalManager(send)
  brain.terminals = terminals
  ipcMain.handle('term:create', (_e, o: { cwd?: string; title?: string; command?: string; cols?: number; rows?: number }) => terminals.create(o))
  ipcMain.handle('term:list', () => terminals.list())
  ipcMain.handle('term:replay', (_e, id: string) => terminals.replay(id))
  ipcMain.on('term:write', (_e, id: string, data: string) => terminals.write(id, data))
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows))
  ipcMain.on('term:focus', (_e, id: string | null) => terminals.focus(id))
  ipcMain.handle('term:kill', (_e, id: string) => terminals.kill(id))
  app.on('will-quit', () => terminals.killAll())

  const history = new HistoryService()
  ipcMain.handle('history:list', () => history.list())
  ipcMain.handle('history:read', (_e, file: string) => history.read(file))
  // Continuing a past thread runs as an agent task in that thread's folder, so its progress is tracked like any other.
  ipcMain.handle('history:continue', (_e, file: string, prompt: string) => {
    const t = history.list().find((x) => x.file === file)
    if (!t) throw new Error('Unknown thread')
    const { model, effort } = history.read(file)
    const choice: ModelChoice = t.provider === 'codex' ? { provider: 'codex', model: model ?? 'gpt-6-sol', effort: (effort as ModelChoice['effort']) ?? 'medium' } : { provider: 'claude', model: model ?? 'opus' }
    return tasks.start({ title: t.title, prompt, choice, cwd: t.cwd, sessionId: t.id })
  })
  ipcMain.handle('tasks:start', (_e, t: { agent: 'codex' | 'claude'; project: string; prompt: string }) =>
    brain.delegate({ kind: 'delegate', agent: t.agent, project: t.project, prompt: t.prompt, state: 'proposed' }, undefined, true)
  )
  ipcMain.handle('tasks:stop', (_e, id: string) => tasks.stop(id))
  ipcMain.handle('projects:list', (_e, force?: boolean) => discoverProjects(getSettings().projectRoots, force, vault.projectLinks()))
  ipcMain.handle('project:activate', (_e, name?: string) => brain.setActiveProject(name))
  ipcMain.handle('project:reveal', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('memory:atlas', () => vault.atlas())
  ipcMain.handle('memory:revert', (_e, hash: string) => vault.undo(hash))
  ipcMain.handle('memory:search', (_e, q: string, strict?: boolean) => vault.search(q, { allowPrivate: true, limit: strict ? 4 : 8, strict }))
  ipcMain.handle('memory:read', (_e, rel: string) => vault.read(rel))
  ipcMain.handle('memory:open', async (_e, rel?: string) => {
    const target = rel ? join(vault.root, rel) : vault.root
    const obsidian = existsSync('/Applications/Obsidian.app')
    if (obsidian) return shell.openExternal(`obsidian://open?path=${encodeURIComponent(target)}`)
    return rel ? shell.openPath(target) : shell.openPath(vault.root)
  })
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = updateSettings(patch)
    // Every view holds settings; send the new ones so none acts on a stale copy.
    send('settings', s)
    send('context', { ...brain.context(), brainLabel: label(s.brain) })
    if (patch.voice?.narrate === 'mute') send('speech:stop')
    if (patch.brain) void ensureSplash()
    if ('dictationHotkey' in patch) bindDictation()
    return s
  })
  ipcMain.handle('providers:health', () => providerHealth(getSettings().localBaseUrl))
  ipcMain.handle('canvas:set-token', async (_e, raw: string, url?: string) => {
    const token = raw.trim()
    if (url) updateSettings({ canvasUrl: url.trim().replace(/\/$/, '') })
    if (!token) {
      setSecret('canvas', null)
      return { ok: true }
    }
    try {
      const name = await verifyCanvas(token, getSettings().canvasUrl ?? DEFAULT_CANVAS)
      setSecret('canvas', token)
      return { ok: true, name }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('canvas:sign-in', async () => {
    try {
      const name = await signInCanvas(getSettings().canvasUrl ?? DEFAULT_CANVAS)
      send('settings', updateSettings({ canvasSignedIn: true }))
      return { ok: true, name }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('canvas:sign-out', async () => {
    await signOutCanvas()
    send('settings', updateSettings({ canvasSignedIn: false }))
  })
  ipcMain.handle('secrets:has', (_e, name: 'canvas') => !!getSecret(name))
  ipcMain.handle('voice:start', async () => {
    await systemPreferences.askForMediaAccess('microphone').catch(() => false)
    void voice.start()
    return voice.health
  })
  ipcMain.handle('voice:stop', () => voice.stop())
  ipcMain.handle('voice:health', () => voice.health)
  ipcMain.handle('voice:stt', (_e, wav: ArrayBuffer) => voice.transcribe(wav))
  ipcMain.handle('voice:tts', (_e, text: string, override?: string) => voice.speak(text, override ?? getSettings().voice.ttsVoice, getSettings().voice.speed))
  ipcMain.handle('window:mode', (_e, m: Mode) => setMode(m))
  ipcMain.handle('window:get-mode', () => mode)
  ipcMain.handle('window:hide', () => win?.hide())
  ipcMain.handle('app:quit', () => app.quit())
  ipcMain.handle('screen:capture', () => captureScreen())
  // The screenshot gallery. A new shot tells the renderer so the gallery refreshes.
  const shots = new Shots(join(app.getPath('userData'), 'Screenshots'))
  takeShot = async () => {
    const shot = await shots.take(grab)
    if (shot) send('shots:changed')
    return !!shot
  }
  ipcMain.handle('shots:list', () => shots.list())
  ipcMain.handle('shots:take', () => takeShot())
  ipcMain.handle('shots:open', (_e, id: string) => void shell.openPath(shots.get(id)?.path ?? ''))
  ipcMain.handle('shots:reveal', (_e, id: string) => shots.get(id) && shell.showItemInFolder(shots.get(id)!.path))
  ipcMain.handle('shots:remove', (_e, id: string) => shots.remove(id))
  // Ask Vesper about a saved shot: attach it to the composer, as ⌥⇧L does for a fresh one.
  ipcMain.handle('shots:ask', (_e, id: string) => {
    const s = shots.get(id)
    if (s) send('screen:attached', { path: s.path, preview: `data:image/jpeg;base64,${readFileSync(s.path).toString('base64')}` })
  })
  ipcMain.handle('screen:discard', (_e, path: string) => {
    if (path.startsWith(app.getPath('temp'))) rmSync(path, { force: true })
  })

  createWindow()
  createTray(() => void shell.openPath(vault.root))

  // ⌥Space summons or tucks away Vesper. ⌥⇧Space talks. ⌥⇧L looks at the screen, then asks.
  globalShortcut.register('Alt+Space', () => {
    if (!win) return
    if (!win.isVisible()) setMode('expanded')
    else if (mode === 'compact') setMode('expanded')
    else if (win.isFocused()) setMode('compact', false)
    else win.focus()
  })
  globalShortcut.register('Alt+Shift+Space', () => {
    if (!win?.isVisible()) win?.showInactive()
    send('hotkey:talk')
  })
  bindDictation()
  // ⌥⇧S saves a screenshot to the gallery without opening Vesper; the pill confirms it.
  globalShortcut.register('Alt+Shift+S', async () => send('shots:taken', await takeShot()))
  globalShortcut.register('Alt+Shift+L', async () => {
    const shot = await captureScreen()
    setMode('expanded')
    send('screen:attached', shot)
  })

  if (getSettings().voice.enabled) void voice.start()
  void ensureSplash()
  managePower()
  startIdleWork({ vault, cwd: join(app.getPath('userData'), 'workspace'), embed: (texts) => voice.embed(texts), busy: () => brain.busy })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    voice.stop()
    stopSplash()
    tasks.stopAll()
    importer.stop()
  })
})

app.on('window-all-closed', () => app.quit())
// Clicking the Dock icon brings Vesper back if it was hidden.
app.on('activate', () => setMode('expanded'))
