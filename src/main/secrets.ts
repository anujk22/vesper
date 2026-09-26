import { app, safeStorage } from 'electron'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// API keys and tokens, encrypted with the macOS keychain. Never written to settings.json.
export type SecretName = 'canvas'

const file = (name: SecretName) => join(app.getPath('userData'), `${name}.key`)

export function getSecret(name: SecretName): string | null {
  try {
    return safeStorage.decryptString(readFileSync(file(name)))
  } catch {
    return null
  }
}

export function setSecret(name: SecretName, value: string | null) {
  if (value) writeFileSync(file(name), safeStorage.encryptString(value))
  else rmSync(file(name), { force: true })
}

