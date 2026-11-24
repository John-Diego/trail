// Types shared by the server and the web UI.

export type LineType = ' ' | '+' | '-'

export interface DiffLine {
  t: LineType
  /** Line number in the old file (context and removed lines). */
  o?: number
  /** Line number in the new file (context and added lines). */
  n?: number
  s: string
  /** Id of the move this line belongs to, when it was moved rather than written or deleted. */
  mv?: number
  /** The file does not end with a newline after this line. */
  nonl?: boolean
}

export interface Hunk {
  /** Positional id, e.g. "f3h2". Stable only for one import. */
  id: string
  /** Content hash, stable across re-imports while the hunk is unchanged. */
  key: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Text git printed after the @@ markers. */
  section: string
  /** Enclosing definition at the head of the change, when known. */
  symbol?: string
  additions: number
  deletions: number
  /** True when every changed line in the hunk is part of a detected move. */
  pureMove: boolean
  lines: DiffLine[]
  /** Set on the single placeholder hunk of a file with no text diff (binary, rename only, mode change). */
  note?: string
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'

export interface FileDiff {
  idx: number
  path: string
  oldPath: string
  status: FileStatus
  binary: boolean
  /** Lockfiles, build output, snapshots: shown last and collapsed. */
  generated: boolean
  additions: number
  deletions: number
  /** Permission change, e.g. "100644 → 100755". */
  modeChange?: string
  hunks: Hunk[]
}

export interface MoveSide {
  file: number
  path: string
  start: number
  end: number
}

export interface Move {
  id: number
  from: MoveSide
  to: MoveSide
  lines: number
  /** The block sits at a different indentation level than before; its text is otherwise identical. */
  reindented: boolean
}

/** How a move is described to the reviewer and to Claude. */
export function moveLabel(move: Move): string {
  return move.reindented ? 'moved, only indentation changed' : 'moved unchanged'
}

export interface Chapter {
  title: string
  narrative: string
  focus: string
  risk: 'low' | 'medium' | 'high'
  hunks: string[]
  /** True for the chapter Trail adds for hunks the model did not place. */
  leftover?: boolean
}

export interface Concern {
  hunk: string
  severity: 'info' | 'warn' | 'bug'
  note: string
}

export interface Walkthrough {
  summary: string
  chapters: Chapter[]
  concerns: Concern[]
  model: string
  effort: string
  /** Fingerprint of the diff the walkthrough was written for. */
  fingerprint: string
  createdAt: number
}

export interface Comment {
  id: number
  path: string
  side: 'old' | 'new'
  line: number
  /** Whether the line is part of the diff, so it can be posted as an inline GitHub comment. */
  inDiff: boolean
  body: string
  /** The line the note was written on has changed or gone since; it can no longer be posted inline. */
  outdated: boolean
  status: 'draft' | 'submitted' | 'sent'
  createdAt: number
}

export interface ReviewSummary {
  id: number
  kind: 'pr' | 'local'
  title: string
  url: string | null
  repoLabel: string
  number: number | null
  author: string | null
  baseRef: string
  headRef: string
  baseSha: string
  headSha: string
  additions: number
  deletions: number
  fileCount: number
  hunkCount: number
  viewedCount: number
  updatedAt: number
}

export interface Review extends ReviewSummary {
  body: string
  workDir: string
  commits: { sha: string; subject: string }[]
  files: FileDiff[]
  moves: Move[]
  viewed: string[]
  comments: Comment[]
  walkthrough: Walkthrough | null
  /** Changes whenever any hunk changes; hunk labels are only meaningful for one fingerprint. */
  fingerprint: string
  symbolsReady: boolean
  /** Uncommitted changes in the review checkout (PR reviews only). */
  canPush: boolean
}

export interface FileContent {
  old: string | null
  new: string | null
  /** Identifiers in the file that have a definition somewhere in the repository. */
  known: string[]
}

export interface SymbolDef {
  name: string
  path: string
  line: number
  kind: string
  text: string
  /** The file is part of the change under review. */
  changed: boolean
}

export interface SymbolUsage {
  path: string
  line: number
  text: string
  changed: boolean
}

export interface SymbolResult {
  name: string
  defs: SymbolDef[]
  usages: SymbolUsage[]
  usagesTruncated: boolean
}

export interface ChatPart {
  type: 'text' | 'tool'
  text: string
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  parts: ChatPart[]
  model?: string
  effort?: string
  mode?: 'ask' | 'edit'
  costUsd?: number
  error?: string
  /** For user messages: the code location that was attached, as path:line. */
  context?: string
  createdAt: number
}

export interface Thread {
  id: number
  title: string
  messages: ChatMessage[]
}

export interface ChatContext {
  path: string
  side: 'old' | 'new'
  startLine: number
  endLine: number
  hunk?: string
  code: string
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; text: string }
  | { type: 'status'; text: string }
  | { type: 'done'; costUsd?: number; threadId?: number; messageId?: number }
  | { type: 'error'; message: string }

export interface Settings {
  model: string
  effort: string
}

export interface PendingChanges {
  dirty: boolean
  files: { status: string; path: string }[]
  diff: string
  /** The diff was too long to send whole; what is shown is only its beginning. */
  truncated: boolean
}

/** What a new installation starts with. A choice made in the selector is remembered and wins over this. */
export const DEFAULT_SETTINGS: Settings = { model: 'opus', effort: 'medium' }

export const MODELS = [
  { id: 'default', label: 'Auto', hint: 'Your Claude Code default' },
  { id: 'fable', label: 'Fable', hint: 'Most capable' },
  { id: 'opus', label: 'Opus', hint: 'Strong all-rounder' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Fast' },
  { id: 'haiku', label: 'Haiku', hint: 'Fastest' },
] as const

export const EFFORTS = [
  { id: 'default', label: 'Auto' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'X-High' },
  { id: 'max', label: 'Max' },
] as const
