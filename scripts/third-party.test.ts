import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bundledPackages, packageFolder, readPackage, render } from './third-party.ts'

/** A package folder with the given files, under `root/node_modules` (or wherever `at` says). */
function fakePackage(root: string, at: string, pkg: { name: string; version: string; license?: string }, files: Record<string, string> = {}): string {
  const folder = path.join(root, at)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify(pkg))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), text)
  return folder
}

function withTempRoot(run: (root: string) => void): void {
  // Resolved, because a bundler reports real paths and the temporary folder may be reached through a link.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trail-licences-')))
  try {
    run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('a bundled file is traced to the package it belongs to', () => {
  assert.equal(packageFolder('node_modules/string-width/index.js'), 'node_modules/string-width')
  assert.equal(packageFolder('/work/trail/node_modules/react-dom/cjs/react-dom-client.production.js'), '/work/trail/node_modules/react-dom')
  assert.equal(packageFolder('/work/node_modules/@scope/pkg/dist/a.js'), '/work/node_modules/@scope/pkg')
  // A dependency nested inside another, pnpm's layout, Windows separators, a query added by the bundler.
  assert.equal(packageFolder('/work/node_modules/a/node_modules/b/b.js'), '/work/node_modules/a/node_modules/b')
  assert.equal(packageFolder('/work/node_modules/.pnpm/b@1.0.0/node_modules/b/b.js'), '/work/node_modules/.pnpm/b@1.0.0/node_modules/b')
  assert.equal(packageFolder('C:\\work\\node_modules\\b\\lib\\b.js'), 'C:/work/node_modules/b')
  assert.equal(packageFolder('/work/node_modules/b/b.js?commonjs-proxy'), '/work/node_modules/b')
})

test('files outside node_modules, and files a bundler made up, belong to no package', () => {
  assert.equal(packageFolder('server/index.ts'), null)
  assert.equal(packageFolder('/work/trail/web/src/App.tsx'), null)
  assert.equal(packageFolder('\0vite/modulepreload-polyfill.js'), null)
  assert.equal(packageFolder('\0/work/node_modules/b/b.js?commonjs-proxy'), null)
})

test('every licence and notice file of a package is taken, and a package without one is refused', () => {
  withTempRoot((root) => {
    const dual = fakePackage(root, 'node_modules/dual', { name: 'dual', version: '1.2.3', license: '(MPL-2.0 OR Apache-2.0)' }, {
      LICENSE: 'Apache text\n',
      'LICENSE-MPL': 'MPL text\n',
      'NOTICE.txt': 'Copyright someone\n',
      // Neither of these is a licence: one is code, the other only shares the first letters.
      'license-check.js': '// code',
      'licensing.md': 'not a licence',
    })
    // Named like a licence, but a folder.
    fs.mkdirSync(path.join(dual, 'COPYING'))

    const found = readPackage(dual)
    assert.deepEqual([found.name, found.version, found.licence], ['dual', '1.2.3', '(MPL-2.0 OR Apache-2.0)'])
    assert.deepEqual(found.texts, [['LICENSE', 'Apache text'], ['LICENSE-MPL', 'MPL text'], ['NOTICE.txt', 'Copyright someone']])

    const bare = fakePackage(root, 'node_modules/bare', { name: 'bare', version: '0.1.0', license: 'MIT' })
    assert.throws(() => readPackage(bare), /bare@0\.1\.0 is bundled into dist\/ but has no licence file/)
  })
})

test("the two bundlers' lists become one list of packages, each once", () => {
  withTempRoot((root) => {
    fakePackage(root, 'node_modules/web-only', { name: 'web-only', version: '1.0.0', license: 'MIT' }, { LICENSE: 'web-only text' })
    fakePackage(root, 'node_modules/node-only', { name: 'node-only', version: '2.0.0', license: 'ISC' }, { license: 'node-only text' })
    fakePackage(root, 'node_modules/both', { name: 'both', version: '3.0.0', license: 'MIT' }, { LICENSE: 'both text' })
    // The same package again at another version, nested inside a dependency.
    fakePackage(root, 'node_modules/web-only/node_modules/both', { name: 'both', version: '4.0.0', license: 'MIT' }, { LICENSE: 'both 4 text' })

    const fromVite = ['\0rolldown/runtime.js', `${root}/web/src/main.tsx`, `${root}/web/index.html`, `${root}/shared/types.ts`, `${root}/node_modules/web-only/index.js`, `${root}/node_modules/web-only/other.js?v=1`, `${root}/node_modules/both/a.js`, `${root}/node_modules/web-only/node_modules/both/b.js`]
    // esbuild names its files from Trail's folder.
    const fromEsbuild = ['bin/main.ts', 'server/index.ts', 'shared/types.ts', 'node_modules/node-only/index.js', 'node_modules/both/a.js']

    const found = bundledPackages([...fromVite, ...fromEsbuild], root).map((p) => `${p.name}@${p.version}`)
    assert.deepEqual(found.sort(), ['both@3.0.0', 'both@4.0.0', 'node-only@2.0.0', 'web-only@1.0.0'])
  })
})

test('a bundled file that is neither in node_modules nor part of Trail stops the build', () => {
  withTempRoot((root) => {
    // A linked or workspace package: the bundler reports where it really lives.
    assert.throws(() => bundledPackages([path.join(path.dirname(root), 'linked-package', 'index.js')], root), /neither inside node_modules nor in one of Trail's own folders/)
    // A copy vendored into the repository.
    assert.throws(() => bundledPackages(['vendor/lib/index.js'], root), /neither inside node_modules nor in one of Trail's own folders/)
    assert.deepEqual(bundledPackages(['bin/main.ts', `${root}/web/src/App.tsx`, 'server/index.ts', 'shared/text.ts'], root), [])
  })
})

test('the written file lists the packages in order, each followed by its full texts', () => {
  const text = render([
    { name: 'zeta', version: '2.0.0', licence: 'MIT', texts: [['LICENSE', 'Zeta licence text']] },
    { name: 'alpha', version: '1.0.0', licence: 'BSD-3-Clause', texts: [['LICENSE', 'Alpha licence text'], ['NOTICE', 'Alpha notice']] },
  ])
  assert.match(text, /\n  alpha 1\.0\.0: BSD-3-Clause\n  zeta 2\.0\.0: MIT\n/)
  const positions = ['alpha 1.0.0: LICENSE', 'Alpha licence text', 'alpha 1.0.0: NOTICE', 'Alpha notice', 'zeta 2.0.0: LICENSE', 'Zeta licence text'].map((piece) => text.indexOf(piece))
  assert.ok(positions.every((at) => at > 0), 'every heading and every text is present')
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
})
