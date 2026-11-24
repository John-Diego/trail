#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Trail command line: starts the local server when needed, imports what you point it at, and opens the browser.
//
// The two options on the first line matter. `trail .` is run inside other people's projects, and
// Bun would otherwise read two files from the current folder before any of this code runs:
//   .env         its variables (API keys and all) would reach Trail's server and Claude
//   bunfig.toml  its "preload" scripts would be executed, which is running that project's code
// So Bun is told to read neither. Trail's own settings come from the .env next to this project.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { buildId, ENV_FILE, loadTrailEnv, ROOT, trailHome, trailPort } from '../shared/settings.ts'
import { parseArgs, resolveTarget } from './args.ts'

const BUN_FLAGS = ['--no-env-file', '--config=/dev/null']
const JSON_HEADERS = { 'Content-Type': 'application/json' }
const serverFile = path.join(ROOT, 'server', 'index.ts')

const USAGE = `Trail: local pull request review

  trail <repo> <number>       Review a pull request. The owner comes from TRAIL_OWNER in
                              ${ENV_FILE}
  trail <repo> <number> --owner <name>
                              Same, for another owner (overrides TRAIL_OWNER)
  trail <owner>/<repo> <number>
  trail <owner>/<repo>/<number>
  trail <address>             A GitHub pull request address, with or without https://,
                              e.g. github.com/owner/repo/pull/123/files
                              Also accepted: owner/repo#123 and repo#123

  trail .                     Review the current branch of this repository, including uncommitted changes
  trail <path> --base <ref>   Review a local repository against a base branch.
                              Write ./a/b/12 for a folder whose name looks like a pull request.

  trail                       Open Trail in the browser
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
}

interface Job {
  status?: 'running' | 'done' | 'error'
  message?: string
  reviewId?: number
  error?: string
}

let BASE = ''
let home = ''

/** The Trail server on this port, or null when nothing answers or something else is listening there. */
async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${BASE}/api/health`)
    const body = (await res.json()) as Health
    return res.ok && body.app === 'trail' ? body : null
  } catch {
    return null
  }
}

async function ensureServer(): Promise<void> {
  const running = await health()
  if (running) {
    if (running.build !== buildId()) console.error('Note: the Trail server that is running was started before the code last changed. Run `trail stop` and try again to use the current version.')
    return
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'web', 'index.html'))) {
    throw new Error(`The web UI has not been built yet. Run \`bun install && bun run build\` in ${ROOT}`)
  }
  fs.mkdirSync(home, { recursive: true })
  const logFile = path.join(home, 'server.log')
  const log = fs.openSync(logFile, 'a')
  // Bun runs the TypeScript server directly; there is no compiled copy to keep in step. It starts
  // in Trail's own folder and, like this launcher, reads no .env or bunfig.toml of another project.
  spawn(process.execPath, [...BUN_FLAGS, serverFile], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] }).unref()
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100)
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
  let last = ''
  for (;;) {
    const poll = await fetch(`${BASE}/api/jobs/${started.jobId}`)
    const job = (await poll.json()) as Job
    // A server restarted in the meantime has forgotten the job; stop instead of waiting for ever.
    if (!poll.ok || !job.status) throw new Error(`The import was interrupted${job.error ? ` (${job.error})` : ''}. The server may have restarted; run the command again.`)
    if (job.status === 'error') throw new Error(job.message ?? 'The import failed.')
    if (job.status === 'done') return openBrowser(`${BASE}/#/r/${job.reviewId}`, noOpen)
    if (job.message && job.message !== last) console.log(`${(last = job.message)}…`)
    await Bun.sleep(300)
  }
}

/**
 * Stops the server by asking the process that is answering on Trail's port who it is, then
 * signalling that process. A pid read from a file could be stale and belong to something else.
 */
async function stop(): Promise<void> {
  const legacyPidFile = path.join(home, 'server.pid')
  const running = await health()
  if (!running) {
    fs.rmSync(legacyPidFile, { force: true })
    return console.log('Trail was not running.')
  }
  // Servers started by an earlier version do not report their pid; for those, the file that
  // version wrote is used, now that the health check has confirmed a Trail server is up.
  const fromFile = fs.existsSync(legacyPidFile) ? Number(fs.readFileSync(legacyPidFile, 'utf8').trim()) : NaN
  const pid = running.pid ?? fromFile
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`A Trail server is answering on ${BASE} but did not say which process it is. Stop it from the terminal it was started in.`)
  process.kill(pid)
  fs.rmSync(legacyPidFile, { force: true })
  console.log('Trail stopped.')
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) console.log(USAGE)
  else {
    loadTrailEnv()
    home = trailHome()
    // Passed on as an absolute path, so the server uses the same folder whatever it resolves against.
    process.env.TRAIL_HOME = home
    BASE = `http://localhost:${trailPort()}`
    const target = resolveTarget(args, process.env.TRAIL_OWNER, ENV_FILE, (p) => fs.existsSync(p))
    if (target.kind === 'serve') await import(serverFile)
    else if (target.kind === 'stop') await stop()
    else if (target.kind === 'home') {
      await ensureServer()
      openBrowser(BASE, args.noOpen)
    } else await importAndOpen(target, args.noOpen)
  }
} catch (err) {
  console.error(`Trail: ${(err as Error).message}`)
  process.exit(1)
}
