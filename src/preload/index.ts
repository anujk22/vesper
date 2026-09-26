import { contextBridge, ipcRenderer } from 'electron'

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

const api = {
  chat: {
    send: invoke('chat:send'),
    stop: invoke('chat:stop'),
    reset: invoke('chat:reset'),
    turns: invoke('chat:turns'),
    list: invoke('chat:list'),
    open: invoke('chat:open'),
    dictate: invoke('dictate:type'),
    context: invoke('chat:context')
  },
  actions: { approve: invoke('action:approve'), dismiss: invoke('action:dismiss') },
  tasks: { list: invoke('tasks:list'), start: invoke('tasks:start'), stop: invoke('tasks:stop') },
  canvas: { setToken: invoke('canvas:set-token'), signIn: invoke('canvas:sign-in'), signOut: invoke('canvas:sign-out') },
  secrets: { has: invoke('secrets:has') },
  terminals: {
    create: invoke('term:create'),
    list: invoke('term:list'),
    replay: invoke('term:replay'),
    kill: invoke('term:kill'),
    write: (id: string, data: string) => ipcRenderer.send('term:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('term:resize', id, cols, rows),
    focus: (id: string | null) => ipcRenderer.send('term:focus', id)
  },
  hackathons: {
    list: invoke('hack:list'),
    fromRelay: invoke('hack:from-relay'),
    update: invoke('hack:update'),
    scaffold: invoke('hack:scaffold'),
    agents: invoke('hack:agents'),
    kit: invoke('hack:kit')
  },
  overlay: { set: (p: { state: string; text?: string; startedAt?: number; accent?: { hue: number; chroma: number } }) => ipcRenderer.send('overlay', p), level: (l: number) => ipcRenderer.send('overlay:level', l), ready: () => ipcRenderer.send('overlay:ready'), hover: (on: boolean) => ipcRenderer.send('overlay:hover', on), close: () => ipcRenderer.send('overlay:close') },
  swarm: { list: invoke('swarm:list'), ask: invoke('swarm:ask'), stop: invoke('swarm:stop') },
  history: { list: invoke('history:list'), read: invoke('history:read'), continue: invoke('history:continue') },
  projects: { list: invoke('projects:list'), activate: invoke('project:activate'), reveal: invoke('project:reveal') },
  memory: { atlas: invoke('memory:atlas'), read: invoke('memory:read'), open: invoke('memory:open'), undo: invoke('memory:undo'), revert: invoke('memory:revert'), search: invoke('memory:search') },
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  providers: { health: invoke('providers:health') },
  voice: { start: invoke('voice:start'), stop: invoke('voice:stop'), health: invoke('voice:health'), stt: invoke('voice:stt'), tts: invoke('voice:tts') },
  window: { setMode: invoke('window:mode'), getMode: invoke('window:get-mode'), hide: invoke('window:hide'), quit: invoke('app:quit') },
  relays: { list: invoke('relays:list'), start: invoke('relays:start'), stop: invoke('relays:stop') },
  usage: { get: invoke('usage:get'), refreshClaude: invoke('usage:refresh-claude') },
  importer: {
    state: invoke('import:state'),
    proposals: invoke('import:proposals'),
    chatgpt: invoke('import:chatgpt'),
    text: invoke('import:text'),
    accept: invoke('import:accept'),
    reject: invoke('import:reject'),
    stop: invoke('import:stop')
  },
  screen: { capture: invoke('screen:capture'), discard: invoke('screen:discard') },
  on(channel: string, cb: (...args: unknown[]) => void) {
    const listener = (_e: unknown, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('bluevis', api)

export type VesperApi = typeof api
