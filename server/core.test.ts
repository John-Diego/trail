import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { parseNameStatus, parsePatch } from './diff.ts'
import { detectMoves } from './moves.ts'
import { extractDefs } from './symbols.ts'
import { reconcile } from './walkthrough.ts'

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,9 +1,4 @@ header
 keep one
-  helper(input: string) {
-    const trimmed = input.trim()
-    const lowered = trimmed.toLowerCase()
-    return lowered.replace(/x/g, 'y')
-  }
 keep two
--- a line that starts with dashes
+++ a line that starts with pluses
 keep three
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,6 @@
+export function helper(input: string) {
+  const trimmed = input.trim()
+  const lowered = trimmed.toLowerCase()
+  return lowered.replace(/x/g, 'y')
+}
+export const other = 1
`

const names = [
  { status: 'modified' as const, path: 'src/a.ts', oldPath: 'src/a.ts' },
  { status: 'added' as const, path: 'src/b.ts', oldPath: 'src/b.ts' },
]

test('parses files, hunks and line numbers', () => {
  const files = parsePatch(PATCH, names)
  assert.equal(files.length, 2)
  const [a, b] = files
  assert.equal(a.hunks.length, 1)
  assert.equal(a.hunks[0].section, 'header')
  assert.equal(a.additions, 1)
  assert.equal(a.deletions, 6)
  // Content lines that look like file headers stay inside the hunk.
  assert.deepEqual(a.hunks[0].lines.filter((l) => l.s.includes('starts with')).map((l) => l.t), ['-', '+'])
  assert.deepEqual(a.hunks[0].lines.at(-1), { t: ' ', o: 9, n: 4, s: 'keep three' })
  assert.equal(b.status, 'added')
  assert.equal(b.hunks[0].lines[0].n, 1)
  assert.equal(b.hunks[0].id, 'f1h0')
})

test('hunk keys depend on content, not position', () => {
  const first = parsePatch(PATCH, names)
  const shifted = parsePatch(PATCH.replace('@@ -1,9 +1,4 @@', '@@ -41,9 +41,4 @@'), names)
  assert.equal(first[0].hunks[0].key, shifted[0].hunks[0].key)
  assert.notEqual(first[0].hunks[0].key, first[1].hunks[0].key)
})

test('finds a block moved to another file at a new indentation level', () => {
  const files = parsePatch(PATCH, names)
  const moves = detectMoves(files)
  assert.equal(moves.length, 1)
  // The signature line changed (export added), so the move is the three body lines and the brace.
  assert.deepEqual(moves[0].from, { file: 0, path: 'src/a.ts', start: 3, end: 6 })
  assert.deepEqual(moves[0].to, { file: 1, path: 'src/b.ts', start: 2, end: 5 })
  assert.equal(files[1].hunks[0].pureMove, false)
  assert.equal(files[1].hunks[0].lines[0].mv, undefined)
  assert.equal(files[1].hunks[0].lines[1].mv, 1)
  assert.equal(moves[0].reindented, true)
})

test('does not call short or generic runs a move', () => {
  const patch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,4 +1,4 @@
-  }
-}
-return value
+return value
+  }
+}
 end
`
  const files = parsePatch(patch, [{ status: 'modified', path: 'x.ts', oldPath: 'x.ts' }])
  assert.equal(detectMoves(files).length, 0)
})

test('extracts definitions across languages', () => {
  const name = (line: string) => extractDefs(line).map((d) => d.name)
  assert.deepEqual(name('export async function loadDiff(repo: string) {'), ['loadDiff'])
  assert.deepEqual(name('export const useStore = create<State>((set, get) => ({'), ['useStore'])
  assert.deepEqual(name('  private computeTax(subtotal: number): number {'), ['computeTax'])
  assert.deepEqual(name('def parse_patch(self, text):'), ['parse_patch'])
  assert.deepEqual(name('func (s *Server) HandleImport(w http.ResponseWriter, r *http.Request) {'), ['HandleImport'])
  assert.deepEqual(name('pub fn detect_moves(files: &[File]) -> Vec<Move> {'), ['detect_moves'])
  assert.deepEqual(name('export interface OrderLine {'), ['OrderLine'])
  assert.deepEqual(name('class OrderService(BaseService):'), ['OrderService'])
  assert.deepEqual(name('  def self.find_by_sku(sku)'), ['find_by_sku'])
  assert.deepEqual(name('MAX_RETRIES = 3'), ['MAX_RETRIES'])
  assert.deepEqual(name('#define BUFFER_SIZE 4096'), ['BUFFER_SIZE'])
})

test('does not mistake calls and control flow for definitions', () => {
  const name = (line: string) => extractDefs(line).map((d) => d.name)
  assert.deepEqual(name("  it('works', async () => {"), [])
  assert.deepEqual(name('  if (order.total > 0) {'), [])
  assert.deepEqual(name('  } else if (x) {'), [])
  assert.deepEqual(name('  for (const line of lines) {'), [])
  assert.deepEqual(name('  // function oldName() {'), [])
  assert.deepEqual(name('    return compute(a, b)'), [])
})

test('walkthrough reconciliation never loses a hunk', () => {
  const files = parsePatch(PATCH, names)
  const chapter = { title: 'One', narrative: '', focus: '', risk: 'low' as const }
  const { chapters, concerns } = reconcile(
    files,
    [{ ...chapter, hunks: ['f1h0', 'f9h9', 'f1h0'] }, { ...chapter, title: 'Empty', hunks: ['nope'] }],
    [{ hunk: 'f0h0', severity: 'warn', note: 'kept' }, { hunk: 'f7h7', severity: 'bug', note: 'dropped' }],
  )
  assert.deepEqual(chapters.map((c) => c.hunks), [['f1h0'], ['f0h0']])
  assert.equal(chapters[1].leftover, true)
  assert.deepEqual(concerns.map((c) => c.note), ['kept'])
})

function patchOf(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`
}
const modified = (path: string) => [{ status: 'modified' as const, path, oldPath: path }]

test('re-indented Python is an edit, never a move', () => {
  // Three calls leave the loop body: same text, different meaning.
  const body = `@@ -1,5 +1,5 @@
 for item in items:
-    validate_order(item)
-    record_metric(item)
-    notify_listeners(item)
+validate_order(item)
+record_metric(item)
+notify_listeners(item)
 done()
`
  const files = parsePatch(patchOf('jobs.py', body), modified('jobs.py'))
  assert.equal(detectMoves(files).length, 0)
  assert.equal(files[0].hunks[0].pureMove, false)
})

test('a block whose lines shift by different amounts is not a move', () => {
  const body = `@@ -1,5 +1,5 @@
 start
-  const firstValue = computeFirst()
-  const secondValue = computeSecond()
-  const thirdValue = computeThird()
+  const firstValue = computeFirst()
+      const secondValue = computeSecond()
+  const thirdValue = computeThird()
 end
`
  const files = parsePatch(patchOf('a.ts', body), modified('a.ts'))
  assert.equal(detectMoves(files).length, 0)
})

test('inner whitespace changes are edits', () => {
  const body = `@@ -1,4 +1,4 @@
-const message = "total:  " + total
-const second = buildSecondThing(a, b)
-const third = buildThirdThing(a, b)
+const message = "total: " + total
+const second = buildSecondThing(a, b)
+const third = buildThirdThing(a, b)
 end
`
  const files = parsePatch(patchOf('a.ts', body), modified('a.ts'))
  assert.equal(detectMoves(files).length, 0)
})

test('identical edits in one file get distinct keys', () => {
  const body = `@@ -1,2 +1,3 @@
 a
+  log.debug(value)
 b
@@ -10,2 +11,3 @@
 c
+  log.debug(value)
 d
`
  const [file] = parsePatch(patchOf('a.ts', body), modified('a.ts'))
  assert.equal(file.hunks.length, 2)
  assert.notEqual(file.hunks[0].key, file.hunks[1].key)
})

test('files without a text diff still get a reviewable hunk', () => {
  const patch = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
`
  const files = parsePatch(patch, [
    { status: 'modified', path: 'logo.png', oldPath: 'logo.png' },
    { status: 'modified', path: 'run.sh', oldPath: 'run.sh' },
    { status: 'renamed', path: 'new/name.ts', oldPath: 'old/name.ts' },
  ])
  assert.deepEqual(files.map((f) => f.hunks.length), [1, 1, 1])
  assert.match(files[0].hunks[0].note!, /Binary file changed/)
  assert.match(files[1].hunks[0].note!, /100644 → 100755/)
  assert.match(files[2].hunks[0].note!, /Renamed from old\/name\.ts/)
  assert.equal(new Set(files.map((f) => f.hunks[0].key)).size, 3)
  // And the walkthrough cannot lose them.
  const { chapters } = reconcile(files, [], [])
  assert.deepEqual(chapters.flatMap((c) => c.hunks).sort(), ['f0h0', 'f1h0', 'f2h0'])
})

test('a type change is two patch blocks for one reported file', () => {
  const names = parseNameStatus('T\0link\0M\0z.txt\0')
  assert.deepEqual(names.map((n) => `${n.status}:${n.path}`), ['deleted:link', 'added:link', 'modified:z.txt'])
  const patch = `diff --git a/link b/link
deleted file mode 100644
index 1111111..0000000
--- a/link
+++ /dev/null
@@ -1 +0,0 @@
-content
diff --git a/link b/link
new file mode 120000
index 0000000..2222222
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+target
\\ No newline at end of file
diff --git a/z.txt b/z.txt
--- a/z.txt
+++ b/z.txt
@@ -1 +1 @@
-old
+new
`
  const files = parsePatch(patch, names)
  assert.deepEqual(files.map((f) => f.path), ['link', 'link', 'z.txt'])
  assert.equal(files[1].hunks[0].lines[0].nonl, true)
  assert.deepEqual(files[2].hunks[0].lines.map((l) => l.t + l.s), ['-old', '+new'])
})

test('a patch that disagrees with the file list is refused, not mislabelled', () => {
  const patch = patchOf('other.ts', '@@ -1 +1 @@\n-a\n+b\n')
  assert.throws(() => parsePatch(patch, modified('expected.ts')), /disagree/)
  assert.throws(() => parsePatch(patchOf('a.ts', '@@ -1 +1 @@\n-a\n+b\n'), [...modified('a.ts'), ...modified('b.ts')]), /fewer files/)
})

test('blank context lines without a leading space keep line numbers right', () => {
  const body = `@@ -1,4 +1,4 @@
 one

-three
+THREE
 four
`
  const [file] = parsePatch(patchOf('a.txt', body), modified('a.txt'))
  assert.deepEqual(file.hunks[0].lines.map((l) => [l.t, l.o ?? 0, l.n ?? 0]), [[' ', 1, 1], [' ', 2, 2], ['-', 3, 0], ['+', 0, 3], [' ', 4, 4]])
})

test('hand-written code in build or out folders is not treated as generated', () => {
  const paths = ['src/build/compile.ts', 'tools/out/x.go', 'packages/dist/index.ts', 'vendor/lib.go']
  const files = parsePatch(paths.map((p) => patchOf(p, '@@ -1 +1 @@\n-a\n+b\n')).join(''), paths.flatMap(modified))
  assert.deepEqual(files.map((f) => f.generated), [false, false, false, false])
  const lock = parsePatch(patchOf('web/package-lock.json', '@@ -1 +1 @@\n-a\n+b\n'), modified('web/package-lock.json'))
  assert.equal(lock[0].generated, true)
})

test('the same edit in different surroundings is a different hunk', () => {
  const guarded = `@@ -1,3 +1,4 @@
 if (isTestEnv) {
+  dropAllTables()
 }
 done()
`
  const unguarded = `@@ -1,3 +1,4 @@
 function startServer() {
+  dropAllTables()
 }
 done()
`
  const a = parsePatch(patchOf('a.ts', guarded), modified('a.ts'))[0].hunks[0].key
  const b = parsePatch(patchOf('a.ts', unguarded), modified('a.ts'))[0].hunks[0].key
  assert.notEqual(a, b)
  // Position alone does not matter.
  const moved = parsePatch(patchOf('a.ts', guarded.replace('@@ -1,3 +1,4 @@', '@@ -51,3 +51,4 @@')), modified('a.ts'))[0].hunks[0].key
  assert.equal(a, moved)
})

test('a hunk header with unusual characters in its section text still parses', () => {
  for (const odd of ['a\rb', 'x\u2028y', 'x\u2029y']) {
    const body = `@@ -1,2 +1,2 @@ function ${odd}() {
-  return 1
+  return evil()
 }
`
    const [file] = parsePatch(patchOf('a.js', body), modified('a.js'))
    assert.equal(file.additions, 1, JSON.stringify(odd))
    assert.equal(file.hunks[0].note, undefined)
  }
})

test('text the parser does not understand is an error, not a silently dropped change', () => {
  const body = `@@ -1 +1 @@
-a
+b
this line should not be here
`
  assert.throws(() => parsePatch(patchOf('a.ts', body), modified('a.ts')), /unexpected text/)
})

test('removing an enclosing block is an edit, not a move', () => {
  const body = `@@ -1,7 +1,5 @@
 start()
-if (confirmed) {
-  deleteAllUsers(account)
-  deleteAllSessions(account)
-  deleteAllBackups(account)
-}
+deleteAllUsers(account)
+deleteAllSessions(account)
+deleteAllBackups(account)
 end()
`
  const files = parsePatch(patchOf('a.js', body), modified('a.js'))
  assert.equal(detectMoves(files).length, 0)
  assert.equal(files[0].hunks[0].lines.some((l) => l.mv), false)
})

test('trailing whitespace and tab-for-space changes are edits', () => {
  const trailing = `@@ -1,4 +1,4 @@
-const first = computeFirst()
-const second = computeSecond()
-const third = computeThird()
+const first = computeFirst()  
+const second = computeSecond()  
+const third = computeThird()  
 end
`
  assert.equal(detectMoves(parsePatch(patchOf('a.ts', trailing), modified('a.ts'))).length, 0)
  const tabs = `@@ -1,4 +1,4 @@
-\tconst first = computeFirst()
-\tconst second = computeSecond()
-\tconst third = computeThird()
+ const first = computeFirst()
+ const second = computeSecond()
+ const third = computeThird()
 end
`
  assert.equal(detectMoves(parsePatch(patchOf('a.ts', tabs), modified('a.ts'))).length, 0)
})

test('a block relocated within one file at the same depth is still a move', () => {
  const body = `@@ -1,5 +1,2 @@
 top()
-function helperOne() { return computeOne() }
-function helperTwo() { return computeTwo() }
-function helperThree() { return computeThree() }
 middle()
@@ -20,2 +17,5 @@
 bottom()
+function helperOne() { return computeOne() }
+function helperTwo() { return computeTwo() }
+function helperThree() { return computeThree() }
 end()
`
  const files = parsePatch(patchOf('a.ts', body), modified('a.ts'))
  const moves = detectMoves(files)
  assert.equal(moves.length, 1)
  assert.equal(moves[0].reindented, false)
  assert.equal(files[0].hunks.every((h) => h.pureMove), true)
})
