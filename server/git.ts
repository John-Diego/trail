import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { loadTrailEnv, trailHome } from '../shared/settings.ts'

// The server reads Trail's own .env itself, so it has the same settings however it was started
// (by the launcher, by `trail serve`, or by `bun run dev`).
loadTrailEnv()
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
          const detail = (stderr || err.message).trim().split('\n').slice(-6).join('\n')
          return reject(new CommandError(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${detail}`, code, stderr))
        }
        resolve(stdout)
      },
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
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
