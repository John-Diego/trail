import type { ChatContext, Comment, FileContent, PendingChanges, Review, ReviewSummary, Settings, StreamEvent, SymbolResult, Thread } from '../../shared/types.ts'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    // The server only accepts state-changing requests declared as JSON, body or not.
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({ error: `Unexpected response (${res.status})` }))
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data as T
}

/** POST and read the server-sent event stream that comes back. */
async function stream(path: string, body: unknown, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `Request failed (${res.status})`)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)) as StreamEvent)
    }
  }
}

interface Job {
  status: 'running' | 'done' | 'error'
  message: string
  reviewId?: number
}

async function waitForJob(jobId: number, onProgress: (m: string) => void): Promise<number> {
  for (;;) {
    const job = await request<Job>('GET', `/jobs/${jobId}`)
    if (job.status === 'done') return job.reviewId!
    if (job.status === 'error') throw new Error(job.message)
    onProgress(job.message)
    await new Promise((r) => setTimeout(r, 400))
  }
}

export interface ChatBody {
  threadId?: number
  message: string
  context: ChatContext | null
  model: string
  effort: string
  mode: 'ask' | 'edit'
}

export const api = {
  reviews: () => request<ReviewSummary[]>('GET', '/reviews'),
  review: (id: number) => request<Review>('GET', `/reviews/${id}`),
  remove: (id: number) => request('DELETE', `/reviews/${id}`),
  async importReview(body: { kind: 'pr' | 'local'; ref?: string; path?: string; base?: string }, onProgress: (m: string) => void) {
    const { jobId } = await request<{ jobId: number }>('POST', '/reviews', body)
    return waitForJob(jobId, onProgress)
  },
  async refresh(id: number, onProgress: (m: string) => void) {
    const { jobId } = await request<{ jobId: number }>('POST', `/reviews/${id}/refresh`)
    return waitForJob(jobId, onProgress)
  },
  file: (id: number, idx: number) => request<FileContent>('GET', `/reviews/${id}/file?i=${idx}`),
  blob: (id: number, path: string, side: 'old' | 'new') =>
    request<{ text: string; known: string[] }>('GET', `/reviews/${id}/blob?path=${encodeURIComponent(path)}&side=${side}`),
  symbol: (id: number, name: string, path: string) =>
    request<SymbolResult>('GET', `/reviews/${id}/symbol?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`),
  setViewed: (id: number, keys: string[], viewed: boolean) => request('POST', `/reviews/${id}/viewed`, { keys, viewed }),
  addComment: (id: number, c: { path: string; side: string; line: number; inDiff: boolean; body: string; text?: string }) => request<Comment[]>('POST', `/reviews/${id}/comments`, c),
  updateComment: (id: number, commentId: number, patch: { body?: string; status?: string }) => request<Comment[]>('PUT', `/reviews/${id}/comments/${commentId}`, patch),
  deleteComment: (id: number, commentId: number) => request<Comment[]>('DELETE', `/reviews/${id}/comments/${commentId}`),
  threads: (id: number) => request<Thread[]>('GET', `/reviews/${id}/threads`),
  chat: (id: number, body: ChatBody, onEvent: (e: StreamEvent) => void, signal: AbortSignal) => stream(`/reviews/${id}/chat`, body, onEvent, signal),
  walkthrough: (id: number, s: Settings, onEvent: (e: StreamEvent) => void, signal: AbortSignal) => stream(`/reviews/${id}/walkthrough`, s, onEvent, signal),
  pending: (id: number) => request<PendingChanges>('GET', `/reviews/${id}/pending`),
  discardPending: (id: number) => request<PendingChanges>('DELETE', `/reviews/${id}/pending`),
  pushPending: (id: number, message: string) => request('POST', `/reviews/${id}/pending`, { message }),
  submit: (id: number, event: string, body: string) => request<{ url: string; comments: Comment[] }>('POST', `/reviews/${id}/submit`, { event, body }),
  settings: () => request<Settings>('GET', '/settings'),
  saveSettings: (s: Partial<Settings>) => request<Settings>('PUT', '/settings', s),
}
