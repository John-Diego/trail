import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chapter, FileDiff, Hunk, Review, Walkthrough } from '../../shared/types.ts'
import { api } from './api.ts'
import { Chat } from './Chat.tsx'
import { FileSection, SelectionToolbar, hunkContext } from './DiffView.tsx'
import { Markdown } from './Markdown.tsx'
import { ModelPicker, cycle, settingsLabel } from './ModelPicker.tsx'
import { Notes } from './Notes.tsx'
import { Peek } from './Peek.tsx'
import { activeWalkthrough, hunkIndex, useStore, type HunkRef } from './store.ts'

/** Consecutive hunks of the same file share one file header. */
function groupByFile(refs: HunkRef[]): { file: FileDiff; hunks: Hunk[] }[] {
  const groups: { file: FileDiff; hunks: Hunk[] }[] = []
  for (const r of refs) {
    const last = groups[groups.length - 1]
    if (last && last.file.idx === r.file.idx) last.hunks.push(r.hunk)
    else groups.push({ file: r.file, hunks: [r.hunk] })
  }
  return groups
}

/** Source first, tests after, generated files last: the order to read files in when there is no walkthrough. */
function fileOrder(files: FileDiff[]): FileDiff[] {
  const rank = (f: FileDiff) => (f.generated || f.binary ? 2 : /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\./i.test(f.path) ? 1 : 0)
  return [...files].sort((a, b) => rank(a) - rank(b) || a.idx - b.idx)
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div className="progress" title={`${done} of ${total} hunks viewed`}>
      <div className="progress-bar"><div style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
      <span>{done}/{total} viewed</span>
    </div>
  )
}

function WalkthroughButton({ review, label }: { review: Review; label: string }) {
  const settings = useStore((s) => s.settings)
  const run = useStore((s) => s.wtRun)
  const error = useStore((s) => s.wtError)

  if (run && run.reviewId === review.id)
    return (
      <div className="wt-running">
        <span className="spinner" /> <span className="wt-status">{run.status}</span>
        <button className="btn tiny" onClick={() => useStore.getState().stopWalkthrough()}>Stop</button>
      </div>
    )
  return (
    <div className="wt-cta">
      <button className="btn primary" disabled={!!run} onClick={() => useStore.getState().startWalkthrough(review.id)}>{label}</button>
      <span className="hint">{run ? 'Another walkthrough is being written.' : `Uses ${settingsLabel(settings.model, settings.effort)}. Larger changes take a few minutes.`}</span>
      {error && <div className="error-line">{error}</div>}
    </div>
  )
}

function Overview({ review, wt }: { review: Review; wt: Walkthrough | null }) {
  const setChapter = useStore((s) => s.setChapter)
  const movedLines = review.moves.reduce((n, m) => n + m.lines, 0)
  const stale = review.walkthrough && !wt
  const index = useMemo(() => hunkIndex(review), [review])
  return (
    <div className="overview">
      <h1>{review.title}</h1>
      <div className="overview-meta">
        <span className="mono">{review.repoLabel}{review.number ? `#${review.number}` : ''}</span>
        {review.author && <span>by {review.author}</span>}
        <span className="mono">{review.headRef} → {review.baseRef}</span>
        {review.url && <a href={review.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
      </div>
      <div className="stats">
        <div><b>{review.fileCount}</b> files</div>
        <div><b>{review.hunkCount}</b> hunks</div>
        <div><b className="add">+{review.additions}</b> <b className="del">−{review.deletions}</b></div>
        {movedLines > 0 && <div title="Lines that were moved without being edited. They are folded in the diff."><b>{movedLines}</b> lines only moved ({review.moves.length} block{review.moves.length === 1 ? '' : 's'})</div>}
      </div>

      {wt ? (
        <>
          <h2>What this change does</h2>
          <Markdown text={wt.summary} />
          {wt.concerns.length > 0 && (
            <>
              <h2>Things to check ({wt.concerns.length})</h2>
              <div className="concern-list">
                {wt.concerns.map((c, i) => {
                  const ref = index.get(c.hunk)
                  return (
                    <div key={i} className={`concern ${c.severity}`}>
                      <strong>{c.severity === 'bug' ? 'Possible bug' : c.severity === 'warn' ? 'Check this' : 'Note'}</strong> <Markdown text={c.note} />
                      {ref && <button className="link mono concern-where" onClick={() => useStore.getState().reveal(c.hunk)}>{ref.file.path} · {c.hunk}</button>}
                    </div>
                  )
                })}
              </div>
            </>
          )}
          <h2>Reading order</h2>
          <ol className="chapter-list">
            {wt.chapters.map((c, i) => (
              <li key={i}>
                <button onClick={() => setChapter(i)}>
                  <span className={`risk ${c.risk}`} title={`${c.risk} risk`} />
                  <span className="t">{c.title}</span>
                  <span className="dim">{c.hunks.length} hunk{c.hunks.length === 1 ? '' : 's'}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="row">
            <button className="btn primary" onClick={() => setChapter(0)}>Start reading →</button>
            <WalkthroughButton review={review} label="Regenerate" />
          </div>
          <p className="hint">Walkthrough written by {settingsLabel(wt.model, wt.effort)}. It is a reading aid: every hunk is still shown, files without a text diff included, and anything it did not place is listed in its own chapter.</p>
        </>
      ) : (
        <div className="wt-empty">
          <h2>{stale ? 'The walkthrough is out of date' : 'Get a guided walkthrough'}</h2>
          <p>
            {stale
              ? 'The change is different from the one the walkthrough was written for.'
              : 'Claude reads the change and the code around it, then orders the hunks into chapters that follow the logic: data shapes first, then the core change, callers, tests, and mechanical follow-ups. Code that only moved is set apart.'}
          </p>
          <WalkthroughButton review={review} label={stale ? 'Regenerate walkthrough' : 'Generate walkthrough'} />
          <p className="hint">Or read file by file: switch to <button className="link" onClick={() => useStore.getState().setView('files')}>Files</button>.</p>
        </div>
      )}

      {review.body.trim() && (
        <>
          <h2>Author’s description</h2>
          <Markdown text={review.body} />
        </>
      )}
      {review.commits.length > 0 && (
        <>
          <h2>Commits ({review.commits.length})</h2>
          <ul className="commits">{review.commits.map((c) => <li key={c.sha}><span className="mono dim">{c.sha}</span> {c.subject}</li>)}</ul>
        </>
      )}
    </div>
  )
}

function ChapterView({ review, wt, index, chapter }: { review: Review; wt: Walkthrough; index: number; chapter: Chapter }) {
  const viewed = useStore((s) => s.viewed)
  const all = useMemo(() => hunkIndex(review), [review])
  const refs = chapter.hunks.map((id) => all.get(id)).filter((r): r is HunkRef => !!r)
  const groups = groupByFile(refs)
  const done = refs.filter((r) => viewed.has(r.hunk.key)).length
  const last = index === wt.chapters.length - 1
  const store = useStore.getState
  return (
    <>
      <div className="chapter-head">
        <div className="chapter-kicker">
          Chapter {index + 1} of {wt.chapters.length}
          <span className={`risk-label ${chapter.risk}`}>{chapter.risk} risk</span>
          <span className="dim">{done}/{refs.length} viewed</span>
        </div>
        <h1>{chapter.title}</h1>
        <Markdown text={chapter.narrative} />
        {chapter.focus && <div className="focus"><strong>Check</strong> <Markdown text={chapter.focus} /></div>}
      </div>
      {groups.map((g, i) => <FileSection key={`${index}:${i}:${g.file.idx}`} review={review} file={g.file} hunks={g.hunks} concerns={wt.concerns} />)}
      <div className="chapter-foot">
        <button className="btn ghost" onClick={() => store().setChapter(index - 1)}>← {index === 0 ? 'Overview' : 'Previous'}</button>
        <button
          className="btn primary"
          onClick={() => {
            store().setViewed(refs.map((r) => r.hunk), true)
            store().setChapter(last ? -1 : index + 1)
          }}
        >
          {last ? 'Mark viewed and finish' : 'Mark viewed and continue →'}
        </button>
      </div>
    </>
  )
}

function Sidebar({ review, wt }: { review: Review; wt: Walkthrough | null }) {
  const view = useStore((s) => s.view)
  const chapter = useStore((s) => s.chapter)
  const viewed = useStore((s) => s.viewed)
  const setChapter = useStore((s) => s.setChapter)
  const setView = useStore((s) => s.setView)
  const all = useMemo(() => hunkIndex(review), [review])
  const files = useMemo(() => fileOrder(review.files), [review.files])

  return (
    <aside className="sidebar">
      <div className="tabs">
        <button className={view === 'walkthrough' ? 'on' : ''} onClick={() => setView('walkthrough')}>Walkthrough</button>
        <button className={view === 'files' ? 'on' : ''} onClick={() => setView('files')}>Files ({review.fileCount})</button>
      </div>
      <div className="sidebar-scroll">
        {view === 'walkthrough' ? (
          <>
            <button className={`nav-item${chapter === -1 ? ' on' : ''}`} onClick={() => setChapter(-1)}>
              <span className="t">Overview</span>
            </button>
            {wt ? (
              wt.chapters.map((c, i) => {
                const keys = c.hunks.map((id) => all.get(id)?.hunk.key).filter(Boolean) as string[]
                const done = keys.filter((k) => viewed.has(k)).length
                return (
                  <button key={i} className={`nav-item${chapter === i ? ' on' : ''}${done === keys.length ? ' done' : ''}`} onClick={() => setChapter(i)}>
                    <span className="num">{done === keys.length ? '✓' : i + 1}</span>
                    <span className="t">{c.title}</span>
                    <span className={`risk ${c.risk}`} title={`${c.risk} risk`} />
                    <span className="count">{done}/{keys.length}</span>
                  </button>
                )
              })
            ) : (
              <p className="hint pad">No walkthrough yet. Generate one from the overview.</p>
            )}
          </>
        ) : (
          files.map((f) => {
            const done = f.hunks.filter((h) => viewed.has(h.key)).length
            const name = f.path.split('/').pop()
            return (
              <button
                key={f.idx}
                className={`nav-item is-file${f.hunks.length && done === f.hunks.length ? ' done' : ''}`}
                title={f.path}
                onClick={() => document.querySelector(`[data-file="${f.idx}"]`)?.scrollIntoView({ block: 'start' })}
              >
                <span className={`status-dot ${f.status}`} />
                <span className="t">
                  {name}
                  <span className="dir">{f.path.slice(0, f.path.length - name!.length)}</span>
                </span>
                <span className="count"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>
              </button>
            )
          })
        )}
      </div>
    </aside>
  )
}

const SHORTCUTS: [string, string][] = [
  ['j / k', 'Next / previous hunk'],
  ['v', 'Mark hunk viewed and move on'],
  ['n / p', 'Next / previous chapter'],
  ['x', 'Explain the focused hunk'],
  ['a', 'Ask about the focused hunk'],
  ['/', 'Go to the chat box'],
  ['m / e', 'Next model / next effort level'],
  ['f', 'Fold or unfold moved code'],
  ['1 2 3', 'Claude, Navigate, Notes panel'],
  ['[ / ]', 'Back / forward in Navigate'],
  ['?', 'Show or hide this list'],
]

export function ReviewPage({ id }: { id: number }) {
  const review = useStore((s) => s.review)
  const error = useStore((s) => s.error)
  const view = useStore((s) => s.view)
  const chapterIdx = useStore((s) => s.chapter)
  const panel = useStore((s) => s.panel)
  const viewed = useStore((s) => s.viewed)
  const collapseMoves = useStore((s) => s.collapseMoves)
  const scrollNonce = useStore((s) => s.scrollNonce)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const pane = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void useStore.getState().load(id)
  }, [id])

  const refresh = useCallback(async () => {
    setRefreshing('Refreshing')
    setRefreshError(null)
    try {
      await api.refresh(id, setRefreshing)
      await useStore.getState().load(id)
    } catch (e) {
      setRefreshError((e as Error).message)
    }
    setRefreshing(null)
  }, [id])

  const wt = review && review.id === id ? activeWalkthrough(review) : null
  const chapter = wt && chapterIdx >= 0 ? wt.chapters[chapterIdx] : null

  // Hunks on screen in reading order, for keyboard movement.
  const visible = useMemo<HunkRef[]>(() => {
    if (!review) return []
    const all = hunkIndex(review)
    if (view === 'walkthrough') return chapter ? chapter.hunks.map((h) => all.get(h)).filter((r): r is HunkRef => !!r) : []
    return fileOrder(review.files).flatMap((file) => file.hunks.map((hunk) => ({ file, hunk })))
  }, [review, view, chapter])

  useEffect(() => {
    if (!useStore.getState().focusHunk) pane.current?.scrollTo({ top: 0 })
  }, [chapterIdx, view, scrollNonce])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return
      const s = useStore.getState()
      const at = visible.findIndex((r) => r.hunk.id === s.focusHunk)
      const move = (d: number) => {
        const next = visible[Math.max(0, Math.min(visible.length - 1, at + d))]
        if (next) s.focus(next.hunk.id, true)
      }
      const current = visible[at]
      const chapters = wt?.chapters.length ?? 0
      switch (e.key) {
        case 'j': move(1); break
        case 'k': move(-1); break
        case 'v':
          if (current) {
            const was = s.viewed.has(current.hunk.key)
            s.setViewed([current.hunk], !was)
            if (!was) move(1)
          }
          break
        case 'n': if (s.view === 'walkthrough' && s.chapter < chapters - 1) s.setChapter(s.chapter + 1); break
        case 'p': if (s.view === 'walkthrough' && s.chapter > -1) s.setChapter(s.chapter - 1); break
        case 'x': if (current) s.askClaude('Explain this hunk: what it does, why this change needs it, and anything that looks risky or wrong.', hunkContext(current.file, current.hunk), true); break
        case 'a': if (current) s.askClaude('', hunkContext(current.file, current.hunk), false); break
        case '/': s.setPanel('chat'); setTimeout(() => document.getElementById('chat-input')?.focus()); break
        case 'm': cycle('model'); break
        case 'e': cycle('effort'); break
        case 'f': s.toggleCollapseMoves(); break
        case '1': s.setPanel('chat'); break
        case '2': s.setPanel('peek'); break
        case '3': s.setPanel('notes'); break
        case '[': s.peekGo(-1); break
        case ']': s.peekGo(1); break
        case '?': setHelp((h) => !h); break
        case 'Escape': setHelp(false); break
        default: return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, wt])

  if (error) return <div className="center-msg"><p>{error}</p><a href="#/">Back to reviews</a></div>
  if (!review || review.id !== id) return <div className="center-msg">Loading review…</div>

  const allHunks = review.files.flatMap((f) => f.hunks)
  const done = allHunks.filter((h) => viewed.has(h.key)).length
  const drafts = review.comments.filter((c) => c.status === 'draft').length

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" title="All reviews">Trail</a>
        <div className="title">
          <span className="t">{review.title}</span>
          <span className="sub mono">{review.repoLabel}{review.number ? `#${review.number}` : ` · ${review.headRef}`}</span>
        </div>
        <Progress done={done} total={allHunks.length} />
        <span className="spacer" />
        {review.moves.length > 0 && (
          <label className="toggle" title="Fold code that was moved without being edited (f)">
            <input type="checkbox" checked={collapseMoves} onChange={() => useStore.getState().toggleCollapseMoves()} /> Fold moved code
          </label>
        )}
        <button className="btn" onClick={refresh} disabled={!!refreshing} title="Fetch new commits or working tree changes">{refreshing ?? 'Refresh'}</button>
        <ModelPicker />
        <button className="btn icon" onClick={() => setHelp(!help)} title="Keyboard shortcuts (?)">?</button>
      </header>
      {refreshError && <div className="banner error">{refreshError} <button className="link" onClick={() => setRefreshError(null)}>Dismiss</button></div>}
      <div className="body">
        <Sidebar review={review} wt={wt} />
        <main
          className="diff-pane"
          ref={pane}
          onClick={(e) => {
            const sym = (e.target as HTMLElement).closest<HTMLElement>('.sym')
            if (!sym || !window.getSelection()?.isCollapsed) return
            const row = sym.closest<HTMLElement>('tr[data-path]')
            useStore.getState().peek({ kind: 'symbol', name: sym.textContent!, fromPath: row?.dataset.path ?? '' })
          }}
        >
          {view === 'walkthrough' ? (
            chapter && wt ? <ChapterView review={review} wt={wt} index={chapterIdx} chapter={chapter} /> : <Overview review={review} wt={wt} />
          ) : (
            fileOrder(review.files).map((f) => <FileSection key={f.idx} review={review} file={f} hunks={f.hunks} concerns={wt?.concerns ?? []} />)
          )}
          <SelectionToolbar container={pane} />
        </main>
        <aside className="right">
          <div className="tabs">
            <button className={panel === 'chat' ? 'on' : ''} onClick={() => useStore.getState().setPanel('chat')}>Claude</button>
            <button className={panel === 'peek' ? 'on' : ''} onClick={() => useStore.getState().setPanel('peek')}>Navigate</button>
            <button className={panel === 'notes' ? 'on' : ''} onClick={() => useStore.getState().setPanel('notes')}>Notes{drafts ? ` (${drafts})` : ''}</button>
          </div>
          {/* The chat stays mounted so an answer keeps streaming while you look something up. */}
          <div className="panel" hidden={panel !== 'chat'}><Chat review={review} onRefresh={refresh} /></div>
          {panel === 'peek' && <div className="panel"><Peek review={review} /></div>}
          {panel === 'notes' && <div className="panel"><Notes review={review} /></div>}
        </aside>
      </div>
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Keyboard shortcuts</h2>
            <dl>{SHORTCUTS.map(([k, d]) => <div key={k}><dt className="kbd">{k}</dt><dd>{d}</dd></div>)}</dl>
            <p className="hint">Click any underlined name in the diff to see its definition and usages. Select code to ask Claude about it.</p>
          </div>
        </div>
      )}
    </div>
  )
}
