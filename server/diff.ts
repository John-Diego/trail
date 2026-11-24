import { createHash } from 'node:crypto'
import type { DiffLine, FileDiff, FileStatus, Hunk } from '../shared/types.ts'
import { git } from './git.ts'

// Only patterns that are machine-written with high confidence. A file matched here is hidden by
// default and its contents are not sent to Claude, so a false match would hide real code.
const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|Pipfile\.lock|flake\.lock|mix\.lock|Podfile\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(js|css)\.map$/,
  /\.snap$/,
  /(^|\/)(node_modules|__snapshots__)\//,
  /\.(pb\.go|pb\.ts|g\.dart)$/,
  /_pb2(_grpc)?\.py$/,
]

export function isGenerated(path: string): boolean {
  return GENERATED.some((re) => re.test(path))
}

export interface NameStatus {
  status: FileStatus
  path: string
  oldPath: string
}

export function parseNameStatus(raw: string): NameStatus[] {
  const parts = raw.split('\0')
  const out: NameStatus[] = []
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++]
      const path = parts[i++]
      out.push({ status: letter === 'R' ? 'renamed' : 'copied', path, oldPath })
    } else if (letter === 'T') {
      // A type change (file to symlink, say) is one entry here but two blocks in the patch:
      // the old object deleted, then the new one added.
      const path = parts[i++]
      out.push({ status: 'deleted', path, oldPath: path }, { status: 'added', path, oldPath: path })
    } else {
      const path = parts[i++]
      const status: FileStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
      out.push({ status, path, oldPath: path })
    }
  }
  return out
}

// The trailing section text is whatever line git found above the hunk, and may contain any
// character, including a bare carriage return; [^]* accepts them all where . would not.
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?([^]*)$/

function emptyHunk(file: FileDiff, note: string): Hunk {
  return { id: `f${file.idx}h0`, key: '', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, section: '', additions: 0, deletions: 0, pureMove: false, lines: [], note }
}

/** What changed in a file that has no text hunks, in words. */
function describeHunkless(file: FileDiff): string {
  if (file.binary) return file.status === 'added' ? 'Binary file added.' : file.status === 'deleted' ? 'Binary file deleted.' : 'Binary file changed.'
  if (file.modeChange) return `File mode changed (${file.modeChange}). Contents are unchanged.`
  if (file.status === 'renamed') return `Renamed from ${file.oldPath}. Contents are unchanged.`
  if (file.status === 'copied') return `Copied from ${file.oldPath}. Contents are unchanged.`
  if (file.status === 'added') return 'Empty file added.'
  if (file.status === 'deleted') return 'Empty file deleted.'
  return 'No text changes.'
}

/**
 * Parse `git diff` output. File names come from --name-status rather than the patch
 * headers, so paths with spaces or unusual characters are never guessed at.
 */
export function parsePatch(patch: string, names: NameStatus[]): FileDiff[] {
  const files: FileDiff[] = []
  const blobs: string[] = []
  const lines = patch.split('\n')
  let file: FileDiff | null = null
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  // Lines the current hunk still owes, from its header. Parsing by count means nothing
  // after a hunk can be mistaken for part of it.
  let oldLeft = 0
  let newLeft = 0
  let oldMode = ''

  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0]
      if (c === '+' && newLeft > 0) {
        hunk!.lines.push({ t: '+', n: newNo++, s: line.slice(1) })
        hunk!.additions++
        file!.additions++
        newLeft--
        continue
      }
      if (c === '-' && oldLeft > 0) {
        hunk!.lines.push({ t: '-', o: oldNo++, s: line.slice(1) })
        hunk!.deletions++
        file!.deletions++
        oldLeft--
        continue
      }
      // An empty line is a blank context line written without its leading space (diff.suppressBlankEmpty).
      if ((c === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        hunk!.lines.push({ t: ' ', o: oldNo++, n: newNo++, s: line.slice(1) })
        oldLeft--
        newLeft--
        continue
      }
      if (c === '\\') {
        const last = hunk!.lines[hunk!.lines.length - 1]
        if (last) last.nonl = true
        continue
      }
      throw new Error(`Could not parse the diff of ${file!.path}: unexpected line inside a hunk.`)
    }

    if (line.startsWith('diff --git ')) {
      const meta = names[files.length]
      if (!meta) throw new Error('The patch lists more files than git reported; cannot label files reliably.')
      // Quoted headers (unusual characters in the path) are not compared; everything else must match.
      if (!line.includes('"') && !line.endsWith(` b/${meta.path}`)) throw new Error(`The patch and the file list disagree at ${meta.path}; cannot label files reliably.`)
      file = { idx: files.length, path: meta.path, oldPath: meta.oldPath, status: meta.status, binary: false, generated: isGenerated(meta.path), additions: 0, deletions: 0, hunks: [] }
      files.push(file)
      blobs.push('')
      hunk = null
      oldMode = ''
      continue
    }
    if (!file) continue

    const m = HUNK_RE.exec(line)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[3])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      hunk = { id: `f${file.idx}h${file.hunks.length}`, key: '', oldStart: oldNo, oldLines: oldLeft, newStart: newNo, newLines: newLeft, section: m[5] ?? '', additions: 0, deletions: 0, pureMove: false, lines: [] }
      file.hunks.push(hunk)
    } else if (line.startsWith('\\')) {
      const last = hunk?.lines[hunk.lines.length - 1]
      if (last) last.nonl = true
    } else if (hunk) {
      // Between hunks there is nothing but the next hunk or the next file. Anything else means
      // this parser has misread the patch, and guessing could hide a change.
      if (line !== '') throw new Error(`Could not parse the diff of ${file.path}: unexpected text after a hunk.`)
    } else {
      // File header lines, before the first hunk.
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true
      else if (line.startsWith('old mode ')) oldMode = line.slice(9)
      else if (line.startsWith('new mode ')) file.modeChange = `${oldMode || '?'} → ${line.slice(9)}`
      else if (line.startsWith('index ')) blobs[file.idx] = line
    }
  }
  if (oldLeft > 0 || newLeft > 0) throw new Error(`The diff of ${file!.path} ends in the middle of a hunk.`)
  if (files.length !== names.length) throw new Error('The patch lists fewer files than git reported; cannot label files reliably.')

  for (const f of files) {
    // Every changed file gets at least one reviewable unit, so binary files, pure renames and
    // mode changes show up in chapters and in the viewed count instead of slipping past.
    if (!f.hunks.length) f.hunks.push(emptyHunk(f, describeHunkless(f)))
    const seen = new Map<string, number>()
    for (const h of f.hunks) {
      const base = h.note ? hashOf(`${f.path}\n${h.note}\n${blobs[f.idx]}`) : hunkKey(f.path, h.lines)
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      // Identical edits in one file must not share a viewed mark.
      h.key = n ? `${base}-${n}` : base
    }
  }
  return files
}

function hashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * Identity of a hunk by its content: the changed lines and the lines around them, but not
 * their position. A viewed mark survives new commits elsewhere in the file, and is dropped
 * when the same edit turns up in different surroundings, where it may mean something else.
 */
export function hunkKey(path: string, lines: DiffLine[]): string {
  let text = path
  for (const l of lines) text += `\n${l.t}${l.s}${l.nonl ? '\\' : ''}`
  return hashOf(text)
}

// Neither the reviewer's personal git settings nor the repository's own must change what is shown.
const STABLE = ['-c', 'diff.suppressBlankEmpty=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'core.attributesFile=/dev/null']
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/']

/**
 * Global options that make git read attributes from an empty tree instead of the repository.
 * A .gitattributes line such as "*.js -diff" would otherwise turn a source file into
 * "binary file changed" and keep its contents out of the review.
 */
export async function ignoreAttributes(repoDir: string): Promise<string[]> {
  const emptyTree = (await git(repoDir, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
  return [`--attr-source=${emptyTree}`]
}

export async function loadDiff(repoDir: string, baseSha: string, headSha: string): Promise<FileDiff[]> {
  const range = [baseSha, headSha]
  const run = async (attr: string[]) => {
    const [names, patch] = await Promise.all([
      git(repoDir, [...attr, ...STABLE, 'diff', '--name-status', '-z', '-M', ...DIFF_FLAGS, ...range]),
      git(repoDir, [...attr, ...STABLE, 'diff', '-U3', '-M', ...DIFF_FLAGS, ...range]),
    ])
    return parsePatch(patch, parseNameStatus(names))
  }
  const attr = await ignoreAttributes(repoDir)
  try {
    return await run(attr)
  } catch (err) {
    // git older than 2.40 has no --attr-source. The review still works; attributes then apply.
    if (/attr-source/.test((err as Error).message)) return run([])
    throw err
  }
}
