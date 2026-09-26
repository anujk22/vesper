import { app, clipboard, screen } from 'electron'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from './shell'

// Mac actions for voice and typed commands: open and quit apps, place windows, type text into
// the focused app. Window placement and typing go through System Events, which needs
// Accessibility permission (System Settings, Privacy & Security, Accessibility).

let apps: string[] | null = null

export function installedApps(): string[] {
  if (apps) return apps
  const dirs = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]
  apps = [...new Set(dirs.flatMap((d) => {
    try {
      return readdirSync(d).filter((f) => f.endsWith('.app')).map((f) => f.slice(0, -4))
    } catch {
      return []
    }
  }))].sort()
  return apps
}

const ALIASES: Record<string, string> = { 'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code', code: 'Visual Studio Code', chrome: 'Google Chrome', settings: 'System Settings', mail: 'Mail' }

/** The installed app a spoken name most likely means. */
export function findApp(name: string): string | undefined {
  const n = name.toLowerCase().replace(/\b(the|app|application)\b/g, '').replace(/[^a-z0-9. ]/g, '').replace(/\s+/g, ' ').trim()
  if (!n) return undefined
  if (/^(vesper|bluevis|yourself|you)$/.test(n)) return app.getName()
  const list = installedApps()
  const alias = ALIASES[n]
  if (alias && list.includes(alias)) return alias
  return list.find((a) => a.toLowerCase() === n) ?? list.find((a) => a.toLowerCase().startsWith(n)) ?? list.find((a) => a.toLowerCase().includes(n))
}

const quote = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

async function osascript(...lines: string[]) {
  const r = await run('osascript', lines.flatMap((l) => ['-e', l]), { timeout: 10000 })
  if (r.code !== 0) {
    if (/not allowed|assistive|1002|-25211|-1719/i.test(r.stderr)) throw new Error('Vesper needs Accessibility permission for this: System Settings, Privacy & Security, Accessibility.')
    throw new Error(r.stderr.trim() || 'AppleScript failed')
  }
  return r.stdout.trim()
}

export async function openApp(name: string): Promise<string> {
  const a = findApp(name)
  if (!a) throw new Error(`No app called ${name} is installed.`)
  if (a === app.getName()) return a
  const r = await run('open', ['-a', a])
  if (r.code !== 0) throw new Error(`Could not open ${a}.`)
  return a
}

export async function quitApp(name: string): Promise<string> {
  const a = findApp(name)
  if (!a) throw new Error(`No app called ${name} is installed.`)
  await osascript(`tell application "${quote(a)}" to quit`)
  return a
}

export type Region = 'left' | 'right' | 'full' | 'top' | 'bottom' | 'left-third' | 'center-third' | 'right-third' | 'center'

export function regionRect(region: Region, area: { x: number; y: number; width: number; height: number }) {
  const { x, y, width: w, height: h } = area
  const third = Math.round(w / 3)
  const half = Math.round(w / 2)
  switch (region) {
    case 'left':
      return { x, y, w: half, h }
    case 'right':
      return { x: x + half, y, w: w - half, h }
    case 'top':
      return { x, y, w, h: Math.round(h / 2) }
    case 'bottom':
      return { x, y: y + Math.round(h / 2), w, h: h - Math.round(h / 2) }
    case 'left-third':
      return { x, y, w: third, h }
    case 'center-third':
      return { x: x + third, y, w: third, h }
    case 'right-third':
      return { x: x + 2 * third, y, w: w - 2 * third, h }
    case 'center':
      return { x: x + Math.round(w * 0.15), y: y + Math.round(h * 0.08), w: Math.round(w * 0.7), h: Math.round(h * 0.84) }
    default:
      return { x, y, w, h }
  }
}

/** Set by main: Vesper places its own window directly. */
export const self: { place: ((r: { x: number; y: number; width: number; height: number }) => void) | null } = { place: null }

/** Open the app if needed and move its front window into a region of the main display. */
export async function placeApp(name: string, region: Region): Promise<string> {
  const a = await openApp(name)
  const area = screen.getPrimaryDisplay().workArea
  if (a === app.getName() && self.place) {
    const s = regionRect(region, area)
    self.place({ x: s.x, y: s.y, width: s.w, height: s.h })
    return a
  }
  const bundle = await osascript(`id of application "${quote(a)}"`)
  const r = regionRect(region, area)
  const proc = `(first application process whose bundle identifier is "${quote(bundle)}")`
  // A just-launched app needs a moment to show its first window.
  for (let i = 0; i < 20; i++) {
    const n = await osascript(`tell application "System Events" to count windows of ${proc}`).catch((e: Error) => (/Accessibility/.test(e.message) ? Promise.reject(e) : '0'))
    if (Number(n) > 0) break
    await new Promise((res) => setTimeout(res, 250))
  }
  await osascript(`tell application "System Events" to tell ${proc} to set position of window 1 to {${r.x}, ${r.y}}`, `tell application "System Events" to tell ${proc} to set size of window 1 to {${r.w}, ${r.h}}`)
  return a
}

/** Type text into whatever field has focus, through the clipboard, then put the clipboard back. */
export async function typeText(text: string) {
  const previous = await clipboard.readText()
  await clipboard.writeText(text)
  try {
    await osascript('tell application "System Events" to keystroke "v" using command down')
  } finally {
    setTimeout(() => void clipboard.writeText(previous), 700)
  }
}
