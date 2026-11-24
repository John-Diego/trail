// Command-line parsing for the launcher, kept free of side effects so it can be tested.
import path from 'node:path'
import { isAddress, isGithubAddress, isValidName, parsePrRef } from '../shared/pr-ref.ts'

export { parseEnvFile } from '../shared/settings.ts'

export interface Args {
  positional: string[]
  base?: string
  owner?: string
  noOpen: boolean
  help: boolean
}

export type Target = { kind: 'home' } | { kind: 'serve' } | { kind: 'stop' } | { kind: 'pr'; ref: string } | { kind: 'local'; path: string; base?: string }

const VALUE_FLAGS = ['base', 'owner'] as const

export function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], noOpen: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-open') args.noOpen = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (a.startsWith('--')) {
      const [name, inline] = a.slice(2).split(/=(.*)/s)
      const flag = VALUE_FLAGS.find((f) => f === name)
      if (!flag) throw new Error(`Unknown option ${a}. Run trail --help to see the options.`)
      const value = inline ?? argv[++i]
      if (!value || value.startsWith('-')) throw new Error(`--${flag} needs a value.`)
      args[flag] = value
    } else if (a.startsWith('-') && a.length > 1) throw new Error(`Unknown option ${a}. Run trail --help to see the options.`)
    else args.positional.push(a)
  }
  return args
}

/** An option that would be ignored is refused, so a command never quietly does less than was asked. */
function refuse(args: Args, flags: readonly ('base' | 'owner')[], why: string): void {
  for (const flag of flags) if (args[flag] !== undefined) throw new Error(`--${flag} ${why}`)
}

/**
 * What the arguments ask for. A pull request can be written as one word (an address,
 * owner/repo/123, owner/repo#123, repo#123) or as two (repository, then number). Anything
 * else that is a single word is a command or a local path.
 *
 * `exists` says whether a relative path is a real file or folder. A word that is both a
 * pull request reference and something on disk is refused rather than guessed at.
 */
export function resolveTarget(args: Args, defaultOwner: string | undefined, envFile: string, exists: (p: string) => boolean = () => false): Target {
  const [first, second, ...extra] = args.positional
  if (extra.length) throw new Error('Too many arguments. Run trail --help for usage.')
  if (first === undefined) {
    refuse(args, VALUE_FLAGS, 'needs something to review. Run trail --help for usage.')
    return { kind: 'home' }
  }

  if (second !== undefined) {
    if (!/^#?\d+$/.test(second)) throw new Error(`Expected a pull request number after "${first}", but got "${second}".`)
    if (!/^#?0*[1-9]\d{0,8}$/.test(second)) throw new Error(`"${second}" is not a pull request number.`)
    if (!/^[^/\s#]+(\/[^/\s#]+)?$/.test(first)) throw new Error(`"${first}" is not a repository name. Use repo or owner/repo before the number.`)
  } else if (first === 'serve' || first === 'stop') {
    refuse(args, VALUE_FLAGS, `does nothing with "trail ${first}".`)
    return { kind: first }
  }

  const text = second === undefined ? first : `${first} ${second}`
  const pr = parsePrRef(text)
  if (pr) {
    if (second === undefined && exists(first)) {
      throw new Error(`"${first}" is a folder here and also reads as a pull request. Write ./${first} for the folder, or the pull request as "${pr.owner ? `${pr.owner}/` : ''}${pr.repo} ${pr.number}".`)
    }
    refuse(args, ['base'], 'only applies to a local repository; a pull request already has a base branch.')
    if (pr.owner && args.owner && pr.owner !== args.owner) throw new Error(`--owner ${args.owner} conflicts with the owner "${pr.owner}" written in the reference. Use one or the other.`)
    // An owner written with the repository, then --owner, then TRAIL_OWNER.
    const owner = pr.owner ?? args.owner ?? defaultOwner
    if (!owner) throw new Error(`No owner for "${pr.repo}". Set TRAIL_OWNER in ${envFile}, or pass --owner <name>.`)
    if (!isValidName(owner)) throw new Error(`"${owner}" is not a valid owner name.`)
    return { kind: 'pr', ref: `${owner}/${pr.repo}#${pr.number}` }
  }
  if (second !== undefined) throw new Error(`"${first}" is not a repository name. Use repo or owner/repo before the number.`)
  if (isGithubAddress(first)) throw new Error('That GitHub address is not a pull request. It should look like https://github.com/owner/repo/pull/123.')
  if (isAddress(first)) throw new Error(`Trail reads pull requests from github.com only, so it cannot open ${first}.`)
  refuse(args, ['owner'], 'only applies to pull requests.')
  return { kind: 'local', path: path.resolve(first), base: args.base }
}
