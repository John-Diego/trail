// Trail command line: starts the local server when needed, imports what you point it at, and opens the browser.
// Loaded by trail.ts once the Node.js version has been checked.
//
// `trail .` is run inside other people's projects, so nothing here may depend on the current
// folder. Node reads no configuration from it, the published package is one bundled file with
// no modules to look up, and Trail's own settings live in the home folder.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildId, CONFIG_HELP, CONFIG_KEYS, configFile, ENTRY, isConfigKey, MIN_NODE, readConfig, ROOT, setting, trailHome, trailPort, writeConfig, type ConfigKey } from '../shared/settings.ts'
import { parseArgs, resolveTarget, type Target } from './args.ts'
import { describeList, fetchList } from './list.ts'
import { fit, pick, status } from './picker.ts'
import { stripControl } from '../shared/text.ts'

const JSON_HEADERS = { 'Content-Type': 'application/json' }
// Node's built-in SQLite still announces itself as experimental on every start; that is noise here.
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning']

/**
 * How to start the server. From the published package it is the bundled dist/server.js next
 * to this file. From a source checkout it is the TypeScript itself, loaded through tsx.
 */
function serverCommand(): string[] {
  const built = path.join(path.dirname(ENTRY), 'server.js')
  if (ENTRY.endsWith('.js') && fs.existsSync(built)) return [...NODE_FLAGS, built]
  return [...NODE_FLAGS, '--import', 'tsx', path.join(ROOT, 'server', 'index.ts')]
}

const USAGE = `Trail: local pull request review

  trail <repo> <number>       Review a pull request. The owner is the one saved with
                              "trail config owner <name>"
  trail <repo> <number> --owner <name>
                              Same, for another owner, for this command only
  trail <owner>/<repo> <number>
  trail <owner>/<repo>/<number>   (or <repo>/<number> with the saved owner)
  trail <address>             A GitHub pull request address, with or without https://,
                              e.g. github.com/owner/repo/pull/123/files
                              Also accepted: owner/repo#123 and repo#123

  trail <owner>/<repo>        List that repository's pull requests and choose one.
  trail <repo>                Same, with the saved owner. A repository address works too.
  trail --list                List pull requests waiting for your review (across the saved owner, if any)
      Narrow any list with:   --mine | --author <login>     who wrote it (@me works)
                              --for-me | --reviewer <login> whose review is requested (or org/team)
                              --label <name>   --state open|closed|merged|all
                              --search "<words>"   --limit <n>
                              A value starting with a dash needs "=": --search=-label:wip
      In the list:            arrows move, enter opens in Trail, type to filter, tab changes scope

  trail .                     Review the current branch of this repository, including uncommitted changes
  trail <path> --base <ref>   Review a local repository against a base branch.
                              A path starts with ".", "/" or "~": write ./name for a folder here.

  trail                       Open Trail in the browser
  trail config                Show the saved settings (owner, port, home)
  trail config <name> <value> Save one.  trail config <name> --unset removes it
  trail doctor                Check that git, gh and Claude Code are installed and logged in
  trail serve                 Run the server in the foreground
  trail stop                  Stop the background server

  --no-open                   Import without opening the browser
`

interface Health {
  app?: string
  /** Process id of the server. Absent on servers started before this was added. */
  pid?: number
  /** Identity of the code the server is running. */
  build?: string
  /** A Claude run or an import is in progress, so restarting now would interrupt it. */
  busy?: boolean
  /** The data folder the server is serving. Absent on servers started before this was added. */
  home?: string
}

/**
 * Whether the server answering is the one for this data folder. Two Trails can exist side by
 * side (TRAIL_HOME), and this one must never stop or restart the other's server. A server too
 * old to say which folder it serves counts as not ours for anything done without being asked.
 */
function ours(running: Health): boolean {
  return running.home !== undefined && path.resolve(running.home) === trailHome()
}

interface Job {
  status?: 'running' | 'done' | 'error'
  message?: string
  detail?: string
  reviewId?: number
  error?: string
}

let BASE = ''
let home = ''
/** Why the port setting cannot be used, when it cannot. Only doctor carries on in that case. */
let portProblem = ''

/** The Trail server at this address, or null when nothing answers or something else is listening there. */
async function health(base = BASE): Promise<Health | null> {
  try {
    const res = await fetch(`${base}/api/health`)
    const body = (await res.json()) as Health
    return res.ok && body.app === 'trail' ? body : null
  } catch {
    return null
  }
}

async function ensureServer(): Promise<void> {
  const running = await health()
  if (running?.home !== undefined && !ours(running)) {
    throw new Error(`${BASE} is in use by a Trail server for another data folder (${running.home}). Give this one its own port with "trail config port <number>".`)
  }
  if (running && running.build === buildId()) return
  if (running) {
    // A server from before an update would pair the old program with the new web page. It is
    // restarted, unless that would cut off work in progress.
    if (running.busy !== false) {
      // An older server does not say whether it is busy, so it is not interrupted either.
      const why = running.busy ? 'and it is in the middle of something. When that is done, run' : 'by a version that cannot be restarted automatically. Run'
      console.error(`Note: the Trail server that is running was started before Trail was last updated, ${why} \`trail stop\` and try again to use the current version.`)
      return
    }
    console.error('Trail was updated since its server started; restarting the server.')
    await stopServer(BASE, running)
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'web', 'index.html'))) {
    throw new Error(`The web page has not been built. Run \`npm install && npm run build\` in ${ROOT}`)
  }
  fs.mkdirSync(home, { recursive: true })
  const logFile = path.join(home, 'server.log')
  const log = fs.openSync(logFile, 'a')
  // Started in Trail's own folder, never the one this command was run in.
  spawn(process.execPath, serverCommand(), { cwd: ROOT, detached: true, stdio: ['ignore', log, log] }).unref()
  for (let i = 0; i < 80; i++) {
    await sleep(100)
    if (await health()) return
  }
  throw new Error(`Trail did not start. See ${logFile}`)
}

function openBrowser(url: string, noOpen: boolean): void {
  console.log(url)
  if (noOpen) return
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
  spawn(cmd, args, { detached: true, stdio: 'ignore' })
    .on('error', () => {})
    .unref()
}

async function importAndOpen(body: { kind: 'pr'; ref: string } | { kind: 'local'; path: string; base?: string }, noOpen: boolean): Promise<void> {
  await ensureServer()
  const res = await fetch(`${BASE}/api/reviews`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
  const started = (await res.json()) as { jobId?: number; error?: string }
  if (started.error || started.jobId === undefined) throw new Error(started.error ?? 'The server did not accept the import.')
  // In a terminal the current stage is one line that updates in place with how far along it
  // is; piped, each stage is printed once. Everything shown comes from the server, some of it
  // quoting git or GitHub, so it is cleaned first.
  const live = !!process.stdout.isTTY
  let onLine = false
  let stage = ''
  const endLine = () => {
    if (onLine) process.stdout.write('\n')
    onLine = false
  }
  // Ctrl-C ends the waiting, not the import: the server carries on with it.
  const interrupted = () => {
    endLine()
    console.error('Stopped waiting. The import carries on in the background; run the command again to open it.')
    process.exit(130)
  }
  process.once('SIGINT', interrupted)
  try {
    for (;;) {
      const poll = await fetch(`${BASE}/api/jobs/${started.jobId}`)
      const job = (await poll.json()) as Job
      // A server restarted in the meantime has forgotten the job; stop instead of waiting for ever.
      if (!poll.ok || !job.status) throw new Error(`The import was interrupted${job.error ? ` (${job.error})` : ''}. The server may have restarted; run the command again.`)
      if (job.status === 'error') throw new Error(job.message ?? 'The import failed.')
      if (job.status === 'done') {
        endLine()
        return openBrowser(`${BASE}/#/r/${job.reviewId}`, noOpen)
      }
      const message = stripControl(job.message ?? '').replace(/\n/g, ' ')
      const detail = stripControl(job.detail ?? '').replace(/\n/g, ' ')
      if (live) {
        if (message !== stage) endLine()
        // Kept to one row: a line that wraps cannot be redrawn in place.
        const text = fit(`${message}${detail ? `: ${detail}` : ''}…`, Math.max(20, (process.stdout.columns || 80) - 1)).trimEnd()
        process.stdout.write(`\r\x1b[K${text}`)
        onLine = true
      } else if (message !== stage) console.log(`${message}…`)
      stage = message
      await sleep(300)
    }
  } catch (err) {
    endLine()
    throw err
  } finally {
    process.off('SIGINT', interrupted)
  }
}

/** Mark pull requests that already have a review in Trail, if its server happens to be running. */
async function markKnownReviews(rows: { repo: string; number: number; inTrail?: string }[]): Promise<void> {
  if (!(await health())) return
  try {
    const reviews = (await (await fetch(`${BASE}/api/reviews`)).json()) as { repoLabel: string; number: number | null; viewedCount: number; hunkCount: number }[]
    const known = new Map(reviews.filter((r) => r.number).map((r) => [`${r.repoLabel.toLowerCase()}#${r.number}`, `${r.viewedCount}/${r.hunkCount} viewed`]))
    for (const row of rows) row.inTrail = known.get(`${row.repo.toLowerCase()}#${row.number}`)
  } catch {
    // Only a convenience; the list is complete without it.
  }
}

/** List pull requests, let the reader choose one, and open it. Without a terminal, print the list instead. */
async function listAndOpen(target: Extract<Target, { kind: 'list' }>, noOpen: boolean): Promise<void> {
  const heading = describeList(target)
  console.error(`Reading ${heading}…`)
  const { rows, me } = await fetchList(target)
  // A status message, so it goes where status goes: a script reading the list must not take it for a row.
  if (!rows.length) return console.error(`No ${heading}.`)
  await markKnownReviews(rows)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Piped or scripted: one pull request per line, ready for another command to read.
    for (const r of rows) console.log([`${r.repo}#${r.number}`, r.title, r.author, status(r, me)].join('\t'))
    return
  }
  // At the limit there may be more than were fetched; say so instead of implying the list is complete.
  const count = rows.length === target.filters.limit ? `first ${rows.length} (--limit for more)` : String(rows.length)
  const { row: chosen, interrupted } = await pick(rows, me, `${heading} · ${count}`)
  if (!chosen) {
    console.error('No pull request chosen.')
    // The usual exit status for Ctrl-C, so a script can tell it from leaving with Esc.
    if (interrupted) process.exitCode = 130
    return
  }
  console.log(`Opening ${chosen.repo}#${chosen.number}: ${chosen.title}`)
  await importAndOpen({ kind: 'pr', ref: `${chosen.repo}#${chosen.number}` }, noOpen)
}

/**
 * Stop the server answering at an address by signalling the process it says it is, then wait
 * until it is gone. A pid read from a file could be stale and belong to something else.
 */
async function stopServer(base: string, running: Health): Promise<void> {
  const legacyPidFile = path.join(home, 'server.pid')
  // Servers started by an earlier version do not report their pid; for those, the file that
  // version wrote is used, now that the health check has confirmed a Trail server is up.
  const fromFile = fs.existsSync(legacyPidFile) ? Number(fs.readFileSync(legacyPidFile, 'utf8').trim()) : NaN
  const pid = running.pid ?? fromFile
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`A Trail server is answering on ${base} but did not say which process it is. Stop it from the terminal it was started in.`)
  process.kill(pid)
  fs.rmSync(legacyPidFile, { force: true })
  for (let i = 0; i < 50 && (await health(base)); i++) await sleep(100)
  // Starting a new server now would fail on the taken port and leave the old one in charge.
  if (await health(base)) throw new Error(`The Trail server on ${base} did not stop. Check it with "trail doctor", or end process ${pid} yourself.`)
}

async function stop(): Promise<void> {
  const running = await health()
  if (!running) return console.log('Trail was not running.')
  if (running.home !== undefined && !ours(running)) throw new Error(`The Trail server on ${BASE} serves another data folder (${running.home}), so it was left running.`)
  await stopServer(BASE, running)
  console.log('Trail stopped.')
}

/** Run the server in this terminal until it is stopped, passing on any request to stop. */
function serve(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, serverCommand(), { cwd: ROOT, stdio: 'inherit' })
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
    // Whoever asks this process to stop is asking for the server to stop; without this the
    // server would be left running with nothing attached to it.
    const forward = (signal: NodeJS.Signals) => child.kill(signal)
    for (const s of signals) process.on(s, forward)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      for (const s of signals) process.off(s, forward)
      // Stopped on request (Ctrl-C, `trail stop`, a process manager) is a normal end.
      process.exitCode = signal ? 0 : (code ?? 1)
      resolve()
    })
  })
}

async function config(target: Extract<Target, { kind: 'config' }>): Promise<void> {
  const { key, value, unset } = target
  const names = Object.keys(CONFIG_KEYS) as ConfigKey[]
  if (key !== undefined && !isConfigKey(key)) throw new Error(`There is no setting called "${key}". The settings are: ${names.join(', ')}.`)
  if (key && (value !== undefined || unset)) {
    // The port and the data folder are fixed for a server's lifetime, and after the change
    // `trail stop` would look for it at the new address. So one running at the old address is
    // stopped now, while it can still be found.
    if (key === 'home' && process.env.TRAIL_HOME) throw new Error(`TRAIL_HOME is set in your environment (${process.env.TRAIL_HOME}), which fixes the data folder for this shell. Unset it to save a different one.`)
    // The current port may itself be the broken value this command is fixing.
    let oldBase = ''
    try {
      oldBase = `http://localhost:${trailPort()}`
    } catch {
      // Nothing can be running on a port that is not a port.
    }
    const running = key === 'owner' || !oldBase ? null : await health(oldBase)
    // Judged before the change, while "this data folder" still means the old one.
    const wasOurs = !!running && ours(running)
    home = trailHome()
    writeConfig(key, unset ? undefined : value!.trim())
    console.log(unset ? `Removed ${key}.` : `Saved ${key} = ${readConfig()[key]}`)
    if (process.env[CONFIG_KEYS[key]]) console.log(`Note: ${CONFIG_KEYS[key]} is set in your environment (${process.env[CONFIG_KEYS[key]]}) and wins over the saved value.`)
    if (running && wasOurs) {
      await stopServer(oldBase, running)
      console.log('Stopped the Trail server that was running with the old value. The next command starts it with the new one.')
    } else if (running) {
      console.log(`A Trail server is still running on ${oldBase}. It was left alone because it could not be confirmed as this one's.`)
    }
    return
  }
  const saved = readConfig()
  for (const name of key ? [key] : names) {
    const fromEnv = process.env[CONFIG_KEYS[name]]
    const savedText = saved[name] ?? '(not set)'
    console.log(`${name.padEnd(6)} ${fromEnv && fromEnv !== saved[name] ? `${fromEnv}  (from ${CONFIG_KEYS[name]} in your environment; saved: ${savedText})` : savedText}`)
    if (!key) console.log(`       ${CONFIG_HELP[name]}`)
  }
  if (!key) console.log(`\nSaved in ${configFile()}. Change one with: trail config <name> <value>`)
}

/** Run a command and report whether it exists, whether it succeeded, and what it printed. */
function probe(cmd: string, args: string[]): Promise<{ found: boolean; ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // The same environment the real calls use, so the answer is about github.com.
    execFile(cmd, args, { encoding: 'utf8', timeout: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' } }, (err, stdout, stderr) => {
      resolve({ found: (err as NodeJS.ErrnoException | null)?.code !== 'ENOENT', ok: !err, out: (stdout || stderr).trim() })
    })
  })
}

/** Check what Trail needs on this machine, saying how to fix each thing that is missing. */
async function doctor(): Promise<void> {
  let missing = 0
  const report = (ok: boolean, label: string, fix?: string) => {
    console.log(`${ok ? '✓' : '✗'} ${label}`)
    if (!ok) {
      missing++
      if (fix) console.log(`    ${fix}`)
    }
  }
  const firstLine = (text: string) => text.split('\n')[0]
  report(true, `Node.js ${process.versions.node} (needs ${MIN_NODE.join('.')} or newer)`)

  const [git, gh, ghAuth, claude, claudeAuth] = await Promise.all([
    probe('git', ['--version']),
    probe('gh', ['--version']),
    // Asked about github.com only: a stale login for some other host must not count against it.
    probe('gh', ['auth', 'status', '--hostname', 'github.com']),
    probe('claude', ['--version']),
    probe('claude', ['auth', 'status']),
  ])
  report(git.ok, git.ok ? firstLine(git.out) : git.found ? 'git is installed but does not run' : 'git is not installed', 'Install git: https://git-scm.com')
  report(gh.ok, gh.ok ? `GitHub CLI: ${firstLine(gh.out)}` : 'GitHub CLI (gh) is not installed', 'Install it from https://cli.github.com. It is needed for pull requests, not for local repositories.')
  if (gh.ok) report(ghAuth.ok, ghAuth.ok ? 'GitHub CLI is logged in to github.com' : 'GitHub CLI is not logged in to github.com', 'Run: gh auth login --hostname github.com')
  report(claude.ok, claude.ok ? `Claude Code ${firstLine(claude.out)}` : 'Claude Code (claude) is not installed', 'Install it from https://claude.com/claude-code. It answers questions and writes walkthroughs.')
  if (claude.ok) {
    // The command prints JSON; if it ever prints something else, its exit status still decides.
    let loggedIn = claudeAuth.ok
    try {
      if ((JSON.parse(claudeAuth.out) as { loggedIn?: boolean }).loggedIn === false) loggedIn = false
    } catch {
      if (/"loggedIn":\s*false/.test(claudeAuth.out)) loggedIn = false
    }
    report(loggedIn, loggedIn ? 'Claude Code is logged in' : 'Claude Code is not logged in', 'Run: claude   and log in when it asks.')
  }
  report(fs.existsSync(path.join(ROOT, 'dist', 'web', 'index.html')), 'The web page is built', `Run \`npm install && npm run build\` in ${ROOT}`)

  console.log(`\n  owner     ${setting('owner') ?? '(not set: save one with "trail config owner <name>")'}`)
  console.log(`  data      ${home}`)
  console.log(`  settings  ${configFile()}`)
  if (portProblem) report(false, 'The saved port cannot be used', portProblem)
  else {
    const running = await health()
    console.log(`  server    ${running ? `running at ${BASE}${running.build === buildId() ? '' : ' (started before the last update)'}` : `not running; it will use ${BASE}`}`)
  }
  if (missing) {
    console.log(`\n${missing} thing${missing === 1 ? '' : 's'} to fix.`)
    process.exitCode = 1
  } else console.log('\nEverything Trail needs is in place.')
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) console.log(USAGE)
  else {
    const target = resolveTarget(args, setting('owner'), (p) => fs.existsSync(p))
    // Fixed for the server this may start: the settings file before the data folder is put in
    // the environment (which would otherwise move it), and the data folder as an absolute path.
    process.env.TRAIL_CONFIG = configFile()
    if (target.kind === 'config') await config(target)
    else {
      home = trailHome()
      process.env.TRAIL_HOME = home
      // A port that cannot be used stops everything except the two commands that exist to
      // find and fix such problems: config (above) and doctor.
      try {
        BASE = `http://localhost:${trailPort()}`
      } catch (err) {
        if (target.kind !== 'doctor') throw err
        portProblem = (err as Error).message
      }
      if (target.kind === 'doctor') await doctor()
      else if (target.kind === 'serve') await serve()
      else if (target.kind === 'stop') await stop()
      else if (target.kind === 'list') await listAndOpen(target, args.noOpen)
      else if (target.kind === 'home') {
        await ensureServer()
        openBrowser(BASE, args.noOpen)
      } else await importAndOpen(target, args.noOpen)
    }
  }
} catch (err) {
  // An error can quote git, GitHub or a remote server, so it is cleaned like everything else shown.
  console.error(`Trail: ${stripControl((err as Error).message)}`)
  process.exit(1)
}
