// The licences of the packages whose code the build compiles into dist/.
//
// The published package installs no dependencies, because their code travels inside it. Their
// licences ask for the copyright notice and the licence text to travel with every copy, so the
// build writes them all to dist/THIRD_PARTY_LICENSES.txt.
//
// The list comes from what the two bundlers actually read, not from package.json, where build
// tools and bundled libraries sit side by side. Vite reports the files of the web page through
// the plugin below, and esbuild writes a metafile for the command and the server (see the build
// script in package.json). write-third-party-licenses.ts then turns the two lists into the file.
//
// The lists hold every file the bundlers reach from JavaScript or TypeScript, a stylesheet
// imported from a module included. They would not hold a package reached only from inside a
// stylesheet (@import or url()) or from a web worker, which Vite builds separately. Trail has
// neither; teach this file about them before adding one.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Inside node_modules, so the lists are never committed or published: they hold paths of this machine.
const LISTS = path.join(ROOT, 'node_modules', '.cache', 'trail')
const WEB_LIST = path.join(LISTS, 'web-modules.json')
/** The same path as --metafile in the build script. */
const NODE_LIST = path.join(LISTS, 'esbuild-meta.json')
const OUTPUT = path.join(ROOT, 'dist', 'THIRD_PARTY_LICENSES.txt')
/** The folders of Trail's own source. A bundled file from anywhere else has to belong to a package. */
const OWN_FOLDERS = ['bin', 'server', 'shared', 'web']

/** Vite plugin that notes which files went into the web page. */
export function recordBundledModules(): Plugin {
  // One list for the whole build, however many outputs it has.
  const files = new Set<string>()
  return {
    name: 'trail:record-bundled-modules',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') for (const id of chunk.moduleIds) files.add(id)
      }
      fs.mkdirSync(LISTS, { recursive: true })
      fs.writeFileSync(WEB_LIST, JSON.stringify([...files]))
    },
  }
}

/**
 * The folder of the package a bundled file belongs to, or null for a file outside node_modules.
 * It is the name after the last "node_modules" in the path (two names for a scoped package),
 * which holds for npm, pnpm and yarn alike, and for a dependency nested inside another.
 */
export function packageFolder(file: string): string | null {
  // A bundler marks the files it made up itself with a leading NUL, and may add "?query" to real ones.
  if (file.startsWith('\0')) return null
  const parts = file.replace(/\\/g, '/').replace(/\?.*$/, '').split('/')
  const at = parts.lastIndexOf('node_modules')
  if (at < 0) return null
  return parts.slice(0, at + (parts[at + 1]?.startsWith('@') ? 3 : 2)).join('/')
}

export interface Bundled {
  name: string
  version: string
  /** The licence as the package's own package.json names it, such as "MIT". */
  licence: string
  /** Every licence and notice file the package ships: file name, then its text. */
  texts: [name: string, text: string][]
}

// LICENSE, LICENCE.md, LICENSE-MIT.txt, COPYING, NOTICE and the like, but not a source file that happens to start the same way.
const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i
const SOURCE_FILE = /\.([cm]?[jt]s|json|map)$/i

export function readPackage(folder: string): Bundled {
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { name: string; version: string; license?: unknown }
  const texts = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name) && !SOURCE_FILE.test(entry.name))
    .map((entry): [string, string] => [entry.name, fs.readFileSync(path.join(folder, entry.name), 'utf8').trim()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  // Shipping a package's code without its licence text is what this file exists to prevent, so
  // a package that has none stops the build instead of being listed with a gap.
  if (!texts.length) throw new Error(`${pkg.name}@${pkg.version} is bundled into dist/ but has no licence file in ${folder}. Its licence text has to be added before Trail can be published.`)
  return { name: pkg.name, version: pkg.version, licence: typeof pkg.license === 'string' ? pkg.license : 'see its licence text', texts }
}

/**
 * The packages that the given bundled files belong to, each once. `root` is Trail's folder:
 * esbuild names its files from there, and Vite gives full paths.
 */
export function bundledPackages(files: string[], root: string): Bundled[] {
  const packages = new Map<string, Bundled>()
  for (const file of files) {
    // A bundler's own glue code. It has no package to look up; the written file says whose it is.
    if (file.startsWith('\0')) continue
    const folder = packageFolder(file)
    if (folder) {
      const found = readPackage(path.resolve(root, folder))
      packages.set(`${found.name}@${found.version}`, found)
      continue
    }
    // Anything else must be Trail's own source. A linked or vendored package would otherwise
    // pass for it and ship without its licence.
    const own = path.relative(root, path.resolve(root, file.replace(/\?.*$/, '')))
    if (!OWN_FOLDERS.includes(own.split(path.sep)[0])) {
      throw new Error(`${file} is bundled into dist/ but is neither inside node_modules nor in one of Trail's own folders (${OWN_FOLDERS.join(', ')}), so its licence cannot be looked up. Install it as a package, or teach scripts/third-party.ts about it.`)
    }
  }
  return [...packages.values()]
}

const RULE = '-'.repeat(80)

export function render(packages: Bundled[]): string {
  const sorted = [...packages].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
  const out = [
    'Third-party software in Trail',
    '',
    "Trail's own licence is in the LICENSE file. The published package also contains code from the",
    'projects listed here, compiled into the files in dist/. Each of them remains under its own',
    'licence, which is reproduced below as its authors ship it. The notices their authors marked',
    'to be kept are also still in place inside those files.',
    '',
    'The tools that build Trail (Vite, Rolldown and esbuild, all under the MIT licence) add a few',
    'lines of their own helper code to the same files.',
    '',
    ...sorted.map((p) => `  ${p.name} ${p.version}: ${p.licence}`),
  ]
  for (const p of sorted) {
    for (const [name, text] of p.texts) out.push('', RULE, `${p.name} ${p.version}: ${name}`, RULE, '', text)
  }
  return out.join('\n') + '\n'
}

function readList(file: string, writer: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is missing or unreadable. ${writer} writes it during "npm run build"; run that instead of this step on its own.`)
  }
}

/** Write dist/THIRD_PARTY_LICENSES.txt from the lists the two bundlers left. Returns how many packages it covers. */
export function writeThirdPartyLicenses(): number {
  const web = readList(WEB_LIST, 'The Vite build') as string[]
  const node = Object.keys((readList(NODE_LIST, 'esbuild') as { inputs: Record<string, unknown> }).inputs)
  const packages = bundledPackages([...web, ...node], ROOT)
  fs.writeFileSync(OUTPUT, render(packages))
  // Used up: a later run must not take these for the lists of a newer build.
  fs.rmSync(LISTS, { recursive: true, force: true })
  return packages.length
}
