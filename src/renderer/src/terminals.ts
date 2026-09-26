import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

// xterm instances live outside React so terminals keep their screen and scrollback while other views are shown.
interface Entry {
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  opened: boolean
  /** Output that arrived while the saved screen was still being replayed. */
  queue: string[] | null
}

const entries = new Map<string, Entry>()
let subscribed = false

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function subscribe() {
  if (subscribed) return
  subscribed = true
  window.bluevis.on('term:data', (id, data) => {
    const e = entries.get(id as string)
    if (!e) return
    if (e.queue) e.queue.push(data as string)
    else e.term.write(data as string)
  })
}

function ensure(id: string): Entry {
  subscribe()
  let e = entries.get(id)
  if (e) return e
  const term = new Terminal({
    fontFamily: "'SF Mono', Menlo, ui-monospace, monospace",
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: true,
    allowTransparency: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    theme: {
      background: 'rgba(0,0,0,0)',
      foreground: css('--bone') || '#eef3fb',
      cursor: css('--sky') || '#a7c7ff',
      selectionBackground: 'rgba(120,150,255,0.35)'
    }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const el = document.createElement('div')
  el.className = 'xterm-host'
  term.onData((d) => window.bluevis.terminals.write(id, d))
  term.onResize(({ cols, rows }) => window.bluevis.terminals.resize(id, cols, rows))
  e = { term, fit, el, opened: false, queue: [] }
  entries.set(id, e)
  const entry = e
  void window.bluevis.terminals.replay(id).then((saved) => {
    entry.term.write(saved as string)
    for (const d of entry.queue ?? []) entry.term.write(d)
    entry.queue = null
  })
  return e
}

/** Show a terminal inside `container`. Returns a function that detaches it again (the terminal keeps running). */
export function attach(id: string, container: HTMLElement): () => void {
  const e = ensure(id)
  container.appendChild(e.el)
  if (!e.opened) {
    e.term.open(e.el)
    e.opened = true
  }
  const refit = () => {
    if (e.el.isConnected && e.el.clientWidth > 0) e.fit.fit()
  }
  requestAnimationFrame(refit)
  const ro = new ResizeObserver(refit)
  ro.observe(container)
  return () => {
    ro.disconnect()
    e.el.remove()
  }
}

export function focusTerminal(id: string) {
  entries.get(id)?.term.focus()
}

export function dispose(id: string) {
  entries.get(id)?.term.dispose()
  entries.delete(id)
}
