import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isAddress, isGithubAddress, isValidName, parsePrRef, PR_FORMS_HELP } from '../shared/pr-ref.ts'
import type { Comment, FileDiff, Move, Review, ReviewSummary, Walkthrough } from '../shared/types.ts'
import { db, tx } from './db.ts'
import { loadDiff } from './diff.ts'
import { git, gitOk, LONG, run, runTransfer, TRAIL_HOME } from './git.ts'
import { withMove } from './locks.ts'
import { setting } from '../shared/settings.ts'
import { detectMoves } from './moves.ts'
import { annotateHunks, indexSymbols } from './symbols.ts'

/** `message` is the stage, in words. `detail` is how far along it is, when that is known. */
type Progress = (message: string, detail?: string) => void

interface Source {
  kind: 'pr' | 'local'
  sourceKey: string
  title: string
  body: string
  url: string | null
  repoLabel: string
  owner: string | null
  repo: string | null
  number: number | null
  author: string | null
  baseRef: string
  headRef: string
  baseSha: string
  headSha: string
  repoDir: string
  workDir: string
  canPush: boolean
}

async function resolvePr(ref: string, progress: Progress): Promise<Source> {
  const parsed = parsePrRef(ref)
  if (!parsed) {
    if (isGithubAddress(ref)) throw new Error('That GitHub address is not a pull request.')
    if (isAddress(ref)) throw new Error('Trail reads pull requests from github.com only.')
    throw new Error(`Could not read "${ref.trim()}" as a pull request. Use ${PR_FORMS_HELP}.`)
  }
  // Read now, not when the server started: the owner may have been saved or changed since.
  const typedOwner = parsed.owner ?? setting('owner')
  if (!typedOwner) throw new Error(`No owner for "${parsed.repo}". Write it as owner/${parsed.repo}/${parsed.number}, or save a default with "trail config owner <name>".`)
  // The owner becomes a command argument and part of folder names, wherever it came from.
  if (!isValidName(typedOwner)) throw new Error(`"${typedOwner}" is not a valid owner name. Check it with "trail config".`)
  progress(`Reading ${typedOwner}/${parsed.repo}#${parsed.number} from GitHub`)
  const meta = JSON.parse(
    await run('gh', ['pr', 'view', String(parsed.number), '-R', `${typedOwner}/${parsed.repo}`, '--json', 'number,title,body,author,baseRefName,baseRefOid,headRefName,url,isCrossRepository,maintainerCanModify']),
  )
  // GitHub ignores case in names, so "Acme/API" and "acme/api" are one repository. The spelling
  // GitHub itself reports is used from here on, so they are also one review and one clone.
  const canonical = parsePrRef(String(meta.url ?? ''))
  const pr = { owner: canonical?.owner ?? typedOwner, repo: canonical?.repo ?? parsed.repo, number: parsed.number }
  const slug = `${pr.owner}/${pr.repo}`

  const repoDir = path.join(TRAIL_HOME, 'repos', pr.owner, `${pr.repo}.git`)
  if (!fs.existsSync(repoDir)) {
    const cloning = `Cloning ${slug} (first time only)`
    progress(cloning)
    fs.mkdirSync(path.dirname(repoDir), { recursive: true })
    // Cloned beside its final place and moved there when complete, so that a clone cut short
    // (a dropped connection, a restart) is started again instead of being taken for a whole one.
    const partial = `${repoDir}.partial`
    fs.rmSync(partial, { recursive: true, force: true })
    try {
      await runTransfer('gh', ['repo', 'clone', slug, partial, '--', '--bare', '--progress'], { label: 'gh repo clone', onProgress: (p) => progress(cloning, p) })
      fs.renameSync(partial, repoDir)
    } catch (err) {
      fs.rmSync(partial, { recursive: true, force: true })
      throw err
    }
  }
  progress('Fetching the pull request')
  const headRefLocal = `refs/trail/pr-${pr.number}`
  const baseRefLocal = `refs/trail/base-${pr.number}`
  await runTransfer('git', ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', 'fetch', '--force', '--progress', 'origin', `+refs/pull/${pr.number}/head:${headRefLocal}`, `+refs/heads/${meta.baseRefName}:${baseRefLocal}`], {
    cwd: repoDir,
    label: 'git fetch',
    onProgress: (p) => progress('Fetching the pull request', p),
  })
  const headSha = (await git(repoDir, ['rev-parse', headRefLocal])).trim()
  let baseSha = (await git(repoDir, ['merge-base', headRefLocal, baseRefLocal])).trim()
  // Once a pull request is merged, its commits are part of the base branch, so the branch as it
  // is now has nothing the pull request lacks. GitHub records where the base branch stood for
  // the pull request; measured from there, the change is what was reviewed and merged.
  if (baseSha === headSha && /^[0-9a-f]{40,64}$/.test(String(meta.baseRefOid ?? ''))) {
    baseSha = (await git(repoDir, ['merge-base', headRefLocal, meta.baseRefOid]).catch(() => baseSha)).trim()
  }

  // A separate checkout of the head, so Claude and code search see the whole repository as the author left it.
  const workDir = path.join(TRAIL_HOME, 'worktrees', pr.owner, pr.repo, String(pr.number))
  // Checked here, at the moment the checkout would move, not when the refresh was requested.
  await withMove(workDir, async () => {
    if (isTrailCheckout(workDir)) {
      const dirty = (await git(workDir, ['status', '--porcelain', '--untracked-files=all'])).trim()
      const current = (await git(workDir, ['rev-parse', 'HEAD'])).trim()
      if (current !== headSha) {
        if (dirty) throw new Error(`The review checkout at ${workDir} has uncommitted changes. Commit, push or discard them before refreshing.`)
        await git(workDir, ['checkout', '--detach', headSha])
      }
    } else {
      progress('Preparing a checkout of the head commit')
      // Whatever is at that path is not a checkout Trail made (or no longer is one); start clean.
      fs.rmSync(workDir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(workDir), { recursive: true })
      await git(repoDir, ['worktree', 'prune'])
      await git(repoDir, ['worktree', 'add', '--detach', '--force', workDir, headSha], { timeoutMs: LONG })
    }
  })

  return {
    kind: 'pr',
    sourceKey: `pr:${slug}#${pr.number}`,
    title: meta.title,
    body: meta.body ?? '',
    url: meta.url,
    repoLabel: slug,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    author: meta.author?.login ?? null,
    baseRef: meta.baseRefName,
    headRef: meta.headRefName,
    baseSha,
    headSha,
    repoDir,
    workDir,
    // Pushing to a fork needs its own remote; keep to the simple, common case.
    canPush: !meta.isCrossRepository,
  }
}

/**
 * Whether the directory is a worktree Trail created: its .git must be a file pointing into one
 * of Trail's own clones. If something replaced it, git commands there could be redirected to a
 * repository of an attacker's design, so nothing is run in it.
 */
export function isTrailCheckout(workDir: string): boolean {
  try {
    const dotGit = path.join(workDir, '.git')
    if (!fs.lstatSync(dotGit).isFile()) return false
    const m = /^gitdir: (.+)\n?$/.exec(fs.readFileSync(dotGit, 'utf8'))
    if (!m) return false
    const repos = fs.realpathSync(path.join(TRAIL_HOME, 'repos')) + path.sep
    return fs.realpathSync(path.resolve(workDir, m[1])).startsWith(repos)
  } catch {
    return false
  }
}

async function defaultBase(repoDir: string): Promise<string> {
  try {
    const ref = (await git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
    if (ref) return ref
  } catch {
    // No origin/HEAD recorded; fall through to common names.
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await gitOk(repoDir, ['rev-parse', '--verify', '--quiet', candidate])) return candidate
  }
  throw new Error('Could not find a base branch. Pass one explicitly (for example --base main).')
}

/**
 * Commit object for the working tree, including untracked files, built through a
 * temporary index so the user's index, branch and files are left untouched.
 */
async function snapshotWorkingTree(repoDir: string): Promise<string | null> {
  // Explicit, because a personal status.showUntrackedFiles=no would hide brand-new files from the review.
  const status = (await git(repoDir, ['status', '--porcelain', '--untracked-files=all'])).trim()
  if (!status) return null
  const tmpIndex = path.join(os.tmpdir(), `trail-index-${process.pid}-${Date.now()}`)
  const realIndex = path.resolve(repoDir, (await git(repoDir, ['rev-parse', '--git-path', 'index'])).trim())
  // Starting from a copy of the real index keeps its stat cache, so only changed files are re-hashed.
  if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex)
  // An identity is supplied so this works on machines where git has none configured.
  const who = { GIT_AUTHOR_NAME: 'Trail', GIT_AUTHOR_EMAIL: 'trail@localhost', GIT_COMMITTER_NAME: 'Trail', GIT_COMMITTER_EMAIL: 'trail@localhost' }
  const env = { ...process.env, ...who, GIT_INDEX_FILE: tmpIndex }
  try {
    await git(repoDir, ['add', '-A'], { env })
    const tree = (await git(repoDir, ['write-tree'], { env })).trim()
    return (await git(repoDir, ['commit-tree', tree, '-p', 'HEAD', '-m', 'Trail: working tree snapshot'], { env })).trim()
  } finally {
    fs.rmSync(tmpIndex, { force: true })
  }
}

async function resolveLocal(dir: string, base: string | undefined, progress: Progress): Promise<Source> {
  if (dir === '~' || dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(1))
  if (!fs.existsSync(dir)) throw new Error(`${dir} does not exist.`)
  const top = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim()
  if (!top) throw new Error(`${dir} is not inside a git repository.`)
  if (base?.startsWith('-')) throw new Error('That is not a valid base branch.')
  const baseRef = base || (await defaultBase(top))
  const branch = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  progress('Snapshotting the working tree')
  const snapshot = await snapshotWorkingTree(top)
  const headSha = snapshot ?? (await git(top, ['rev-parse', 'HEAD'])).trim()
  const baseSha = (await git(top, ['merge-base', baseRef, 'HEAD'])).trim()
  const subjects = (await git(top, ['log', '--format=%s', `${baseSha}..HEAD`])).trim().split('\n').filter(Boolean)
  return {
    kind: 'local',
    sourceKey: `local:${top}:${branch}`,
    title: subjects.length === 1 ? subjects[0] : `${branch}${snapshot ? ' + uncommitted changes' : ''}`,
    body: '',
    url: null,
    repoLabel: path.basename(top),
    owner: null,
    repo: null,
    number: null,
    author: null,
    baseRef,
    headRef: branch,
    baseSha,
    headSha,
    repoDir: top,
    workDir: top,
    canPush: false,
  }
}

export interface ImportRequest {
  kind: 'pr' | 'local'
  ref?: string
  path?: string
  base?: string
}

export async function importReview(req: ImportRequest, progress: Progress): Promise<number> {
  const src = req.kind === 'pr' ? await resolvePr(req.ref ?? '', progress) : await resolveLocal(req.path || process.cwd(), req.base, progress)
  if (src.baseSha === src.headSha) throw new Error(`Nothing to review: ${src.headRef} has no changes against ${src.baseRef}.`)

  progress('Reading the diff')
  const files = await loadDiff(src.repoDir, src.baseSha, src.headSha)
  const moves = detectMoves(files)
  const log = (await git(src.repoDir, ['log', '--format=%h%x09%s', `${src.baseSha}..${src.headSha}`])).trim()
  const commits = log
    ? log.split('\n').map((l) => ({ sha: l.split('\t')[0], subject: l.split('\t').slice(1).join('\t') }))
    : []

  const now = Date.now()
  const id = tx(() => {
    db.prepare(
      `INSERT INTO reviews (kind, source_key, title, body, url, repo_label, owner, repo, number, author, base_ref, head_ref, base_sha, head_sha, repo_dir, work_dir, can_push, commits_json, files_json, moves_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO UPDATE SET title = excluded.title, body = excluded.body, base_ref = excluded.base_ref, head_ref = excluded.head_ref,
         base_sha = excluded.base_sha, head_sha = excluded.head_sha, repo_dir = excluded.repo_dir, work_dir = excluded.work_dir, can_push = excluded.can_push,
         commits_json = excluded.commits_json, files_json = excluded.files_json, moves_json = excluded.moves_json, updated_at = excluded.updated_at`,
    ).run(
      src.kind, src.sourceKey, src.title, src.body, src.url, src.repoLabel, src.owner, src.repo, src.number, src.author,
      src.baseRef, src.headRef, src.baseSha, src.headSha, src.repoDir, src.workDir, src.canPush ? 1 : 0,
      JSON.stringify(commits), JSON.stringify(files), JSON.stringify(moves), now, now,
    )
    const reviewId = (db.prepare('SELECT id FROM reviews WHERE source_key = ?').get(src.sourceKey) as { id: number }).id
    reanchorNotes(reviewId, files)
    return reviewId
  })

  progress('Indexing definitions for navigation')
  try {
    await indexSymbols(id, src.repoDir, src.headSha)
    annotateHunks(id, files)
    db.prepare('UPDATE reviews SET files_json = ? WHERE id = ?').run(JSON.stringify(files), id)
  } catch (err) {
    // Navigation is an aid, not a requirement: the review still opens without it.
    progress(`Navigation index unavailable: ${(err as Error).message}`)
  }
  return id
}

interface Row {
  id: number
  kind: 'pr' | 'local'
  title: string
  body: string
  url: string | null
  repo_label: string
  owner: string | null
  repo: string | null
  number: number | null
  author: string | null
  base_ref: string
  head_ref: string
  base_sha: string
  head_sha: string
  repo_dir: string
  work_dir: string
  can_push: number
  commits_json: string
  files_json: string
  moves_json: string
  symbols_sha: string | null
  updated_at: number
}

export interface LoadedReview {
  row: Row
  files: FileDiff[]
}

export function loadRow(id: number): LoadedReview {
  const row = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as unknown as Row | undefined
  if (!row) throw Object.assign(new Error('Review not found.'), { status: 404 })
  return { row, files: JSON.parse(row.files_json) }
}

function summarize(row: Row, files: FileDiff[], viewed: Set<string>): ReviewSummary {
  const hunks = files.flatMap((f) => f.hunks)
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    repoLabel: row.repo_label,
    number: row.number,
    author: row.author,
    baseRef: row.base_ref,
    headRef: row.head_ref,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    fileCount: files.length,
    hunkCount: hunks.length,
    viewedCount: hunks.filter((h) => viewed.has(h.key)).length,
    updatedAt: row.updated_at,
  }
}

/** Identity of the diff as a whole. A walkthrough applies as long as this is unchanged. */
export function fingerprint(files: FileDiff[]): string {
  const hash = createHash('sha1')
  for (const f of files) for (const h of f.hunks) hash.update(`${h.id}:${h.key};`)
  return hash.digest('hex').slice(0, 16)
}

function viewedKeys(id: number): Set<string> {
  const rows = db.prepare('SELECT hunk_key FROM viewed WHERE review_id = ?').all(id) as { hunk_key: string }[]
  return new Set(rows.map((r) => r.hunk_key))
}

export function listReviews(): ReviewSummary[] {
  const rows = db.prepare('SELECT * FROM reviews ORDER BY updated_at DESC').all() as unknown as Row[]
  return rows.map((row) => summarize(row, JSON.parse(row.files_json), viewedKeys(row.id)))
}

export function listComments(id: number): Comment[] {
  const rows = db.prepare('SELECT * FROM comments WHERE review_id = ? ORDER BY path, line, id').all(id) as any[]
  return rows.map((r) => ({ id: r.id, path: r.path, side: r.side, line: r.line, inDiff: !!r.in_diff, body: r.body, outdated: !!r.outdated, status: r.status, createdAt: r.created_at }))
}

/**
 * After a re-import, line numbers may point at different code. Each draft note remembers the
 * text of its line: if that text is still at the same line nothing changes; if it now sits at
 * exactly one other line of the file's diff the note follows it; otherwise the note is marked
 * outdated, so it is never posted to GitHub against code it was not written about.
 */
function reanchorNotes(id: number, files: FileDiff[]): void {
  const notes = db.prepare("SELECT id, path, side, line, line_text FROM comments WHERE review_id = ? AND status = 'draft' AND in_diff = 1 AND line_text IS NOT NULL").all(id) as {
    id: number
    path: string
    side: string
    line: number
    line_text: string
  }[]
  const update = db.prepare('UPDATE comments SET line = ?, outdated = ? WHERE id = ?')
  for (const note of notes) {
    const lines = files
      .filter((f) => f.path === note.path)
      .flatMap((f) => f.hunks.flatMap((h) => h.lines))
      .filter((l) => (note.side === 'old' ? l.t !== '+' : l.t !== '-'))
      .map((l) => ({ no: (note.side === 'old' ? l.o : l.n)!, text: l.s }))
    const same = lines.filter((l) => l.text === note.line_text)
    if (same.some((l) => l.no === note.line)) update.run(note.line, 0, note.id)
    else if (same.length === 1) update.run(same[0].no, 0, note.id)
    else update.run(note.line, 1, note.id)
  }
}

export function getReview(id: number): Review {
  const { row, files } = loadRow(id)
  const viewed = viewedKeys(id)
  const wt = db.prepare('SELECT json FROM walkthroughs WHERE review_id = ?').get(id) as { json: string } | undefined
  const moves: Move[] = JSON.parse(row.moves_json)
  return {
    ...summarize(row, files, viewed),
    body: row.body,
    workDir: row.work_dir,
    commits: JSON.parse(row.commits_json),
    files,
    moves,
    viewed: [...viewed],
    comments: listComments(id),
    walkthrough: wt ? (JSON.parse(wt.json) as Walkthrough) : null,
    fingerprint: fingerprint(files),
    symbolsReady: row.symbols_sha === row.head_sha,
    canPush: !!row.can_push,
  }
}

/** Import the same source again, picking up new commits or working tree changes. */
export async function refreshReview(id: number, progress: Progress): Promise<number> {
  const { row } = loadRow(id)
  if (row.kind === 'pr') return importReview({ kind: 'pr', ref: `${row.repo_label}#${row.number}` }, progress)
  return importReview({ kind: 'local', path: row.repo_dir, base: row.base_ref }, progress)
}
