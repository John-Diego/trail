import hljs from 'highlight.js/lib/common'
import dart from 'highlight.js/lib/languages/dart'
import elixir from 'highlight.js/lib/languages/elixir'
import scala from 'highlight.js/lib/languages/scala'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import protobuf from 'highlight.js/lib/languages/protobuf'

hljs.registerLanguage('dart', dart)
hljs.registerLanguage('elixir', elixir)
hljs.registerLanguage('scala', scala)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('protobuf', protobuf)

/** A run of text with one highlight class ('' for plain). */
export interface Tok {
  t: string
  c: string
}

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', rb: 'ruby', php: 'php', cs: 'csharp', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  m: 'objectivec', mm: 'objectivec', scala: 'scala', ex: 'elixir', exs: 'elixir', dart: 'dart', lua: 'lua',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  md: 'markdown', html: 'xml', xml: 'xml', vue: 'xml', svelte: 'xml', css: 'css', scss: 'scss', less: 'less',
  graphql: 'graphql', gql: 'graphql', proto: 'protobuf', r: 'r', pl: 'perl', mk: 'makefile',
}

function languageFor(path: string): string | null {
  const base = path.split('/').pop() ?? ''
  if (base === 'Dockerfile') return 'dockerfile'
  if (base === 'Makefile') return 'makefile'
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : ''
  return EXT[ext] ?? null
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" }

/**
 * highlight.js returns nested <span class> HTML for the whole file. Flatten it into
 * per-line tokens so single lines can be rendered, linked and marked independently.
 */
function htmlToLines(html: string): Tok[][] {
  const lines: Tok[][] = [[]]
  const stack: string[] = []
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(m[1])
    else if (m[2] === undefined) stack.pop()
    else {
      const text = m[2].replace(/&(amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e])
      const cls = stack.length ? stack[stack.length - 1] : ''
      const parts = text.split('\n')
      parts.forEach((part, i) => {
        if (i > 0) lines.push([])
        if (part) lines[lines.length - 1].push({ t: part, c: cls })
      })
    }
  }
  return lines
}

export function highlightLines(code: string, path: string): Tok[][] {
  const lang = code.length < 400_000 ? languageFor(path) : null
  if (lang) {
    try {
      return htmlToLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value)
    } catch {
      // Fall through to plain text.
    }
  }
  return code.split('\n').map((l) => (l ? [{ t: l, c: '' }] : []))
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c])
}

const IDENT = /[A-Za-z_$][\w$]*/g
const NO_LINK = /comment|string|regexp|meta|number|doctag/

function emit(text: string, cls: string, known: Set<string> | null): string {
  let body: string
  if (known && known.size && !NO_LINK.test(cls)) {
    body = ''
    let last = 0
    for (const m of text.matchAll(IDENT)) {
      if (!known.has(m[0])) continue
      body += escapeHtml(text.slice(last, m.index)) + `<span class="sym">${escapeHtml(m[0])}</span>`
      last = m.index + m[0].length
    }
    body += escapeHtml(text.slice(last))
  } else {
    body = escapeHtml(text)
  }
  return cls ? `<span class="${cls}">${body}</span>` : body
}

/**
 * HTML for one line. `known` identifiers become navigation links; `mark` is a character
 * range that changed within the line (word-level diff).
 */
export function renderLine(tokens: Tok[], known: Set<string> | null, mark?: [number, number]): string {
  if (!mark) return tokens.map((t) => emit(t.t, t.c, known)).join('')
  const [from, to] = mark
  let pos = 0
  let html = ''
  for (const tok of tokens) {
    const start = pos
    const end = pos + tok.t.length
    pos = end
    if (end <= from || start >= to) {
      html += emit(tok.t, tok.c, known)
      continue
    }
    const a = Math.max(from, start) - start
    const b = Math.min(to, end) - start
    if (a > 0) html += emit(tok.t.slice(0, a), tok.c, known)
    html += `<mark>${emit(tok.t.slice(a, b), tok.c, known)}</mark>`
    if (b < tok.t.length) html += emit(tok.t.slice(b), tok.c, known)
  }
  return html
}

/** The part of two similar lines that differs, as [start, end) on each, or null when they are too different to compare. */
export function intraline(a: string, b: string): { a: [number, number]; b: [number, number] } | null {
  const max = Math.max(a.length, b.length)
  if (!max || a === b) return null
  let p = 0
  const min = Math.min(a.length, b.length)
  while (p < min && a[p] === b[p]) p++
  let s = 0
  while (s < min - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const common = p + s - (a.length - a.trimStart().length)
  if (common < max * 0.35) return null
  return { a: [p, a.length - s], b: [p, b.length - s] }
}
