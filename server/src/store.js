// Data access for services, samples, incidents and the incident timeline. All async (Postgres).
import { db, now, newId, json, parse } from './db.js';

const marks = (list) => list.map(() => '?').join(',');

// ——— Workspace settings ———

// fixMode: how an approved code fix lands. 'pr' (default) opens a pull request; 'push' commits to the branch.
const DEFAULT_SETTINGS = { fixMode: 'pr' };
export async function getWorkspaceSettings(workspaceId) {
  const row = await db.one('SELECT settings FROM workspaces WHERE id = ?', workspaceId);
  return { ...DEFAULT_SETTINGS, ...parse(row?.settings ?? '{}') };
}
export async function updateWorkspaceSettings(workspaceId, patch) {
  const next = { ...(await getWorkspaceSettings(workspaceId)), ...patch };
  await db.run('UPDATE workspaces SET settings = ? WHERE id = ?', json(next), workspaceId);
  return next;
}

// ——— Services ———

const toService = (r) =>
  r && {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    healthUrl: r.health_url,
    sentryProject: r.sentry_project,
    status: r.status,
    release: r.release,
    lastCheckedAt: r.last_checked_at,
    failedChecks: r.failed_checks,
    slowChecks: r.slow_checks,
    latencyThresholdMs: r.latency_threshold_ms,
    mutedUntil: r.muted_until && r.muted_until > now() ? r.muted_until : null,
    muteReason: r.muted_until && r.muted_until > now() ? r.mute_reason : null,
  };

export const getService = async (id) => toService(await db.one('SELECT * FROM services WHERE id = ?', id));
export const listServices = async (workspaceId) => (await db.all('SELECT * FROM services WHERE workspace_id = ? ORDER BY created_at', workspaceId)).map(toService);
export const allServices = async () => (await db.all('SELECT * FROM services')).map(toService);

export async function createService(workspaceId, { name, healthUrl, sentryProject, latencyThresholdMs }) {
  const id = newId('svc');
  await db.run(
    'INSERT INTO services (id, workspace_id, name, health_url, sentry_project, latency_threshold_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    workspaceId,
    name,
    healthUrl || null,
    sentryProject || null,
    latencyThresholdMs || null,
    now(),
  );
  return getService(id);
}

export async function updateService(id, { name, healthUrl, sentryProject, latencyThresholdMs }) {
  await db.run(
    'UPDATE services SET name = ?, health_url = ?, sentry_project = ?, latency_threshold_ms = ?, status = ?, failed_checks = 0, slow_checks = 0 WHERE id = ?',
    name,
    healthUrl || null,
    sentryProject || null,
    latencyThresholdMs || null,
    'unknown',
    id,
  );
  return getService(id);
}

// Snooze alerting (deploys, maintenance). Checks keep running; incidents don't open.
export async function setMute(id, { until, reason }) {
  await db.run('UPDATE services SET muted_until = ?, mute_reason = ? WHERE id = ?', until ?? null, until ? reason || null : null, id);
  return getService(id);
}

export const deleteService = (id) => db.run('DELETE FROM services WHERE id = ?', id);

export async function recordCheck(serviceId, { status, release, failedChecks, slowChecks = 0, sample }) {
  const t = now();
  await db.run(
    'UPDATE services SET status = ?, release = COALESCE(?, release), failed_checks = ?, slow_checks = ?, last_checked_at = ? WHERE id = ?',
    status,
    release ?? null,
    failedChecks,
    slowChecks,
    t,
    serviceId,
  );
  await db.run(
    'INSERT INTO samples (service_id, at, healthy, latency_ms, errors_per_min, release) VALUES (?, ?, ?, ?, ?, ?)',
    serviceId,
    t,
    sample.healthy ?? null,
    sample.latencyMs ?? null,
    sample.errorsPerMin ?? null,
    sample.release ?? null,
  );
}

export async function listSamples(serviceId, { since, limit = 360 } = {}) {
  const rows = await db.all(
    'SELECT at, healthy, latency_ms, errors_per_min, release FROM samples WHERE service_id = ? AND at >= ? ORDER BY at DESC LIMIT ?',
    serviceId,
    since ?? new Date(Date.now() - 3600_000).toISOString(),
    limit,
  );
  return rows.reverse().map((s) => ({ at: s.at, healthy: s.healthy, latencyMs: s.latency_ms, errorsPerMin: s.errors_per_min, release: s.release }));
}

// Expired sign-in sessions and abandoned OAuth handshakes.
export async function pruneAuth() {
  await db.run('DELETE FROM sessions WHERE expires_at < ?', now());
  await db.run('DELETE FROM oauth_states WHERE expires_at < ?', now());
}

export const pruneSamples = () => db.run('DELETE FROM samples WHERE at < ?', new Date(Date.now() - 7 * 86400_000).toISOString());

// ——— Incidents ———

// awaiting_merge: a code fix was opened as a pull request and PEAK waits for it to be merged.
export const OPEN_STATUSES = ['investigating', 'awaiting_approval', 'fixing', 'awaiting_merge', 'verifying'];

const INCIDENT_JSON = ['signal', 'diagnosis', 'pending_action', 'approval', 'fix', 'verification', 'agent', 'slack', 'closure'];
const INCIDENT_COLUMNS = new Set([...INCIDENT_JSON, 'title', 'status', 'resolved_at']);

const toIncident = (r) =>
  r && {
    id: r.id,
    workspaceId: r.workspace_id,
    serviceId: r.service_id,
    title: r.title,
    status: r.status,
    signal: parse(r.signal),
    diagnosis: parse(r.diagnosis),
    pendingAction: parse(r.pending_action),
    approval: parse(r.approval),
    fix: parse(r.fix),
    verification: parse(r.verification),
    agent: parse(r.agent),
    slack: parse(r.slack),
    closure: parse(r.closure),
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    updatedAt: r.updated_at,
  };

export const getIncident = async (id) => toIncident(await db.one('SELECT * FROM incidents WHERE id = ?', id));

// Newest first, paged with an exact (started_at, id) cursor: rows sharing a timestamp are never skipped.
// Returns { items, next } where next is the cursor for the following page, or null.
export async function pageIncidents(workspaceId, { limit = 25, after } = {}) {
  const [at, id] = after ? String(after).split('|') : [];
  const rows = at
    ? await db.all('SELECT * FROM incidents WHERE workspace_id = ? AND (started_at, id) < (?, ?) ORDER BY started_at DESC, id DESC LIMIT ?', workspaceId, at, id ?? '', limit + 1)
    : await db.all('SELECT * FROM incidents WHERE workspace_id = ? ORDER BY started_at DESC, id DESC LIMIT ?', workspaceId, limit + 1);
  const items = rows.slice(0, limit).map(toIncident);
  const last = items.at(-1);
  return { items, next: rows.length > limit ? `${last.startedAt}|${last.id}` : null };
}

export async function listIncidents(workspaceId, { limit = 50 } = {}) {
  return (await pageIncidents(workspaceId, { limit })).items;
}

// Closed incidents (and their timelines, via ON DELETE CASCADE) older than the retention window.
export async function pruneIncidents(days) {
  if (!days) return;
  await db.run(`DELETE FROM incidents WHERE started_at < ? AND status NOT IN (${marks(OPEN_STATUSES)})`, new Date(Date.now() - days * 86400_000).toISOString(), ...OPEN_STATUSES);
}

export async function openIncidentFor(serviceId) {
  return toIncident(await db.one(`SELECT * FROM incidents WHERE service_id = ? AND status IN (${marks(OPEN_STATUSES)}) ORDER BY started_at DESC LIMIT 1`, serviceId, ...OPEN_STATUSES));
}

export const incidentsInStatus = async (statuses) => (await db.all(`SELECT * FROM incidents WHERE status IN (${marks(statuses)})`, ...statuses)).map(toIncident);

export async function createIncident({ workspaceId, serviceId, title, signal }) {
  const id = newId('inc');
  const t = now();
  const row = await db.one(
    'INSERT INTO incidents (id, workspace_id, service_id, title, status, signal, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
    id,
    workspaceId,
    serviceId,
    title,
    'investigating',
    json(signal),
    t,
    t,
  );
  return toIncident(row);
}

// patch keys use the camelCase names from toIncident → "col = ?" pairs.
function setClause(patch) {
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (!INCIDENT_COLUMNS.has(col)) throw new Error(`updateIncident: unknown field ${k}`);
    cols.push(`${col} = ?`);
    vals.push(INCIDENT_JSON.includes(col) ? json(v) : v);
  }
  cols.push('updated_at = ?');
  vals.push(now());
  return { sql: cols.join(', '), vals };
}

export async function updateIncident(id, patch) {
  const { sql, vals } = setClause(patch);
  return toIncident(await db.one(`UPDATE incidents SET ${sql} WHERE id = ? RETURNING *`, ...vals, id));
}

// Atomic status transition in one statement: only succeeds (and applies `patch`) if the
// incident is still in one of `from`. Returns the updated incident, or null.
export async function transition(id, from, to, patch = {}) {
  const { sql, vals } = setClause({ ...patch, status: to });
  return toIncident(await db.one(`UPDATE incidents SET ${sql} WHERE id = ? AND status IN (${marks(from)}) RETURNING *`, ...vals, id, ...from));
}

// ——— Timeline ———

export async function addEvent(incidentId, kind, title, detail) {
  await db.run('INSERT INTO incident_events (incident_id, at, kind, title, detail) VALUES (?, ?, ?, ?, ?)', incidentId, now(), kind, title, json(detail ?? null));
}

export async function listEvents(incidentId) {
  const rows = await db.all('SELECT id, at, kind, title, detail FROM incident_events WHERE incident_id = ? ORDER BY id', incidentId);
  return rows.map((e) => ({ ...e, id: String(e.id), detail: parse(e.detail) }));
}

// Merge fields into incident.agent in one statement (no read-modify-write race).
export async function mergeAgent(id, patch) {
  await db.run("UPDATE incidents SET agent = (COALESCE(agent, '{}')::jsonb || ?::jsonb)::text, updated_at = ? WHERE id = ?", json(patch), now(), id);
}
