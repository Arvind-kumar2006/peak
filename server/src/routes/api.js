// Dashboard API (all routes require a signed-in user; data is scoped to their workspace).
import { Router } from 'express';
import { requireUser, githubAuthorizeUrl, githubOAuthEnabled, slackAuthorizeUrl } from '../auth.js';
import { githubClient } from '../integrations/github.js';
import { joinChannel, listChannels, slackOAuthEnabled } from '../integrations/slack.js';
import { kvGet, kvDelete } from '../db.js';
import { decrypt } from '../crypto.js';
import { listIntegrations, connect, disconnect } from '../integrations/index.js';
import {
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
  setMute,
  getWorkspaceSettings,
  updateWorkspaceSettings,
  listSamples,
  pageIncidents,
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

async function ownService(req) {
  const s = await getService(req.params.id);
  if (!s || s.workspaceId !== req.workspaceId) throw bad('Service not found', 404);
  return s;
}
async function ownIncident(req) {
  const i = await getIncident(req.params.id);
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

api.get('/overview', async (req, res) => {
  const [list, integrations, page, settings] = await Promise.all([
    listServices(req.workspaceId),
    listIntegrations(req.workspaceId),
    pageIncidents(req.workspaceId, { limit: 20 }),
    getWorkspaceSettings(req.workspaceId),
  ]);
  const incidents = page.items;
  const services = await Promise.all(
    list.map(async (s) => ({
      ...s,
      openIncident: incidents.find((i) => i.serviceId === s.id && OPEN_STATUSES.includes(i.status))?.id ?? null,
      samples: await listSamples(s.id, { since: minutesAgo(30) }),
    })),
  );
  res.json({
    user: { name: req.user.name, email: req.user.email },
    integrations,
    services,
    incidents,
    // Cursor for "Load older incidents", fixed when this page was read.
    incidentsNext: page.next,
    agent: agentStatus,
    settings,
    monitor: config.monitor,
    setupComplete: integrations.every((i) => i.connected) && services.length > 0,
  });
});

// ——— Workspace settings ———
// fixMode: 'pr' (approved code fixes open a pull request) | 'push' (commit straight to the branch).
api.get('/workspace/settings', async (req, res) => res.json(await getWorkspaceSettings(req.workspaceId)));
api.put('/workspace/settings', async (req, res) => {
  const patch = {};
  if (req.body?.fixMode !== undefined) {
    if (!['pr', 'push'].includes(req.body.fixMode)) throw bad('fixMode must be "pr" or "push"');
    patch.fixMode = req.body.fixMode;
  }
  const settings = await updateWorkspaceSettings(req.workspaceId, patch);
  publish(req.workspaceId);
  res.json(settings);
});

api.get('/stream', (req, res) => subscribe(req.workspaceId, res));

// ——— Integrations ———

api.get('/integrations', async (req, res) => res.json(await listIntegrations(req.workspaceId)));

// ——— Connect GitHub per user (OAuth) ———
// 1. /authorize redirects to GitHub; the callback (auth.js) parks the token for this workspace.
// 2. /repos lists repositories that token can push to; the user picks one.
// 3. PUT /integrations/github { oauth: true, repo, branch } saves it.

const pendingKey = (ws) => `github_pending:${ws}`;
async function pendingGithub(workspaceId) {
  const raw = await kvGet(pendingKey(workspaceId));
  if (!raw) return null;
  const p = await decrypt(raw);
  return p.expiresAt > Date.now() ? p : null;
}

api.get('/integrations/github/authorize', async (req, res) => {
  if (!githubOAuthEnabled()) throw bad('GitHub OAuth is not configured on this server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)', 404);
  res.redirect(await githubAuthorizeUrl({ purpose: 'connect', workspaceId: req.workspaceId }));
});

api.get('/integrations/github/pending', async (req, res) => {
  const p = await pendingGithub(req.workspaceId);
  res.json(p ? { login: p.login } : null);
});

api.get('/integrations/github/repos', async (req, res) => {
  const p = await pendingGithub(req.workspaceId);
  if (!p) throw bad('GitHub authorization expired. Connect again.', 409);
  const gh = githubClient(p.token);
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh('GET', `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  res.json(repos.filter((r) => r.permissions?.push && !r.archived).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, pushedAt: r.pushed_at })));
});

api.get('/integrations/github/branches', async (req, res) => {
  const p = await pendingGithub(req.workspaceId);
  if (!p) throw bad('GitHub authorization expired. Connect again.', 409);
  const repo = String(req.query.repo ?? '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw bad('repo must be owner/name');
  const branches = await githubClient(p.token)('GET', `/repos/${repo}/branches?per_page=100`);
  res.json(branches.map((b) => b.name));
});

// ——— Connect Slack (OAuth) ———
// The same three steps, with a channel to pick instead of a repository. The app's Redirect
// URL must be <APP_URL>/api/auth/slack/callback; the callback is handled in auth.js.

const slackPendingKey = (ws) => `slack_pending:${ws}`;
async function pendingSlack(workspaceId) {
  const raw = await kvGet(slackPendingKey(workspaceId));
  if (!raw) return null;
  const p = await decrypt(raw);
  return p.expiresAt > Date.now() ? p : null;
}

api.get('/integrations/slack/authorize', async (req, res) => {
  if (!slackOAuthEnabled()) throw bad('Slack is not configured on this server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET)', 404);
  res.redirect(await slackAuthorizeUrl({ workspaceId: req.workspaceId }));
});

api.get('/integrations/slack/pending', async (req, res) => {
  const p = await pendingSlack(req.workspaceId);
  res.json(p ? { team: p.team, teamId: p.teamId } : null);
});

api.get('/integrations/slack/channels', async (req, res) => {
  const p = await pendingSlack(req.workspaceId);
  if (!p) throw bad('Slack authorization expired. Connect again.', 409);
  const channels = await listChannels(p.token).catch((err) => {
    throw bad(err.slackError === 'missing_scope' ? 'The Slack app is missing channels:read / groups:read. Update its scopes and reinstall it.' : err.message);
  });
  res.json(channels);
});

api.put('/integrations/:kind', async (req, res) => {
  const kind = req.params.kind;
  const body = { ...(req.body ?? {}) };
  // GitHub and Slack connect over OAuth only: the credential always comes from the pending
  // store the callback filled in, never from the request body, so there is nothing to paste.
  if (kind === 'github' || kind === 'slack') {
    const name = kind === 'github' ? 'GitHub' : 'Slack';
    if (!body.oauth) throw bad(`${name} can only be connected by authorizing it in the browser`, 400);
    const p = kind === 'github' ? await pendingGithub(req.workspaceId) : await pendingSlack(req.workspaceId);
    if (!p) throw bad(`${name} authorization expired. Connect again.`, 409);
    Object.assign(body, kind === 'github' ? { token: p.token, via: 'oauth', login: p.login } : { botToken: p.token, team: p.team, teamId: p.teamId, botUserId: p.botUserId });
  }
  await connect(req.workspaceId, kind, body);
  if (kind === 'github') await kvDelete(pendingKey(req.workspaceId));
  if (kind === 'slack') await kvDelete(slackPendingKey(req.workspaceId));
  publish(req.workspaceId);
  res.json(await listIntegrations(req.workspaceId));
});

api.delete('/integrations/:kind', async (req, res) => {
  await disconnect(req.workspaceId, req.params.kind);
  publish(req.workspaceId);
  res.json(await listIntegrations(req.workspaceId));
});

// ——— Services ———

api.get('/services', async (req, res) => res.json(await listServices(req.workspaceId)));

api.post('/services', async (req, res) => {
  const service = await createService(req.workspaceId, serviceInput(req.body ?? {}));
  await checkService(service).catch(() => {});
  publish(req.workspaceId);
  res.status(201).json(await getService(service.id));
});

api.put('/services/:id', async (req, res) => {
  await ownService(req);
  const service = await updateService(req.params.id, serviceInput(req.body ?? {}));
  await checkService(service).catch(() => {});
  publish(req.workspaceId);
  res.json(await getService(service.id));
});

// Snooze alerting for a deploy or maintenance window: { minutes, reason }. minutes 0 = unmute.
api.post('/services/:id/mute', async (req, res) => {
  await ownService(req);
  const minutes = Number(req.body?.minutes ?? 0);
  if (!(minutes >= 0 && minutes <= 7 * 24 * 60)) throw bad('minutes must be between 0 and 10080');
  const until = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  const service = await setMute(req.params.id, { until, reason: String(req.body?.reason ?? '').slice(0, 200) });
  publish(req.workspaceId);
  res.json(service);
});

api.delete('/services/:id', async (req, res) => {
  await ownService(req);
  await deleteService(req.params.id);
  publish(req.workspaceId);
  res.json({ ok: true });
});

// ——— Incidents ———

// Paged, newest first: ?after=<cursor from the previous page>&limit=
api.get('/incidents', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  res.json(await pageIncidents(req.workspaceId, { limit, after: req.query.after ? String(req.query.after) : undefined }));
});

api.get('/incidents/:id', async (req, res) => {
  const incident = await ownIncident(req);
  const from = new Date(new Date(incident.startedAt).getTime() - 10 * 60_000).toISOString();
  const [service, events, samples] = await Promise.all([getService(incident.serviceId), listEvents(incident.id), listSamples(incident.serviceId, { since: from, limit: 2000 })]);
  res.json({ incident, service, events, samples });
});

api.post('/incidents/:id/approve', async (req, res) => {
  await ownIncident(req);
  res.json(await decide(req.params.id, { decision: 'approve', by: req.user.name || req.user.email }));
});

api.post('/incidents/:id/resolve', async (req, res) => {
  await ownIncident(req);
  res.json(await closeManually(req.params.id, { by: req.user.name || req.user.email, note: String(req.body?.note ?? '').slice(0, 500) }));
});

api.post('/incidents/:id/rerun', async (req, res) => {
  await ownIncident(req);
  res.json(await rerun(req.params.id, { by: req.user.name || req.user.email }));
});

api.post('/incidents/:id/reject', async (req, res) => {
  await ownIncident(req);
  res.json(await decide(req.params.id, { decision: 'reject', by: req.user.name || req.user.email, reason: String(req.body?.reason ?? '').slice(0, 500) }));
});
