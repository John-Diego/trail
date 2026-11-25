#!/usr/bin/env node
// The `trail` command. This file does one thing before anything else is loaded: it checks the
// Node.js version. The real program (main) and the libraries bundled with it use syntax that an
// old Node cannot even parse, so loading them first would end in a syntax error instead of a
// message a person can act on.
import { fileURLToPath } from 'node:url'
import { requireNode } from '../shared/settings.ts'

try {
  requireNode()
} catch (err) {
  console.error(`Trail: ${(err as Error).message}`)
  process.exit(1)
}

// Built, this is dist/cli.js next to dist/main.js; from source, bin/trail.ts next to bin/main.ts.
// The name is worked out at run time so that the bundler keeps the two files separate.
const main = fileURLToPath(import.meta.url).endsWith('.js') ? './main.js' : './main.ts'
await import(new URL(main, import.meta.url).href)
