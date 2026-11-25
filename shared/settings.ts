// Settings shared by the launcher and the server, so both always agree on port, data folder
// and owner however they were started. Node only: the web page does not import this.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The file this code is running from: bin/trail.ts or shared/settings.ts from source, dist/cli.js or dist/server.js when installed. */
export const ENTRY = fileURLToPath(import.meta.url)

/**
 * Trail's own folder: the package root. Every file this can run from sits one level below
 * it. Found with fileURLToPath, not import.meta.dirname, so that an old Node gets as far as
 * the version check and its clear message instead of failing here.
 */
export const ROOT = path.resolve(path.dirname(ENTRY), '..')

export const MIN_NODE = [22, 13] as const

/** Throws, with what to do, when this Node is too old for Trail (its database needs node:sqlite). */
export function requireNode(): void {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return
  throw new Error(`Trail needs Node.js ${MIN_NODE.join('.')} or newer, and this is ${process.versions.node}. Update Node.js (https://nodejs.org) and run the command again.`)
}

/** The settings a person can save, and the environment variable each one maps to. */
export const CONFIG_KEYS = { owner: 'TRAIL_OWNER', port: 'TRAIL_PORT', home: 'TRAIL_HOME' } as const
export type ConfigKey = keyof typeof CONFIG_KEYS
export type Config = Partial<Record<ConfigKey, string>>

export const CONFIG_HELP: Record<ConfigKey, string> = {
  owner: 'GitHub user or organisation used when only a repository name is given',
  port: 'port of the local web page (default 4477)',
  home: 'folder for the database, clones and checkouts (default ~/.trail)',
}

/**
 * Where saved settings live: ~/.trail/config.json. Not in Trail's own folder, which a global
 * install replaces on every update. TRAIL_HOME moves it along with the data, and
 * TRAIL_CONFIG names the file outright.
 */
export function configFile(): string {
  if (process.env.TRAIL_CONFIG) return process.env.TRAIL_CONFIG
  // With TRAIL_HOME set, that folder is a self-contained profile: its own data and its own settings.
  const base = process.env.TRAIL_HOME ? path.resolve(os.homedir(), expandHome(process.env.TRAIL_HOME)) : path.join(os.homedir(), '.trail')
  return path.join(base, 'config.json')
}

export function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(CONFIG_KEYS, key)
}

export function readConfig(): Config {
  const file = configFile()
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    // No file yet means nothing is saved. Any other failure would silently discard the
    // reader's settings, so it is reported.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Could not read ${file}: ${(err as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it, or delete it and set the values again with "trail config".`)
  }
  const config: Config = {}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (isConfigKey(key) && (typeof value === 'string' || typeof value === 'number') && String(value).trim()) config[key] = String(value).trim()
    }
  }
  return config
}

/** What a value must look like before it is saved. Returns the problem in words, or null when it is fine. */
export function configProblem(key: ConfigKey, value: string): string | null {
  if (key === 'owner') return /^[A-Za-z0-9_][\w.-]*$/.test(value) ? null : `"${value}" is not a GitHub user or organisation name.`
  if (key === 'port') return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? null : `"${value}" is not a port number (1 to 65535).`
  return value.trim() ? null : 'The folder cannot be empty.'
}

/** Save one setting, or remove it when the value is undefined. */
export function writeConfig(key: ConfigKey, value: string | undefined): void {
  const config = readConfig()
  if (value === undefined) delete config[key]
  else {
    const problem = configProblem(key, value)
    if (problem) throw new Error(problem)
    // A folder is saved as the full path it means now, so it means the same from anywhere later.
    config[key] = key === 'home' ? path.resolve(expandHome(value)) : value
  }
  const file = configFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Written beside the file and moved into place, so an interrupted write cannot leave half a file.
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/**
 * The value of a setting right now: the environment variable when it is set, otherwise what
 * is saved. Read each time it is needed, so a running server sees a setting that was changed
 * after it started.
 */
export function setting(key: ConfigKey): string | undefined {
  return process.env[CONFIG_KEYS[key]] || readConfig()[key]
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
}

/** The data folder as an absolute path. ~ is expanded; a relative path is taken from the home folder, never the current one. */
export function trailHome(): string {
  return path.resolve(os.homedir(), expandHome(setting('home') || '~/.trail'))
}

export function trailPort(): number {
  const raw = setting('port') || '4477'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`The port must be a number from 1 to 65535, but it is "${raw}". Set it with "trail config port <number>".`)
  return port
}

/**
 * Changes whenever Trail's code changes on disk: an update of the installed package, or an
 * edit when running from source. The launcher compares its own value with the running
 * server's, to notice a server that was started before the change.
 */
export function buildId(): string {
  // Decided by what is actually running, so a clone that runs its built files is judged by those.
  const fromSource = !ENTRY.endsWith('.js')
  let newest = 0
  for (const dir of fromSource ? ['bin', 'server', 'shared'] : ['dist']) {
    try {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (entry.isFile()) newest = Math.max(newest, fs.statSync(path.join(ROOT, dir, entry.name)).mtimeMs)
      }
    } catch {
      // A folder that is not there contributes nothing.
    }
  }
  return String(Math.round(newest))
}
