import { Database } from 'bun:sqlite'
import path from 'node:path'
import { TRAIL_HOME } from './git.ts'

export const db = new Database(path.join(TRAIL_HOME, 'trail.db'))

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  -- Identity of the thing under review, so importing it again refreshes instead of duplicating.
  source_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  repo_label TEXT NOT NULL,
  owner TEXT,
  repo TEXT,
  number INTEGER,
  author TEXT,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  repo_dir TEXT NOT NULL,
  work_dir TEXT NOT NULL,
  can_push INTEGER NOT NULL DEFAULT 0,
  commits_json TEXT NOT NULL DEFAULT '[]',
  files_json TEXT NOT NULL DEFAULT '[]',
  moves_json TEXT NOT NULL DEFAULT '[]',
  symbols_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS viewed (
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  hunk_key TEXT NOT NULL,
  PRIMARY KEY (review_id, hunk_key)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  side TEXT NOT NULL,
  line INTEGER NOT NULL,
  in_diff INTEGER NOT NULL,
  body TEXT NOT NULL,
  -- Text of the line the note was written on, to follow it or flag the note after a refresh.
  line_text TEXT,
  outdated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS walkthroughs (
  review_id INTEGER PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_by_name ON symbols (review_id, name);
CREATE INDEX IF NOT EXISTS symbols_by_path ON symbols (review_id, path, line);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? fallback
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
