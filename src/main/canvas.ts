import { BrowserWindow, session } from 'electron'
import { formatAnnouncements, formatGrades, formatPlanner, nextLink, type CanvasAnnouncement, type CanvasCourse, type PlannerItem } from '../core/canvas'
import { getSecret } from './secrets'
import { getSettings } from './settings'

export const DEFAULT_CANVAS = 'https://rutgers.instructure.com'

// Schools can block personal tokens; then Anuj signs in once in a Vesper window and reads use that session,
// exactly as the Canvas website does. The session lives in its own partition, separate from everything else.
const canvasSession = () => session.fromPartition('persist:canvas')

/** Read-only Canvas access, by token or signed-in session. Every request is a GET. */
async function get<T>(path: string, token: string | null, base: string): Promise<T[]> {
  const out: T[] = []
  let url: string | null = `${base.replace(/\/$/, '')}/api/v1${path}`
  for (let page = 0; url && page < 10; page++) {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : { Accept: 'application/json' }
    const init: RequestInit = { headers, signal: AbortSignal.timeout(15000) }
    const res: Response = token ? await fetch(url, init) : await canvasSession().fetch(url, init)
    if (res.status === 401) throw new Error(token ? 'Canvas rejected the token. Create a new one in Canvas under Account, Settings.' : 'Signed out of Canvas. Sign in again in Settings.')
    if (!res.ok) throw new Error(`Canvas returned ${res.status}`)
    // Session-authenticated JSON is prefixed with "while(1);" to stop cross-site reads.
    const body = JSON.parse((await res.text()).replace(/^while\(1\);/, '')) as T | T[]
    out.push(...(Array.isArray(body) ? body : [body]))
    url = nextLink(res.headers.get('link'))
  }
  return out
}

/** Open Canvas in a window for Anuj to sign in (NetID, Duo). Resolves with the account's name once the session works. */
export function signInCanvas(base: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ width: 980, height: 760, title: 'Sign in to Canvas', webPreferences: { partition: 'persist:canvas', contextIsolation: true, nodeIntegration: false, sandbox: true } })
    let done = false
    const check = async () => {
      if (done) return
      try {
        const [me] = await get<{ name: string }>('/users/self', null, base)
        done = true
        win.close()
        resolve(me.name)
      } catch {
        // Not signed in yet; wait for the next page load.
      }
    }
    win.webContents.on('did-finish-load', () => void check())
    win.on('closed', () => !done && reject(new Error('Canvas sign-in was closed before it finished.')))
    void win.loadURL(`${base.replace(/\/$/, '')}/login`)
  })
}

export async function signOutCanvas() {
  await canvasSession().clearStorageData()
}

/** Check a token before saving it. Returns the account's name. */
export async function verifyCanvas(token: string, base: string): Promise<string> {
  const [me] = await get<{ name: string }>('/users/self', token, base)
  return me.name
}

let cache: { at: number; text: string } | null = null

/** Due work (last week to two weeks out) with submission state, current grades, and recent announcements. */
export async function canvasBrief(): Promise<string | null> {
  const token = getSecret('canvas')
  if (!token && !getSettings().canvasSignedIn) return null
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.text
  const base = getSettings().canvasUrl ?? DEFAULT_CANVAS
  const now = Date.now()
  const iso = (t: number) => new Date(t).toISOString()
  try {
    const courses = await get<CanvasCourse>('/courses?enrollment_state=active&include[]=total_scores&per_page=50', token, base)
    const codes = courses.map((c) => `context_codes[]=course_${c.id}`).join('&')
    const [planner, announcements] = await Promise.all([
      get<PlannerItem>(`/planner/items?start_date=${iso(now - 7 * 86400_000)}&end_date=${iso(now + 14 * 86400_000)}&per_page=100`, token, base),
      courses.length ? get<CanvasAnnouncement>(`/announcements?${codes}&start_date=${iso(now - 7 * 86400_000)}&end_date=${iso(now)}&per_page=50`, token, base) : Promise.resolve([])
    ])
    const text = [
      `Due work, past week through next two weeks:\n${formatPlanner(planner, now)}`,
      `Current grades:\n${formatGrades(courses)}`,
      `Announcements, last 7 days:\n${formatAnnouncements(announcements.sort((a, b) => Date.parse(b.posted_at) - Date.parse(a.posted_at)), courses)}`
    ].join('\n\n')
    cache = { at: now, text }
    return text
  } catch (e) {
    return `(Canvas error: ${(e as Error).message})`
  }
}
