import { createMcpServer, createHttpServer, ok, notImplemented, mockMode } from '../_shared/index.js';
import { getState, recordAction, metricsAt, runningSha, BAD_SHA, GOOD_SHA, short } from '../_shared/mockState.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 7102);
const name = 'cloud-mcp';
const DEMO_APP_URL = process.env.DEMO_APP_URL ?? 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- real mode: the demo app's own endpoints (contracts/demo-app-api.md) ----------

async function fetchMetrics() {
  const res = await fetch(`${DEMO_APP_URL}/metrics`);
  if (!res.ok) throw new Error(`GET /metrics → ${res.status}`);
  return res.json();
}

// Background sampler: /metrics every SAMPLE_INTERVAL_SEC, last 10 minutes kept.
// Keeps the verification window independent of when the agent happens to ask.
const SAMPLE_INTERVAL_SEC = Number(process.env.SAMPLE_INTERVAL_SEC ?? 10);
const samples = [];
if (!mockMode()) {
  const tick = async () => {
    try {
      samples.push(await fetchMetrics());
      while (samples.length > (600 / SAMPLE_INTERVAL_SEC)) samples.shift();
    } catch (err) {
      console.warn(`[${name}] sampler: ${err.message}`);
    }
  };
  tick();
  setInterval(tick, SAMPLE_INTERVAL_SEC * 1000);
}

// ---------- mock mode ----------

function mockServiceStatus() {
  const state = getState();
  const sha = runningSha(state);
  const rolledBack = state.action?.tool === 'trigger_rollback';
  const restarts = state.scenario === 'B' ? 2 : 0;
  const deploys = {
    // Scenario A: the bad commit was deployed ~12 minutes before the incident started.
    A: {
      currentDeploy: rolledBack
        ? { id: 'dep-rollback-1', commitSha: GOOD_SHA, createdAt: state.action.at }
        : { id: 'dep-bad', commitSha: BAD_SHA, createdAt: minutesBefore(state.startedAt, 12) },
      previousDeploy: rolledBack ? { id: 'dep-bad', commitSha: BAD_SHA } : { id: 'dep-good', commitSha: GOOD_SHA },
    },
    // Scenario B / healthy: nothing deployed for over a day.
    B: {
      currentDeploy: { id: 'dep-good', commitSha: GOOD_SHA, createdAt: minutesBefore(state.startedAt, 26 * 60) },
      previousDeploy: { id: 'dep-older', commitSha: '0a8e22c0000000000000000000000000000000' },
    },
  };
  const d = deploys[state.scenario] ?? deploys.B;
  const m = metricsAt(state);
  const degraded = m.http.errorRate > 0.05 || m.http.p95Ms > 150 || m.process.memoryMB > m.process.memoryLimitMB * 0.6;
  return { status: degraded ? 'degraded' : 'live', runningCommit: short(sha), ...d, restartCount: restarts + (state.action?.tool === 'restart_service' ? 1 : 0) };
}

function minutesBefore(iso, minutes) {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

function mockRecentErrors(sinceMinutes) {
  const state = getState();
  const m = metricsAt(state);
  if (m.http.errorRate < 0.05) return [];
  const firstSeen = new Date(Date.parse(state.startedAt) + 60_000).toISOString();
  if (Date.now() - Date.parse(firstSeen) > sinceMinutes * 60_000) return [];
  return [
    {
      title: 'Error: pool exhausted (10/10)',
      count: 214,
      firstSeen,
      lastSeen: new Date().toISOString(),
      release: short(runningSha(state)),
      culprit: 'GET /orders',
    },
  ];
}

// Samples covering [now + wait - seconds, now + wait]. Mock mode doesn't sleep: it evaluates
// the simulated world at those times, so "wait 60s then check" is instant in tests.
function mockWindow(seconds, intervalSec, waitSeconds) {
  const state = getState();
  const end = Date.now() + waitSeconds * 1000;
  const out = [];
  for (let t = end - seconds * 1000; t <= end; t += intervalSec * 1000) out.push(metricsAt(state, t));
  return out;
}

function buildServer() {
  const server = createMcpServer(name);
  const isMock = mockMode();

  server.registerTool(
    'get_service_status',
    {
      description: 'Returns current service status, the running commit, and the current + previous deploy (use previousDeploy.id as the rollback target)',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => (isMock ? ok(mockServiceStatus(), 'cloud-mcp.get_service_status') : notImplemented('cloud-mcp.get_service_status'))
  );

  server.registerTool(
    'get_metrics',
    {
      description: 'Returns the current metrics snapshot from the demo app (/metrics)',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (isMock) return ok(metricsAt(getState()), 'cloud-mcp.get_metrics');
      try {
        return ok(await fetchMetrics(), 'cloud-mcp.get_metrics');
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message, source: 'cloud-mcp.get_metrics' }) }] };
      }
    }
  );

  server.registerTool(
    'get_metrics_window',
    {
      description:
        'Returns metrics samples over a time window. For verification after a fix, set waitSeconds (e.g. 60) to wait first and get only fresh samples.',
      inputSchema: {
        seconds: z.number().int().positive().max(300).default(60),
        intervalSec: z.number().int().positive().max(60).default(10),
        waitSeconds: z.number().int().min(0).max(180).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ seconds = 60, intervalSec = 10, waitSeconds = 0 }) => {
      if (isMock) {
        return ok({ samples: mockWindow(seconds, intervalSec, waitSeconds), simulated: true }, 'cloud-mcp.get_metrics_window');
      }
      if (waitSeconds > 0) await sleep(waitSeconds * 1000);
      const cutoff = Date.now() - seconds * 1000;
      const window = samples.filter((s) => Date.parse(s.timestamp) >= cutoff);
      return ok({ samples: window }, 'cloud-mcp.get_metrics_window');
    }
  );

  server.registerTool(
    'get_recent_errors',
    {
      description: 'Returns recent Sentry issues, each tagged with the release (commit SHA) it happened on',
      inputSchema: { sinceMinutes: z.number().int().positive().max(1440).default(30) },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceMinutes = 30 }) =>
      isMock ? ok({ issues: mockRecentErrors(sinceMinutes) }, 'cloud-mcp.get_recent_errors') : notImplemented('cloud-mcp.get_recent_errors')
  );

  server.registerTool(
    'restart_service',
    {
      description: 'Restarts the demo service. Destructive: requires human approval.',
      inputSchema: { reason: z.string().describe('Why the restart is needed') },
      annotations: { destructiveHint: true },
    },
    async ({ reason }) => {
      console.log(`[${name}] restart_service EXECUTED — reason: ${reason}`);
      if (!isMock) return notImplemented('cloud-mcp.restart_service');
      recordAction('restart_service', { reason });
      return ok({ ok: true, deployId: 'dep-restart-1', at: new Date().toISOString() }, 'cloud-mcp.restart_service');
    }
  );

  server.registerTool(
    'scale_service',
    {
      description: 'Scales the demo service instances. Destructive: requires human approval.',
      inputSchema: { instances: z.number().int().min(1).max(3), reason: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ instances, reason }) => {
      console.log(`[${name}] scale_service EXECUTED — instances: ${instances}, reason: ${reason}`);
      if (!isMock) return notImplemented('cloud-mcp.scale_service');
      recordAction('scale_service', { instances, reason });
      return ok({ ok: true, instances, at: new Date().toISOString() }, 'cloud-mcp.scale_service');
    }
  );

  server.registerTool(
    'clear_cache',
    {
      description: 'Clears the in-process cache. Destructive: requires human approval.',
      inputSchema: { reason: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ reason }) => {
      console.log(`[${name}] clear_cache EXECUTED — reason: ${reason}`);
      if (isMock) {
        const before = metricsAt(getState()).cache.entries;
        recordAction('clear_cache', { reason });
        return ok({ ok: true, cleared: before, at: new Date().toISOString() }, 'cloud-mcp.clear_cache');
      }
      const res = await fetch(`${DEMO_APP_URL}/admin/cache/clear`, { method: 'POST', headers: { 'x-admin-token': ADMIN_TOKEN } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `clear_cache → ${res.status}`, body }) }] };
      return ok({ ok: true, cleared: body.cleared, at: new Date().toISOString() }, 'cloud-mcp.clear_cache');
    }
  );

  return server;
}

createHttpServer(name, PORT, buildServer);
