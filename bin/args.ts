// Command-line parsing for the launcher, kept free of side effects so it can be tested.
import path from 'node:path'
import { isAddress, isGithubAddress, isValidName, parsePrRef, parseRepoRef } from '../shared/pr-ref.ts'

const VALUE_FLAGS = ['base', 'owner', 'author', 'reviewer', 'label', 'state', 'search', 'limit'] as const
const SWITCHES = { '--no-open': 'noOpen', '--list': 'list', '--mine': 'mine', '--for-me': 'forMe', '--unset': 'unset', '--help': 'help', '-h': 'help' } as const
type ValueFlag = (typeof VALUE_FLAGS)[number]
/** Options that narrow a list of pull requests. Giving any of them asks for a list. */
const FILTER_FLAGS = ['author', 'reviewer', 'label', 'state', 'search', 'limit'] as const

export type Args = { positional: string[]; noOpen: boolean; list: boolean; mine: boolean; forMe: boolean; unset: boolean; help: boolean } & Partial<Record<ValueFlag, string>>

export type PrState = 'open' | 'closed' | 'merged' | 'all'

export interface ListFilters {
  /** A login, or @me. */
  author?: string
  /** A login or team whose review is requested, or @me. */
  reviewer?: string
  label?: string
  state: PrState
  /** Extra words in GitHub's search syntax. */
  search?: string
  limit: number
}

export type Target =
  | { kind: 'home' }
  | { kind: 'serve' }
  | { kind: 'stop' }
  /** Check that everything Trail depends on is installed and logged in. */
  | { kind: 'doctor' }
  /** Show the saved settings, show one, set one, or (unset) remove one. */
  | { kind: 'config'; key?: string; value?: string; unset: boolean }
  | { kind: 'pr'; ref: string }
  | { kind: 'local'; path: string; base?: string }
  /** Pull requests to choose from: of one repository, or (without one) across an owner or all of GitHub. */
  | { kind: 'list'; repo?: string; owner?: string; filters: ListFilters }

export function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], noOpen: false, list: false, mine: false, forMe: false, unset: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a in SWITCHES) args[SWITCHES[a as keyof typeof SWITCHES]] = true
    else if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s)
      const flag = VALUE_FLAGS.find((f) => f === name)
      if (!flag) throw new Error(`Unknown option ${a}. Run trail --help to see the options.`)
      // Written as --flag=value, the value may start with a dash (GitHub's search uses that to
      // exclude: --search=-label:wip). As the next word, a dash means the value was forgotten.
      const value = inline ?? argv[++i]
      if (!value || (inline === undefined && value.startsWith('-'))) throw new Error(`--${flag} needs a value.`)
      args[flag] = value
    } else if (a.startsWith('-') && a.length > 1) throw new Error(`Unknown option ${a}. Run trail --help to see the options.`)
    else args.positional.push(a)
  }
  return args
}

/** An option that would be ignored is refused, so a command never quietly does less than was asked. */
function refuse(args: Args, flags: readonly ValueFlag[], why: string): void {
  for (const flag of flags) if (args[flag] !== undefined) throw new Error(`--${flag} ${why}`)
}

function wantsList(args: Args): boolean {
  return args.list || args.mine || args.forMe || FILTER_FLAGS.some((f) => args[f] !== undefined)
}

function refuseListOptions(args: Args, why: string): void {
  if (args.list) throw new Error(`--list ${why}`)
  if (args.mine) throw new Error(`--mine ${why}`)
  if (args.forMe) throw new Error(`--for-me ${why}`)
  refuse(args, FILTER_FLAGS, why)
}

const LOGIN = /^(@me|[A-Za-z0-9_][\w.-]*)$/
// A review can also be requested from a team, written org/team.
const LOGIN_OR_TEAM = /^(@me|[A-Za-z0-9_][\w.-]*(\/[\w.-]+)?)$/

function listFilters(args: Args): ListFilters {
  if (args.mine && args.author) throw new Error('--mine and --author say two different things. Use one.')
  if (args.forMe && args.reviewer) throw new Error('--for-me and --reviewer say two different things. Use one.')
  const author = args.mine ? '@me' : args.author
  const reviewer = args.forMe ? '@me' : args.reviewer
  if (author !== undefined && !LOGIN.test(author)) throw new Error(`"${author}" is not a GitHub user name. Use a login, or @me, after --author.`)
  if (reviewer !== undefined && !LOGIN_OR_TEAM.test(reviewer)) throw new Error(`"${reviewer}" is not a GitHub user or team. Use a login, org/team, or @me, after --reviewer.`)
  const state = (args.state ?? 'open').toLowerCase()
  if (state !== 'open' && state !== 'closed' && state !== 'merged' && state !== 'all') throw new Error(`--state must be open, closed, merged or all, not "${args.state}".`)
  const limit = args.limit === undefined ? 50 : Number(args.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error(`--limit must be a number from 1 to 500, not "${args.limit}".`)
  return { ...(author ? { author } : {}), ...(reviewer ? { reviewer } : {}), ...(args.label ? { label: args.label } : {}), state, ...(args.search ? { search: args.search } : {}), limit }
}

/** The owner to use: one written in the reference, then --owner, then TRAIL_OWNER. Two different ones are refused. */
function pickOwner(written: string | undefined, args: Args, defaultOwner: string | undefined): string | undefined {
  if (written && args.owner && written !== args.owner) throw new Error(`--owner ${args.owner} conflicts with the owner "${written}" written in the reference. Use one or the other.`)
  const owner = written ?? args.owner ?? defaultOwner
  if (owner !== undefined && !isValidName(owner)) throw new Error(`"${owner}" is not a valid owner name.`)
  return owner
}

/**
 * What the arguments ask for.
 *
 * - A pull request: one word (an address, owner/repo/123, owner/repo#123, repo#123) or two
 *   (repository, then number).
 * - A list to choose from: a repository without a number (owner/repo, a repository address,
 *   or just repo), or --list or any filter option.
 * - A local repository: a path starting with ".", "/" or "~".
 *
 * `exists` says whether a relative path is a real file or folder. A word that is both a
 * GitHub reference and something on disk is refused rather than guessed at.
 */
export function resolveTarget(args: Args, defaultOwner: string | undefined, exists: (p: string) => boolean = () => false): Target {
  const ownerHint = 'Save one with "trail config owner <name>"'
  const [first, second, ...extra] = args.positional
  const listing = wantsList(args)

  // Commands with words of their own. A number after one means a repository of that name instead.
  if ((first === 'config' || first === 'doctor') && !/^#?\d+$/.test(second ?? '')) {
    refuseListOptions(args, `does nothing with "trail ${first}".`)
    refuse(args, ['base', 'owner'], `does nothing with "trail ${first}".`)
    if (first === 'doctor') {
      if (second !== undefined || args.unset) throw new Error('"trail doctor" takes no arguments.')
      return { kind: 'doctor' }
    }
    if (extra.length > 1) throw new Error('Too many arguments. Use: trail config [name] [value].')
    if (args.unset && (second === undefined || extra.length)) throw new Error('Use --unset with one setting and no value: trail config owner --unset.')
    return { kind: 'config', key: second, value: extra[0], unset: args.unset }
  }
  if (args.unset) throw new Error('--unset only applies to "trail config <name>".')
  if (extra.length) throw new Error('Too many arguments. Run trail --help for usage.')

  if (first === undefined) {
    refuse(args, ['base'], 'needs a local repository to review. Run trail --help for usage.')
    if (listing) return { kind: 'list', owner: pickOwner(undefined, args, defaultOwner), filters: listFilters(args) }
    refuse(args, ['owner'], 'needs something to review. Run trail --help for usage.')
    return { kind: 'home' }
  }

  if (second !== undefined) {
    if (!/^#?\d+$/.test(second)) throw new Error(`Expected a pull request number after "${first}", but got "${second}".`)
    if (!/^#?0*[1-9]\d{0,8}$/.test(second)) throw new Error(`"${second}" is not a pull request number.`)
    if (!/^[^/\s#]+(\/[^/\s#]+)?$/.test(first)) throw new Error(`"${first}" is not a repository name. Use repo or owner/repo before the number.`)
  } else if (first === 'serve' || first === 'stop') {
    refuseListOptions(args, `does nothing with "trail ${first}". For a repository of that name, write owner/${first}.`)
    refuse(args, ['base', 'owner'], `does nothing with "trail ${first}".`)
    return { kind: first }
  } else if (/^#?\d+$/.test(first)) {
    throw new Error(`"${first}" is only a number. Put the repository first: trail <repo> ${first.replace('#', '')}.`)
  } else if (/^[./~]/.test(first)) {
    // Spelled as a path, so it is one.
    refuseListOptions(args, 'lists pull requests on GitHub, so it needs a repository name, not a folder.')
    refuse(args, ['owner'], 'only applies to pull requests.')
    return { kind: 'local', path: path.resolve(first), base: args.base }
  }

  // "name/123" is pull request 123 of the repository "name", unless a list was asked for:
  // then it is the repository called "123" of the owner "name".
  const repoNamedByNumber = second === undefined && listing && /^[^/\s#]+\/\d+$/.test(first)
  const pr = repoNamedByNumber ? null : parsePrRef(second === undefined ? first : `${first} ${second}`)
  if (pr) {
    refuseListOptions(args, 'is for choosing from a list, but this names one pull request. Leave out the number to list.')
    if (second === undefined && exists(first)) {
      throw new Error(`"${first}" is a file or folder here and also reads as a pull request. Write ./${first} for the one on disk, or the pull request as "${pr.owner ? `${pr.owner}/` : ''}${pr.repo} ${pr.number}".`)
    }
    refuse(args, ['base'], 'only applies to a local repository; a pull request already has a base branch.')
    const owner = pickOwner(pr.owner, args, defaultOwner)
    if (!owner) throw new Error(`No owner for "${pr.repo}". ${ownerHint}, or pass --owner <name>.`)
    return { kind: 'pr', ref: `${owner}/${pr.repo}#${pr.number}` }
  }
  if (second !== undefined) throw new Error(`"${first}" is not a repository name. Use repo or owner/repo before the number.`)

  // A repository without a number: list its pull requests to choose from.
  const repo = parseRepoRef(first)
  if (repo) {
    // "src/app" could be a path even when it does not exist yet, if "src" does.
    const onDisk = exists(first) || (first.includes('/') && exists(first.split('/')[0]))
    // --base only means something for a local repository, so with it a name on disk is that repository.
    if (onDisk && args.base !== undefined && !listing) return { kind: 'local', path: path.resolve(first), base: args.base }
    const owner = pickOwner(repo.owner, args, defaultOwner)
    if (!owner) {
      // Without an owner a bare word cannot be looked up on GitHub, so a folder of that name is simply the folder.
      if (onDisk && !listing) return { kind: 'local', path: path.resolve(first), base: args.base }
      throw new Error(`"${first}" ${onDisk ? 'needs an owner to be listed' : 'is not a folder here, and has no owner to look it up under on GitHub'}. ${ownerHint}, pass --owner <name>, or write owner/${repo.repo}.`)
    }
    if (onDisk && !listing) throw new Error(`"${first}" is a file or folder here and also reads as the GitHub repository ${owner}/${repo.repo}. Write ./${first} for the one on disk, or add --list for the repository's pull requests.`)
    refuse(args, ['base'], 'only applies to a local repository.')
    return { kind: 'list', repo: `${owner}/${repo.repo}`, filters: listFilters(args) }
  }

  if (isGithubAddress(first) && first.includes('?') && parseRepoRef(first.replace(/\?.*$/, ''))) {
    throw new Error('That address carries a filter (the part after "?"), which Trail cannot read. Use the address without it, and add --search "<words>" or one of the other filters.')
  }
  if (isGithubAddress(first)) throw new Error('That GitHub address is neither a pull request nor a repository. It should look like https://github.com/owner/repo or https://github.com/owner/repo/pull/123.')
  if (isAddress(first)) throw new Error(`Trail reads pull requests from github.com only, so it cannot open ${first}.`)
  refuseListOptions(args, 'needs a repository name such as owner/repo.')
  refuse(args, ['owner'], 'only applies to pull requests.')
  return { kind: 'local', path: path.resolve(first), base: args.base }
}
