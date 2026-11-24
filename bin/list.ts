// Fetches pull requests to choose from, through the gh command and the reader's own GitHub login.
import type { ListFilters } from './args.ts'

/** One pull request as shown in the list. Fields GitHub's search does not return are left out. */
export interface PrRow {
  /** owner/repo */
  repo: string
  number: number
  title: string
  author: string
  draft: boolean
  state: 'open' | 'closed' | 'merged'
  updatedAt: string
  branch?: string
  additions?: number
  deletions?: number
  files?: number
  /** Whose review is requested: logins, and teams written as "team <slug>". */
  reviewers: string[]
  /** Whether GitHub reported review requests for this row. Its cross-repository search does not. */
  reviewKnown: boolean
  decision?: 'approved' | 'changes requested'
  labels: string[]
  /** Progress of a review of this pull request already in Trail, such as "5/12 viewed". */
  inTrail?: string
}

export interface ListTarget {
  repo?: string
  owner?: string
  filters: ListFilters
}

const REPO_FIELDS = 'number,title,author,isDraft,state,updatedAt,headRefName,additions,deletions,changedFiles,reviewRequests,reviewDecision,labels'
const SEARCH_FIELDS = 'number,title,author,isDraft,state,updatedAt,repository,labels'

/** A qualifier in GitHub's search syntax. The value is always quoted, with any quotes of its own removed. */
function term(key: string, value: string): string {
  return `${key}:"${value.replace(/"/g, '')}"`
}

/** GitHub has one qualifier for a person asked to review and another for a team (written org/team). */
function reviewTerm(reviewer: string): string {
  return term(reviewer.includes('/') ? 'team-review-requested' : 'review-requested', reviewer)
}

/**
 * Free search text as the separate arguments `gh search` expects. gh adds the quotes itself
 * around any argument containing a space, and would quote ours a second time, so a quoted
 * phrase ("exact phrase", or label:"needs review") is handed over as one argument without them.
 */
function words(text: string): string[] {
  return (text.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((w) => w.replace(/"/g, '')).filter(Boolean)
}

/**
 * Across repositories, a list with no filter at all answers "what is waiting for me?".
 * Any filter replaces that question: merged or labelled pull requests are rarely still
 * waiting for a review, so adding it silently would return almost nothing.
 */
export function impliedReviewer(target: ListTarget): string | undefined {
  const f = target.filters
  if (f.reviewer) return f.reviewer
  return !target.repo && !f.author && !f.search && !f.label && f.state === 'open' ? '@me' : undefined
}

/**
 * The gh command for a list. Within one repository `gh pr list` returns sizes and review
 * requests; across repositories only GitHub's search can answer, with fewer details.
 * Values are attached to their flag with "=" so that none can be mistaken for a flag.
 */
export function ghListArgs(target: ListTarget): string[] {
  const f = target.filters
  if (target.repo) {
    const args = ['pr', 'list', '-R', target.repo, `--state=${f.state}`, `--limit=${f.limit}`, `--json=${REPO_FIELDS}`]
    // gh has no flag for "review requested from", and its --label splits on commas, so those
    // cases and free text go through the search query. The other filters join it there, so
    // that one query says everything.
    if (f.reviewer || f.search || (f.label && f.label.includes(','))) {
      const query = [f.author && term('author', f.author), f.reviewer && reviewTerm(f.reviewer), f.label && term('label', f.label), f.search]
      args.push(`--search=${query.filter(Boolean).join(' ')}`)
    } else {
      if (f.author) args.push(`--author=${f.author}`)
      if (f.label) args.push(`--label=${f.label}`)
    }
    return args
  }
  const args = ['search', 'prs', `--limit=${f.limit}`, '--sort=updated', `--json=${SEARCH_FIELDS}`]
  if (target.owner) args.push(`--owner=${target.owner}`)
  if (f.state === 'merged') args.push('--merged')
  else if (f.state !== 'all') args.push(`--state=${f.state}`)
  if (f.author) args.push(`--author=${f.author}`)
  if (f.label) args.push(`--label=${f.label}`)
  const reviewer = impliedReviewer(target)
  if (reviewer) args.push(`--review-requested=${reviewer}`)
  // gh quotes any search argument that contains a space, which would turn `is:draft label:bug`
  // into one meaningless phrase. So the text is handed over word by word.
  if (f.search) args.push('--', ...words(f.search))
  return args
}

/** What the list contains, in words, for the heading. */
export function describeList(target: ListTarget): string {
  const f = target.filters
  const reviewer = impliedReviewer(target)
  const who = (v: string) => (v === '@me' ? 'you' : v)
  const parts = [
    f.state === 'all' ? 'pull requests (any state)' : `${f.state} pull requests`,
    target.repo ? `in ${target.repo}` : target.owner ? `across ${target.owner}` : 'across GitHub',
    f.author && `by ${who(f.author)}`,
    reviewer && `waiting for ${reviewer === '@me' ? 'your review' : `review by ${reviewer}`}`,
    f.label && `labelled ${f.label}`,
    f.search && `matching "${f.search}"`,
  ]
  return parts.filter(Boolean).join(' ')
}

/**
 * Text from GitHub, made safe to print. Titles, branch names and labels are written by
 * whoever opened the pull request, and a terminal acts on control characters: without this a
 * title could clear the screen, rename the window or write to the clipboard. Characters that
 * reorder text (bidirectional overrides) are removed too, since they can make a line read
 * as something it is not.
 */
export function printable(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
}

type Json = Record<string, any>

/** gh's two result shapes, made the same. `me` fills in what a search result implies but does not state. */
export function normalize(items: Json[], target: ListTarget, me: string): PrRow[] {
  const askedForMe = !target.repo && impliedReviewer(target) === '@me'
  const names = (list: unknown, name: (item: Json) => unknown) => (Array.isArray(list) ? list.map((item: Json) => printable(name(item))).filter(Boolean) : [])
  return items.map((p) => {
    const state = String(p.state ?? 'open').toLowerCase()
    const decision = p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : undefined
    return {
      repo: target.repo ?? printable(p.repository?.nameWithOwner),
      number: Number(p.number),
      title: printable(p.title),
      author: printable(p.author?.login) || 'unknown',
      draft: !!p.isDraft,
      state: state === 'merged' || state === 'closed' ? state : 'open',
      updatedAt: printable(p.updatedAt),
      ...(p.headRefName ? { branch: printable(p.headRefName) } : {}),
      ...(typeof p.additions === 'number' ? { additions: p.additions, deletions: Number(p.deletions ?? 0), files: Number(p.changedFiles ?? 0) } : {}),
      // A search for "review requested from me" does not list reviewers, but every result has that request.
      reviewers: Array.isArray(p.reviewRequests) ? names(p.reviewRequests, (r) => (r.login ? r.login : `team ${r.slug ?? r.name ?? ''}`.trim())) : askedForMe && me ? [me] : [],
      reviewKnown: Array.isArray(p.reviewRequests) || (askedForMe && !!me),
      ...(decision ? { decision } : {}),
      labels: names(p.labels, (l) => l.name),
    } satisfies PrRow
  })
}

async function gh(args: string[]): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    // gh must fail rather than stop to ask something nobody will see, and must talk to
    // github.com, which is the only host Trail supports, whatever GH_HOST says.
    proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' } })
  } catch {
    throw new Error('The gh command was not found. Install the GitHub CLI and run `gh auth login`.')
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited])
  if (code !== 0) throw new Error(printable(err.trim().split('\n').slice(-3).join(' ')) || `gh ${args[0]} ${args[1]} failed.`)
  return out
}

export async function fetchList(target: ListTarget): Promise<{ rows: PrRow[]; me: string }> {
  const [list, me] = await Promise.all([gh(ghListArgs(target)), gh(['api', 'user', '--jq', '.login']).then((s) => printable(s), () => '')])
  let items: unknown
  try {
    items = JSON.parse(list)
  } catch {
    throw new Error('GitHub returned a list that could not be read. Run the command again; if it keeps happening, check `gh auth status`.')
  }
  if (!Array.isArray(items)) throw new Error('GitHub returned something other than a list of pull requests.')
  return { rows: normalize(items as Json[], target, me), me }
}
