// One place that understands every way a pull request can be written, used by the command
// line and by the server (for the box on the home page), so both accept the same forms.

export interface PrRef {
  /** Missing when only the repository was named; the caller supplies the default owner. */
  owner?: string
  repo: string
  number: number
}

const NAME = /^[A-Za-z0-9_][\w.-]*$/
const GITHUB = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i
// Up to nine digits: every real pull request number fits, and nothing overflows or loses precision.
const N = '(\\d{1,9})'

const FORMS: RegExp[] = [
  // A GitHub address, with or without https://, and with anything after the number
  // (/files, /commits/…, ?diff=split, #discussion_r1): github.com/owner/repo/pull/123
  new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/([^/\\s?#]+)\\/([^/\\s?#]+)\\/pull\\/${N}(?:[/?#]\\S*)?$`, 'i'),
  // The path of such an address on its own: owner/repo/pull/123
  new RegExp(`^([^/\\s?#]+)\\/([^/\\s?#]+)\\/pull\\/${N}(?:[/?#]\\S*)?$`),
  // owner/repo/123
  new RegExp(`^([^/\\s#]+)\\/([^/\\s#]+)\\/${N}$`),
  // owner/repo#123 and owner/repo 123
  new RegExp(`^([^/\\s#]+)\\/([^/\\s#]+)(?:#|\\s+#?)${N}$`),
  // repo#123 and repo 123, owner to be filled in
  new RegExp(`^()([^/\\s#]+)(?:#|\\s+#?)${N}$`),
]

/** Whether the text could be the name of a GitHub user, organisation or repository. Also keeps names from being read as command options or as "." and "..". */
export function isValidName(name: string): boolean {
  return NAME.test(name)
}

/**
 * The pull request a piece of text refers to, or null when the text is not a pull request
 * reference (a local path, for instance). Names that could not be a GitHub owner or
 * repository, such as "." or "..", make it null too, so "./a/b/12" stays a path.
 */
export function parsePrRef(text: string): PrRef | null {
  const input = text.trim()
  // Something on github.com is either a pull request address or not a pull request at all;
  // the looser forms must not reinterpret it (github.com/owner/123 is not owner "github.com").
  for (const form of GITHUB.test(input) ? FORMS.slice(0, 1) : FORMS) {
    const m = form.exec(input)
    if (!m) continue
    const owner = m[1]
    // The clone address of a repository ends in .git; the repository itself does not.
    const repo = m[2].replace(/\.git$/i, '')
    const number = Number(m[3])
    if ((owner && !NAME.test(owner)) || !NAME.test(repo) || number < 1) return null
    return { ...(owner ? { owner } : {}), repo, number }
  }
  return null
}

export interface RepoRef {
  /** Missing when only the repository was named; the caller supplies the default owner. */
  owner?: string
  repo: string
}

const REPO_FORMS: RegExp[] = [
  // A repository address, optionally its pull request list: github.com/owner/repo, …/repo/pulls
  // A query string (?q=…) is not accepted: it is a filter, and dropping it would list more than was asked for.
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\/pulls)?\/?(?:#\S*)?$/i,
  // owner/repo
  /^([^/\s#]+)\/([^/\s#]+?)\/?$/,
  // repo, owner to be filled in
  /^()([^/\s#]+)$/,
]

/**
 * The repository a piece of text names, without a pull request number: the "incomplete"
 * forms of a reference. Null when the text is not one (a path such as ./a/b, for instance).
 */
export function parseRepoRef(text: string): RepoRef | null {
  const input = text.trim()
  for (const form of GITHUB.test(input) ? REPO_FORMS.slice(0, 1) : REPO_FORMS) {
    const m = form.exec(input)
    if (!m) continue
    const owner = m[1]
    const repo = m[2].replace(/\.git$/i, "")
    if ((owner && !NAME.test(owner)) || !NAME.test(repo)) return null
    return { ...(owner ? { owner } : {}), repo }
  }
  return null
}

/** True for a github.com address, whether or not it points at a pull request. */
export function isGithubAddress(text: string): boolean {
  return GITHUB.test(text.trim())
}

/**
 * True for text that is plainly a web or git address rather than a folder: it has a scheme
 * (https://…), is an SSH address (git@host:…), or starts with a host name and contains /pull/.
 * Used to refuse addresses on other hosts clearly instead of treating them as folder names.
 */
export function isAddress(text: string): boolean {
  const input = text.trim()
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^[\w.-]+@[\w.-]+:/.test(input) || /^[\w-]+(\.[\w-]+)+(:\d+)?\/.*\/pull\/\d+/i.test(input)
}

export const PR_FORMS_HELP = 'a pull request address (https://github.com/owner/repo/pull/123), owner/repo/123, owner/repo#123, or repo 123 with a default owner set'
