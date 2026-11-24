import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { moveLabel, type FileDiff, type Move, type StreamEvent } from '../shared/types.ts'
import { TRAIL_HOME } from './git.ts'

export interface ClaudeRun {
  cwd: string
  prompt: string
  model: string
  effort: string
  /** 'ask' can only read; 'edit' may also change files in cwd. */
  mode: 'ask' | 'edit'
  /**
   * Whether cwd is the reviewer's own repository. A pull request checkout is not: anything
   * in it may have been written to attack whoever opens it. There Claude Code runs in
   * restricted and safe mode, which load no settings, hooks, plugins, language servers,
   * skills or CLAUDE.md from anywhere, keep file tools inside the checkout, and refuse
   * writes to git and configuration files.
   */
  trusted: boolean
  systemPrompt?: string
  resume?: string | null
  addDirs?: string[]
  jsonSchema?: object
  signal?: AbortSignal
  onEvent: (event: StreamEvent) => void
}

export interface ClaudeResult {
  text: string
  structured: unknown
  sessionId: string | null
  costUsd: number | undefined
}

/**
 * Whether Claude Code may load this checkout's own settings, hooks and CLAUDE.md. Never for a
 * pull request. For a local repository, only if the reviewer has already accepted Claude Code's
 * trust prompt for that folder, which Claude Code records in ~/.claude.json. A repository they
 * merely typed the path of (a fresh clone of someone else's code) gets no such trust.
 */
export function isTrustedCheckout(kind: 'pr' | 'local', dir: string): boolean {
  if (kind !== 'local') return false
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).projects ?? {}
    return [dir, fs.realpathSync(dir)].some((d) => projects[d]?.hasTrustDialogAccepted === true)
  } catch {
    return false
  }
}

const READ_TOOLS = 'Read,Grep,Glob'
const EDIT_TOOLS = 'Read,Grep,Glob,Edit,Write'

/** A short, human description of a tool call, with paths shown relative to the checkout. */
function describeTool(name: string, input: any, roots: string[]): string {
  if (!input || typeof input !== 'object') return name
  const rel = (p: unknown): string => {
    if (typeof p !== 'string') return ''
    for (const root of roots) {
      if (p === root) return 'the repository'
      if (p.startsWith(root + '/')) return p.slice(root.length + 1)
    }
    return p
  }
  if (name === 'Grep') return `Searched for "${input.pattern}"${input.path ? ` in ${rel(input.path)}` : ''}`
  if (name === 'Glob') return `Listed ${rel(input.pattern)}${input.path ? ` in ${rel(input.path)}` : ''}`
  const verb: Record<string, string> = { Read: 'Read', Edit: 'Edited', Write: 'Wrote' }
  const target = rel(input.file_path ?? input.path)
  return target ? `${verb[name] ?? name} ${target}` : (verb[name] ?? name)
}

/**
 * Run Claude Code headlessly (`claude -p`) with the reviewer's existing login and settings,
 * translating its JSON event stream into the few events the UI needs.
 */
export function runClaude(opts: ClaudeRun): Promise<ClaudeResult> {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
  // Nobody is at a terminal to answer prompts; anything outside the allowed tools is denied.
  args.push('--permission-prompts', 'none', '--tools', opts.mode === 'edit' ? EDIT_TOOLS : READ_TOOLS)
  if (opts.mode === 'edit') args.push('--permission-mode', 'acceptEdits')
  // MCP servers add seconds of start-up to every question and are not needed to read code.
  args.push('--strict-mcp-config')
  if (!opts.trusted) args.push('--restricted', '--safe-mode')
  for (const value of [opts.model, opts.effort]) if (value && !/^[\w.[\]-]+$/.test(value)) return Promise.reject(new Error('Unknown model or effort setting.'))
  if (opts.model && opts.model !== 'default') args.push('--model', opts.model)
  if (opts.effort && opts.effort !== 'default') args.push('--effort', opts.effort)
  if (opts.resume) args.push('--resume', opts.resume)
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt)
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir)
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema))

  if (!fs.existsSync(opts.cwd)) return Promise.reject(new Error('The checkout for this review no longer exists. Refresh the review to recreate it.'))
  const roots = [fs.realpathSync(opts.cwd), opts.cwd, ...(opts.addDirs ?? [])]

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.TRAIL_CLAUDE_BIN || 'claude', args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let text = ''
    let sessionId: string | null = null
    let final: any = null
    let settled = false

    const abort = () => child.kill('SIGTERM')
    opts.signal?.addEventListener('abort', abort, { once: true })

    const handle = (line: string) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.session_id && !sessionId) sessionId = msg.session_id
      if (msg.type === 'stream_event') {
        const ev = msg.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          text += ev.delta.text
          opts.onEvent({ type: 'text', text: ev.delta.text })
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
          opts.onEvent({ type: 'status', text: 'Thinking' })
        } else if (ev?.type === 'message_start' && text && !text.endsWith('\n\n')) {
          // A new assistant turn after tool calls: keep its text apart from the previous turn's.
          text += '\n\n'
          opts.onEvent({ type: 'text', text: '\n\n' })
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use' && block.name !== 'StructuredOutput') opts.onEvent({ type: 'tool', text: describeTool(block.name, block.input, roots) })
        }
      } else if (msg.type === 'result') {
        final = msg
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim()) handle(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      reject(new Error(err.code === 'ENOENT' ? 'The `claude` command was not found. Install Claude Code and make sure it is on your PATH.' : err.message))
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', abort)
      if (settled) return
      settled = true
      if (buffer.trim()) handle(buffer)
      if (opts.signal?.aborted) return reject(new Error('Stopped.'))
      if (!final || final.is_error) {
        const detail = (final?.result as string) || stderr.trim().split('\n').slice(-4).join('\n') || `claude exited with code ${code}`
        return reject(new Error(detail))
      }
      resolve({ text: text || final.result || '', structured: final.structured_output, sessionId: final.session_id ?? sessionId, costUsd: final.total_cost_usd })
    })
    // If claude exits before reading a large prompt the pipe breaks; 'close' reports the real failure.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.prompt)
  })
}

const MAX_HUNK_LINES = 400

/**
 * The diff as a text file with stable hunk labels, written where Claude can read it.
 * Both the walkthrough and chat refer to hunks by these labels.
 */
export function writeAnnotatedDiff(reviewId: number, files: FileDiff[], moves: Move[]): { dir: string; file: string; text: string } {
  const moveById = new Map(moves.map((m) => [m.id, m]))
  const out: string[] = []
  for (const f of files) {
    const rename = f.oldPath !== f.path ? `, was ${f.oldPath}` : ''
    out.push(`=== FILE ${f.path} (${f.status}${rename}, +${f.additions} -${f.deletions}) ===`)
    if (f.modeChange) out.push(`(file mode changed: ${f.modeChange})`)
    if (f.hunks[0]?.note) {
      out.push(`--- HUNK ${f.hunks[0].id} [no text diff] ${f.hunks[0].note}`, '')
      continue
    }
    if (f.generated) {
      out.push(`(generated or lock file, contents not shown; hunks: ${f.hunks.map((h) => h.id).join(' ')})`, '')
      continue
    }
    for (const h of f.hunks) {
      const notes: string[] = []
      if (h.symbol) notes.push(`in ${h.symbol}`)
      const ids = [...new Set(h.lines.map((l) => l.mv).filter((x): x is number => !!x))]
      for (const id of ids) {
        const m = moveById.get(id)!
        const here = h.lines.some((l) => l.mv === id && l.t === '+')
        notes.push(here ? `${m.lines} lines ${moveLabel(m)} from ${m.from.path}:${m.from.start}` : `${m.lines} lines ${moveLabel(m)} to ${m.to.path}:${m.to.start}`)
      }
      if (h.pureMove) notes.push('PURE MOVE: no line in this hunk was edited apart from indentation')
      out.push(`--- HUNK ${h.id} @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${notes.length ? ` [${notes.join('; ')}]` : ''}`)
      const lines = h.lines.length > MAX_HUNK_LINES ? h.lines.slice(0, MAX_HUNK_LINES) : h.lines
      for (const l of lines) out.push(`${l.t}${l.s}`, ...(l.nonl ? ['\\ No newline at end of file'] : []))
      if (lines.length < h.lines.length) out.push(`(… ${h.lines.length - lines.length} more lines in this hunk; read the file for the rest)`)
    }
    out.push('')
  }
  const dir = path.join(TRAIL_HOME, 'reviews', String(reviewId))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'diff.txt')
  const text = out.join('\n')
  fs.writeFileSync(file, text)
  return { dir, file, text }
}
