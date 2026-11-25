import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { isAddress, parsePrRef, parseRepoRef } from '../shared/pr-ref.ts'
import fs from 'node:fs'
import { configFile, configProblem, readConfig, setting, trailHome, trailPort, writeConfig } from '../shared/settings.ts'
import { parseArgs, resolveTarget, type ListFilters } from './args.ts'
import { describeList, ghListArgs, normalize, printable, type PrRow } from './list.ts'
import { age, fit, incomplete, layout, line, matches, narrowed, parseKeys, reduce, render, scopesFor, status, visibleTop, width, type PickerState } from './picker.ts'

const target = (argv: string[], owner?: string) => resolveTarget(parseArgs(argv), owner)

test('repo and number use the owner from the settings file', () => {
  assert.deepEqual(target(['api', '123'], 'acme'), { kind: 'pr', ref: 'acme/api#123' })
  assert.deepEqual(target(['api', '#123'], 'acme'), { kind: 'pr', ref: 'acme/api#123' })
  assert.deepEqual(target(['api#123'], 'acme'), { kind: 'pr', ref: 'acme/api#123' })
})

test('--owner overrides the settings file, in either position and either spelling', () => {
  assert.deepEqual(target(['api', '123', '--owner', 'other'], 'acme'), { kind: 'pr', ref: 'other/api#123' })
  assert.deepEqual(target(['--owner=other', 'api', '123'], 'acme'), { kind: 'pr', ref: 'other/api#123' })
  assert.deepEqual(target(['api', '--owner', 'other', '123']), { kind: 'pr', ref: 'other/api#123' })
})

test('an owner written with the repository wins over the settings file; a conflicting --owner is refused', () => {
  assert.deepEqual(target(['third/api', '7'], 'acme'), { kind: 'pr', ref: 'third/api#7' })
  assert.deepEqual(target(['third/api#7'], 'acme'), { kind: 'pr', ref: 'third/api#7' })
  assert.deepEqual(target(['third/api', '7', '--owner', 'third'], 'acme'), { kind: 'pr', ref: 'third/api#7' })
  assert.throws(() => target(['third/api', '7', '--owner', 'other'], 'acme'), /--owner other conflicts with the owner "third"/)
  assert.throws(() => target(['https://github.com/third/api/pull/7', '--owner', 'other']), /conflicts/)
})

test('a missing owner is explained, with where to set it', () => {
  assert.throws(() => target(['api', '123']), /No owner for "api".*trail config owner.*--owner/s)
})

test('URLs, local paths and commands still work', () => {
  const url = 'https://github.com/acme/api/pull/9'
  // Every form is reduced to owner/repo#number before it reaches the server.
  assert.deepEqual(target([url]), { kind: 'pr', ref: 'acme/api#9' })
  assert.deepEqual(target(['.']), { kind: 'local', path: path.resolve('.'), base: undefined })
  assert.deepEqual(target(['~/code/app', '--base', 'develop']), { kind: 'local', path: path.resolve('~/code/app'), base: 'develop' })
  assert.deepEqual(target([]), { kind: 'home' })
  assert.deepEqual(target(['stop']), { kind: 'stop' })
  // A repository that happens to be called "serve" is still a repository when a number follows.
  assert.deepEqual(target(['serve', '4'], 'acme'), { kind: 'pr', ref: 'acme/serve#4' })
})

test('mistakes are reported instead of guessed at', () => {
  assert.throws(() => target(['api', 'main'], 'acme'), /pull request number/)
  assert.throws(() => target(['api', '1', '2'], 'acme'), /Too many arguments/)
  assert.throws(() => target(['.', '12'], 'acme'), /not a repository name/)
  assert.throws(() => target(['api', '1', '--owner', '-x'], 'acme'), /--owner needs a value/)
  assert.throws(() => target(['api', '1', '--owner', 'a/b'], 'acme'), /not a valid owner/)
  assert.throws(() => parseArgs(['-v']), /Unknown option -v/)
  assert.throws(() => parseArgs(['api', '1', '--owner']), /--owner needs a value/)
  assert.throws(() => parseArgs(['api', '1', '--owner', '--no-open']), /--owner needs a value/)
  assert.throws(() => parseArgs(['--ownr', 'x']), /Unknown option --ownr/)
})

test('owner/repo/number in one word', () => {
  assert.deepEqual(target(['other-org/api/123']), { kind: 'pr', ref: 'other-org/api#123' })
  assert.deepEqual(target(['other-org/api/pull/123']), { kind: 'pr', ref: 'other-org/api#123' })
  // The owner in the word wins over the settings file.
  assert.deepEqual(target(['other-org/api/123'], 'acme'), { kind: 'pr', ref: 'other-org/api#123' })
})

test('GitHub addresses in the shapes people paste', () => {
  const want = { kind: 'pr', ref: 'acme/api#123' }
  for (const address of [
    'https://github.com/acme/api/pull/123',
    'http://github.com/acme/api/pull/123',
    'github.com/acme/api/pull/123',
    'www.github.com/acme/api/pull/123',
    'https://github.com/acme/api/pull/123/',
    'https://github.com/acme/api/pull/123/files',
    'https://github.com/acme/api/pull/123/commits/0a1b2c3',
    'https://github.com/acme/api/pull/123?diff=split&w=1',
    'https://github.com/acme/api/pull/123#discussion_r42',
    'https://github.com/acme/api/pull/123/files#diff-abc',
    'acme/api/pull/123/files',
  ])
    assert.deepEqual(target([address]), want, address)
})

test('GitHub addresses that are not pull requests are refused, not treated as folders', () => {
  for (const address of ['https://github.com/acme/api/issues/5', 'github.com/acme/api/tree/main', 'https://github.com/acme'])
    assert.throws(() => target([address], 'acme'), /neither a pull request nor a repository/, address)
})

test('anything spelled as a path is a path', () => {
  for (const p of ['.', '..', './a/b/12', '../a/b/12', '~/code/app', '/tmp/a/b/12', './some-folder', './a/b', 'a/b/c', 'a/b/c/12'])
    assert.equal(target([p], 'acme').kind, 'local', p)
})

test('the shared parser also reads the two-word form, for the box on the home page', () => {
  assert.deepEqual(parsePrRef('  api 123 '), { repo: 'api', number: 123 })
  assert.deepEqual(parsePrRef('acme/api #123'), { owner: 'acme', repo: 'api', number: 123 })
  assert.deepEqual(parsePrRef('acme/api/123'), { owner: 'acme', repo: 'api', number: 123 })
  assert.equal(parsePrRef('acme/api'), null)
  assert.deepEqual(parseRepoRef('acme/api'), { owner: 'acme', repo: 'api' })
  assert.deepEqual(parseRepoRef('https://github.com/acme/api.git'), { owner: 'acme', repo: 'api' })
  assert.deepEqual(parseRepoRef('api'), { repo: 'api' })
  assert.equal(parseRepoRef('./api'), null)
  assert.equal(parseRepoRef('a/b/c'), null)
  assert.equal(parsePrRef('just some words'), null)
  assert.equal(parsePrRef('./api 123'), null)
})

test('pull request numbers are bounded', () => {
  assert.equal(parsePrRef('api#0'), null)
  assert.equal(parsePrRef('acme/api/' + '9'.repeat(10)), null)
  assert.equal(parsePrRef('acme/api#' + '9'.repeat(400)), null)
  assert.deepEqual(parsePrRef('acme/api#0012'), { owner: 'acme', repo: 'api', number: 12 })
  assert.throws(() => target(['api', '0'], 'acme'), /not a pull request number/)
  assert.throws(() => target(['api', '9'.repeat(30)], 'acme'), /not a pull request number/)
})

test('a clone address suffix is dropped', () => {
  assert.deepEqual(parsePrRef('acme/api.git/123'), { owner: 'acme', repo: 'api', number: 123 })
  assert.deepEqual(target(['acme/api.git#4']), { kind: 'pr', ref: 'acme/api#4' })
})

test('addresses on other hosts are refused clearly, not treated as folders', () => {
  for (const address of ['https://github.example.com/acme/api/pull/5', 'https://gitlab.com/acme/api/-/merge_requests/5', 'https://github.com:443/acme/api/pull/5', 'git@github.com:acme/api.git', 'ghe.corp.example/acme/api/pull/5']) {
    assert.equal(isAddress(address), true, address)
    assert.throws(() => target([address], 'acme'), /github\.com only/, address)
  }
  for (const notAddress of ['.', './a/b/12', 'src/lib/2024', 'v1.2/notes', 'a.b/c']) assert.equal(isAddress(notAddress), false, notAddress)
})

test('a word that is both a folder here and a pull request reference is not guessed at', () => {
  const onDisk = (p: string) => ['src/lib/2024', 'notes#1'].includes(p)
  const resolve = (argv: string[]) => resolveTarget(parseArgs(argv), 'acme', onDisk)
  assert.throws(() => resolve(['src/lib/2024']), /is a file or folder here and also reads as a pull request.*\.\/src\/lib\/2024.*"src\/lib 2024"/s)
  assert.throws(() => resolve(['notes#1']), /is a file or folder here/)
  assert.deepEqual(resolve(['./src/lib/2024']).kind, 'local')
  // Not on disk: it is a pull request. Two words are always a pull request.
  assert.deepEqual(resolve(['docs/v2/3']), { kind: 'pr', ref: 'docs/v2#3' })
  assert.deepEqual(resolve(['src/lib', '2024']), { kind: 'pr', ref: 'src/lib#2024' })
})

test('options that would be ignored are refused', () => {
  assert.throws(() => target(['api', '12', '--base', 'develop'], 'acme'), /--base only applies to a local repository/)
  assert.throws(() => target(['.', '--owner', 'acme']), /--owner only applies to pull requests/)
  assert.throws(() => target(['stop', '--owner', 'acme']), /does nothing with "trail stop"/)
  assert.throws(() => target(['--base', 'main']), /needs a local repository/)
  assert.throws(() => target(['--owner', 'acme']), /needs something to review/)
})

test('the data folder and port settings', () => {
  const saved = { home: process.env.TRAIL_HOME, port: process.env.TRAIL_PORT }
  try {
    process.env.TRAIL_HOME = '~/somewhere'
    assert.equal(trailHome(), path.join(os.homedir(), 'somewhere'))
    // A relative folder is taken from the home folder, never from the folder a command runs in.
    process.env.TRAIL_HOME = 'data'
    assert.equal(trailHome(), path.join(os.homedir(), 'data'))
    process.env.TRAIL_HOME = '/abs/trail'
    assert.equal(trailHome(), '/abs/trail')
    process.env.TRAIL_PORT = '5000'
    assert.equal(trailPort(), 5000)
    for (const bad of ['4477# x', 'abc', '0', '70000']) {
      process.env.TRAIL_PORT = bad
      assert.throws(() => trailPort(), /port must be a number from 1 to 65535/, bad)
    }
  } finally {
    for (const [key, value] of [['TRAIL_HOME', saved.home], ['TRAIL_PORT', saved.port]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

const OPEN: ListFilters = { state: 'open', limit: 50 }

test('a repository without a number lists its pull requests', () => {
  const list = (repo: string) => ({ kind: 'list', repo, filters: OPEN })
  assert.deepEqual(target(['other-org/api']), list('other-org/api'))
  assert.deepEqual(target(['api'], 'acme'), list('acme/api'))
  assert.deepEqual(target(['api', '--owner', 'other-org'], 'acme'), list('other-org/api'))
  for (const address of ['https://github.com/other-org/api', 'github.com/other-org/api/', 'https://github.com/other-org/api/pulls', 'https://github.com/other-org/api.git'])
    assert.deepEqual(target([address]), list('other-org/api'), address)
  // A filter in the address would be dropped, so the address is refused instead.
  assert.throws(() => target(['https://github.com/other-org/api/pulls?q=is%3Adraft']), /carries a filter.*--search/s)
  assert.deepEqual(target(['other-org/api', '--list']), list('other-org/api'))
})

test('--list and the filters', () => {
  assert.deepEqual(target(['--list'], 'acme'), { kind: 'list', owner: 'acme', filters: OPEN })
  assert.deepEqual(target(['--list']), { kind: 'list', owner: undefined, filters: OPEN })
  // A filter on its own asks for a list too.
  assert.deepEqual(target(['api', '--mine'], 'acme'), { kind: 'list', repo: 'acme/api', filters: { ...OPEN, author: '@me' } })
  assert.deepEqual(target(['acme/api', '--for-me', '--state', 'all', '--limit', '5']), { kind: 'list', repo: 'acme/api', filters: { reviewer: '@me', state: 'all', limit: 5 } })
  assert.deepEqual(target(['acme/api', '--author', 'alice', '--reviewer', 'acme/backend', '--label', 'needs review', '--search', 'cache']).kind, 'list')
  assert.throws(() => target(['acme/api', '--state', 'done']), /--state must be open, closed, merged or all/)
  assert.throws(() => target(['acme/api', '--limit', 'many']), /--limit must be a number/)
  assert.throws(() => target(['acme/api', '--author', 'a b']), /not a GitHub user name/)
  assert.throws(() => target(['acme/api', '--mine', '--author', 'bob']), /--mine and --author/)
  assert.throws(() => target(['acme/api', '12', '--list']), /names one pull request/)
  assert.throws(() => target(['acme/api/12', '--author', 'bob']), /names one pull request/)
  assert.throws(() => target(['.', '--list']), /needs a repository name, not a folder/)
  assert.throws(() => target(['acme/api', '--base', 'main']), /--base only applies to a local repository/)
})

test('a name that is both a folder here and a repository is not guessed at', () => {
  const onDisk = (p: string) => ['web', 'packages/app'].includes(p)
  const resolve = (argv: string[], owner?: string) => resolveTarget(parseArgs(argv), owner, onDisk)
  assert.throws(() => resolve(['web'], 'acme'), /is a file or folder here and also reads as the GitHub repository acme\/web.*\.\/web.*--list/s)
  assert.throws(() => resolve(['packages/app']), /also reads as the GitHub repository packages\/app/)
  // --list settles it one way, ./ the other.
  assert.deepEqual(resolve(['web', '--list'], 'acme'), { kind: 'list', repo: 'acme/web', filters: OPEN })
  assert.equal(resolve(['./web'], 'acme').kind, 'local')
  // With no owner to look under, a bare folder name can only be the folder.
  assert.equal(resolve(['web']).kind, 'local')
  assert.throws(() => resolve(['api']), /is not a folder here, and has no owner/)
})

test('the gh command for each kind of list', () => {
  const args = (repo: string | undefined, filters: Partial<ListFilters>, owner?: string) => ghListArgs({ repo, owner, filters: { ...OPEN, ...filters } }).join(' ')
  assert.match(args('acme/api', {}), /^pr list -R acme\/api --state=open --limit=50 --json=/)
  assert.match(args('acme/api', { author: 'alice', label: 'bug' }), /--author=alice --label=bug$/)
  // "Review requested from" exists only in the search syntax, so every filter moves there.
  assert.match(args('acme/api', { author: '@me', reviewer: 'bob', label: 'needs review' }), /--search=author:"@me" review-requested:"bob" label:"needs review"$/)
  // A team has its own qualifier, and a quote inside a value cannot unbalance the query.
  assert.match(args('acme/api', { reviewer: 'acme/backend' }), /--search=team-review-requested:"acme\/backend"$/)
  assert.match(args('acme/api', { label: 'a"b, c' }), /--search=label:"ab, c"$/)
  assert.match(args(undefined, {}, 'acme'), /^search prs .*--owner=acme --state=open --review-requested=@me$/)
  assert.match(args(undefined, { author: '@me', state: 'merged' }), /--merged --author=@me$/)
  // Any filter replaces the implied "waiting for me", which would otherwise empty the list.
  for (const filters of [{ author: '@me' }, { label: 'bug' }, { state: 'merged' as const }, { search: 'cache' }]) assert.doesNotMatch(args(undefined, filters), /review-requested/, JSON.stringify(filters))
  // Search text goes to gh word by word; handed over whole, gh would quote it into one phrase.
  // gh adds quotes to an argument with a space, so phrases reach it without their own.
  const searched = ghListArgs({ owner: 'acme', filters: { ...OPEN, search: 'is:draft -label:wip "exact phrase" label:"needs review"', label: 'good first issue' } })
  assert.deepEqual(searched.slice(searched.indexOf('--')), ['--', 'is:draft', '-label:wip', 'exact phrase', 'label:needs review'])
  assert.ok(searched.includes('--label=good first issue'))
  assert.equal(describeList({ owner: 'acme', filters: { ...OPEN, state: 'merged' } }), 'merged pull requests across acme')
  assert.equal(describeList({ repo: 'acme/api', filters: { ...OPEN, author: '@me' } }), 'open pull requests in acme/api by you')
  assert.equal(describeList({ owner: 'acme', filters: OPEN }), 'open pull requests across acme waiting for your review')
})

test('both shapes of gh output become the same rows', () => {
  const fromRepo = normalize(
    [{ number: 7, title: 'Add  cache\nlayer', author: { login: 'alice' }, isDraft: false, state: 'OPEN', updatedAt: '2026-11-20T10:00:00Z', headRefName: 'cache', additions: 120, deletions: 30, changedFiles: 4, reviewRequests: [{ __typename: 'User', login: 'me' }, { __typename: 'Team', name: 'Backend', slug: 'backend' }], reviewDecision: 'CHANGES_REQUESTED', labels: [{ name: 'perf' }] }],
    { repo: 'acme/api', filters: OPEN },
    'me',
  )
  assert.deepEqual(fromRepo[0], { repo: 'acme/api', number: 7, title: 'Add cache layer', author: 'alice', draft: false, state: 'open', updatedAt: '2026-11-20T10:00:00Z', branch: 'cache', additions: 120, deletions: 30, files: 4, reviewers: ['me', 'team backend'], reviewKnown: true, decision: 'changes requested', labels: ['perf'] })
  const fromSearch = normalize([{ number: 9, title: 'Fix', author: { login: 'bob' }, isDraft: true, state: 'open', updatedAt: '', repository: { nameWithOwner: 'acme/web' }, labels: [] }], { owner: 'acme', filters: OPEN }, 'me')
  // A search for "review requested from me" does not list reviewers, but implies this one.
  assert.deepEqual(fromSearch[0], { repo: 'acme/web', number: 9, title: 'Fix', author: 'bob', draft: true, state: 'open', updatedAt: '', reviewers: ['me'], reviewKnown: true, labels: [] })
  // Any other search says nothing about reviews, and the row records that.
  const mine = normalize([{ number: 9, title: 'Fix', author: { login: 'me' }, state: 'open', repository: { nameWithOwner: 'acme/web' } }], { owner: 'acme', filters: { ...OPEN, author: '@me' } }, 'me')
  assert.deepEqual([mine[0].reviewers, mine[0].reviewKnown], [[], false])
})

const NOW = Date.parse('2026-11-24T12:00:00Z')
const row = (number: number, extra: Partial<PrRow> = {}): PrRow => ({ repo: 'acme/api', number, title: `Change number ${number}`, author: 'alice', draft: false, state: 'open', updatedAt: '2026-11-22T12:00:00Z', additions: 10, deletions: 2, files: 1, reviewers: [], reviewKnown: true, labels: [], ...extra })
const ROWS = [row(1, { title: 'Add cache layer', reviewers: ['me'], labels: ['perf'] }), row(2, { author: 'me', title: 'Fix login redirect', branch: 'fix/login' }), row(3, { author: 'bob', draft: true, title: 'WIP billing export' }), row(4, { decision: 'approved', title: 'Rename helpers' })]
const start = (extra: Partial<PickerState> = {}): PickerState => ({ rows: ROWS, me: 'me', heading: 'open pull requests in acme/api', query: '', scope: 0, cursor: 0, top: 0, ...extra })
const press = (state: PickerState, ...keys: string[]) => {
  let outcome: ReturnType<typeof reduce> = { state }
  for (const k of keys.flatMap((s) => parseKeys(s))) {
    if (!('state' in outcome)) break
    outcome = reduce(outcome.state, k, 10)
  }
  return outcome
}

test('keys from the terminal', () => {
  assert.deepEqual(parseKeys('\x1b[A\x1b[B\r'), ['up', 'down', 'enter'])
  assert.deepEqual(parseKeys('\x1b'), ['escape'])
  assert.deepEqual(parseKeys('cache\t'), [{ text: 'cache' }, 'tab'])
  assert.deepEqual(parseKeys('\x7f\x03'), ['backspace', 'interrupt'])
  // A sequence the list has no use for (F5 here) is dropped, not typed into the filter.
  assert.deepEqual(parseKeys('\x1b[15~a'), [{ text: 'a' }])
})

test('typing narrows the list; prefixes look in one field', () => {
  const numbers = (query: string) => ROWS.filter((r) => matches(r, query)).map((r) => r.number)
  assert.deepEqual(numbers('cache'), [1])
  assert.deepEqual(numbers('LOGIN'), [2])
  assert.deepEqual(numbers('#3'), [3])
  assert.deepEqual(numbers('author:bob'), [3])
  assert.deepEqual(numbers('@alice'), [1, 4])
  assert.deepEqual(numbers('reviewer:me'), [1])
  assert.deepEqual(numbers('label:perf'), [1])
  assert.deepEqual(numbers('alice rename'), [4])
  assert.deepEqual(numbers('nothing-like-this'), [])
})

test('moving, scoping, choosing and leaving', () => {
  assert.deepEqual((press(start(), '\x1b[B', '\x1b[B', '\r') as { pick: PrRow }).pick.number, 3)
  // The cursor stops at the ends.
  assert.equal((press(start(), '\x1b[A') as { state: PickerState }).state.cursor, 0)
  assert.equal((press(start(), '\x1b[F', '\x1b[B') as { state: PickerState }).state.cursor, 3)
  // Tab: waiting for my review, then mine.
  assert.deepEqual(narrowed((press(start(), '\t') as { state: PickerState }).state).map((r) => r.number), [1])
  assert.deepEqual((press(start(), '\t\t', '\r') as { pick: PrRow }).pick.number, 2)
  // Typing then enter picks the first match; the cursor returns to the top when the list changes.
  assert.deepEqual((press(start({ cursor: 3 }), 'billing', '\r') as { pick: PrRow }).pick.number, 3)
  // Escape clears the filter first, and leaves only when there is nothing to clear.
  assert.equal((press(start(), 'zzz', '\x1b') as { state: PickerState }).state.query, '')
  assert.deepEqual(press(start(), 'zzz', '\x1b', '\x1b'), { quit: true, interrupted: false })
  assert.deepEqual(press(start(), '\x03'), { quit: true, interrupted: true })
  // Enter with nothing matching does nothing.
  assert.ok('state' in press(start(), 'zzz', '\r'))
})

test('a long list scrolls with the cursor', () => {
  const many = Array.from({ length: 40 }, (_, i) => row(i + 1))
  let s = start({ rows: many })
  for (let i = 0; i < 25; i++) s = (reduce(s, 'down', 10) as { state: PickerState }).state
  assert.equal(s.cursor, 25)
  assert.equal(s.top, 16)
  s = (reduce(s, 'home', 10) as { state: PickerState }).state
  assert.deepEqual([s.cursor, s.top], [0, 0])
})

test('the screen never overflows the terminal, at any width', () => {
  for (const cols of [40, 60, 80, 100, 140, 200]) {
    const lines = render(start({ query: 'a' }), cols, 20, NOW).split('\n')
    assert.equal(lines.length, 3 + 14 + 2, `rows at ${cols}`)
    for (const l of lines) assert.ok(width(l) <= cols, `${cols} cols: "${l.replace(/\x1b\[[0-9;]*m/g, '')}" is ${width(l)} wide`)
  }
  const text = render(start(), 120, 20, NOW).replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(text, /Trail · open pull requests in acme\/api/)
  assert.match(text, /All 4 .*Waiting for my review 1 .*Mine 1/)
  assert.match(text, /▸ +#1 +Add cache layer +alice +\+10 −2 +2d +your review requested/)
  assert.match(text, /#3 +WIP billing export +bob .* draft/)
  assert.match(text, /#4 +Rename helpers .* approved/)
  assert.match(text, /1 of 4/)
})

test('columns are only as wide as their contents need, and the title gets the rest', () => {
  const wide = layout(start(), 120)
  // Longest status here is "your review requested" (21), longest author "alice" (5).
  assert.deepEqual([wide.authorW, wide.statusW, wide.sizeW], [5, 21, 6])
  assert.ok(wide.titleW >= 60, `title got ${wide.titleW}`)
  // On a narrow screen the status gives way before the title does.
  const narrow = layout(start(), 60)
  assert.ok(narrow.titleW >= 28 && narrow.statusW < 21, JSON.stringify(narrow))
  const tiny = layout(start(), 40)
  assert.deepEqual([tiny.statusW, tiny.sizeW], [0, 0])
})

test('status and age wording', () => {
  assert.equal(status(row(1, { reviewers: ['me'], inTrail: '5/12 viewed' }), 'me'), 'your review requested · in Trail 5/12 viewed')
  assert.equal(status(row(1, { reviewers: ['bob', 'backend'] }), 'me'), 'review: bob, backend')
  assert.equal(status(row(1, { state: 'merged', decision: 'approved' }), 'me'), 'merged')
  assert.equal(status(row(1), 'me'), '')
  assert.deepEqual(['2026-11-24T11:30:00Z', '2026-11-24T02:00:00Z', '2026-11-20T12:00:00Z', '2026-10-01T12:00:00Z', '2026-01-10T12:00:00Z'].map((d) => age(d, NOW)), ['30m', '10h', '4d', '8w', '10mo'])
  assert.equal(width(line(ROWS[0], start(), 90, true, undefined, NOW)), 90)
  assert.equal(describeList({ repo: 'acme/api', filters: { ...OPEN, state: 'all' } }), 'pull requests (any state) in acme/api')
})

test('text from GitHub cannot send commands to the terminal', () => {
  // Set the window title, clear the screen, colour, a C1 control, and a right-to-left override.
  const hostile = 'Fix\x1b]0;pwned\x07\x1b[2J\x1b[31m bug\u009b2J \u202Egnp.exe'
  assert.equal(printable(hostile), 'Fix ]0;pwned [2J [31m bug 2J gnp.exe')
  const [r] = normalize([{ number: 1, title: hostile, author: { login: 'a\x1bb' }, headRefName: 'x\x07y', labels: [{ name: 'l\x1b[2J' }], reviewRequests: [{ login: 'r\x1b' }], state: 'OPEN' }], { repo: 'acme/api', filters: OPEN }, 'me')
  const everything = JSON.stringify(r) + render({ rows: [r], me: 'me', heading: 'h', query: '', scope: 0, cursor: 0, top: 0 }, 100, 20, NOW).replace(/\x1b\[[0-9;]*m/g, '')
  assert.doesNotMatch(everything, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/)
})

test('filter values may start with a dash only when attached with =', () => {
  assert.equal(parseArgs(['acme/api', '--search=-label:wip']).search, '-label:wip')
  assert.throws(() => parseArgs(['acme/api', '--search', '-label:wip']), /--search needs a value/)
  // Whatever the value, gh receives it attached to its flag, never as a word of its own.
  assert.ok(ghListArgs({ repo: 'acme/api', filters: { ...OPEN, search: '-label:wip' } }).includes('--search=-label:wip'))
  assert.ok(ghListArgs({ repo: 'acme/api', filters: { ...OPEN, label: '-x' } }).includes('--label=-x'))
  assert.throws(() => target(['acme/api', '--author', 'acme/backend']), /not a GitHub user name/)
  assert.equal(target(['acme/api', '--reviewer', 'acme/backend']).kind, 'list')
})

test('names that could be a command, a number or a path are not guessed at', () => {
  assert.throws(() => target(['12'], 'acme'), /is only a number.*trail <repo> 12/)
  assert.throws(() => target(['serve', '--list'], 'acme'), /does nothing with "trail serve".*owner\/serve/)
  assert.throws(() => target(['stop', '--mine'], 'acme'), /does nothing with "trail stop"/)
  const onDisk = (p: string) => ['bin', 'web', 'README.md'].includes(p)
  const resolve = (argv: string[], owner?: string) => resolveTarget(parseArgs(argv), owner, onDisk)
  // "bin/x" does not exist, but "bin" does: it is more likely a mistyped path than a repository.
  assert.throws(() => resolve(['bin/x']), /is a file or folder here and also reads as the GitHub repository bin\/x/)
  assert.throws(() => resolve(['README.md'], 'acme'), /is a file or folder here/)
  // --base only makes sense for a local repository, so with it the folder is meant.
  assert.deepEqual(resolve(['web', '--base', 'main'], 'acme'), { kind: 'local', path: path.resolve('web'), base: 'main' })
})

test('only the scopes that can be answered are offered', () => {
  const labels = (rows: PrRow[], me: string) => scopesFor({ rows, me }).map((s) => s.label)
  assert.deepEqual(labels(ROWS, 'me'), ['All', 'Waiting for my review', 'Mine'])
  // Without the reader's login nothing can be "mine"; without review data nothing can be "waiting".
  assert.deepEqual(labels(ROWS, ''), ['All'])
  assert.deepEqual(labels([row(1, { reviewKnown: false })], 'me'), ['All', 'Mine'])
  // Tab wraps within what is offered.
  assert.equal((press(start({ me: '' }), '\t') as { state: PickerState }).state.scope, 0)
})

test('wide characters are measured as the terminal shows them', () => {
  assert.equal(width('日本語'), 6)
  assert.equal(width('👍 ok'), 5)
  assert.equal(width(fit('日本語のタイトルはとても長い', 10)), 10)
  assert.equal(width(fit('e\u0301e\u0301e\u0301', 5)), 5)
  const wide = [row(1, { title: '修复缓存层的并发问题并添加更多的测试用例 🚀🚀🚀 and a long tail of text that keeps going' }), row(2, { author: '作者名字很长很长很长很长' })]
  for (const cols of [50, 80, 120]) for (const l of render(start({ rows: wide }), cols, 12, NOW).split('\n')) assert.ok(width(l) <= cols, `${cols}: ${width(l)}`)
})

test('the highlighted row stays on screen when the terminal shrinks', () => {
  const many = Array.from({ length: 40 }, (_, i) => row(i + 1))
  const s = start({ rows: many, cursor: 30, top: 7 })
  assert.equal(visibleTop(s, 24), 7)
  assert.equal(visibleTop(s, 4), 27)
  assert.match(render(s, 80, 10, NOW), /▸ +#31 /)
})

test('pasted text is text, and a split arrow key is not Escape', () => {
  // A paste containing a line break must not press Enter.
  assert.deepEqual(parseKeys('\x1b[200~fix\r\nlogin\x1b[201~'), [{ text: 'fix login' }])
  assert.deepEqual(parseKeys('a\x1b[200~b\x1b[201~\r'), [{ text: 'ab' }, 'enter'])
  assert.equal(incomplete('\x1b'), true)
  assert.equal(incomplete('\x1b['), true)
  assert.equal(incomplete('\x1b[200~half a paste'), true)
  assert.equal(incomplete('\x1b[A'), false)
  assert.equal(incomplete('abc'), false)
})

test('the config and doctor commands', () => {
  assert.deepEqual(target(['config']), { kind: 'config', key: undefined, value: undefined, unset: false })
  assert.deepEqual(target(['config', 'owner']), { kind: 'config', key: 'owner', value: undefined, unset: false })
  assert.deepEqual(target(['config', 'owner', 'acme']), { kind: 'config', key: 'owner', value: 'acme', unset: false })
  assert.deepEqual(target(['config', 'port', '5000']), { kind: 'config', key: 'port', value: '5000', unset: false })
  assert.deepEqual(target(['config', 'owner', '--unset']), { kind: 'config', key: 'owner', value: undefined, unset: true })
  assert.deepEqual(target(['doctor']), { kind: 'doctor' })
  assert.throws(() => target(['config', 'owner', 'a', 'b']), /Too many arguments/)
  assert.throws(() => target(['config', '--unset']), /--unset with one setting/)
  assert.throws(() => target(['config', 'owner', 'acme', '--unset']), /--unset with one setting/)
  assert.throws(() => target(['acme/api', '--unset']), /--unset only applies/)
  assert.throws(() => target(['doctor', 'now']), /takes no arguments/)
  assert.throws(() => target(['config', '--list']), /does nothing with "trail config"/)
  // A repository that happens to be called "config" or "doctor" is still reachable by number.
  assert.deepEqual(target(['config', '12'], 'acme'), { kind: 'pr', ref: 'acme/config#12' })
  assert.deepEqual(target(['acme/doctor']), { kind: 'list', repo: 'acme/doctor', filters: OPEN })
})

test('saved settings: written, read back, validated, and overridden by the environment', () => {
  const saved = { config: process.env.TRAIL_CONFIG, owner: process.env.TRAIL_OWNER, port: process.env.TRAIL_PORT }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-config-'))
  try {
    process.env.TRAIL_CONFIG = path.join(dir, 'nested', 'config.json')
    delete process.env.TRAIL_OWNER
    delete process.env.TRAIL_PORT
    assert.deepEqual(readConfig(), {})
    writeConfig('owner', 'acme')
    writeConfig('port', '5000')
    assert.deepEqual(readConfig(), { owner: 'acme', port: '5000' })
    assert.equal(configFile(), process.env.TRAIL_CONFIG)

    assert.throws(() => writeConfig('owner', '../x'), /not a GitHub user or organisation/)
    assert.throws(() => writeConfig('port', '70000'), /not a port number/)
    assert.equal(configProblem('home', '~/elsewhere'), null)
    assert.deepEqual(readConfig(), { owner: 'acme', port: '5000' })

    // The environment wins over what is saved, and a saved value is seen as soon as it changes.
    process.env.TRAIL_PORT = '6000'
    assert.deepEqual([setting('owner'), setting('port'), trailPort()], ['acme', '6000', 6000])
    delete process.env.TRAIL_PORT
    assert.equal(trailPort(), 5000)
    writeConfig('home', '~/elsewhere')
    assert.equal(readConfig().home, path.join(os.homedir(), 'elsewhere'))
    writeConfig('home', undefined)

    writeConfig('owner', undefined)
    assert.deepEqual(readConfig(), { port: '5000' })

    // Only known settings are read, whatever else the file contains; a broken file says so.
    fs.writeFileSync(process.env.TRAIL_CONFIG, JSON.stringify({ owner: 'acme', token: 'secret', port: 5000, home: '  ' }))
    assert.deepEqual(readConfig(), { owner: 'acme', port: '5000' })
    fs.writeFileSync(process.env.TRAIL_CONFIG, '["an", "array"]')
    assert.deepEqual(readConfig(), {})
    fs.writeFileSync(process.env.TRAIL_CONFIG, '{ not json')
    assert.throws(() => readConfig(), /is not valid JSON/)
    // A file that exists but cannot be read is reported, not treated as "nothing saved".
    process.env.TRAIL_CONFIG = dir
    assert.throws(() => readConfig(), /Could not read/)
    // With only TRAIL_HOME set, the settings live in that folder too.
    delete process.env.TRAIL_CONFIG
    const savedHome = process.env.TRAIL_HOME
    process.env.TRAIL_HOME = path.join(dir, 'profile')
    assert.equal(configFile(), path.join(dir, 'profile', 'config.json'))
    if (savedHome === undefined) delete process.env.TRAIL_HOME
    else process.env.TRAIL_HOME = savedHome
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    for (const [key, value] of [['TRAIL_CONFIG', saved.config], ['TRAIL_OWNER', saved.owner], ['TRAIL_PORT', saved.port]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('repo/number is a pull request of the saved owner', () => {
  assert.deepEqual(target(['api/123'], 'acme'), { kind: 'pr', ref: 'acme/api#123' })
  assert.deepEqual(target(['api/123', '--owner', 'other']), { kind: 'pr', ref: 'other/api#123' })
  assert.throws(() => target(['api/123']), /No owner for "api"/)
  // A repository whose name is a number is still reachable: by asking for its list, or by address.
  assert.deepEqual(target(['gabrielecirulli/2048', '--list']), { kind: 'list', repo: 'gabrielecirulli/2048', filters: OPEN })
  assert.deepEqual(target(['github.com/gabrielecirulli/2048']), { kind: 'list', repo: 'gabrielecirulli/2048', filters: OPEN })
})
