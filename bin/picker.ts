// An arrow-key list for choosing a pull request in the terminal. The state, the key handling
// and the drawing are pure functions, so they can be tested without a terminal; `pick` at the
// bottom is the only part that touches one.
import type { PrRow } from './list.ts'

export interface PickerState {
  rows: PrRow[]
  /** The reader's GitHub login, for the "waiting for my review" and "mine" scopes. Empty when unknown. */
  me: string
  heading: string
  /** Text typed so far to narrow the list. */
  query: string
  /** Index into scopesFor(state). */
  scope: number
  /** Position of the highlighted row within the narrowed list. */
  cursor: number
  /** First narrowed row drawn, for lists longer than the screen. */
  top: number
}

export type Key = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'enter' | 'escape' | 'tab' | 'backtab' | 'backspace' | 'clear' | 'interrupt' | { text: string }

interface Scope {
  label: string
  test: (row: PrRow) => boolean
}

/**
 * The scopes Tab moves through. Only ones that can be answered are offered: "mine" needs the
 * reader's login, and "waiting for my review" needs rows that say whose review is requested,
 * which GitHub's cross-repository search does not report.
 */
export function scopesFor(state: Pick<PickerState, 'rows' | 'me'>): Scope[] {
  const { me, rows } = state
  const scopes: Scope[] = [{ label: 'All', test: () => true }]
  if (me && rows.some((r) => r.reviewKnown)) scopes.push({ label: 'Waiting for my review', test: (r) => r.reviewers.includes(me) })
  if (me) scopes.push({ label: 'Mine', test: (r) => r.author === me })
  return scopes
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const SEQUENCES: Record<string, Key> = {
  '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
  '\x1b[H': 'home', '\x1b[1~': 'home', '\x1bOH': 'home', '\x1b[F': 'end', '\x1b[4~': 'end', '\x1bOF': 'end',
  '\x1b[Z': 'backtab',
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace', '\x15': 'clear', '\x03': 'interrupt', '\x10': 'up', '\x0e': 'down',
}

/** Whether what has arrived so far stops in the middle of an escape sequence or a paste, so more should be awaited. */
export function incomplete(buffer: string): boolean {
  const paste = buffer.lastIndexOf(PASTE_START)
  if (paste >= 0 && buffer.indexOf(PASTE_END, paste) < 0) return true
  return /\x1b(\[[0-9;?]*)?$/.test(buffer)
}

/** Turn what the terminal sent into keys. One read can hold several keys. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = []
  let text = ''
  const flush = () => {
    if (text) keys.push({ text })
    text = ''
  }
  for (let i = 0; i < chunk.length; ) {
    if (chunk.startsWith(PASTE_START, i)) {
      // Pasted text is only ever text: a newline inside it must not act as Enter and open
      // whatever row happens to match.
      const end = chunk.indexOf(PASTE_END, i)
      const pasted = chunk.slice(i + PASTE_START.length, end < 0 ? undefined : end)
      text += pasted.replace(/[\x00-\x1f\x7f]+/g, ' ')
      i = end < 0 ? chunk.length : end + PASTE_END.length
      continue
    }
    const seq = Object.keys(SEQUENCES).find((s) => chunk.startsWith(s, i))
    if (seq) {
      flush()
      keys.push(SEQUENCES[seq])
      i += seq.length
    } else if (chunk[i] === '\x1b') {
      flush()
      // Escape on its own is the key; escape followed by more is a sequence this list has no use for.
      const rest = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(chunk.slice(i))![0]
      if (rest.length === 1) keys.push('escape')
      i += rest.length
    } else {
      if (chunk[i] >= ' ') text += chunk[i]
      i++
    }
  }
  flush()
  return keys
}

/**
 * Whether a row matches the typed text. Every word must match. A plain word is looked for in
 * the number, title, author, branch, repository and labels. Three prefixes look in one place:
 * author:name (or @name), reviewer:name, label:name.
 */
export function matches(row: PrRow, query: string): boolean {
  const has = (hay: string | string[], needle: string) => [hay].flat().some((h) => h.toLowerCase().includes(needle))
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => {
      const [, key, value] = /^(author|reviewer|label):(.*)$/.exec(word) ?? []
      if (key === 'author') return has(row.author, value)
      if (key === 'reviewer') return has(row.reviewers, value)
      if (key === 'label') return has(row.labels, value)
      if (word.startsWith('@') && word.length > 1) return has(row.author, word.slice(1))
      return has([`#${row.number}`, row.title, row.author, row.branch ?? '', row.repo, ...row.labels], word)
    })
}

/** The rows left after the scope and the typed text. */
export function narrowed(state: PickerState): PrRow[] {
  const scope = scopesFor(state)[state.scope] ?? scopesFor(state)[0]
  return state.rows.filter((r) => scope.test(r) && matches(r, state.query))
}

/** Rows of the screen left for pull requests once the heading and footer are drawn. */
export function pageSize(screenRows: number): number {
  return Math.max(1, screenRows - 6)
}

/** The first row to draw so that the highlighted one is on screen, whatever size the screen is now. */
export function visibleTop(state: PickerState, page: number): number {
  if (state.cursor < state.top) return state.cursor
  if (state.cursor >= state.top + page) return state.cursor - page + 1
  return Math.max(0, state.top)
}

export type Outcome = { state: PickerState } | { pick: PrRow } | { quit: true; interrupted: boolean }

/** What one key does. `page` is how many rows fit on screen. */
export function reduce(state: PickerState, key: Key, page: number): Outcome {
  const count = narrowed(state).length
  const moved = (cursor: number): Outcome => {
    const next = { ...state, cursor: Math.max(0, Math.min(count - 1, cursor)) }
    return { state: { ...next, top: visibleTop(next, page) } }
  }
  const renarrowed = (next: Partial<PickerState>): Outcome => ({ state: { ...state, ...next, cursor: 0, top: 0 } })
  const scopeCount = scopesFor(state).length

  if (typeof key === 'object') return renarrowed({ query: state.query + key.text })
  switch (key) {
    case 'up': return moved(state.cursor - 1)
    case 'down': return moved(state.cursor + 1)
    case 'pageup': return moved(state.cursor - page)
    case 'pagedown': return moved(state.cursor + page)
    case 'home': return moved(0)
    case 'end': return moved(count - 1)
    case 'tab': return renarrowed({ scope: (state.scope + 1) % scopeCount })
    case 'backtab': return renarrowed({ scope: (state.scope + scopeCount - 1) % scopeCount })
    case 'backspace': return renarrowed({ query: state.query.slice(0, -1) })
    case 'clear': return renarrowed({ query: '' })
    // Escape first undoes the typed text; pressed again with nothing typed, it leaves.
    case 'escape': return state.query ? renarrowed({ query: '' }) : { quit: true, interrupted: false }
    case 'interrupt': return { quit: true, interrupted: true }
    case 'enter': {
      const row = narrowed(state)[state.cursor]
      return row ? { pick: row } : { state }
    }
  }
}

const useColor = !process.env.NO_COLOR
const paint = (code: string) => (s: string) => (useColor && s ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = paint('1')
const dim = paint('2')
const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const cyan = paint('36')
const inverse = paint('7')

const graphemes = new Intl.Segmenter()

/** Columns a string takes on screen: colour codes take none, and CJK characters and emoji take two. */
export function width(s: string): number {
  return Bun.stringWidth(s)
}

/** As much of the start of a string as fits in `w` columns, never splitting a character in two. */
function cut(s: string, w: number): string {
  let out = ''
  let used = 0
  for (const { segment } of graphemes.segment(s)) {
    const next = Bun.stringWidth(segment)
    if (used + next > w) break
    out += segment
    used += next
  }
  return out
}

/** A string made exactly `w` columns wide: cut with an ellipsis when too long, padded when too short. */
export function fit(s: string, w: number, align: 'left' | 'right' = 'left'): string {
  if (w <= 0) return ''
  const text = width(s) <= w ? s : w > 1 ? cut(s, w - 1) + '…' : cut(s, w)
  const pad = ' '.repeat(Math.max(0, w - width(text)))
  return align === 'right' ? pad + text : text + pad
}

export function age(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (!Number.isFinite(min)) return ''
  if (min < 60) return `${min}m`
  if (min < 60 * 24) return `${Math.round(min / 60)}h`
  if (min < 60 * 24 * 14) return `${Math.round(min / 1440)}d`
  if (min < 60 * 24 * 70) return `${Math.round(min / 10080)}w`
  return `${Math.round(min / 43800)}mo`
}

/**
 * The one thing most worth knowing about a pull request's review state, in words. Nothing is
 * said about reviews when GitHub did not report them for this row: silence there must not
 * read as "no review needed".
 */
export function status(row: PrRow, me: string): string {
  const parts: string[] = []
  if (row.state !== 'open') parts.push(row.state)
  else if (row.draft) parts.push('draft')
  else if (row.decision) parts.push(row.decision)
  else if (me && row.reviewers.includes(me)) parts.push('your review requested')
  else if (row.reviewers.length) parts.push(`review: ${row.reviewers.join(', ')}`)
  if (row.inTrail) parts.push(`in Trail ${row.inTrail}`)
  return parts.join(' · ')
}

function colourStatus(text: string): string {
  const t = text.trimStart()
  if (t.startsWith('your review requested')) return yellow(text)
  if (t.startsWith('approved')) return green(text)
  if (t.startsWith('changes requested')) return red(text)
  return dim(text)
}

export interface Layout {
  showRepo: boolean
  idW: number
  titleW: number
  authorW: number
  sizeW: number
  statusW: number
}

const longest = (texts: string[], cap: number) => Math.min(cap, Math.max(0, ...texts.map(width)))

/**
 * Column widths for this list on a screen this wide. Each column is as wide as its longest
 * entry needs, up to a cap; the title takes everything left. On a narrow screen the status,
 * then the size, give way so the title stays readable.
 */
export function layout(state: PickerState, cols: number): Layout {
  const showRepo = new Set(state.rows.map((r) => r.repo)).size > 1
  const idW = longest(state.rows.map((r) => (showRepo ? `${r.repo}#${r.number}` : `#${r.number}`)), 40)
  const authorW = longest(state.rows.map((r) => r.author), 16)
  let sizeW = longest(state.rows.map((r) => (r.additions === undefined ? '' : `+${r.additions} −${r.deletions}`)), 14)
  let statusW = longest(state.rows.map((r) => status(r, state.me)), 40)
  const titleFor = () => cols - (2 + idW + 2 + 2 + authorW + (sizeW ? 2 + sizeW : 0) + 2 + 4 + (statusW ? 2 + statusW : 0))
  const MIN_TITLE = 28
  if (titleFor() < MIN_TITLE) statusW = Math.max(0, Math.min(statusW, statusW - (MIN_TITLE - titleFor())))
  if (statusW < 6) statusW = 0
  if (titleFor() < MIN_TITLE) sizeW = 0
  return { showRepo, idW, titleW: Math.max(8, titleFor()), authorW, sizeW, statusW }
}

/** One pull request as a line exactly `cols` wide. */
export function line(row: PrRow, state: PickerState, cols: number, selected: boolean, widths: Layout = layout(state, cols), now = Date.now()): string {
  const plainText = (s: string) => s
  const { showRepo, idW, titleW, authorW, sizeW, statusW } = widths
  const id = showRepo ? `${row.repo}#${row.number}` : `#${row.number}`
  const faded = row.draft || row.state !== 'open'
  // Each cell is cut to its width first and coloured second, so colour never changes the layout.
  const cells: [text: string, colour: (s: string) => string][] = [
    [selected ? '▸ ' : '  ', plainText],
    [fit(id, idW, showRepo ? 'left' : 'right'), cyan],
    ['  ' + fit(row.title, titleW), faded ? dim : plainText],
    ['  ' + fit(row.author, authorW), dim],
  ]
  if (sizeW) {
    const size = row.additions === undefined ? '' : `+${row.additions} −${row.deletions}`
    cells.push(['  ' + fit(size, sizeW, 'right'), (s) => s.replace(/\+\d+/, (m) => green(m)).replace(/−\d+/, (m) => red(m))])
  }
  cells.push(['  ' + fit(age(row.updatedAt, now), 4, 'right'), dim])
  if (statusW) cells.push(['  ' + fit(status(row, state.me), statusW), colourStatus])
  const plain = fit(cells.map(([text]) => text).join(''), cols)
  return selected ? inverse(plain) : fit(cells.map(([text, colour]) => colour(text)).join(''), cols)
}

/** The whole screen as text: heading, scope and filter line, the visible rows, and the key hints. */
export function render(state: PickerState, cols: number, screenRows: number, now = Date.now()): string {
  const list = narrowed(state)
  const page = pageSize(screenRows)
  // Worked out again here, so that a screen that has just shrunk still shows the highlighted row.
  const top = visibleTop(state, page)
  const widths = layout(state, cols)
  const lines: string[] = []

  lines.push(bold(fit(`Trail · ${state.heading}`, cols)))
  const scopes = scopesFor(state)
    .map((s, i) => {
      const n = state.rows.filter((r) => s.test(r) && matches(r, state.query)).length
      const label = ` ${s.label} ${n} `
      return i === state.scope ? inverse(label) : dim(label)
    })
    .join(' ')
  const filter = state.query ? `Filter: ${state.query}▏` : dim('Type to filter')
  lines.push(fit(scopes + ' '.repeat(Math.max(2, cols - width(scopes) - width(filter))) + filter, cols))
  lines.push('')

  if (!list.length) lines.push(dim(fit(state.rows.length ? '  Nothing matches. Press esc to clear the filter, or tab to change scope.' : '  No pull requests.', cols)))
  for (let i = top; i < Math.min(list.length, top + page); i++) lines.push(line(list[i], state, cols, i === state.cursor, widths, now))
  while (lines.length < 3 + page) lines.push('')

  lines.push(dim(fit(list.length ? `${state.cursor + 1} of ${list.length}` : '', cols, 'right')))
  lines.push(dim(fit(cols >= 88 ? '↑↓ move · enter open · type to filter (author: reviewer: label:) · tab scope · esc quit' : '↑↓ move · enter open · type to filter · tab scope · esc quit', cols)))
  return lines.join('\n')
}

export interface Choice {
  row: PrRow | null
  /** The reader pressed Ctrl-C, as opposed to leaving with Esc. */
  interrupted: boolean
}

/**
 * Show the list and wait for a choice. Uses the terminal's alternate screen, so the
 * scrollback is untouched, and puts the terminal back however this ends: a choice, Esc,
 * Ctrl-C, an error, the input closing, or the process being told to stop.
 */
export function pick(rows: PrRow[], me: string, heading: string): Promise<Choice> {
  const { stdin, stdout } = process
  let state: PickerState = { rows, me, heading, query: '', scope: 0, cursor: 0, top: 0 }
  const size = () => ({ cols: stdout.columns || 100, rows: stdout.rows || 30 })
  const draw = () => stdout.write(`\x1b[H\x1b[J${render(state, size().cols, size().rows)}`)

  return new Promise((resolve, reject) => {
    let buffer = ''
    let waiting: ReturnType<typeof setTimeout> | undefined
    let restored = false

    const restore = () => {
      if (restored) return
      restored = true
      clearTimeout(waiting)
      stdin.off('data', onData).off('end', onEnd).off('error', onEnd)
      stdout.off('resize', onResize)
      process.off('exit', restore).off('SIGTERM', onSignal).off('SIGHUP', onSignal)
      if (stdin.isTTY) stdin.setRawMode(false)
      stdin.pause()
      // Stop bracketed paste, show the cursor, leave the alternate screen.
      stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l')
    }
    const finish = (choice: Choice) => {
      restore()
      resolve(choice)
    }
    const fail = (err: unknown) => {
      restore()
      reject(err)
    }
    const onSignal = (signal: NodeJS.Signals) => {
      restore()
      process.exit(signal === 'SIGHUP' ? 129 : 143)
    }
    const onEnd = () => finish({ row: null, interrupted: false })
    const onResize = () => {
      try {
        draw()
      } catch (err) {
        fail(err)
      }
    }
    const handle = () => {
      const input = buffer
      buffer = ''
      try {
        for (const key of parseKeys(input)) {
          const outcome = reduce(state, key, pageSize(size().rows))
          if ('quit' in outcome) return finish({ row: null, interrupted: outcome.interrupted })
          if ('pick' in outcome) return finish({ row: outcome.pick, interrupted: false })
          state = outcome.state
        }
        draw()
      } catch (err) {
        fail(err)
      }
    }
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      clearTimeout(waiting)
      // An arrow key is several bytes and can arrive in two reads on a slow link. Its first
      // byte alone is the Escape key, so wait a moment before taking it for one.
      if (incomplete(buffer)) waiting = setTimeout(handle, buffer.includes(PASTE_START) ? 500 : 40)
      else handle()
    }

    try {
      process.once('exit', restore).once('SIGTERM', onSignal).once('SIGHUP', onSignal)
      // Alternate screen, hidden cursor, and bracketed paste so that pasted text arrives marked as such.
      stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h')
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on('data', onData).once('end', onEnd).once('error', onEnd)
      stdout.on('resize', onResize)
      draw()
    } catch (err) {
      fail(err)
    }
  })
}
