import { Fragment, type ReactNode } from 'react'

/** A small, safe Markdown renderer (no HTML injection) covering what replies and vault notes use. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`md ${className}`}>{blocks(text)}</div>
}

function blocks(src: string): ReactNode[] {
  const lines = src.replace(/\r/g, '').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(
        <pre key={key++}>
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const Tag = (level === 1 ? 'h1' : level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4') as 'h1'
      out.push(<Tag key={key++}>{inline(h[2])}</Tag>)
      i++
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = row(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]))
      out.push(
        <table key={key++}>
          <thead>
            <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(<blockquote key={key++}>{inline(body.join(' '))}</blockquote>)
      continue
    }
    const ul = /^\s*[-*•]\s+/
    const ol = /^\s*\d+[.)]\s+/
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line)
      const re = ordered ? ol : ul
      const items: string[] = []
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i++].replace(re, '')
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !ul.test(lines[i]) && !ol.test(lines[i])) item += ` ${lines[i++].trim()}`
        items.push(item)
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it.replace(/^\[( |x)\]\s*/i, (m) => (m.includes('x') ? '✓ ' : '○ ')))}</li>
          ))}
        </List>
      )
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*•]\s|\s*\d+[.)]\s|\s*>|\s*\|)/.test(lines[i])) para.push(lines[i++])
    if (!para.length) para.push(lines[i++])
    out.push(<p key={key++}>{inline(para.join(' '))}</p>)
  }
  return out
}

/** Inline Markdown only (code, bold, links), for single lines such as Vesper's spoken sentence. */
export function Inline({ text }: { text: string }) {
  return <>{inline(text)}</>
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)|(https?:\/\/[^\s)]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>)
    const t = m[0]
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>)
    else if (m[3]) out.push(<strong key={k++}>{t.slice(2, -2).split('|').pop()}</strong>)
    else if (m[4]) {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!
      out.push(
        <a key={k++} href={href} target="_blank" rel="noreferrer">
          {inline(label)}
        </a>
      )
    } else if (m[5]) out.push(<em key={k++}>{t.slice(1, -1)}</em>)
    else if (m[6])
      out.push(
        <a key={k++} href={t} target="_blank" rel="noreferrer">
          {t}
        </a>
      )
    last = m.index + t.length
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>)
  return out
}
