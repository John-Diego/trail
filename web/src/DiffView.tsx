import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { moveLabel, type ChatContext, type Comment, type Concern, type DiffLine, type FileDiff, type Hunk, type Move, type Review } from '../../shared/types.ts'
import { api } from './api.ts'
import { useFile, type LoadedFile } from './files.ts'
import { escapeHtml, intraline, renderLine, type Tok } from './highlight.ts'
import { Markdown } from './Markdown.tsx'
import { useStore } from './store.ts'

const EXPAND_STEP = 20

type Row =
  | { kind: 'line'; line: DiffLine; mark?: [number, number] }
  | { kind: 'fold'; key: string; move: Move; added: boolean; count: number }
  | { kind: 'ctx'; o: number; n: number }

/** Pair up replaced lines and find the part of each that actually changed. */
function wordMarks(lines: DiffLine[]): Map<DiffLine, [number, number]> {
  const marks = new Map<DiffLine, [number, number]>()
  let i = 0
  while (i < lines.length) {
    if (lines[i].t !== '-') {
      i++
      continue
    }
    let d = i
    while (d < lines.length && lines[d].t === '-') d++
    let a = d
    while (a < lines.length && lines[a].t === '+') a++
    const dels = d - i
    const adds = a - d
    if (dels === adds) {
      for (let k = 0; k < dels; k++) {
        const del = lines[i + k]
        const add = lines[d + k]
        if (del.mv || add.mv) continue
        const diff = intraline(del.s, add.s)
        if (diff) {
          marks.set(del, diff.a)
          marks.set(add, diff.b)
        }
      }
    }
    i = a
  }
  return marks
}

function buildRows(hunk: Hunk, moves: Map<number, Move>, collapseMoves: boolean, opened: Set<string>): Row[] {
  const marks = wordMarks(hunk.lines)
  const rows: Row[] = []
  let i = 0
  while (i < hunk.lines.length) {
    const line = hunk.lines[i]
    const move = line.mv ? moves.get(line.mv) : undefined
    if (move && collapseMoves) {
      let j = i
      while (j < hunk.lines.length && hunk.lines[j].mv === line.mv && hunk.lines[j].t === line.t) j++
      const key = `${line.mv}${line.t}${i}`
      if (j - i >= 3 && !opened.has(key)) {
        rows.push({ kind: 'fold', key, move, added: line.t === '+', count: j - i })
        i = j
        continue
      }
    }
    rows.push({ kind: 'line', line, mark: marks.get(line) })
    i++
  }
  return rows
}

/**
 * HTML for a line of the diff. The diff's own text is the truth: highlighted tokens from the
 * full file are used only when they spell exactly that text, so a stale or mismatched file
 * can cost colour but can never show different code on a changed line.
 */
function codeHtml(tokens: Tok[] | undefined, fallback: string, known: Set<string> | null, mark?: [number, number]): string {
  if (!tokens || tokens.map((t) => t.t).join('') !== fallback) return mark ? `${escapeHtml(fallback.slice(0, mark[0]))}<mark>${escapeHtml(fallback.slice(mark[0], mark[1]))}</mark>${escapeHtml(fallback.slice(mark[1]))}` : escapeHtml(fallback)
  return renderLine(tokens, known, mark)
}

export function hunkContext(file: FileDiff, hunk: Hunk): ChatContext {
  const newLines = hunk.lines.filter((l) => l.n !== undefined)
  return {
    path: file.path,
    side: 'new',
    startLine: newLines[0]?.n ?? hunk.newStart,
    endLine: newLines[newLines.length - 1]?.n ?? hunk.newStart,
    hunk: hunk.id,
    code: hunk.lines.map((l) => l.t + l.s).join('\n').slice(0, 12_000),
  }
}

function NoteComposer({ onSave, onCancel, initial = '' }: { onSave: (body: string) => void; onCancel: () => void; initial?: string }) {
  const [body, setBody] = useState(initial)
  return (
    <div className="note-composer">
      <textarea
        autoFocus
        value={body}
        placeholder="Leave a note on this line"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) onSave(body)
          e.stopPropagation()
        }}
      />
      <div className="row">
        <span className="hint">⌘↵ to save</span>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={!body.trim()} onClick={() => onSave(body)}>Save note</button>
      </div>
    </div>
  )
}

function NoteCard({ review, note }: { review: Review; note: Comment }) {
  const setComments = useStore((s) => s.setComments)
  const [editing, setEditing] = useState(false)
  if (editing)
    return (
      <NoteComposer
        initial={note.body}
        onCancel={() => setEditing(false)}
        onSave={async (body) => {
          setComments(await api.updateComment(review.id, note.id, { body }))
          setEditing(false)
        }}
      />
    )
  return (
    <div className={`note ${note.status}`}>
      <div className="note-body">{note.body}</div>
      <div className="note-meta">
        <span>{note.status === 'draft' ? 'Draft note' : note.status === 'submitted' ? 'Posted to GitHub' : 'Sent to Claude'}</span>
        {note.outdated && <span className="outdated" title="This line changed after the note was written. The note will go in the review summary, not on a line.">Outdated: the code here has changed</span>}
        <button className="link" onClick={() => setEditing(true)}>Edit</button>
        <button className="link" onClick={async () => setComments(await api.deleteComment(review.id, note.id))}>Delete</button>
      </div>
    </div>
  )
}

interface HunkProps {
  review: Review
  file: FileDiff
  hunk: Hunk
  loaded: LoadedFile | null
  moves: Map<number, Move>
  concerns: Concern[]
  notes: Comment[]
  viewed: boolean
  focused: boolean
  collapseMoves: boolean
}

const HunkView = memo(function HunkView({ review, file, hunk, loaded, moves, concerns, notes, viewed, focused, collapseMoves }: HunkProps) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const [openedFolds, setOpenedFolds] = useState<Set<string>>(new Set())
  const [up, setUp] = useState(0)
  const [down, setDown] = useState(0)
  const [composer, setComposer] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const scrollNonce = useStore((s) => s.scrollNonce)

  // Viewed hunks get out of the way; so do blocks of code that only moved.
  const autoCollapsed = viewed || (hunk.pureMove && collapseMoves)
  const open = openOverride ?? !autoCollapsed
  useEffect(() => setOpenOverride(null), [viewed])
  useEffect(() => {
    if (!focused || !ref.current) return
    const el = ref.current
    const scroller = el.closest('.diff-pane')
    if (!scroller) return
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    if (top < 60 || top > scroller.clientHeight * 0.6) scroller.scrollBy({ top: top - 90, behavior: 'smooth' })
  }, [focused, scrollNonce])

  const rows = useMemo(() => buildRows(hunk, moves, collapseMoves, openedFolds), [hunk, moves, collapseMoves, openedFolds])
  const known = loaded?.known ?? null

  // Line numbers just outside the hunk, used to show more of the file around it.
  const oldBefore = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
  const newBefore = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1
  const newAfter = newBefore + hunk.newLines + 1
  const oldAfter = oldBefore + hunk.oldLines + 1
  const total = loaded?.newLines?.length ?? 0
  const pos = file.hunks.indexOf(hunk)
  const prev = file.hunks[pos - 1]
  const next = file.hunks[pos + 1]
  const upLimit = newBefore - (prev ? prev.newStart + prev.newLines - 1 : 0)
  const downLimit = (next ? next.newStart - 1 : total) - (newAfter - 1)
  const canUp = !!loaded?.newLines && up < upLimit
  const canDown = !!loaded?.newLines && down < downLimit

  const move = hunk.pureMove ? moves.get(hunk.lines.find((l) => l.mv)?.mv ?? -1) : undefined
  const moveText = move
    ? hunk.additions
      ? `${move.lines} lines ${moveLabel(move)} from ${move.from.path}:${move.from.start}`
      : `${move.lines} lines ${moveLabel(move)} to ${move.to.path}:${move.to.start}`
    : null

  const store = useStore.getState
  const saveNote = async (side: 'old' | 'new', line: number, inDiff: boolean, body: string) => {
    // Always the current path: GitHub addresses both sides of a renamed file by its new name.
    // The line's text goes along so the note can follow its line, or be flagged, after a refresh.
    const text = inDiff ? hunk.lines.find((l) => (side === 'old' ? l.o === line && l.t !== '+' : l.n === line && l.t !== '-'))?.s : undefined
    store().setComments(await api.addComment(review.id, { path: file.path, side, line, inDiff, body, text }))
    setComposer(null)
  }

  const notesAt = (side: 'old' | 'new', line: number) => notes.filter((n) => n.side === side && n.line === line)

  const renderExtras = (side: 'old' | 'new', line: number, inDiff: boolean) => {
    const key = `${side}:${line}`
    const here = notesAt(side, line)
    if (!here.length && composer !== key) return null
    return (
      <tr className="extra" key={`x${key}`}>
        <td colSpan={3}>
          {here.map((n) => <NoteCard key={n.id} review={review} note={n} />)}
          {composer === key && <NoteComposer onCancel={() => setComposer(null)} onSave={(body) => saveNote(side, line, inDiff, body)} />}
        </td>
      </tr>
    )
  }

  const lineRow = (key: string, cls: string, side: 'old' | 'new', o: number | undefined, n: number | undefined, html: string, inDiff: boolean) => {
    const line = (side === 'old' ? o : n)!
    return [
      <tr key={key} className={cls} data-path={side === 'old' ? file.oldPath : file.path} data-side={side} data-line={line} data-hunk={hunk.id}>
        <td className="ln">{o ?? ''}</td>
        <td className="ln">
          {n ?? ''}
          <button className="add-note" title="Add a note" onClick={() => setComposer(`${side}:${line}`)}>+</button>
        </td>
        <td className="code" dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
      </tr>,
      renderExtras(side, line, inDiff),
    ]
  }

  const ctxRows = (from: number, count: number, oldOffset: number) =>
    Array.from({ length: count }, (_, k) => {
      const n = from + k
      return lineRow(`c${n}`, 'ctx expanded', 'new', n + oldOffset, n, renderLine(loaded?.newLines?.[n - 1] ?? [], known), false)
    })

  return (
    <div ref={ref} className={`hunk${focused ? ' focused' : ''}${viewed ? ' viewed' : ''}`} data-hunk-id={hunk.id} onMouseDown={() => !focused && store().focus(hunk.id)}>
      <div className="hunk-bar">
        <button className="twisty" onClick={() => setOpenOverride(!open)} aria-label={open ? 'Collapse hunk' : 'Expand hunk'}>{open ? '▾' : '▸'}</button>
        <span className="hunk-id">{hunk.id}</span>
        {hunk.symbol && <span className="hunk-symbol">{hunk.symbol}</span>}
        <span className="hunk-range">
          {hunk.additions > 0 && <span className="add">+{hunk.additions}</span>} {hunk.deletions > 0 && <span className="del">−{hunk.deletions}</span>}
        </span>
        {moveText && (
          <button className="move-chip" onClick={() => move && store().peek({ kind: 'location', path: hunk.additions ? move.from.path : move.to.path, side: hunk.additions ? 'old' : 'new', line: hunk.additions ? move.from.start : move.to.start, endLine: hunk.additions ? move.from.end : move.to.end, label: 'Other side of the move' })}>
            ↪ {moveText}
          </button>
        )}
        <span className="spacer" />
        <button className="btn tiny" onClick={() => store().askClaude('Explain this hunk: what it does, why this change needs it, and anything that looks risky or wrong.', hunkContext(file, hunk), true)}>Explain</button>
        <button className="btn tiny" onClick={() => store().askClaude('', hunkContext(file, hunk), false)}>Ask</button>
        <label className="viewed-toggle">
          <input type="checkbox" checked={viewed} onChange={(e) => store().setViewed([hunk], e.target.checked)} /> Viewed
        </label>
      </div>
      {concerns.map((c, i) => (
        <div key={i} className={`concern ${c.severity}`}>
          <strong>{c.severity === 'bug' ? 'Possible bug' : c.severity === 'warn' ? 'Check this' : 'Note'}</strong> <Markdown text={c.note} />
        </div>
      ))}
      {open && hunk.note && <div className="file-note">{hunk.note}</div>}
      {open && !hunk.note && (
        <table className="lines">
          <colgroup>
            <col className="col-ln" />
            <col className="col-ln" />
            <col />
          </colgroup>
          <tbody>
            {canUp && (
              <tr className="expander">
                <td colSpan={3}><button onClick={() => setUp(Math.min(upLimit, up + EXPAND_STEP))}>↑ Show {Math.min(EXPAND_STEP, upLimit - up)} more lines</button></td>
              </tr>
            )}
            {up > 0 && ctxRows(newBefore - up + 1, up, oldBefore - newBefore)}
            {rows.map((row, i) => {
              if (row.kind === 'fold') {
                const other = row.added ? row.move.from : row.move.to
                return (
                  <tr key={`f${row.key}`} className={`fold ${row.added ? 'add' : 'del'}`}>
                    <td colSpan={3}>
                      <span className="fold-text">↪ {row.count} lines {moveLabel(row.move)} {row.added ? 'from' : 'to'} </span>
                      <button className="link" onClick={() => store().peek({ kind: 'location', path: other.path, side: row.added ? 'old' : 'new', line: other.start, endLine: other.end, label: 'Other side of the move' })}>
                        {other.path}:{other.start}
                      </button>
                      <button className="link dim" onClick={() => setOpenedFolds(new Set(openedFolds).add(row.key))}>show lines</button>
                    </td>
                  </tr>
                )
              }
              if (row.kind !== 'line') return null
              const l = row.line
              const side = l.t === '-' ? 'old' : 'new'
              const tokens = l.t === '-' ? loaded?.oldLines?.[l.o! - 1] : loaded?.newLines?.[l.n! - 1]
              const cls = `${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}${l.mv ? ' mv' : ''}`
              const html = codeHtml(tokens, l.s, known, row.mark) + (l.nonl ? '<span class="nonl">no newline at end of file</span>' : '')
              return lineRow(`l${i}`, cls, side, l.o, l.n, html, true)
            })}
            {down > 0 && ctxRows(newAfter, down, oldAfter - newAfter)}
            {canDown && (
              <tr className="expander">
                <td colSpan={3}><button onClick={() => setDown(Math.min(downLimit, down + EXPAND_STEP))}>↓ Show {Math.min(EXPAND_STEP, downLimit - down)} more lines</button></td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
})

const STATUS_LABEL: Record<string, string> = { added: 'New', deleted: 'Deleted', modified: 'Changed', renamed: 'Renamed', copied: 'Copied' }

export function FileSection({ review, file, hunks, concerns }: { review: Review; file: FileDiff; hunks: Hunk[]; concerns: Concern[] }) {
  const [near, setNear] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const viewed = useStore((s) => s.viewed)
  const focusHunk = useStore((s) => s.focusHunk)
  const collapseMoves = useStore((s) => s.collapseMoves)
  const containsFocus = hunks.some((h) => h.id === focusHunk)
  const [openGenerated, setOpenGenerated] = useState(false)

  // Mount file contents only when the section approaches the viewport, so very large changes stay responsive.
  useEffect(() => {
    if (near || !ref.current) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '1200px 0px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [near])

  const active = near || containsFocus
  const loaded = useFile(review, file, active && !file.generated)
  const moves = useMemo(() => new Map(review.moves.map((m) => [m.id, m])), [review.moves])
  const allViewed = hunks.length > 0 && hunks.every((h) => viewed.has(h.key))
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''
  const hidden = file.generated && !openGenerated
  const estimated = hunks.reduce((n, h) => n + h.lines.length * 20 + 40, 0)

  return (
    <section ref={ref} className="file" data-file={file.idx}>
      <header className="file-header">
        <span className={`status ${file.status}`}>{STATUS_LABEL[file.status]}</span>
        <button className="file-path" title="Open the whole file" onClick={() => useStore.getState().peek({ kind: 'location', path: file.status === 'deleted' ? file.oldPath : file.path, side: file.status === 'deleted' ? 'old' : 'new', line: 1 })}>
          <span className="dir">{dir}</span>
          {file.path.slice(dir.length)}
        </button>
        {file.oldPath !== file.path && <span className="renamed-from">from {file.oldPath}</span>}
        {file.modeChange && <span className="renamed-from">mode {file.modeChange}</span>}
        <span className="counts"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
        <span className="spacer" />
        {hunks.length > 1 && (
          <label className="viewed-toggle">
            <input type="checkbox" checked={allViewed} onChange={(e) => useStore.getState().setViewed(hunks, e.target.checked)} /> All viewed
          </label>
        )}
      </header>
      {file.binary && <div className="file-note">Binary file. Nothing to show.</div>}
      {hidden && !file.binary && (
        <div className="file-note">
          Generated or lock file, hidden by default. <button className="link" onClick={() => setOpenGenerated(true)}>Show {hunks.length} hunks</button>
        </div>
      )}
      {!hidden &&
        (active ? (
          hunks.map((h) => (
            <HunkView
              // Keyed by content too: after a refresh the same label can name a different hunk.
              key={`${h.id}:${h.key}`}
              review={review}
              file={file}
              hunk={h}
              loaded={loaded}
              moves={moves}
              concerns={concerns.filter((c) => c.hunk === h.id)}
              notes={review.comments.filter((c) => c.path === file.path || c.path === file.oldPath)}
              viewed={viewed.has(h.key)}
              focused={focusHunk === h.id}
              collapseMoves={collapseMoves}
            />
          ))
        ) : (
          <div style={{ height: Math.min(estimated, 4000) }} />
        ))}
    </section>
  )
}

/** Floating actions for the code the reviewer has selected with the mouse. */
export function SelectionToolbar({ container }: { container: React.RefObject<HTMLElement | null> }) {
  const [state, setState] = useState<{ x: number; y: number; ctx: ChatContext } | null>(null)

  useEffect(() => {
    const el = container.current
    if (!el) return
    const onUp = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setState(null)
      const range = sel.getRangeAt(0)
      const rowOf = (node: Node) => (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>('tr[data-line]')
      const start = rowOf(range.startContainer)
      const end = rowOf(range.endContainer) ?? start
      if (!start || !end || !el.contains(start)) return setState(null)
      const code = sel.toString().trim()
      if (code.length < 2) return setState(null)
      // Anchor to where the selection ends, kept inside the diff pane so it never covers the side panel.
      const rects = range.getClientRects()
      const rect = rects[rects.length - 1] ?? range.getBoundingClientRect()
      const bounds = el.getBoundingClientRect()
      const a = Number(start.dataset.line)
      const b = Number(end.dataset.line)
      setState({
        x: Math.max(bounds.left + 8, Math.min(rect.right - 40, bounds.right - 300)),
        y: Math.min(rect.bottom + 6, window.innerHeight - 44),
        ctx: { path: start.dataset.path!, side: start.dataset.side as 'old' | 'new', startLine: Math.min(a, b), endLine: Math.max(a, b), hunk: start.dataset.hunk, code: code.slice(0, 12_000) },
      })
    }
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.selection-toolbar')) setState(null)
    }
    el.addEventListener('mouseup', onUp)
    document.addEventListener('mousedown', onDown)
    return () => {
      el.removeEventListener('mouseup', onUp)
      document.removeEventListener('mousedown', onDown)
    }
  }, [container])

  if (!state) return null
  const ask = (text: string, send: boolean) => {
    useStore.getState().askClaude(text, state.ctx, send)
    window.getSelection()?.removeAllRanges()
    setState(null)
  }
  return (
    <div className="selection-toolbar" style={{ left: state.x, top: state.y }}>
      <button onClick={() => ask('Explain what this code does and why it is here.', true)}>Explain</button>
      <button onClick={() => ask('', false)}>Ask Claude…</button>
      <button onClick={() => ask('Is there anything wrong or risky in this code? Check the surrounding code before answering.', true)}>Find problems</button>
    </div>
  )
}
