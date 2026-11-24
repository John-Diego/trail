import { useEffect, useState } from 'react'
import type { ReviewSummary } from '../../shared/types.ts'
import { api } from './api.ts'
import { ReviewPage } from './ReviewPage.tsx'

function useRoute(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

function ago(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`
  return `${Math.round(min / 1440)} d ago`
}

function Home() {
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null)
  const [ref, setRef] = useState('')
  const [base, setBase] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)

  const load = () => api.reviews().then(setReviews, (e: Error) => setError(e.message))
  useEffect(() => void load(), [])

  const value = ref.trim()
  const isLocal = /^[~/.]/.test(value)

  const open = async () => {
    if (!value) return
    setError(null)
    setProgress('Starting')
    try {
      const id = await api.importReview(isLocal ? { kind: 'local', path: value, base: base.trim() || undefined } : { kind: 'pr', ref: value }, setProgress)
      window.location.hash = `#/r/${id}`
    } catch (e) {
      setError((e as Error).message)
    }
    setProgress(null)
  }

  return (
    <div className="home">
      <h1>Trail</h1>
      <p className="lead">Review a pull request in the order its logic runs, with moved code folded away, one-click navigation, and Claude Code beside the diff.</p>
      <form
        className="open-form"
        onSubmit={(e) => {
          e.preventDefault()
          void open()
        }}
      >
        <input autoFocus value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Pull request address, owner/repo/123, or the path of a local repository" disabled={!!progress} />
        {isLocal && <input className="base" value={base} onChange={(e) => setBase(e.target.value)} placeholder="Base branch (default: main)" disabled={!!progress} />}
        <button className="btn primary" disabled={!value || !!progress}>{isLocal ? 'Review local changes' : 'Open pull request'}</button>
      </form>
      {progress && <div className="working"><span className="spinner" /> {progress}</div>}
      {error && <div className="error-line">{error}</div>}
      <p className="hint">
        Pull requests are read with your <span className="mono">gh</span> login. You can paste a GitHub address, or write <span className="mono">owner/repo/123</span>, or just <span className="mono">repo 123</span> when a default owner is set. A path starting with <span className="mono">/</span>, <span className="mono">~</span> or <span className="mono">.</span> reviews that local repository's current branch against its base, including uncommitted changes.
      </p>

      {reviews && reviews.length > 0 && (
        <>
          <h2>Reviews</h2>
          <div className="review-list">
            {reviews.map((r) => (
              <a key={r.id} className="review-card" href={`#/r/${r.id}`}>
                <div className="t">{r.title}</div>
                <div className="sub">
                  <span className="mono">{r.repoLabel}{r.number ? `#${r.number}` : ` · ${r.headRef}`}</span>
                  <span>{r.fileCount} files</span>
                  <span><span className="add">+{r.additions}</span> <span className="del">−{r.deletions}</span></span>
                  <span>{r.viewedCount}/{r.hunkCount} viewed</span>
                  <span>{ago(r.updatedAt)}</span>
                </div>
                <div className="progress-bar"><div style={{ width: `${r.hunkCount ? (r.viewedCount / r.hunkCount) * 100 : 0}%` }} /></div>
                <button
                  className="link dim remove"
                  title="Deletes your notes and viewed marks for this review. Nothing changes on GitHub or in your repository."
                  onClick={async (e) => {
                    e.preventDefault()
                    if (removing !== r.id) return setRemoving(r.id)
                    await api.remove(r.id)
                    setRemoving(null)
                    void load()
                  }}
                  onBlur={() => setRemoving(null)}
                >
                  {removing === r.id ? "Click again to remove" : "Remove"}
                </button>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function App() {
  const hash = useRoute()
  const m = /^#\/r\/(\d+)/.exec(hash)
  return m ? <ReviewPage id={Number(m[1])} /> : <Home />
}
