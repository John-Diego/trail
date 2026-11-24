// Settings shared by the launcher and the server, so both always agree on port, data folder
// and owner however they were started. Bun only: the web page does not import this.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Trail's own folder, found from this file, so it is right whatever folder a command runs in. */
export const ROOT = path.resolve(import.meta.dir, '..')
export const ENV_FILE = path.join(ROOT, '.env')

/**
 * Settings from Trail's own .env file. Only TRAIL_ variables are read; anything else in the
 * file is ignored. Blank values count as not set.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(TRAIL_[A-Z0-9_]+)\s*=(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    const quoted = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(value)
    // A quoted value is taken whole. An unquoted one ends where a comment starts.
    value = quoted ? quoted[2] : value.replace(/(^|\s)#.*$/, '').trim()
    if (value) out[m[1]] = value
  }
  return out
}

/**
 * Put Trail's .env settings into the environment. A variable already set in the real
 * environment wins. Bun's own automatic .env loading is switched off everywhere Trail starts,
 * because it reads the .env of the current folder, and Trail is run inside other projects.
 */
export function loadTrailEnv(): void {
  if (!fs.existsSync(ENV_FILE)) return
  for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8')))) process.env[key] ||= value
}

/** The data folder as an absolute path. ~ is expanded; a relative path is taken from Trail's folder, not the current one. */
export function trailHome(): string {
  const configured = process.env.TRAIL_HOME || '~/.trail'
  const expanded = configured === '~' || configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(1)) : configured
  return path.resolve(ROOT, expanded)
}

export function trailPort(): number {
  const raw = process.env.TRAIL_PORT || '4477'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`TRAIL_PORT must be a port number, but it is "${raw}".`)
  return port
}

/**
 * Changes whenever Trail's code changes on disk. The launcher compares its own value with the
 * running server's, to notice a server that was started before an update.
 */
export function buildId(): string {
  let newest = 0
  for (const dir of ['bin', 'server', 'shared']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) newest = Math.max(newest, fs.statSync(path.join(ROOT, dir, name)).mtimeMs)
  }
  return String(Math.round(newest))
}
