// Dashboard API (all routes require a signed-in user; data is scoped to their workspace).
import { Router } from 'express';
import { requireUser } from '../auth.js';
import { listIntegrations, connect, disconnect } from '../integrations/index.js';
import {
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
  setMute,
  listSamples,
  listIncidents,
  getIncident,
  listEvents,
  OPEN_STATUSES,
} from '../store.js';
import { checkService } from '../monitor.js';
import { decide, closeManually, rerun, agentStatus } from '../agent/runner.js';
import { subscribe, publish } from '../events.js';
import { config } from '../config.js';

export const api = Router();
api.use(requireUser);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

function ownService(req) {
  const s = getService(req.params.id);
  if (!s || s.workspaceId !== req.workspaceId) throw bad('Service not found', 404);
  return s;
}
function ownIncident(req) {
  const i = getIncident(req.params.id);
  if (!i || i.workspaceId !== req.workspaceId) throw bad('Incident not found', 404);
  return i;
}

function serviceInput(body) {
  const name = String(body.name ?? '').trim();
  const healthUrl = String(body.healthUrl ?? '').trim();
  const sentryProject = String(body.sentryProject ?? '').trim();
  const latencyThresholdMs = body.latencyThresholdMs === '' || body.latencyThresholdMs == null ? null : Number(body.latencyThresholdMs);
  if (!name) throw bad('Name is required');
  if (latencyThresholdMs != null && !(Number.isInteger(latencyThresholdMs) && latencyThresholdMs >= 50)) throw bad('Latency threshold must be a whole number of milliseconds, at least 50');
  if (healthUrl && !/^https?:\/\/\S+$/.test(healthUrl)) throw bad('Health URL must start with http:// or https://');
  if (!healthUrl && !sentryProject) throw bad('Give the service a health URL, a Sentry project, or both');
  return { name, healthUrl, sentryProject, latencyThresholdMs };
}

const withIncident = (s) => ({ ...s, openIncident: listIncidents(s.workspaceId, { limit: 20 }).find((i) => i.serviceId === s.id && OPEN_STATUSES.includes(i.status))?.id ?? null });

api.get('/overview', (req, res) => {
  const services = listServices(req.workspaceId).map((s) => ({ ...withIncident(s), samples: listSamples(s.id, { since: minutesAgo(30) }) }));
  const integrations = listIntegrations(req.workspaceId);
  res.json({
    user: { name: req.user.name, email: req.user.email },
    integrations,
    services,
    incidents: listIncidents(req.workspaceId, { limit: 20 }),
    agent: agentStatus,
    monitor: config.monitor,
    setupComplete: integrations.every((i) => i.connected) && services.length > 0,
  });
});

api.get('/stream', (req, res) => subscribe(req.workspaceId, res));

// ——— Integrations ———

api.get('/integrations', (req, res) => res.json(listIntegrations(req.workspaceId)));

api.put('/integrations/:kind', async (req, res) => {
  await connect(req.workspaceId, req.params.kind, req.body ?? {});
  publish(req.workspaceId);
  res.json(listIntegrations(req.workspaceId));
});

api.delete('/integrations/:kind', (req, res) => {
  disconnect(req.workspaceId, req.params.kind);
  publish(req.workspaceId);
  res.json(listIntegrations(req.workspaceId));
});

// ——— Services ———

api.get('/services', (req, res) => res.json(listServices(req.workspaceId)));

api.post('/services', async (req, res) => {
  const service = createService(req.workspaceId, serviceInput(req.body ?? {}));
  await checkService(service).catch(() => {});
  publish(req.workspaceId);
  res.status(201).json(getService(service.id));
});

api.put('/services/:id', async (req, res) => {
  ownService(req);
  const service = updateService(req.params.id, serviceInput(req.body ?? {}));
  await checkService(service).catch(() => {});
  publish(req.workspaceId);
  res.json(getService(service.id));
});

// Snooze alerting for a deploy or maintenance window: { minutes, reason }. minutes 0 = unmute.
api.post('/services/:id/mute', (req, res) => {
  ownService(req);
  const minutes = Number(req.body?.minutes ?? 0);
  if (!(minutes >= 0 && minutes <= 7 * 24 * 60)) throw bad('minutes must be between 0 and 10080');
  const until = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  const service = setMute(req.params.id, { until, reason: String(req.body?.reason ?? '').slice(0, 200) });
  publish(req.workspaceId);
  res.json(service);
});

api.delete('/services/:id', (req, res) => {
  ownService(req);
  deleteService(req.params.id);
  publish(req.workspaceId);
  res.json({ ok: true });
});

// ——— Incidents ———

// Paged, newest first: ?before=<startedAt of the last row>&limit=
api.get('/incidents', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const items = listIncidents(req.workspaceId, { limit: limit + 1, before: req.query.before ? String(req.query.before) : undefined });
  res.json({ items: items.slice(0, limit), next: items.length > limit ? items[limit - 1].startedAt : null });
});

api.get('/incidents/:id', (req, res) => {
  const incident = ownIncident(req);
  const service = getService(incident.serviceId);
  const from = new Date(new Date(incident.startedAt).getTime() - 10 * 60_000).toISOString();
  res.json({ incident, service, events: listEvents(incident.id), samples: listSamples(service.id, { since: from, limit: 2000 }) });
});

api.post('/incidents/:id/approve', async (req, res) => {
  ownIncident(req);
  res.json(await decide(req.params.id, { decision: 'approve', by: req.user.name || req.user.email }));
});

api.post('/incidents/:id/resolve', async (req, res) => {
  ownIncident(req);
  res.json(await closeManually(req.params.id, { by: req.user.name || req.user.email, note: String(req.body?.note ?? '').slice(0, 500) }));
});

api.post('/incidents/:id/rerun', async (req, res) => {
  ownIncident(req);
  res.json(await rerun(req.params.id, { by: req.user.name || req.user.email }));
});

api.post('/incidents/:id/reject', async (req, res) => {
  ownIncident(req);
  res.json(await decide(req.params.id, { decision: 'reject', by: req.user.name || req.user.email, reason: String(req.body?.reason ?? '').slice(0, 500) }));
});
