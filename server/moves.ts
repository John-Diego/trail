import type { DiffLine, FileDiff, Move } from '../shared/types.ts'

interface Entry {
  file: number
  line: DiffLine
  /** Old line number for removed entries, new line number for added ones. */
  no: number
  /** The line without its indentation, otherwise exactly as written, trailing whitespace included. */
  text: string
  /** The leading whitespace, exactly as written. */
  indent: string
  /** The file's language gives indentation meaning, so it must match exactly. */
  sensitive: boolean
  /** Enough content to identify the line; braces and blank lines are not. */
  strong: boolean
  taken: boolean
}

const MAX_CANDIDATES = 40
const MIN_STRONG_LINES = 3

// Where moving a line to another indentation level can change what the program does.
const INDENT_SENSITIVE = /\.(py|pyi|pyw|pyx|ya?ml|haml|pug|jade|coffee|nim|sass|styl|fs|fsx|hs|elm|md|mdx|markdown|rst|bzl|star|gd)$|(^|\/)(Makefile|BUILD|BUILD\.bazel|WORKSPACE|[^/]*\.mk)$/i

function isStrong(text: string): boolean {
  return text.trim().length >= 8 && (text.match(/[A-Za-z0-9_]/g)?.length ?? 0) >= 6
}

function collect(files: FileDiff[], type: '+' | '-'): Entry[] {
  const out: Entry[] = []
  for (const f of files) {
    if (f.binary || f.generated) continue
    const sensitive = INDENT_SENSITIVE.test(f.path) || INDENT_SENSITIVE.test(f.oldPath)
    for (const h of f.hunks) {
      for (const line of h.lines) {
        if (line.t !== type) continue
        const indent = /^[ \t]*/.exec(line.s)![0]
        const text = line.s.slice(indent.length)
        out.push({ file: f.idx, line, no: (type === '+' ? line.n : line.o)!, text, indent, sensitive, strong: isStrong(text), taken: false })
      }
    }
  }
  return out
}

function adjacent(a: Entry, b: Entry): boolean {
  return a.file === b.file && b.no === a.no + 1
}

/**
 * Whether an added line continues a move that started with the given indentation shift.
 * In indentation-sensitive files the indentation must be identical; elsewhere a block that
 * moved to another file may shift by one constant amount (a method lifted out of a class).
 */
function fits(added: Entry, removed: Entry, shift: number): boolean {
  if (added.text !== removed.text) return false
  if (added.text === '') return added.indent === removed.indent || !(added.sensitive || removed.sensitive)
  if (shift === 0 || added.sensitive || removed.sensitive) return added.indent === removed.indent
  // Deeper or shallower by the same amount, written with the same characters: a tab swapped
  // for spaces is an edit, not a shift.
  const [shorter, longer] = shift > 0 ? [removed.indent, added.indent] : [added.indent, removed.indent]
  return longer.length - shorter.length === Math.abs(shift) && longer.startsWith(shorter)
}

/**
 * Find blocks of removed lines that reappear as added lines, in the same file or another.
 * Marks the lines with a move id and returns the moves.
 *
 * A line only counts as moved when its text is byte-for-byte identical after the indentation,
 * and the indentation rule above holds. A moved method whose body was also edited shows the edited
 * lines as ordinary additions and deletions, which is what a reviewer needs to see.
 */
export function detectMoves(files: FileDiff[]): Move[] {
  const removed = collect(files, '-')
  const added = collect(files, '+')
  if (!removed.length || !added.length) return finish(files, [])

  const index = new Map<string, number[]>()
  removed.forEach((e, i) => {
    if (!e.strong) return
    const list = index.get(e.text)
    if (list) list.push(i)
    else index.set(e.text, [i])
  })

  const moves: Move[] = []
  let i = 0
  while (i < added.length) {
    const start = added[i]
    const candidates = start.strong && !start.taken ? index.get(start.text) : undefined
    if (!candidates || candidates.length > MAX_CANDIDATES) {
      i++
      continue
    }
    let bestLen = 0
    let bestJ = -1
    let bestStrong = 0
    let bestShift = 0
    for (const j of candidates) {
      if (removed[j].taken) continue
      const shift = start.indent.length - removed[j].indent.length
      // Code that stays in its file but changes depth has usually gained or lost an enclosing
      // block (an if, a loop, a try). That changes behaviour, so it is shown as an edit.
      if (shift !== 0 && removed[j].file === start.file) continue
      let len = 0
      let strong = 0
      while (
        i + len < added.length &&
        j + len < removed.length &&
        !added[i + len].taken &&
        !removed[j + len].taken &&
        fits(added[i + len], removed[j + len], shift) &&
        (len === 0 || (adjacent(added[i + len - 1], added[i + len]) && adjacent(removed[j + len - 1], removed[j + len])))
      ) {
        if (added[i + len].strong) strong++
        len++
      }
      if (strong > bestStrong || (strong === bestStrong && len > bestLen)) {
        bestLen = len
        bestJ = j
        bestStrong = strong
        bestShift = shift
      }
    }
    if (bestJ < 0 || bestStrong < MIN_STRONG_LINES) {
      i++
      continue
    }
    // Trailing blank lines are not evidence of a move; leave them out of the block.
    while (bestLen > 0 && added[i + bestLen - 1].text.trim() === '') bestLen--
    const id = moves.length + 1
    for (let k = 0; k < bestLen; k++) {
      added[i + k].taken = true
      added[i + k].line.mv = id
      removed[bestJ + k].taken = true
      removed[bestJ + k].line.mv = id
    }
    const fromFile = files[removed[bestJ].file]
    const toFile = files[added[i].file]
    moves.push({
      id,
      from: { file: fromFile.idx, path: fromFile.oldPath, start: removed[bestJ].no, end: removed[bestJ + bestLen - 1].no },
      to: { file: toFile.idx, path: toFile.path, start: added[i].no, end: added[i + bestLen - 1].no },
      lines: bestLen,
      reindented: bestShift !== 0,
    })
    i += bestLen
  }
  return finish(files, moves)
}

function finish(files: FileDiff[], moves: Move[]): Move[] {
  for (const f of files) {
    for (const h of f.hunks) {
      const changed = h.lines.filter((l) => l.t !== ' ')
      // Blank lines next to a moved block are not flagged themselves but do not make it an edit.
      h.pureMove = changed.length > 0 && changed.some((l) => l.mv) && changed.every((l) => l.mv || l.s.trim() === '')
    }
  }
  return moves
}
