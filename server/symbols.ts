import type { FileDiff, SymbolDef, SymbolResult, SymbolUsage } from '../shared/types.ts'
import { db, tx } from './db.ts'
import { git } from './git.ts'

/**
 * Heuristic, language-agnostic definition index. One `git grep` pass over the head commit
 * finds lines that look like definitions; per-line patterns then extract names. It is not a
 * compiler: it trades precision for working on any repository with no setup. Results are
 * ranked so the likeliest definition comes first, and usages are an exact word search.
 */

const CODE_EXT =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|swift|rb|php|cs|c|h|cc|cpp|cxx|hpp|hh|m|mm|scala|ex|exs|erl|dart|lua|sh|bash|zsh|vue|svelte|sql|proto|graphql|gql|tf|zig|nim|clj|hs|ml|r|pl|groovy|gradle)$/i

const SKIP_PATH = /(^|\/)(node_modules|vendor|dist|build|out|target|\.next|coverage|__pycache__|third_party|\.venv|venv)\/|\.min\.|\.d\.ts$/

// Cheap prefilter run by git grep (POSIX ERE). Anything a per-line pattern below could match must pass it.
const PREFILTER =
  '(^|[^A-Za-z0-9_])(function|class|interface|struct|enum|trait|protocol|module|namespace|record|object|type|typealias|union|def|defp|defmodule|defmacro|func|fn|fun|sub|proc|const|let|var|val|static|macro_rules!|impl|#define)[^A-Za-z0-9_]' +
  '|^[[:space:]]*[A-Za-z_$][]A-Za-z0-9_$<>,.?*&: []*\\([^;]*(\\{|=>)[[:space:]]*$' +
  '|^[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function|\\(|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=>)' +
  '|^[A-Z][A-Z0-9_]+[[:space:]]*='

const NOT_NAMES = new Set(
  'if else for while do switch case catch try finally return throw new delete typeof instanceof void await yield function class super this with in of import export from as default sizeof and or not is lambda pass raise assert elif except match when unless until begin end then loop foreach using lock fixed checked guard defer go select range where constructor'.split(
    ' ',
  ),
)

interface Found {
  name: string
  kind: string
}

const TYPE_KW = /\b(class|interface|struct|enum|trait|protocol|module|namespace|record|object|defmodule|typealias|union|type)\s+([A-Za-z_][\w.]*)/
const FUNC_KW = /\b(function\*?|def|defp|defmacro|func|fn|fun|sub|proc)\s+(?:\([^)]*\)\s*)?(?:self\.)?([A-Za-z_$][\w$]*[?!]?)/
const VAR_FN = /\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\(|<|[A-Za-z_$][\w$]*\s*=>)/
const VAR_TOP = /^(?:export\s+)?(?:pub(?:\([a-z]+\))?\s+)?(?:const|let|var|static|val)\s+(?:mut\s+)?([A-Za-z_$][\w$]*)\s*[:=]/
const PROP_FN = /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/
const METHOD =
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|async|virtual|readonly|synchronized|export|default|open|suspend|inline|get|set|unsafe|extern|constexpr)\s+)*(?:[\w<>\[\],.?*&:]+\s+)*?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(([^'"`]*)\)\s*(?::\s*[^={;]+|->\s*[^{;]+|throws\s+[\w., ]+)?\s*\{\s*$/
const PY_CONST = /^([A-Z][A-Z0-9_]+)\s*=/
const C_DEFINE = /^\s*#define\s+([A-Za-z_]\w*)/
const RUST_MACRO = /\bmacro_rules!\s+([A-Za-z_]\w*)/

export function extractDefs(line: string): Found[] {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return []
  const cDefine = C_DEFINE.exec(line)
  if (cDefine) return [{ name: cDefine[1], kind: 'macro' }]
  if (trimmed.startsWith('#')) return []

  const found: Found[] = []
  const add = (name: string | undefined, kind: string) => {
    if (!name || NOT_NAMES.has(name) || found.some((f) => f.name === name)) return
    found.push({ name: name.split('.').pop()!, kind })
  }

  const typeKw = TYPE_KW.exec(line)
  // `type` is also a builtin and a field name in several languages; require it to start the statement.
  if (typeKw && (typeKw[1] !== 'type' || /^\s*(export\s+|pub\s+|declare\s+)*type\s/.test(line))) add(typeKw[2], typeKw[1])
  const funcKw = FUNC_KW.exec(line)
  if (funcKw) add(funcKw[2], 'function')
  add(VAR_FN.exec(line)?.[1], 'function')
  add(RUST_MACRO.exec(line)?.[1], 'macro')
  if (!found.length) {
    add(PROP_FN.exec(line)?.[1], 'function')
    const method = METHOD.exec(line)
    // A lambda inside the argument list means this is a call like `it('…', () => {`, not a definition.
    if (method && !method[2].includes('=>') && !/\bfunction\b/.test(method[2])) add(method[1], 'method')
  }
  if (!found.length) {
    add(VAR_TOP.exec(line)?.[1], 'variable')
    add(PY_CONST.exec(line)?.[1], 'constant')
  }
  return found
}

export async function indexSymbols(reviewId: number, repoDir: string, headSha: string): Promise<number> {
  const out = await git(repoDir, ['grep', '-n', '-z', '-I', '-E', '-e', PREFILTER, headSha], { okCodes: [1] })
  const prefix = headSha.length + 1
  const rows: [string, string, number, string, string][] = []
  for (const record of out.split('\n')) {
    if (!record) continue
    // Format with -z: "<sha>:<path>\0<line>\0<text>"
    const a = record.indexOf('\0')
    const b = record.indexOf('\0', a + 1)
    if (a < 0 || b < 0) continue
    const path = record.slice(prefix, a)
    if (!CODE_EXT.test(path) || SKIP_PATH.test(path)) continue
    const text = record.slice(b + 1)
    if (text.length > 400) continue
    const lineNo = Number(record.slice(a + 1, b))
    for (const def of extractDefs(text)) rows.push([def.name, path, lineNo, def.kind, text.trim().slice(0, 200)])
  }
  tx(() => {
    db.prepare('DELETE FROM symbols WHERE review_id = ?').run(reviewId)
    const insert = db.prepare('INSERT INTO symbols (review_id, name, path, line, kind, text) VALUES (?, ?, ?, ?, ?, ?)')
    for (const r of rows) insert.run(reviewId, ...r)
    db.prepare('UPDATE reviews SET symbols_sha = ? WHERE id = ?').run(headSha, reviewId)
  })
  return rows.length
}

const IDENT = /[A-Za-z_$][\w$]*/g

/** Of the identifiers in the given sources, those with a definition in the index. */
export function knownIdentifiers(reviewId: number, ...sources: (string | null)[]): string[] {
  const names = new Set<string>()
  for (const src of sources) {
    if (!src) continue
    for (const m of src.matchAll(IDENT)) if (m[0].length > 1 && !NOT_NAMES.has(m[0])) names.add(m[0])
  }
  const all = [...names]
  const known: string[] = []
  for (let i = 0; i < all.length; i += 400) {
    const chunk = all.slice(i, i + 400)
    const rows = db
      .prepare(`SELECT DISTINCT name FROM symbols WHERE review_id = ? AND name IN (${chunk.map(() => '?').join(',')})`)
      .all(reviewId, ...chunk) as { name: string }[]
    for (const r of rows) known.push(r.name)
  }
  return known
}

const KIND_WEIGHT: Record<string, number> = { function: 30, class: 30, interface: 30, struct: 30, enum: 30, trait: 30, type: 28, method: 18, macro: 20, variable: 8, constant: 8 }
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|mocks?|fixtures|examples?)\/|[._-](test|spec)\.[a-z]+$/i

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

export async function lookupSymbol(
  reviewId: number,
  repoDir: string,
  headSha: string,
  files: FileDiff[],
  name: string,
  fromPath: string,
): Promise<SymbolResult> {
  const changed = new Set(files.map((f) => f.path))
  const rows = db.prepare('SELECT name, path, line, kind, text FROM symbols WHERE review_id = ? AND name = ? LIMIT 200').all(reviewId, name) as unknown as Omit<
    SymbolDef,
    'changed'
  >[]
  const fromDir = dirOf(fromPath)
  const score = (d: Omit<SymbolDef, 'changed'>) =>
    (KIND_WEIGHT[d.kind] ?? 15) +
    (d.path === fromPath ? 40 : 0) +
    (dirOf(d.path) === fromDir ? 15 : 0) +
    (changed.has(d.path) ? 20 : 0) -
    (TEST_PATH.test(d.path) && !TEST_PATH.test(fromPath) ? 25 : 0)
  const defs: SymbolDef[] = rows
    .map((d) => ({ ...d, changed: changed.has(d.path) }))
    .sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path))
    .slice(0, 30)

  const MAX = 300
  let usages: SymbolUsage[] = []
  if (/^[\w$]+$/.test(name)) {
    const out = await git(repoDir, ['grep', '-n', '-z', '-I', '-w', '-F', '-e', name, headSha], { okCodes: [1] })
    const prefix = headSha.length + 1
    const defAt = new Set(defs.map((d) => `${d.path}:${d.line}`))
    for (const record of out.split('\n')) {
      if (!record) continue
      const a = record.indexOf('\0')
      const b = record.indexOf('\0', a + 1)
      if (a < 0 || b < 0) continue
      const path = record.slice(prefix, a)
      const line = Number(record.slice(a + 1, b))
      if (SKIP_PATH.test(path) || defAt.has(`${path}:${line}`)) continue
      usages.push({ path, line, text: record.slice(b + 1).trim().slice(0, 200), changed: changed.has(path) })
    }
  }
  const usagesTruncated = usages.length > MAX
  // Files in the change first: those are the usages a reviewer is most likely checking.
  usages.sort((a, b) => Number(b.changed) - Number(a.changed) || a.path.localeCompare(b.path) || a.line - b.line)
  usages = usages.slice(0, MAX)
  return { name, defs, usages, usagesTruncated }
}

/** Label each hunk with the definition it sits in, using the index for the head commit. */
export function annotateHunks(reviewId: number, files: FileDiff[]): void {
  const stmt = db.prepare('SELECT name, line FROM symbols WHERE review_id = ? AND path = ? ORDER BY line')
  for (const f of files) {
    if (f.status === 'deleted' || !f.hunks.length) continue
    const defs = stmt.all(reviewId, f.path) as { name: string; line: number }[]
    if (!defs.length) continue
    for (const h of f.hunks) {
      const firstChange = h.lines.find((l) => l.t === '+')?.n ?? h.lines.find((l) => l.n !== undefined)?.n ?? h.newStart
      let best: string | undefined
      for (const d of defs) {
        if (d.line > firstChange) break
        best = d.name
      }
      // A hunk that itself introduces definitions is best named after those.
      const added = new Set(h.lines.filter((l) => l.t === '+').map((l) => l.n))
      const introduced = [...new Set(defs.filter((d) => added.has(d.line)).map((d) => d.name))]
      h.symbol = introduced.length ? introduced.slice(0, 3).join(', ') + (introduced.length > 3 ? ', …' : '') : best
    }
  }
}
