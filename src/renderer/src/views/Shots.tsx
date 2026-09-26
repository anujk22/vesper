import { useEffect, useState } from 'react'

interface Shot {
  id: string
  at: number
  app?: string
  thumb: string
}

const day = (at: number) => {
  const d = new Date(at)
  const today = new Date()
  const y = new Date(today.getTime() - 86_400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

/** The screenshot gallery, grouped by day. Click a shot to open it; ask Vesper about it, or move it to the Trash. */
export function Shots() {
  const api = window.bluevis
  const [shots, setShots] = useState<Shot[] | null>(null)
  const load = () => api.shots.list().then((s) => setShots(s as Shot[]))
  useEffect(() => {
    void load()
    const off = api.on('shots:changed', () => void load())
    return () => void off()
  }, [])

  const groups: [string, Shot[]][] = []
  for (const s of shots ?? []) {
    const d = day(s.at)
    if (groups.at(-1)?.[0] === d) groups.at(-1)![1].push(s)
    else groups.push([d, [s]])
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <h2 className="panel-title">Screenshots</h2>
          <p className="panel-sub" style={{ margin: 0 }}>
            Say “Hey Vesper, screenshot” or press ⌥⇧S. Kept on this Mac only.
          </p>
        </div>
        <button className="btn" onClick={() => void api.shots.take()}>
          Take one now
        </button>
      </div>
      {shots && !shots.length && <p className="panel-sub">No screenshots yet. Take one and it will appear here.</p>}
      {groups.map(([d, list]) => (
        <section key={d} className="shot-day">
          <div className="eyebrow">{d}</div>
          <div className="shot-grid">
            {list.map((s) => (
              <figure key={s.id} className="shot">
                <button className="shot-img" onClick={() => api.shots.open(s.id)} title="Open in Preview">
                  <img src={s.thumb} alt={`Screenshot${s.app ? ` of ${s.app}` : ''}`} loading="lazy" />
                </button>
                <figcaption>
                  <span className="mono">
                    {new Date(s.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    {s.app ? ` · ${s.app}` : ''}
                  </span>
                  <span className="shot-actions">
                    <button className="link-btn" onClick={() => api.shots.ask(s.id)}>
                      Ask
                    </button>
                    <button className="link-btn" onClick={() => api.shots.reveal(s.id)}>
                      Show in Finder
                    </button>
                    <button className="link-btn" onClick={() => api.shots.remove(s.id).then(load)}>
                      Delete
                    </button>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
