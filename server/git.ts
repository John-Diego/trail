import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { trailHome } from '../shared/settings.ts'
import { stripControl } from '../shared/text.ts'

// The server reads the saved settings itself, so it has the same ones however it was started
// (by the launcher, by `trail serve`, or by `npm run dev`).
export const TRAIL_HOME = trailHome()
fs.mkdirSync(TRAIL_HOME, { recursive: true })

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  /** Exit codes that are not errors (git grep exits 1 when nothing matches). */
  okCodes?: number[]
  /** Kill the command after this long. Defaults to two minutes; clones and fetches pass more. */
  timeoutMs?: number
}

// Nobody is at a terminal to answer a credential prompt; a command that asks must fail instead of waiting.
// GH_HOST: Trail supports github.com only, whatever host the reader's gh is otherwise pointed at.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' }
export const LONG = 15 * 60_000

export class CommandError extends Error {
  constructor(
    message: string,
    public code: number | null,
    public stderr: string,
  ) {
    super(message)
  }
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: { ...(opts.env ?? process.env), ...NO_PROMPT }, maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000 },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as any).killed) return reject(new CommandError(`${cmd} ${args.slice(0, 3).join(' ')} took too long and was stopped.`, null, stderr))
          const code = typeof (err as any).code === 'number' ? ((err as any).code as number) : null
          if (code !== null && opts.okCodes?.includes(code)) return resolve(stdout)
          // What the command printed may quote a remote server or a branch name, so it is cleaned.
          const detail = stripControl(stderr || err.message).trim().split('\n').slice(-6).join('\n')
          return reject(new CommandError(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${detail}`, code, stderr))
        }
        resolve(stdout)
      },
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

const TRANSFER_PHASES: Record<string, string> = { 'Receiving objects': 'downloading', 'Resolving deltas': 'unpacking', 'Updating files': 'writing files' }
const TRANSFER_RE = /^(Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%(?:[^,]*,\s*(\d[\d.]* (?:bytes|[KMG]iB))(?:\s*\|\s*(\d[\d.]* (?:bytes|[KMG]iB)\/s))?)?/

/**
 * What a line of git's progress output says, in words, or null for any other line. Only the
 * numbers are taken from the line: the rest of what git prints during a transfer includes
 * text sent by the remote, which is not passed on.
 */
export function transferProgress(line: string): string | null {
  const m = TRANSFER_RE.exec(line.trim())
  if (!m) return null
  return [`${TRANSFER_PHASES[m[1]]} ${m[2]}%`, m[3], m[4] && `at ${m[4]}`].filter(Boolean).join(', ').replace(', at ', ' at ')
}

/**
 * Run a git or gh command that transfers a repository, reporting how far along it is. A big
 * repository can take many minutes, so there is no limit on the total time; the command is
 * stopped only if it says nothing at all for `idleMs`.
 */
export function runTransfer(cmd: string, args: string[], opts: { cwd?: string; label?: string; onProgress: (text: string) => void; idleMs?: number; killGraceMs?: number }): Promise<void> {
  const idleMs = opts.idleMs ?? 5 * 60_000
  return new Promise((resolve, reject) => {
    // Its own process group: `gh repo clone` runs git, which runs ssh, and stopping only the
    // first of them would leave the rest running and this promise waiting on their output.
    // LC_ALL=C because the progress lines are recognised by their English wording.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...NO_PROMPT, LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
    let tail = ''
    let pending = ''
    let last = ''
    let stalled = false
    let settled = false
    let idle: ReturnType<typeof setTimeout>
    let escalate: ReturnType<typeof setTimeout> | undefined

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        stalled = true
        signalGroup('SIGTERM')
        // Asked nicely first; a process that ignores that is ended outright.
        escalate = setTimeout(() => signalGroup('SIGKILL'), opts.killGraceMs ?? 10_000)
      }, idleMs)
    }
    const settle = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      clearTimeout(escalate)
      if (code === 0 && !stalled) return resolve()
      // Named for the reader ("git fetch"), not by whatever options happen to come first.
      const what = opts.label ?? `${cmd} ${args.slice(0, 2).join(' ')}`
      if (stalled) {
        const waited = idleMs >= 60_000 ? `${Math.round(idleMs / 60_000)} minute${Math.round(idleMs / 60_000) === 1 ? '' : 's'}` : `${Math.round(idleMs / 1000)} seconds`
        return reject(new CommandError(`${what} made no progress for ${waited} and was stopped. Check your connection and run the command again.`, null, ''))
      }
      // The last lines are the reason. They can include what the remote server sent, so they
      // are cleaned of anything a terminal would act on before they travel any further.
      // Split into lines first: a carriage return is itself a control character, and cleaning
      // before splitting would glue a progress line to the message after it.
      const detail = tail.split(/[\r\n]+/).map((l) => stripControl(l).replace(/\s+/g, ' ').trim()).filter((l) => l && !transferProgress(l)).slice(-4).join('\n')
      reject(new CommandError(`${what} failed: ${detail || `exit status ${code}`}`, code, ''))
    }

    arm()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      arm()
      tail = (tail + chunk).slice(-4000)
      // git redraws its progress line with carriage returns, so those end a line too. The last
      // piece may be half a line; it is kept until the rest arrives.
      const lines = (pending + chunk).split(/[\r\n]+/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const text = transferProgress(line)
        if (text && text !== last) opts.onProgress((last = text))
      }
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      settled = true
      clearTimeout(idle)
      clearTimeout(escalate)
      reject(new CommandError(err.code === 'ENOENT' ? `The ${cmd} command was not found.` : err.message, null, ''))
    })
    // 'close' waits for the output to end, which a leftover grandchild could hold open; 'exit'
    // of the command itself is final, with a moment allowed for its last output to arrive.
    child.on('close', (code) => settle(code))
    child.on('exit', (code) => setTimeout(() => settle(code), 300))
  })
}

export function git(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  // quotePath=false keeps non-ASCII paths readable instead of octal-escaped. The other two switch off
  // ways a repository's own configuration could make git run a program: Trail never needs them.
  return run('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', ...args], { ...opts, cwd })
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args)
    return true
  } catch {
    return false
  }
}

/** File contents at a commit, or null when the path does not exist there. */
export async function showFile(repoDir: string, sha: string, filePath: string): Promise<string | null> {
  try {
    return await git(repoDir, ['show', `${sha}:${filePath}`])
  } catch {
    return null
  }
}
