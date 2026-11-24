import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatContext, ChatMessage, ChatPart, Comment, PendingChanges, Review, Thread } from '../../shared/types.ts'
import { api } from './api.ts'
import { Markdown } from './Markdown.tsx'
import { ModelPicker, settingsLabel } from './ModelPicker.tsx'
import { useStore } from './store.ts'

const STARTERS = [
  'Summarise this change in five bullet points, most important first.',
  'What are the riskiest parts of this change, and why?',
  'Is anything here dead code, duplicated, or more complicated than it needs to be?',
  'What is not covered by the tests in this change?',
]

function Parts({ parts }: { parts: ChatPart[] }) {
  const out: React.ReactNode[] = []
  let tools: string[] = []
  const flush = (key: number) => {
    if (!tools.length) return
    const list = tools
    out.push(
      <details className="tools" key={`t${key}`}>
        <summary>{list.length === 1 ? list[0] : `${list[list.length - 1]} · ${list.length} steps`}</summary>
        {list.length > 1 && <ul>{list.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      </details>,
    )
    tools = []
  }
  parts.forEach((p, i) => {
    if (p.type === 'tool') return void tools.push(p.text)
    flush(i)
    if (p.text.trim()) out.push(<Markdown key={i} text={p.text} />)
  })
  flush(parts.length)
  return <>{out}</>
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'user')
    return (
      <div className="msg user">
        {m.context && <div className="ctx-chip">{m.context}</div>}
        <div className="bubble">{m.parts.map((p) => p.text).join('')}</div>
      </div>
    )
  return (
    <div className="msg assistant">
      <Parts parts={m.parts} />
      {m.error && <div className="error-line">{m.error}</div>}
      <div className="msg-meta">
        {m.mode === 'edit' && <span className="pill accent">edit</span>}
        {m.model && <span>{settingsLabel(m.model, m.effort ?? 'default')}</span>}
        {m.costUsd !== undefined && <span>${m.costUsd.toFixed(m.costUsd < 0.1 ? 3 : 2)}</span>}
      </div>
    </div>
  )
}

function Pending({ review, pending, reload }: { review: Review; pending: PendingChanges; reload: () => void }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [message, setMessage] = useState('Address review feedback')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pending">
      <div className="pending-head">
        <strong>{pending.files.length} file{pending.files.length === 1 ? '' : 's'} changed in the review checkout</strong>
        <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide diff' : 'Show diff'}</button>
      </div>
      <div className="pending-files">{pending.files.map((f) => <span key={f.path} className="mono">{f.path}</span>)}</div>
      {open && (
        <pre className="raw-diff">
          {pending.diff.split('\n').map((l, i) => (
            <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'at' : ''}>{l + '\n'}</span>
          ))}
        </pre>
      )}
      {error && <div className="error-line">{error}</div>}
      {confirm ? (
        <div className="confirm">
          {pending.truncated && <p><strong>The diff above is cut short.</strong> It does not show everything that will be pushed; inspect the checkout at <span className="mono">{review.workDir}</span> first.</p>}
          <p>This commits the changes above and pushes them to <span className="mono">{review.headRef}</span> on {review.repoLabel}, as you. It cannot be undone from here.</p>
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" />
          <div className="row">
            <button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn danger" disabled={busy || !message.trim()} onClick={() => act(async () => { await api.pushPending(review.id, message); setConfirm(false) })}>Commit and push</button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn ghost" disabled={busy} onClick={() => act(() => api.discardPending(review.id))}>Discard changes</button>
          {review.canPush ? (
            <button className="btn" disabled={busy} onClick={() => setConfirm(true)}>Commit and push…</button>
          ) : (
            <span className="hint">This pull request comes from a fork, so Trail cannot push to it. The checkout is at {review.workDir}.</span>
          )}
        </div>
      )}
    </div>
  )
}

export function Chat({ review, onRefresh }: { review: Review; onRefresh: () => void }) {
  const settings = useStore((s) => s.settings)
  const request = useStore((s) => s.chatRequest)
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadId, setThreadId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [context, setContext] = useState<ChatContext | null>(null)
  const [mode, setMode] = useState<'ask' | 'edit'>('ask')
  const [live, setLive] = useState<{ user: ChatMessage; parts: ChatPart[]; status: string } | null>(null)
  const [pending, setPending] = useState<PendingChanges | null>(null)
  const [editedLocal, setEditedLocal] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // Notes the text in the box was drafted from, until that text is sent or the box is cleared.
  const [noteIds, setNoteIds] = useState<number[] | null>(null)
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const handled = useRef(0)

  const loadPending = useCallback(() => {
    if (review.kind === 'pr') api.pending(review.id).then(setPending, () => setPending(null))
  }, [review.id, review.kind])

  useEffect(() => {
    api.threads(review.id).then((t) => {
      setThreads(t)
      setThreadId(t.length ? t[t.length - 1].id : null)
    })
    loadPending()
  }, [review.id, loadPending])

  const thread = threads.find((t) => t.id === threadId)
  const messages = thread?.messages ?? []

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, live?.parts, threadId])

  const send = useCallback(
    // fromBox: the text came from the chat box, which is then cleared. Requests sent by buttons
    // elsewhere (Explain, starters) leave whatever the reader was typing alone.
    async (text: string, ctx: ChatContext | null, sendMode: 'ask' | 'edit', notes: number[] | null = null, fromBox = false) => {
      if (!text.trim() || abort.current) return
      setFailure(null)
      if (fromBox) setNoteIds(null)
      let failed: string | null = null
      const controller = new AbortController()
      abort.current = controller
      const shown = ctx ? `${ctx.path}:${ctx.startLine}${ctx.endLine !== ctx.startLine ? `-${ctx.endLine}` : ''}` : undefined
      const user: ChatMessage = { id: -1, role: 'user', parts: [{ type: 'text', text }], context: shown, createdAt: Date.now() }
      const parts: ChatPart[] = []
      let status = 'Starting Claude'
      let frame = 0
      let finished = false
      const paint = () => {
        if (frame || finished) return
        frame = requestAnimationFrame(() => {
          frame = 0
          // A frame can fire long after it was requested when the tab is in the background;
          // by then the answer may be complete and must not be shown as still in progress.
          if (!finished) setLive({ user, parts: parts.map((p) => ({ ...p })), status })
        })
      }
      setLive({ user, parts: [], status })
      if (fromBox) {
        setDraft('')
        setContext(null)
      }
      let newThread = threadId
      try {
        await api.chat(
          review.id,
          { threadId: threadId ?? undefined, message: text, context: ctx, model: settings.model, effort: settings.effort, mode: sendMode },
          (e) => {
            if (e.type === 'text') {
              const last = parts[parts.length - 1]
              if (last?.type === 'text') last.text += e.text
              else parts.push({ type: 'text', text: e.text })
              status = ''
            } else if (e.type === 'tool') {
              parts.push({ type: 'tool', text: e.text })
              status = e.text
            } else if (e.type === 'status') status = e.text
            else if (e.type === 'error') failed = e.message
            else if (e.type === 'done' && e.threadId) newThread = e.threadId
            paint()
          },
          controller.signal,
        )
      } catch (e) {
        if (!controller.signal.aborted) failed = (e as Error).message
      }
      finished = true
      cancelAnimationFrame(frame)
      abort.current = null
      const fresh = await api.threads(review.id).catch(() => threads)
      setThreads(fresh)
      const shownId = newThread ?? fresh[fresh.length - 1]?.id ?? null
      setThreadId(shownId)
      setLive(null)
      // The server saves most failures on the message itself. Show the rest here, and give the text back.
      const last = fresh.find((t) => t.id === shownId)?.messages.at(-1)
      if (failed && !last?.error) {
        setFailure(failed)
        if (fromBox) {
          setDraft(text)
          setContext(ctx)
          setNoteIds(notes)
        }
      }
      if (notes?.length && !failed && !controller.signal.aborted) {
        let latest: Comment[] | null = null
        for (const id of notes) latest = await api.updateComment(review.id, id, { status: 'sent' }).catch(() => latest)
        if (latest) useStore.getState().setComments(latest)
        // A request drafted from notes is a one-off; later messages should not edit files by surprise.
        setMode('ask')
      }
      if (sendMode === 'edit') {
        if (review.kind === 'pr') loadPending()
        else setEditedLocal(true)
      }
    },
    [review.id, review.kind, threadId, threads, settings.model, settings.effort, loadPending],
  )

  // Questions asked from buttons in the diff arrive through the store.
  useEffect(() => {
    if (!request || request.nonce === handled.current) return
    handled.current = request.nonce
    if (request.mode) setMode(request.mode)
    if (request.send) void send(request.text, request.context, request.mode ?? 'ask')
    else {
      setContext(request.context)
      if (request.text) setDraft(request.text)
      setNoteIds(request.noteIds ?? null)
      input.current?.focus()
    }
  }, [request, send])

  const busy = !!live
  return (
    <div className="chat">
      <div className="chat-head">
        <select value={threadId ?? ''} onChange={(e) => setThreadId(e.target.value ? Number(e.target.value) : null)} disabled={busy}>
          <option value="">New conversation</option>
          {threads.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        {threadId !== null && <button className="btn tiny" disabled={busy} onClick={() => setThreadId(null)}>New</button>}
      </div>
      <div className="chat-scroll" ref={scroller}>
        {!messages.length && !live && (
          <div className="starters">
            <p>Ask Claude Code about this change. It reads the repository at the head commit, so it can check its answers against the real code.</p>
            {STARTERS.map((s) => <button key={s} onClick={() => send(s, null, 'ask')}>{s}</button>)}
          </div>
        )}
        {messages.map((m) => <Message key={m.id} m={m} />)}
        {live && (
          <>
            <Message m={live.user} />
            <div className="msg assistant">
              <Parts parts={live.parts} />
              <div className="working"><span className="spinner" /> {live.status || 'Writing'}</div>
            </div>
          </>
        )}
        {failure && !busy && <div className="error-line">Claude could not answer: {failure}</div>}
        {pending?.dirty && !busy && <Pending review={review} pending={pending} reload={loadPending} />}
        {editedLocal && !busy && (
          <div className="pending">
            <strong>Claude edited files in your working tree.</strong>
            <div className="row">
              <span className="hint">Refresh to review the result, including what Claude just changed.</span>
              <button className="btn" onClick={() => { setEditedLocal(false); onRefresh() }}>Refresh review</button>
            </div>
          </div>
        )}
      </div>
      <div className="composer">
        {context && (
          <div className="ctx-chip removable">
            {context.path.split('/').pop()}:{context.startLine}{context.endLine !== context.startLine ? `–${context.endLine}` : ''}
            <button onClick={() => setContext(null)} aria-label="Remove attached code">×</button>
          </div>
        )}
        {noteIds && (
          <div className="ctx-chip removable" title="When Claude has handled this request, these notes are marked as sent and left out of a GitHub review.">
            From {noteIds.length} note{noteIds.length === 1 ? '' : 's'}
            <button onClick={() => setNoteIds(null)} aria-label="Detach the notes from this message">×</button>
          </div>
        )}
        <textarea
          ref={input}
          id="chat-input"
          value={draft}
          rows={3}
          placeholder={mode === 'edit' ? 'Describe the change you want Claude to make…' : context ? 'Ask about the attached code…' : 'Ask about this change…'}
          onChange={(e) => {
            setDraft(e.target.value)
            // An emptied box is no longer the request that was drafted from the notes.
            if (!e.target.value.trim()) setNoteIds(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send(draft, context, mode, noteIds, true)
            }
            if (e.key === 'Escape') (e.target as HTMLElement).blur()
          }}
        />
        <div className="composer-bar">
          <div className="seg" title="Ask: Claude can only read. Edit: Claude may change files in the review checkout.">
            <button className={mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')}>Ask</button>
            <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>Edit</button>
          </div>
          <ModelPicker />
          <span className="spacer" />
          {busy ? (
            <button className="btn" onClick={() => abort.current?.abort()}>Stop</button>
          ) : (
            <button className="btn primary" disabled={!draft.trim()} onClick={() => send(draft, context, mode, noteIds, true)}>Send</button>
          )}
        </div>
        {mode === 'edit' && (
          <div className="hint">
            {review.kind === 'pr' ? 'Edits go into Trail’s own checkout of this pull request. Nothing is pushed until you say so.' : 'Edits are made directly in your working tree.'}
          </div>
        )}
      </div>
    </div>
  )
}
