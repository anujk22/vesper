import { nativeImage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './shell'

export interface Shot {
  id: string
  path: string
  at: number
  /** The app in front when the shot was taken. */
  app?: string
}

/**
 * The screenshot gallery: full captures in the app's own folder (not the vault, so its git history
 * stays small), a small thumbnail beside each, and one index file.
 */
export class Shots {
  private index: string

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
    this.index = join(dir, 'index.json')
  }

  private read(): Shot[] {
    try {
      return (JSON.parse(readFileSync(this.index, 'utf8')) as Shot[]).filter((s) => existsSync(s.path))
    } catch {
      return []
    }
  }

  /** Save a new capture; `capture` writes the image to the path it is given. */
  async take(capture: (path: string) => Promise<boolean>): Promise<Shot | null> {
    const at = Date.now()
    const id = new Date(at).toISOString().replace(/[:.]/g, '-')
    const path = join(this.dir, `${id}.jpg`)
    const asn = (await run('lsappinfo', ['front'])).stdout.trim()
    const front = (await run('lsappinfo', ['info', '-only', 'name', asn])).stdout.match(/^"([^"]+)"/)?.[1]
    if (!(await capture(path))) return null
    const thumb = nativeImage.createFromPath(path).resize({ width: 480 })
    writeFileSync(join(this.dir, `${id}.thumb.jpg`), thumb.toJPEG(80))
    const shot: Shot = { id, path, at, app: front === 'Vesper' ? undefined : front }
    writeFileSync(this.index, JSON.stringify([shot, ...this.read()], null, 1))
    return shot
  }

  /** Newest first, each with its thumbnail as a data URL. */
  list(): (Shot & { thumb: string })[] {
    return this.read().map((s) => {
      const t = join(this.dir, `${s.id}.thumb.jpg`)
      return { ...s, thumb: existsSync(t) ? `data:image/jpeg;base64,${readFileSync(t).toString('base64')}` : '' }
    })
  }

  get(id: string): Shot | undefined {
    return this.read().find((s) => s.id === id)
  }

  /** Moves the image to the Trash, so a mistaken delete can be undone from Finder. */
  async remove(id: string) {
    const s = this.get(id)
    if (!s) return
    await shell.trashItem(s.path)
    rmSync(join(this.dir, `${s.id}.thumb.jpg`), { force: true })
    writeFileSync(this.index, JSON.stringify(this.read(), null, 1))
  }
}
