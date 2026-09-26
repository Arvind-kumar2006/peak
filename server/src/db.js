// SQLite (node:sqlite, no native deps). One file under data/.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH ?? `${config.dataDir}/peak.db`);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  password_hash TEXT,
  github_id TEXT UNIQUE,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- One row per connected source. kind: github | sentry | slack. mode: live.
-- secrets is encrypted JSON (tokens); settings is plain JSON (repo, org, channel …).
CREATE TABLE IF NOT EXISTS integrations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  secrets TEXT,
  connected_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind)
);
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  health_url TEXT,
  sentry_project TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  release TEXT,
  last_checked_at TEXT,
  failed_checks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS samples (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  healthy INTEGER,
  latency_ms INTEGER,
  errors_per_min INTEGER,
  release TEXT
);
CREATE INDEX IF NOT EXISTS samples_by_service ON samples(service_id, at);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- investigating → awaiting_approval → fixing → verifying → resolved
  -- or: needs_attention (no safe fix) | rejected | unresolved (fix did not help) | failed (agent error)
  status TEXT NOT NULL,
  signal TEXT NOT NULL,
  diagnosis TEXT,
  pending_action TEXT,
  approval TEXT,
  fix TEXT,
  verification TEXT,
  agent TEXT,
  slack TEXT,
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const now = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;

export const json = (v) => (v == null ? null : JSON.stringify(v));
export const parse = (v) => (v == null ? null : JSON.parse(v));

export function kvGet(key) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}
export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
// A random value created once and kept (e.g. the MCP endpoint token).
export function kvOnce(key, make) {
  let v = kvGet(key);
  if (!v) {
    v = make();
    kvSet(key, v);
  }
  return v;
}
