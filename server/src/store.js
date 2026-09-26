// Data access for services, samples, incidents and the incident timeline.
import { db, now, newId, json, parse } from './db.js';

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
  };

export const getService = (id) => toService(db.prepare('SELECT * FROM services WHERE id = ?').get(id));
export const listServices = (workspaceId) => db.prepare('SELECT * FROM services WHERE workspace_id = ? ORDER BY created_at').all(workspaceId).map(toService);
export const allServices = () => db.prepare('SELECT * FROM services').all().map(toService);

export function createService(workspaceId, { name, healthUrl, sentryProject }) {
  const id = newId('svc');
  db.prepare('INSERT INTO services (id, workspace_id, name, health_url, sentry_project, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    workspaceId,
    name,
    healthUrl || null,
    sentryProject || null,
    now(),
  );
  return getService(id);
}

export function updateService(id, { name, healthUrl, sentryProject }) {
  db.prepare('UPDATE services SET name = ?, health_url = ?, sentry_project = ?, status = ?, failed_checks = 0 WHERE id = ?').run(name, healthUrl || null, sentryProject || null, 'unknown', id);
  return getService(id);
}

export const deleteService = (id) => db.prepare('DELETE FROM services WHERE id = ?').run(id);

export function recordCheck(serviceId, { status, release, failedChecks, sample }) {
  db.prepare('UPDATE services SET status = ?, release = COALESCE(?, release), failed_checks = ?, last_checked_at = ? WHERE id = ?').run(status, release ?? null, failedChecks, now(), serviceId);
  db.prepare('INSERT INTO samples (service_id, at, healthy, latency_ms, errors_per_min, release) VALUES (?, ?, ?, ?, ?, ?)').run(
    serviceId,
    now(),
    sample.healthy == null ? null : sample.healthy ? 1 : 0,
    sample.latencyMs ?? null,
    sample.errorsPerMin ?? null,
    sample.release ?? null,
  );
}

export function listSamples(serviceId, { since, limit = 360 } = {}) {
  return db
    .prepare('SELECT at, healthy, latency_ms, errors_per_min, release FROM samples WHERE service_id = ? AND at >= ? ORDER BY at DESC LIMIT ?')
    .all(serviceId, since ?? new Date(Date.now() - 3600_000).toISOString(), limit)
    .reverse()
    .map((s) => ({ at: s.at, healthy: s.healthy == null ? null : !!s.healthy, latencyMs: s.latency_ms, errorsPerMin: s.errors_per_min, release: s.release }));
}

export const pruneSamples = () => db.prepare('DELETE FROM samples WHERE at < ?').run(new Date(Date.now() - 7 * 86400_000).toISOString());

// ——— Incidents ———

export const OPEN_STATUSES = ['investigating', 'awaiting_approval', 'fixing', 'verifying'];

const INCIDENT_JSON = ['signal', 'diagnosis', 'pending_action', 'approval', 'fix', 'verification', 'agent', 'slack'];

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
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    updatedAt: r.updated_at,
  };

export const getIncident = (id) => toIncident(db.prepare('SELECT * FROM incidents WHERE id = ?').get(id));

export function listIncidents(workspaceId, { limit = 50 } = {}) {
  return db.prepare('SELECT * FROM incidents WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?').all(workspaceId, limit).map(toIncident);
}

export function openIncidentFor(serviceId) {
  const marks = OPEN_STATUSES.map(() => '?').join(',');
  return toIncident(db.prepare(`SELECT * FROM incidents WHERE service_id = ? AND status IN (${marks}) ORDER BY started_at DESC LIMIT 1`).get(serviceId, ...OPEN_STATUSES));
}

export const incidentsInStatus = (statuses) =>
  db.prepare(`SELECT * FROM incidents WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses).map(toIncident);

export function createIncident({ workspaceId, serviceId, title, signal }) {
  const id = newId('inc');
  const t = now();
  db.prepare('INSERT INTO incidents (id, workspace_id, service_id, title, status, signal, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    workspaceId,
    serviceId,
    title,
    'investigating',
    json(signal),
    t,
    t,
  );
  return getIncident(id);
}

// patch keys use the camelCase names from toIncident.
export function updateIncident(id, patch) {
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    cols.push(`${col} = ?`);
    vals.push(INCIDENT_JSON.includes(col) ? json(v) : v);
  }
  cols.push('updated_at = ?');
  vals.push(now());
  db.prepare(`UPDATE incidents SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  return getIncident(id);
}

// Atomic status transition: only succeeds if the incident is still in one of `from`.
export function transition(id, from, to, patch = {}) {
  const marks = from.map(() => '?').join(',');
  const r = db.prepare(`UPDATE incidents SET status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`).run(to, now(), id, ...from);
  if (!r.changes) return null;
  return Object.keys(patch).length ? updateIncident(id, patch) : getIncident(id);
}

// ——— Timeline ———

export function addEvent(incidentId, kind, title, detail) {
  db.prepare('INSERT INTO incident_events (incident_id, at, kind, title, detail) VALUES (?, ?, ?, ?, ?)').run(incidentId, now(), kind, title, json(detail ?? null));
}

export function listEvents(incidentId) {
  return db
    .prepare('SELECT id, at, kind, title, detail FROM incident_events WHERE incident_id = ? ORDER BY id')
    .all(incidentId)
    .map((e) => ({ ...e, detail: parse(e.detail) }));
}
