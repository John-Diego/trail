import { useState } from 'react'
import type { Review } from '../../shared/types.ts'
import { api } from './api.ts'
import { useStore } from './store.ts'

const EVENTS = [
  { id: 'COMMENT', label: 'Comment' },
  { id: 'REQUEST_CHANGES', label: 'Request changes' },
  { id: 'APPROVE', label: 'Approve' },
]

export function Notes({ review }: { review: Review }) {
  const setComments = useStore((s) => s.setComments)
  const [summary, setSummary] = useState('')
  const [event, setEvent] = useState('COMMENT')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string; url?: string } | null>(null)

  const drafts = review.comments.filter((c) => c.status === 'draft')
  const inline = drafts.filter((c) => c.inDiff && !c.outdated).length
  const loose = drafts.length - inline

  const submit = async () => {
    setBusy(true)
    setResult(null)
    try {
      const r = await api.submit(review.id, event, summary)
      setComments(r.comments)
      setSummary('')
      setConfirm(false)
      setResult({ ok: true, text: 'Review posted to GitHub.', url: r.url })
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  // Puts the request in the chat box in Edit mode for the reader to check and send. The notes
  // are marked as sent by the chat, and only once Claude has actually handled the request.
  const draftForClaude = () => {
    const text = `Please address these review notes:\n\n${drafts.map((c) => `- ${c.path}:${c.line} — ${c.body}`).join('\n')}`
    useStore.getState().askClaude(text, null, false, 'edit', drafts.map((c) => c.id))
  }

  return (
    <div className="notes">
      <div className="notes-scroll">
        {!review.comments.length && (
          <div className="empty pad">
            <p><strong>No notes yet.</strong></p>
            <p>Hover a line in the diff and press <span className="kbd">+</span> to leave a note. Notes stay on your machine until you post them to GitHub or hand them to Claude.</p>
          </div>
        )}
        {review.comments.map((c) => (
          <div key={c.id} className={`note-row ${c.status}`}>
            <button className="link mono" onClick={() => useStore.getState().revealLine(c.path, c.line)}>{c.path}:{c.line}</button>
            <span className="pill">{c.status === 'draft' ? 'draft' : c.status === 'submitted' ? 'posted' : 'sent to Claude'}</span>
            {c.outdated && <span className="outdated">outdated</span>}
            <div className="note-body">{c.body}</div>
            <button className="link dim" onClick={async () => setComments(await api.deleteComment(review.id, c.id))}>Delete</button>
          </div>
        ))}
      </div>
      <div className="notes-actions">
        {result && (
          <div className={result.ok ? 'ok-line' : 'error-line'}>
            {result.text} {result.url && <a href={result.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
          </div>
        )}
        <button className="btn wide" disabled={!drafts.length} onClick={draftForClaude} title="Writes the request into the chat box in Edit mode. Nothing is sent until you press Send.">
          Draft a change request to Claude from {drafts.length || 'your'} note{drafts.length === 1 ? '' : 's'}
        </button>
        {review.kind === 'pr' && (
          <>
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} onKeyDown={(e) => e.stopPropagation()} rows={3} placeholder="Overall comment (optional)" />
            <div className="row">
              <select value={event} onChange={(e) => setEvent(e.target.value)}>
                {EVENTS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
              <span className="spacer" />
              {!confirm && <button className="btn primary" disabled={busy || (!drafts.length && !summary.trim() && event !== 'APPROVE')} onClick={() => setConfirm(true)}>Submit to GitHub…</button>}
            </div>
            {confirm && (
              <div className="confirm">
                <p>
                  This posts a review on {review.repoLabel}#{review.number} as you: “{EVENTS.find((e) => e.id === event)!.label}”
                  {inline > 0 && `, ${inline} inline comment${inline === 1 ? '' : 's'}`}
                  {loose > 0 && `, ${loose} note${loose === 1 ? '' : 's'} on lines outside the diff or on code that has since changed, folded into the summary`}. Everyone on the pull request will see it.
                </p>
                <div className="row">
                  <button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
                  <button className="btn danger" disabled={busy} onClick={submit}>{busy ? 'Posting…' : 'Post review'}</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
