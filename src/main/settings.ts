import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../core/types'

const file = () => join(app.getPath('userData'), 'settings.json')

function defaultVault(): string {
  if (process.env.BLUEVIS_PROFILE_DIR) return join(app.getPath('userData'), 'vault')
  // In development the vault lives beside the app (gitignored); packaged builds use ~/Vesper Vault.
  return app.isPackaged ? join(homedir(), 'Vesper Vault') : join(app.getAppPath(), 'vault')
}

export function defaults(): Settings {
  return {
    brain: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' },
    worker: { provider: 'codex', model: 'gpt-6-sol', effort: 'medium' },
    localBaseUrl: 'http://127.0.0.1:8000/v1',
    voice: { enabled: true, ttsVoice: 'bm_george', speed: 1.05, narrate: 'brief' },
    // Internship/work folders are deliberately not scanned (work boundary, PRD §4.5).
    projectRoots: ['Personal', 'Hackathons', 'School', 'Classes', 'Clubs'].map((d) => join(homedir(), 'Documents', 'Coding', d)),
    vaultPath: defaultVault(),
    editor: 'Visual Studio Code'
  }
}

let cached: Settings | null = null

export function getSettings(): Settings {
  if (cached) return cached
  const d = defaults()
  try {
    if (existsSync(file())) {
      const saved = JSON.parse(readFileSync(file(), 'utf8'))
      cached = { ...d, ...saved, voice: { ...d.voice, ...saved.voice } }
      // Gemini was removed as a provider; a saved Gemini brain falls back to the default.
      if (saved.brain?.provider === 'gemini') cached!.brain = d.brain
      // "Speak replies" became a narration mode.
      if (saved.voice && !saved.voice.narrate) cached!.voice.narrate = saved.voice.speak === false ? 'mute' : 'brief'
      delete (cached!.voice as { speak?: boolean }).speak
      return cached!
    }
  } catch {
    // Corrupt settings fall back to defaults; the file is rewritten on next save.
  }
  cached = d
  return d
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  if (patch.voice) next.voice = { ...getSettings().voice, ...patch.voice }
  cached = next
  writeFileSync(file(), JSON.stringify(next, null, 2))
  return next
}
