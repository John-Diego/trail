import { create } from 'zustand'
import { DEFAULT_SETTINGS, type ChatContext, type Comment, type FileDiff, type Hunk, type Review, type Settings, type Walkthrough } from '../../shared/types.ts'
import { api } from './api.ts'

export type PeekTarget =
  | { kind: 'symbol'; name: string; fromPath: string }
  | { kind: 'location'; path: string; side: 'old' | 'new'; line: number; endLine?: number; label?: string }

export type Panel = 'chat' | 'peek' | 'notes'

/** A question queued for the chat panel by a button elsewhere in the UI. */
export interface ChatRequest {
  text: string
  context: ChatContext | null
  mode?: 'ask' | 'edit'
  send: boolean
  /** Draft notes this request was written from; marked as sent once Claude has handled it. */
  noteIds?: number[]
  nonce: number
}

interface State {
  review: Review | null
  error: string | null
  settings: Settings
  view: 'walkthrough' | 'files'
  /** -1 is the overview page. */
  chapter: number
  focusHunk: string | null
  /** Bumped to ask the diff pane to scroll the focused hunk into view. */
  scrollNonce: number
  viewed: Set<string>
  collapseMoves: boolean
  panel: Panel
  peekStack: PeekTarget[]
  peekIndex: number
  chatRequest: ChatRequest | null
  /** A walkthrough being generated. Kept here so it survives moving around the review. */
  wtRun: { reviewId: number; status: string } | null
  wtError: string | null

  startWalkthrough: (reviewId: number) => Promise<void>
  stopWalkthrough: () => void
  load: (id: number) => Promise<void>
  setSettings: (s: Partial<Settings>) => void
  setView: (v: State['view']) => void
  setChapter: (i: number) => void
  focus: (hunkId: string | null, scroll?: boolean) => void
  reveal: (hunkId: string) => void
  revealLine: (path: string, line: number) => boolean
  setViewed: (hunks: Hunk[], viewed: boolean) => void
  toggleCollapseMoves: () => void
  setPanel: (p: Panel) => void
  peek: (t: PeekTarget) => void
  peekGo: (delta: number) => void
  askClaude: (text: string, context: ChatContext | null, send: boolean, mode?: 'ask' | 'edit', noteIds?: number[]) => void
  setComments: (c: Comment[]) => void
  setWalkthrough: (w: Walkthrough | null) => void
}

let loadSeq = 0
let wtAbort: AbortController | null = null

export const useStore = create<State>((set, get) => ({
  review: null,
  error: null,
  settings: DEFAULT_SETTINGS,
  view: 'walkthrough',
  chapter: -1,
  focusHunk: null,
  scrollNonce: 0,
  viewed: new Set(),
  collapseMoves: true,
  panel: 'chat',
  peekStack: [],
  peekIndex: -1,
  chatRequest: null,
  wtRun: null,
  wtError: null,

  async startWalkthrough(reviewId) {
    if (get().wtRun) return
    const controller = new AbortController()
    wtAbort = controller
    set({ wtRun: { reviewId, status: 'Starting Claude' }, wtError: null })
    const status = (text: string) => set({ wtRun: { reviewId, status: text } })
    let failed: string | null = null
    try {
      await api.walkthrough(
        reviewId,
        get().settings,
        (e) => {
          if (e.type === 'tool' || e.type === 'status') status(e.text)
          else if (e.type === 'text') status('Writing the walkthrough')
          else if (e.type === 'error') failed = e.message
        },
        controller.signal,
      )
    } catch (e) {
      failed = controller.signal.aborted ? null : (e as Error).message
    }
    wtAbort = null
    set({ wtRun: null, wtError: failed })
    if (failed || controller.signal.aborted || get().review?.id !== reviewId) return
    await get().load(reviewId)
    // The old chapter number means nothing in the new walkthrough; the view itself is left alone.
    set({ chapter: -1 })
  },
  stopWalkthrough: () => wtAbort?.abort(),

  async load(id) {
    const seq = ++loadSeq
    try {
      const sameReview = get().review?.id === id
      const [review, settings] = await Promise.all([api.review(id), api.settings()])
      // A slower response for a review the reader has since left must not replace the current one.
      if (seq !== loadSeq) return
      set({
        review,
        settings,
        error: null,
        viewed: new Set(review.viewed),
        ...(sameReview ? {} : { view: 'walkthrough', chapter: -1, focusHunk: null, peekStack: [], peekIndex: -1, panel: 'chat', chatRequest: null }),
      })
    } catch (err) {
      if (seq === loadSeq) set({ error: (err as Error).message })
    }
  },

  setSettings(patch) {
    set({ settings: { ...get().settings, ...patch } })
    void api.saveSettings(patch)
  },

  setView: (view) => set({ view }),
  setChapter: (chapter) => set({ chapter, view: 'walkthrough', focusHunk: null, scrollNonce: get().scrollNonce + 1 }),
  focus: (focusHunk, scroll = false) => set({ focusHunk, scrollNonce: scroll ? get().scrollNonce + 1 : get().scrollNonce }),

  reveal(hunkId) {
    const { review, view } = get()
    if (!review) return
    const chapters = activeWalkthrough(review)?.chapters
    const idx = view === 'walkthrough' && chapters ? chapters.findIndex((c) => c.hunks.includes(hunkId)) : -1
    if (idx >= 0) set({ chapter: idx, focusHunk: hunkId, scrollNonce: get().scrollNonce + 1 })
    else set({ view: 'files', focusHunk: hunkId, scrollNonce: get().scrollNonce + 1 })
  },

  revealLine(path, line) {
    const file = get().review?.files.find((f) => f.path === path)
    if (!file?.hunks.length) return false
    const hunk = file.hunks.find((h) => line >= h.newStart && line < h.newStart + Math.max(h.newLines, 1)) ?? nearest(file, line)
    get().reveal(hunk.id)
    return true
  },

  setViewed(hunks, viewed) {
    const review = get().review
    if (!review || !hunks.length) return
    const next = new Set(get().viewed)
    for (const h of hunks) viewed ? next.add(h.key) : next.delete(h.key)
    set({ viewed: next })
    api.setViewed(review.id, hunks.map((h) => h.key), viewed).catch(() => {
      // Not saved: show the truth again rather than a mark that will be gone on reload.
      if (get().review?.id === review.id) void get().load(review.id)
    })
  },

  toggleCollapseMoves: () => set({ collapseMoves: !get().collapseMoves }),
  setPanel: (panel) => set({ panel }),

  peek(target) {
    const stack = get().peekStack.slice(0, get().peekIndex + 1)
    stack.push(target)
    set({ peekStack: stack, peekIndex: stack.length - 1, panel: 'peek' })
  },
  peekGo(delta) {
    const i = get().peekIndex + delta
    if (i >= 0 && i < get().peekStack.length) set({ peekIndex: i })
  },

  askClaude: (text, context, send, mode, noteIds) => set({ panel: 'chat', chatRequest: { text, context, send, mode, noteIds, nonce: Date.now() } }),
  setComments: (comments) => set({ review: get().review ? { ...get().review!, comments } : null }),
  setWalkthrough: (walkthrough) => set({ review: get().review ? { ...get().review!, walkthrough } : null, chapter: -1 }),
}))

function nearest(file: FileDiff, line: number): Hunk {
  return file.hunks.reduce((best, h) => (Math.abs(h.newStart - line) < Math.abs(best.newStart - line) ? h : best))
}

/** The walkthrough, unless the diff has changed since it was written and its hunk labels no longer apply. */
export function activeWalkthrough(review: Review): Walkthrough | null {
  return review.walkthrough && review.walkthrough.fingerprint === review.fingerprint ? review.walkthrough : null
}

export interface HunkRef {
  file: FileDiff
  hunk: Hunk
}

export function hunkIndex(review: Review): Map<string, HunkRef> {
  const map = new Map<string, HunkRef>()
  for (const file of review.files) for (const hunk of file.hunks) map.set(hunk.id, { file, hunk })
  return map
}
