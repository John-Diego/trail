import { test } from 'bun:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { isAddress, parsePrRef } from '../shared/pr-ref.ts'
import { ROOT, trailHome, trailPort } from '../shared/settings.ts'
import { parseArgs, parseEnvFile, resolveTarget } from './args.ts'

const ENV = '/trail/.env'
const target = (argv: string[], owner?: string) => resolveTarget(parseArgs(argv), owner, ENV)

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
  assert.throws(() => target(['api', '123']), /No owner for "api".*\/trail\/\.env.*--owner/s)
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

test('the settings file gives only TRAIL_ values, and blank means unset', () => {
  const text = `# comment
TRAIL_OWNER=acme   # the organisation
export TRAIL_PORT="5000"
TRAIL_HOME='/data/trail dir'
TRAIL_EMPTY=
ANTHROPIC_API_KEY=sk-should-never-be-read
  GITHUB_TOKEN = nope
`
  assert.deepEqual(parseEnvFile(text), { TRAIL_OWNER: 'acme', TRAIL_PORT: '5000', TRAIL_HOME: '/data/trail dir' })
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
  for (const address of ['https://github.com/acme/api', 'https://github.com/acme/api/issues/5', 'github.com/acme/api/tree/main', 'https://github.com/acme/123'])
    assert.throws(() => target([address], 'acme'), /not a pull request/, address)
})

test('paths are still paths', () => {
  for (const p of ['.', '..', './a/b/12', '../a/b/12', '~/code/app', '/tmp/a/b/12', 'some-folder', 'a/b', 'a/b/c', 'a/b/c/12'])
    assert.equal(target([p], 'acme').kind, 'local', p)
})

test('the shared parser also reads the two-word form, for the box on the home page', () => {
  assert.deepEqual(parsePrRef('  api 123 '), { repo: 'api', number: 123 })
  assert.deepEqual(parsePrRef('acme/api #123'), { owner: 'acme', repo: 'api', number: 123 })
  assert.deepEqual(parsePrRef('acme/api/123'), { owner: 'acme', repo: 'api', number: 123 })
  assert.equal(parsePrRef('acme/api'), null)
  assert.equal(parsePrRef('just some words'), null)
  assert.equal(parsePrRef('./api 123'), null)
})

test('a .env saved on Windows, and comments in awkward places, are still read correctly', () => {
  assert.deepEqual(parseEnvFile('TRAIL_OWNER=acme\r\nTRAIL_PORT=5000\r\n'), { TRAIL_OWNER: 'acme', TRAIL_PORT: '5000' })
  assert.deepEqual(parseEnvFile('TRAIL_OWNER=   # set me\nTRAIL_PORT= #nothing'), {})
  assert.deepEqual(parseEnvFile('TRAIL_OWNER="acme" # the "main" org'), { TRAIL_OWNER: 'acme' })
  assert.deepEqual(parseEnvFile("TRAIL_HOME='/data/a#b'"), { TRAIL_HOME: '/data/a#b' })
  assert.deepEqual(parseEnvFile('TRAIL_HOME=/data/a#b'), { TRAIL_HOME: '/data/a#b' })
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
  const resolve = (argv: string[]) => resolveTarget(parseArgs(argv), 'acme', ENV, onDisk)
  assert.throws(() => resolve(['src/lib/2024']), /is a folder here and also reads as a pull request.*\.\/src\/lib\/2024.*"src\/lib 2024"/s)
  assert.throws(() => resolve(['notes#1']), /is a folder here/)
  assert.deepEqual(resolve(['./src/lib/2024']).kind, 'local')
  // Not on disk: it is a pull request. Two words are always a pull request.
  assert.deepEqual(resolve(['docs/v2/3']), { kind: 'pr', ref: 'docs/v2#3' })
  assert.deepEqual(resolve(['src/lib', '2024']), { kind: 'pr', ref: 'src/lib#2024' })
})

test('options that would be ignored are refused', () => {
  assert.throws(() => target(['api', '12', '--base', 'develop'], 'acme'), /--base only applies to a local repository/)
  assert.throws(() => target(['.', '--owner', 'acme']), /--owner only applies to pull requests/)
  assert.throws(() => target(['stop', '--owner', 'acme']), /does nothing with "trail stop"/)
  assert.throws(() => target(['--base', 'main']), /needs something to review/)
})

test('the data folder and port settings', () => {
  const saved = { home: process.env.TRAIL_HOME, port: process.env.TRAIL_PORT }
  try {
    process.env.TRAIL_HOME = '~/somewhere'
    assert.equal(trailHome(), path.join(os.homedir(), 'somewhere'))
    // A relative folder is taken from Trail's own folder, never from the folder a command runs in.
    process.env.TRAIL_HOME = 'data'
    assert.equal(trailHome(), path.join(ROOT, 'data'))
    process.env.TRAIL_HOME = '/abs/trail'
    assert.equal(trailHome(), '/abs/trail')
    process.env.TRAIL_PORT = '5000'
    assert.equal(trailPort(), 5000)
    for (const bad of ['4477# x', 'abc', '0', '70000']) {
      process.env.TRAIL_PORT = bad
      assert.throws(() => trailPort(), /TRAIL_PORT must be a port number/, bad)
    }
  } finally {
    for (const [key, value] of [['TRAIL_HOME', saved.home], ['TRAIL_PORT', saved.port]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
