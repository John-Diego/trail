import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type FileContent, type PendingChanges, type Settings, type StreamEvent } from '../shared/types.ts'
import { chat, listThreads } from './chat.ts'
import { db, getSetting, setSetting } from './db.ts'
import { git, run, showFile, TRAIL_HOME } from './git.ts'
import { DIFF_FLAGS, ignoreAttributes } from './diff.ts'
import { getReview, importReview, isTrailCheckout, listComments, listReviews, loadRow, refreshReview, type ImportRequest } from './importer.ts'
import { isRunning, withRun } from './locks.ts'
import { buildId, trailPort } from '../shared/settings.ts'
import { knownIdentifiers, lookupSymbol } from './symbols.ts'
import { generateWalkthrough } from './walkthrough.ts'

const PORT = trailPort()
// What the launcher compares against to notice a server left running from before an update.
const BUILD = buildId()
const HOST = '127.0.0.1'
const builtWeb = path.resolve(import.meta.dir, '../dist/web')
const WEB_DIR = fs.existsSync(path.join(builtWeb, 'index.html')) ? builtWeb : undefined

type Req = http.IncomingMessage
type Res = http.ServerResponse

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

// Sent with every response. The page may only talk to this server, load its own assets, and
// never be framed or submit a form: rendered markdown and diffs come from untrusted sources.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

function send(res: Res, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(text)
}

async function readJson<T>(req: Req): Promise<T> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.')
  }
}

/** Stream events to the browser as server-sent events; abort the work if the browser goes away. */
function eventStream(req: Req, res: Res): { emit: (e: StreamEvent) => void; signal: AbortSignal; close: () => void } {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  const controller = new AbortController()
  let open = true
  res.on('close', () => {
    open = false
    controller.abort()
  })
  return {
    emit: (e) => {
      if (open) res.write(`data: ${JSON.stringify(e)}\n\n`)
    },
    signal: controller.signal,
    close: () => {
      if (open) res.end()
    },
  }
}

// Imports can take a while (first clone of a repository), so they run as pollable jobs.
interface Job {
  status: 'running' | 'done' | 'error'
  message: string
  reviewId?: number
}
const jobs = new Map<number, Job>()
const jobByKey = new Map<string, number>()
let nextJob = 1
let queue: Promise<unknown> = Promise.resolve()

/**
 * Imports and refreshes run one at a time: they fetch into shared clones and move checkouts,
 * which must not happen concurrently. Asking for work that is already queued returns that job.
 */
function startJob(key: string, work: (progress: (m: string) => void) => Promise<number>): number {
  const existing = jobByKey.get(key)
  if (existing !== undefined) return existing
  const id = nextJob++
  const job: Job = { status: 'running', message: 'Waiting for another import to finish' }
  jobs.set(id, job)
  jobByKey.set(key, id)
  queue = queue
    .then(() => work((m) => (job.message = m)))
    .then(
      (reviewId) => Object.assign(job, { status: 'done', reviewId, message: 'Done' }),
      (err: Error) => Object.assign(job, { status: 'error', message: err.message }),
    )
    .finally(() => {
      jobByKey.delete(key)
      // Finished jobs are only needed until the page that started them has read the result.
      for (const old of jobs.keys()) if (old < id - 50) jobs.delete(old)
    })
  return id
}

/**
 * Destructive git commands are only ever run in a checkout Trail created. Without this check,
 * a checkout that lost its .git would make git act on whatever repository encloses it.
 */
async function assertTrailCheckout(workDir: string): Promise<void> {
  const damaged = new HttpError(409, 'The review checkout is missing or damaged. Refresh the review to recreate it.')
  if (!isTrailCheckout(workDir)) throw damaged
  const root = fs.realpathSync(path.join(TRAIL_HOME, 'worktrees')) + path.sep
  const real = fs.realpathSync(workDir)
  const top = (await git(workDir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim()
  if (!real.startsWith(root) || !top || fs.realpathSync(top) !== real) throw damaged
}

function settings(): Settings {
  return { model: getSetting('model', DEFAULT_SETTINGS.model), effort: getSetting('effort', DEFAULT_SETTINGS.effort) }
}

const NO_PENDING: PendingChanges = { dirty: false, files: [], diff: '', truncated: false }

async function pendingChanges(workDir: string): Promise<PendingChanges> {
  if (!isTrailCheckout(workDir)) return NO_PENDING
  const status = await git(workDir, ['status', '--porcelain', '--untracked-files=all'])
  const files = status
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }))
  if (!files.length) return { dirty: false, files: [], diff: '', truncated: false }
  // Read-only: tracked changes from one diff, new files each compared against nothing.
  // Same neutral settings as the review itself, so what is shown is what would be pushed.
  const attr = await ignoreAttributes(workDir).catch(() => [])
  let diff = await git(workDir, [...attr, 'diff', ...DIFF_FLAGS, 'HEAD'])
  const untracked = (await git(workDir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  for (const file of untracked) diff += await git(workDir, [...attr, 'diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file], { okCodes: [1] })
  const MAX = 400_000
  return { dirty: true, files, diff: diff.slice(0, MAX), truncated: diff.length > MAX }
}

async function api(req: Req, res: Res, url: URL): Promise<void> {
  const seg = url.pathname.split('/').filter(Boolean).slice(1) // drop "api"
  const method = req.method ?? 'GET'

  // The pid lets `trail stop` signal the process that is really serving this port.
  if (seg[0] === 'health') return send(res, 200, { ok: true, app: 'trail', pid: process.pid, build: BUILD })
  if (seg[0] === 'settings') {
    if (method === 'PUT') {
      const body = await readJson<Partial<Settings>>(req)
      if (body.model) setSetting('model', body.model)
      if (body.effort) setSetting('effort', body.effort)
    }
    return send(res, 200, settings())
  }
  if (seg[0] === 'jobs' && seg[1]) {
    const job = jobs.get(Number(seg[1]))
    if (!job) throw new HttpError(404, 'Job not found.')
    return send(res, 200, job)
  }
  if (seg[0] !== 'reviews') throw new HttpError(404, 'Not found.')

  if (!seg[1]) {
    if (method === 'GET') return send(res, 200, listReviews())
    if (method === 'POST') {
      const body = await readJson<ImportRequest>(req)
      const key = body.kind === 'pr' ? `pr:${body.ref}` : `local:${body.path}:${body.base ?? ''}`
      return send(res, 202, { jobId: startJob(key, (p) => importReview(body, p)) })
    }
  }

  const id = Number(seg[1])
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad review id.')
  const action = seg[2]

  if (!action) {
    if (method === 'GET') return send(res, 200, getReview(id))
    if (method === 'DELETE') {
      db.prepare('DELETE FROM reviews WHERE id = ?').run(id)
      return send(res, 200, { ok: true })
    }
  }

  if (action === 'refresh' && method === 'POST') {
    // An early answer for the reader; the job checks again at the moment it would move the checkout.
    if (isRunning(loadRow(id).row.work_dir)) throw new HttpError(409, 'Claude is still working in this review. Wait for it to finish, or stop it, before refreshing.')
    return send(res, 202, { jobId: startJob(`review:${id}`, (p) => refreshReview(id, p)) })
  }

  if (action === 'file' && method === 'GET') {
    const { row, files } = loadRow(id)
    const file = files[Number(url.searchParams.get('i'))]
    if (!file) throw new HttpError(404, 'No such file in this review.')
    const MAX = 600_000
    const [oldText, newText] = file.binary
      ? [null, null]
      : await Promise.all([
          file.status === 'added' ? null : showFile(row.repo_dir, row.base_sha, file.oldPath),
          file.status === 'deleted' ? null : showFile(row.repo_dir, row.head_sha, file.path),
        ])
    const content: FileContent = {
      old: oldText && oldText.length <= MAX ? oldText : null,
      new: newText && newText.length <= MAX ? newText : null,
      known: [],
    }
    content.known = knownIdentifiers(id, content.old, content.new)
    return send(res, 200, content)
  }

  if (action === 'blob' && method === 'GET') {
    const { row } = loadRow(id)
    const p = url.searchParams.get('path') ?? ''
    const sha = url.searchParams.get('side') === 'old' ? row.base_sha : row.head_sha
    let text = await showFile(row.repo_dir, sha, p)
    let resolved = p
    if (text === null && p) {
      // Answers sometimes cite a file by its name alone; accept that when it is unambiguous.
      const all = (await git(row.repo_dir, ['ls-tree', '-r', '--name-only', sha])).split('\n')
      const matches = all.filter((f) => f === p || f.endsWith(`/${p}`))
      if (matches.length === 1) {
        resolved = matches[0]
        text = await showFile(row.repo_dir, sha, resolved)
      }
    }
    if (text === null) throw new HttpError(404, `${p} does not exist at that commit.`)
    const body = text.length > 1_500_000 ? text.slice(0, 1_500_000) : text
    return send(res, 200, { text: body, path: resolved, known: knownIdentifiers(id, body) })
  }

  if (action === 'symbol' && method === 'GET') {
    const { row, files } = loadRow(id)
    const name = url.searchParams.get('name') ?? ''
    if (!name) throw new HttpError(400, 'Missing name.')
    return send(res, 200, await lookupSymbol(id, row.repo_dir, row.head_sha, files, name, url.searchParams.get('path') ?? ''))
  }

  if (action === 'viewed' && method === 'POST') {
    const body = await readJson<{ keys: string[]; viewed: boolean }>(req)
    const stmt = body.viewed
      ? db.prepare('INSERT OR IGNORE INTO viewed (review_id, hunk_key) VALUES (?, ?)')
      : db.prepare('DELETE FROM viewed WHERE review_id = ? AND hunk_key = ?')
    for (const key of body.keys ?? []) stmt.run(id, key)
    return send(res, 200, { ok: true })
  }

  if (action === 'comments') {
    if (method === 'POST') {
      const b = await readJson<{ path: string; side: string; line: number; inDiff: boolean; body: string; text?: string }>(req)
      if (!b.body?.trim()) throw new HttpError(400, 'A note needs some text.')
      db.prepare('INSERT INTO comments (review_id, path, side, line, in_diff, body, line_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, b.path, b.side, b.line, b.inDiff ? 1 : 0, b.body.trim(), typeof b.text === 'string' ? b.text : null, Date.now(),
      )
    } else if (method === 'PUT' && seg[3]) {
      const b = await readJson<{ body?: string; status?: string }>(req)
      if (b.body !== undefined) db.prepare('UPDATE comments SET body = ? WHERE id = ? AND review_id = ?').run(b.body.trim(), Number(seg[3]), id)
      if (b.status) db.prepare('UPDATE comments SET status = ? WHERE id = ? AND review_id = ?').run(b.status, Number(seg[3]), id)
    } else if (method === 'DELETE' && seg[3]) {
      db.prepare('DELETE FROM comments WHERE id = ? AND review_id = ?').run(Number(seg[3]), id)
    }
    return send(res, 200, listComments(id))
  }

  if (action === 'threads' && method === 'GET') return send(res, 200, listThreads(id))

  if (action === 'chat' && method === 'POST') {
    const body = await readJson<Parameters<typeof chat>[1]>(req)
    if (!body.message?.trim()) throw new HttpError(400, 'Message is empty.')
    const stream = eventStream(req, res)
    try {
      await withRun(loadRow(id).row.work_dir, () => chat(id, body, stream.emit, stream.signal))
    } catch (err) {
      stream.emit({ type: 'error', message: (err as Error).message })
    }
    return stream.close()
  }

  if (action === 'walkthrough' && method === 'POST') {
    const body = await readJson<Settings>(req)
    const stream = eventStream(req, res)
    try {
      await withRun(loadRow(id).row.work_dir, () => generateWalkthrough(id, body.model || DEFAULT_SETTINGS.model, body.effort || DEFAULT_SETTINGS.effort, stream.emit, stream.signal))
      stream.emit({ type: 'done' })
    } catch (err) {
      stream.emit({ type: 'error', message: (err as Error).message })
    }
    return stream.close()
  }

  if (action === 'pending') {
    const { row } = loadRow(id)
    if (row.kind !== 'pr' || !fs.existsSync(row.work_dir)) return send(res, 200, NO_PENDING)
    if (method === 'GET') return send(res, 200, await pendingChanges(row.work_dir))
    await assertTrailCheckout(row.work_dir)
    if (isRunning(row.work_dir)) throw new HttpError(409, 'Claude is still working in this review. Wait for it to finish first.')
    if (method === 'DELETE') {
      // Only ever run inside Trail's own checkout of the pull request, never the user's repository.
      await git(row.work_dir, ['reset', '--hard', 'HEAD'])
      await git(row.work_dir, ['clean', '-fd'])
      return send(res, 200, await pendingChanges(row.work_dir))
    }
    if (method === 'POST') {
      if (!row.can_push) throw new HttpError(400, 'This pull request comes from a fork; Trail cannot push to it. Copy the diff instead.')
      const body = await readJson<{ message: string }>(req)
      if (!body.message?.trim()) throw new HttpError(400, 'A commit message is required.')
      const remoteHead = (await git(row.repo_dir, ['ls-remote', 'origin', `refs/heads/${row.head_ref}`])).split('\t')[0]
      if (remoteHead !== row.head_sha) throw new HttpError(409, 'The pull request has new commits. Refresh the review before pushing.')
      await git(row.work_dir, ['add', '-A'])
      await git(row.work_dir, ['commit', '-m', body.message.trim()])
      try {
        await git(row.work_dir, ['push', 'origin', `HEAD:refs/heads/${row.head_ref}`], { timeoutMs: 5 * 60_000 })
      } catch (err) {
        // Undo the commit but keep the files, so the changes are still shown as pending and can be retried.
        const undone = await git(row.work_dir, ['reset', '--mixed', row.head_sha]).then(() => true, () => false)
        throw new HttpError(502, `The push failed, so nothing was published. ${undone ? 'The changes are still pending.' : `The commit could not be undone; it is in the checkout at ${row.work_dir}.`} ${(err as Error).message}`)
      }
      return send(res, 200, { ok: true })
    }
  }

  if (action === 'submit' && method === 'POST') {
    const { row } = loadRow(id)
    if (row.kind !== 'pr') throw new HttpError(400, 'Only pull request reviews can be submitted to GitHub.')
    const body = await readJson<{ event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string }>(req)
    const drafts = listComments(id).filter((c) => c.status === 'draft')
    const inline = drafts.filter((c) => c.inDiff && !c.outdated)
    // GitHub only accepts inline comments on lines that are part of the diff; the rest go in the summary.
    // So do notes whose line changed after they were written: their old line number would be wrong now.
    const loose = drafts.filter((c) => !c.inDiff || c.outdated)
    const summary = [body.body?.trim(), ...loose.map((c) => `**${c.path}${c.outdated ? ' (written on an earlier version)' : `:${c.line}`}** — ${c.body}`)].filter(Boolean).join('\n\n')
    if (!inline.length && !summary && body.event !== 'APPROVE') throw new HttpError(400, 'There is nothing to submit yet.')
    const payload = {
      commit_id: row.head_sha,
      event: body.event,
      body: summary,
      comments: inline.map((c) => ({ path: c.path, line: c.line, side: c.side === 'old' ? 'LEFT' : 'RIGHT', body: c.body })),
    }
    const out = await run('gh', ['api', '--method', 'POST', `repos/${row.owner}/${row.repo}/pulls/${row.number}/reviews`, '--input', '-'], {
      input: JSON.stringify(payload),
    })
    const stmt = db.prepare("UPDATE comments SET status = 'submitted' WHERE id = ?")
    for (const c of drafts) stmt.run(c.id)
    return send(res, 200, { ok: true, url: JSON.parse(out).html_url ?? row.url, comments: listComments(id) })
  }

  throw new HttpError(404, 'Not found.')
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' }

function serveStatic(res: Res, url: URL): void {
  if (!WEB_DIR) {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    return void res.end('The web UI has not been built. Run `bun run build`, or use `bun run dev` and open http://localhost:4478.')
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    throw new HttpError(400, 'Bad request path.')
  }
  const rel = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(WEB_DIR, rel)
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html')
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-store',
  })
  fs.createReadStream(file).pipe(res)
}

/**
 * The server can run Claude with edit rights and push commits, so it must not be reachable
 * from other web pages. It listens on loopback only; this also rejects cross-site requests,
 * requests from other local web apps, and DNS-rebinding attempts made through the user's browser.
 */
const OWN_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`]
// TRAIL_DEV_ORIGIN admits the Vite dev server during development (see package.json).
const OWN_ORIGINS = [...OWN_HOSTS.map((h) => `http://${h}`), ...(process.env.TRAIL_DEV_ORIGIN ? [process.env.TRAIL_DEV_ORIGIN] : [])]

function isTrustedRequest(req: Req): boolean {
  // The exact Host stops DNS rebinding; the exact Origin stops other sites and other local apps.
  if (!OWN_HOSTS.includes(req.headers.host ?? '')) return false
  const origin = req.headers.origin
  if (origin && !OWN_ORIGINS.includes(origin)) return false
  // Anything that changes state must be JSON. A browser cannot send that across origins without
  // permission this server never grants, and an HTML form cannot send it at all.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return false
  return true
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  try {
    if (!isTrustedRequest(req)) throw new HttpError(403, 'Requests must come from this machine.')
    if (url.pathname.startsWith('/api/')) await api(req, res, url)
    else serveStatic(res, url)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : ((err as any).status ?? 500)
    if (status >= 500) console.error(err)
    if (!res.headersSent) send(res, status, { error: (err as Error).message })
    else res.end()
  }
})

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Is Trail already running? Set TRAIL_PORT to use another port.` : err.message)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`Trail is running at http://localhost:${PORT}`)
})
