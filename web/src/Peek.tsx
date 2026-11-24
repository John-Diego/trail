import { useEffect, useRef, useState } from 'react'
import type { Review, SymbolResult } from '../../shared/types.ts'
import { api } from './api.ts'
import { loadBlob } from './files.ts'
import { renderLine, type Tok } from './highlight.ts'
import { useStore, type PeekTarget } from './store.ts'

const WINDOW = 45

/** A slice of a file at the base or head commit, with clickable identifiers. */
function CodeWindow({ review, path, side, line, endLine }: { review: Review; path: string; side: 'old' | 'new'; line: number; endLine?: number }) {
  const [data, setData] = useState<{ lines: Tok[][]; known: Set<string> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<[number, number]>([1, 1])
  const target = useRef<HTMLTableRowElement>(null)

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    loadBlob(review, path, side).then(
      (d) => {
        if (!live) return
        setData(d)
        const last = endLine ?? line
        setRange([Math.max(1, line - 4), Math.min(d.lines.length, Math.max(last + 4, line + WINDOW))])
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [review.id, review.headSha, path, side, line, endLine])

  useEffect(() => {
    target.current?.scrollIntoView({ block: 'center' })
  }, [data, line])

  if (error) return <div className="empty">{error}</div>
  if (!data) return <div className="empty">Loading {path}…</div>
  const [from, to] = range
  const rows = []
  for (let n = from; n <= to; n++) {
    const hit = n >= line && n <= (endLine ?? line)
    rows.push(
      <tr key={n} ref={n === line ? target : undefined} className={hit ? 'hit' : ''}>
        <td className="ln">{n}</td>
        <td className="code" dangerouslySetInnerHTML={{ __html: renderLine(data.lines[n - 1] ?? [], data.known) || '&nbsp;' }} />
      </tr>,
    )
  }
  return (
    <div
      className="code-window"
      onClick={(e) => {
        const sym = (e.target as HTMLElement).closest('.sym')
        if (sym && window.getSelection()?.isCollapsed) useStore.getState().peek({ kind: 'symbol', name: sym.textContent!, fromPath: path })
      }}
    >
      {from > 1 && <button className="more" onClick={() => setRange([Math.max(1, from - 40), to])}>↑ Show earlier lines</button>}
      <table className="lines">
        <tbody>{rows}</tbody>
      </table>
      {to < data.lines.length && <button className="more" onClick={() => setRange([from, Math.min(data.lines.length, to + 60)])}>↓ Show later lines</button>}
    </div>
  )
}

function LocationHeader({ review, path, line, side, label }: { review: Review; path: string; line: number; side: 'old' | 'new'; label?: string }) {
  const changed = review.files.some((f) => f.path === path)
  return (
    <div className="peek-loc">
      <div>
        {label && <div className="peek-label">{label}</div>}
        <span className="mono">{path}:{line}</span>
        {side === 'old' && <span className="pill">before the change</span>}
        {changed && side === 'new' && <span className="pill accent">changed in this review</span>}
      </div>
      {changed && side === 'new' && <button className="btn tiny" onClick={() => useStore.getState().revealLine(path, line)}>Go to diff</button>}
    </div>
  )
}

function SymbolView({ review, target }: { review: Review; target: Extract<PeekTarget, { kind: 'symbol' }> }) {
  const [result, setResult] = useState<SymbolResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState(0)
  const [tab, setTab] = useState<'def' | 'uses'>('def')

  useEffect(() => {
    let live = true
    setResult(null)
    setError(null)
    setPick(0)
    api.symbol(review.id, target.name, target.fromPath).then(
      (r) => {
        if (!live) return
        setResult(r)
        setTab(r.defs.length ? 'def' : 'uses')
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [review.id, target.name, target.fromPath])

  if (error) return <div className="empty">{error}</div>
  if (!result) return <div className="empty">Looking up {target.name}…</div>
  const def = result.defs[pick]
  const byFile = new Map<string, typeof result.usages>()
  for (const u of result.usages) byFile.set(u.path, [...(byFile.get(u.path) ?? []), u])

  return (
    <>
      <div className="tabs small">
        <button className={tab === 'def' ? 'on' : ''} onClick={() => setTab('def')}>Definition{result.defs.length > 1 ? `s (${result.defs.length})` : ''}</button>
        <button className={tab === 'uses' ? 'on' : ''} onClick={() => setTab('uses')}>Usages ({result.usages.length}{result.usagesTruncated ? '+' : ''})</button>
      </div>
      {tab === 'def' &&
        (def ? (
          <>
            {result.defs.length > 1 && (
              <div className="def-list">
                {result.defs.map((d, i) => (
                  <button key={`${d.path}:${d.line}`} className={i === pick ? 'on' : ''} onClick={() => setPick(i)}>
                    <span className="kind">{d.kind}</span> <span className="mono">{d.path}:{d.line}</span>
                    {d.changed && <span className="dot" title="Changed in this review" />}
                  </button>
                ))}
              </div>
            )}
            <LocationHeader review={review} path={def.path} line={def.line} side="new" />
            <CodeWindow review={review} path={def.path} side="new" line={def.line} />
          </>
        ) : (
          <div className="empty">
            No definition of <span className="mono">{target.name}</span> found in this repository. It may come from a dependency or be defined in a way the index does not recognise.
          </div>
        ))}
      {tab === 'uses' && (
        <div className="usages">
          {!result.usages.length && <div className="empty">No other uses found.</div>}
          {[...byFile].map(([path, uses]) => (
            <div key={path} className="usage-file">
              <div className="usage-path">
                <span className="mono">{path}</span>
                {uses[0].changed && <span className="pill accent">changed</span>}
              </div>
              {uses.map((u) => (
                <button key={u.line} className="usage" onClick={() => useStore.getState().peek({ kind: 'location', path: u.path, side: 'new', line: u.line })}>
                  <span className="ln">{u.line}</span>
                  <span className="mono">{u.text}</span>
                </button>
              ))}
            </div>
          ))}
          {result.usagesTruncated && <div className="empty">Showing the first 300 uses.</div>}
        </div>
      )}
    </>
  )
}

export function Peek({ review }: { review: Review }) {
  const stack = useStore((s) => s.peekStack)
  const index = useStore((s) => s.peekIndex)
  const go = useStore((s) => s.peekGo)
  const target = stack[index]

  if (!target)
    return (
      <div className="empty pad">
        <p><strong>Follow the code without leaving the diff.</strong></p>
        <p>Click any underlined name in the diff to see where it is defined and where it is used. Keep clicking inside this panel to go deeper; the arrows take you back.</p>
        {!review.symbolsReady && <p>The navigation index is not available for this review. Refresh the review to rebuild it.</p>}
      </div>
    )

  return (
    <div className="peek">
      <div className="peek-nav">
        <button className="btn tiny" disabled={index <= 0} onClick={() => go(-1)} title="Back">←</button>
        <button className="btn tiny" disabled={index >= stack.length - 1} onClick={() => go(1)} title="Forward">→</button>
        <div className="crumbs">
          {stack.slice(Math.max(0, index - 3), index + 1).map((t, i, arr) => (
            <span key={i} className={i === arr.length - 1 ? 'current' : ''}>
              {t.kind === 'symbol' ? t.name : `${t.path.split('/').pop()}:${t.line}`}
            </span>
          ))}
        </div>
      </div>
      {target.kind === 'symbol' ? (
        <SymbolView review={review} target={target} />
      ) : (
        <>
          <LocationHeader review={review} path={target.path} line={target.line} side={target.side} label={target.label} />
          <CodeWindow review={review} path={target.path} side={target.side} line={target.line} endLine={target.endLine} />
        </>
      )}
    </div>
  )
}
