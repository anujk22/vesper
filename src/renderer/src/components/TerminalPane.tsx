import { useEffect, useRef } from 'react'
import type { TerminalInfo } from '../../../core/terminal'
import { attach, focusTerminal } from '../terminals'

export function TerminalPane({ info, onClose, onSplit }: { info: TerminalInfo; onClose: () => void; onSplit?: () => void }) {
  const api = window.bluevis
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const detach = attach(info.id, host.current!)
    focusTerminal(info.id)
    return detach
  }, [info.id])
  return (
    <div className="term-pane" onMouseDown={() => api.terminals.focus(info.id)}>
      <header className="term-head">
        <span className="t">{info.title}</span>
        <span className="mono cwd">{info.command ?? info.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
        {info.exited !== undefined && <span className="mono exited">exited {info.exited}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {onSplit && (
            <button className="btn btn-quiet" onClick={onSplit} title="Open another terminal beside this one">
              Split
            </button>
          )}
          <button className="btn btn-quiet" onClick={onClose} title="Close this terminal and end its process">
            Close
          </button>
        </span>
      </header>
      <div className="term-body" ref={host} />
    </div>
  )
}
