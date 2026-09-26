// Postgres. DATABASE_URL points at the real database (e.g. Neon). Without it, and in tests,
// PGlite (Postgres compiled to WASM, in-process) runs the same SQL: DATABASE_URL=memory for a
// throwaway database, or unset for a local one under data/pglite.
// All PEAK tables live in the `peak` schema so they never collide with an app's own tables.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import { config } from './config.js';

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS peak;
SET search_path TO peak;
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  password_hash TEXT,
  github_id TEXT UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
-- One row per connected source. kind: github | sentry | slack.
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
  slow_checks INTEGER NOT NULL DEFAULT 0,
  latency_threshold_ms INTEGER,
  muted_until TEXT,
  mute_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS samples (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  healthy BOOLEAN,
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
  closure TEXT,
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_by_workspace ON incidents(workspace_id, started_at);
CREATE INDEX IF NOT EXISTS incidents_by_service ON incidents(service_id, status);
CREATE TABLE IF NOT EXISTS incident_events (
  id BIGSERIAL PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS incident_events_by_incident ON incident_events(incident_id, id);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  workspace_id TEXT
);
-- Added after the first release; IF NOT EXISTS makes it a no-op once applied.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS settings TEXT NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let driver = null; // { query(text, params) → { rows, rowCount }, end() }
let ready = null;

async function connect() {
  const url = process.env.DATABASE_URL?.trim();
  if (url && url !== 'memory') {
    const { default: pg } = await import('pg');
    // Node tries each DNS address (IPv6, IPv4…) for only 250ms by default; a first handshake to a
    // cloud database often takes longer, so every attempt "times out". Give each address 3s.
    net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
    // Neon & co. use sslmode=require; pg treats it as verify-full (full cert check), which we want.
    const pool = new pg.Pool({ connectionString: url.replace(/sslmode=(prefer|require|verify-ca)\b/, 'sslmode=verify-full'), max: 10, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000, options: '-c search_path=peak' });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
    driver = { query: (text, params) => pool.query(text, params), end: () => pool.end(), kind: 'postgres' };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    let dir;
    if (url !== 'memory') {
      dir = `${config.dataDir}/pglite`;
      mkdirSync(dir, { recursive: true });
    }
    const lite = new PGlite(dir);
    driver = {
      query: async (text, params) => {
        const r = await lite.query(text, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
      exec: (text) => lite.exec(text),
      end: () => lite.close(),
      kind: dir ? 'pglite' : 'pglite-memory',
    };
  }
  if (driver.exec) await driver.exec(SCHEMA);
  else await driver.query(SCHEMA);
  return driver;
}

// Connect and create the schema once. Every query waits for this. A failed attempt is
// forgotten so the next call retries (e.g. the database was briefly unreachable).
export function initDb() {
  ready ??= connect().catch((err) => {
    ready = null;
    driver = null;
    throw err;
  });
  return ready;
}

export const dbKind = () => driver?.kind ?? null;

// Queries: `?` placeholders are converted to $1, $2 … so SQL stays readable.
const numbered = (text) => {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
};

async function q(text, params = []) {
  await initDb();
  return driver.query(numbered(text), params);
}

export const db = {
  // First row or null.
  one: async (text, ...params) => (await q(text, params)).rows[0] ?? null,
  all: async (text, ...params) => (await q(text, params)).rows,
  // Number of affected rows.
  run: async (text, ...params) => (await q(text, params)).rowCount,
  close: async () => {
    if (driver) await driver.end();
    driver = null;
    ready = null;
  },
};

export const now = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;

export const json = (v) => (v == null ? null : JSON.stringify(v));
export const parse = (v) => (v == null ? null : JSON.parse(v));

export async function kvGet(key) {
  return (await db.one('SELECT value FROM kv WHERE key = ?', key))?.value ?? null;
}
export async function kvSet(key, value) {
  await db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
}
export async function kvDelete(key) {
  await db.run('DELETE FROM kv WHERE key = ?', key);
}
// A random value created once and kept (e.g. the MCP endpoint token). Safe under races.
export async function kvOnce(key, make) {
  await db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', key, make());
  return kvGet(key);
}
