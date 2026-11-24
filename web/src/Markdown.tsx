import { useEffect, useMemo, useRef } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useStore } from './store.ts'

marked.setOptions({ gfm: true, breaks: false })

// Markdown here comes from pull request descriptions and from a model that has read untrusted
// code. Nothing in it may submit a request to this server or load anything from elsewhere:
// a form could post a review as the reader, and a remote image could carry code out in its URL.
const PURIFY = {
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'style', 'svg', 'math', 'link', 'meta', 'base'],
  // No class, id or data attributes either: they could dress text up as part of Trail's own interface.
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'background', 'ping', 'class', 'id'],
  ALLOW_DATA_ATTR: false,
}
const LINKABLE = /^https:\/\/(www\.)?github\.com\//i
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A' || !node.hasAttribute('href')) return
  const href = node.getAttribute('href') ?? ''
  if (LINKABLE.test(href)) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  } else {
    // A link elsewhere could carry text out in its address with one click. The address stays
    // readable on hover and can be copied; it just cannot be followed from here.
    node.removeAttribute('href')
    node.setAttribute('title', href)
    node.setAttribute('class', 'inert-link')
  }
})

const LOCATION = /([\w@.\-/]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?|\b(f\d+h\d+)\b/g

/**
 * Markdown from Claude, sanitised. Mentions of `path:line` and hunk labels become links
 * into the review, so an answer can be followed straight into the code it talks about.
 */
export function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, PURIFY), [text])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const review = useStore.getState().review
    if (!review) return
    const all = review.files.map((f) => f.path)
    // A file cited by name alone still resolves when only one changed file has that name.
    const resolve = (p: string) => {
      if (all.includes(p)) return p
      const matches = all.filter((f) => f.endsWith(`/${p}`))
      return matches.length === 1 ? matches[0] : null
    }
    const hunks = new Set(review.files.flatMap((f) => f.hunks.map((h) => h.id)))
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (!node.parentElement?.closest('a, pre')) nodes.push(node)
    }
    for (const node of nodes) {
      const text = node.data
      LOCATION.lastIndex = 0
      let m: RegExpExecArray | null
      let last = 0
      const frag = document.createDocumentFragment()
      while ((m = LOCATION.exec(text))) {
        const isHunk = !!m[4]
        if (isHunk ? !hunks.has(m[4]) : false) continue
        frag.append(text.slice(last, m.index))
        const a = document.createElement('a')
        a.className = 'loc'
        a.textContent = m[0]
        if (isHunk) a.dataset.hunk = m[4]
        else {
          const changed = resolve(m[1])
          a.dataset.path = changed ?? m[1]
          a.dataset.line = m[2]
          if (m[3]) a.dataset.end = m[3]
          if (changed) a.dataset.changed = '1'
        }
        frag.append(a)
        last = m.index + m[0].length
      }
      if (last === 0) continue
      frag.append(text.slice(last))
      node.replaceWith(frag)
    }
  }, [html])

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a.loc')
    if (!a) return
    e.preventDefault()
    const s = useStore.getState()
    if (a.dataset.hunk) return s.reveal(a.dataset.hunk)
    const line = Number(a.dataset.line)
    // Changed lines are best seen in the diff; anything else opens in the side panel.
    if (a.dataset.changed && !e.altKey && s.revealLine(a.dataset.path!, line)) return
    s.peek({ kind: 'location', path: a.dataset.path!, side: 'new', line, endLine: a.dataset.end ? Number(a.dataset.end) : undefined })
  }

  return <div ref={ref} className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
