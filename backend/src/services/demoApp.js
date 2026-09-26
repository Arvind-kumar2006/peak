// Demo-app proxy (P1's service on :3000).
//
// Two jobs: forward the admin calls the dashboard makes, and read /metrics for
// the chart. The important design decision here is the **synthetic fallback**.
//
// P1's service may not be running when we build or rehearse. A metrics chart
// that renders a plausible baseline beats an empty panel, and a dead inject
// button that reports "demo app not running" beats one that silently does
// nothing. So: forward when we can, synthesise when we can't, and always tell
// the dashboard which one it got via a `source` field.

import { config } from '../config.js';
import { logger } from '../logger.js';

async function call(method, path, { admin = false, timeoutMs } = {}) {
  const headers = {};
  if (admin) headers['x-admin-token'] = config.demoApp.adminToken;
  const res = await fetch(`${config.demoApp.url}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs ?? config.demoApp.timeoutMs),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`demo-app ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Scenario names the dashboard uses → the MCP mock world's scenarios (mcp/_shared/mockState.js).
const MOCK_SCENARIOS = { 'conn-leak': 'A', 'mem-leak': 'B' };

/**
 * The MCP servers' shared mock world (MOCK=1), used when P1's app isn't running.
 * Without this, Simulate injected into a demo app that wasn't there, the agent
 * investigated whatever state the mock world was left in, and the chart drew
 * random healthy numbers instead of the incident.
 */
async function mockWorld(method, path, body) {
  if (!config.mockWorld.url) return null;
  const res = await fetch(`${config.mockWorld.url}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`mock world ${method} ${path} → ${res.status}`);
  return res.json();
}

export function createDemoApp() {
  let reachable = null; // cached reachability so the chart stops hammering a dead host
  let lastReachableAt = 0;

  async function isReachable() {
    if (reachable !== null && Date.now() - lastReachableAt < 10_000) return reachable;
    try {
      await call('GET', '/health', { timeoutMs: 2000 });
      reachable = true;
    } catch {
      reachable = false;
    }
    lastReachableAt = Date.now();
    return reachable;
  }

  return {
    async inject(scenario) {
      if (!(await isReachable()) && config.mockWorld.url) {
        try {
          const result = await mockWorld('POST', '/mock/state', { scenario: MOCK_SCENARIOS[scenario] ?? scenario });
          logger.info('scenario injected into the MCP mock world', { scenario, result });
          return { ok: true, result, target: 'mock' };
        } catch (err) {
          logger.error('mock world inject failed (continuing anyway)', { scenario, err: err.message });
          return { ok: false, error: err.message };
        }
      }
      try {
        const result = await call('POST', `/admin/inject/${scenario}`, { admin: true });
        logger.info('scenario injected', { scenario, result });
        return { ok: true, result };
      } catch (err) {
        // Non-fatal: the incident is still worth investigating, and a judge
        // watching shouldn't see a 500 because the app we're meant to be
        // debugging happens to be down.
        logger.error('inject failed (continuing anyway)', { scenario, err: err.message });
        return { ok: false, error: err.message };
      }
    },

    async reset() {
      if (!(await isReachable()) && config.mockWorld.url) {
        const result = await mockWorld('POST', '/mock/state', { scenario: 'healthy' });
        logger.info('mock world reset', { result });
        return result;
      }
      const result = await call('POST', '/admin/reset', { admin: true });
      logger.info('demo app reset', { result });
      return result;
    },

    async health() {
      return call('GET', '/health', { timeoutMs: 2000 });
    },

    /**
     * Current metrics. Falls back to a synthetic baseline so the dashboard has
     * something to draw before P1's service is up. The `source` field is passed
     * through to the UI, which shows a "simulated" badge — we never let the
     * audience think synthetic numbers are real.
     */
    async metrics() {
      if (await isReachable()) {
        try {
          const real = await call('GET', '/metrics');
          return { ...real, source: 'demo-app' };
        } catch (err) {
          logger.warn('metrics read failed, synthesising', { err: err.message });
        }
      }
      if (config.mockWorld.url) {
        try {
          return { ...(await mockWorld('GET', '/mock/metrics')), source: 'mock' };
        } catch (err) {
          logger.warn('mock world metrics read failed, synthesising', { err: err.message });
        }
      }
      return { ...syntheticMetrics(), source: 'synthetic' };
    },

    isReachable,
  };
}

/**
 * A plausible healthy baseline with a little noise, so the chart looks alive
 * during frontend work. Deliberately *healthy* — a synthetic incident would
 * misrepresent P1's scenario, and the scenarios are P1's to own.
 */
function syntheticMetrics() {
  const jitter = (base, spread) => base + (Math.random() - 0.5) * spread;
  return {
    timestamp: new Date().toISOString(),
    release: 'synthetic',
    http: {
      rpm: Math.round(jitter(240, 20)),
      errorRate: Math.max(0, Number(jitter(0.002, 0.003).toFixed(4))),
      p95Ms: Math.round(jitter(120, 30)),
    },
    db: { pool: { max: 10, inUse: Math.round(jitter(3, 3)), idle: 7, waiting: 0 } },
    process: { memoryMB: Math.round(jitter(180, 20)), memoryLimitMB: 512 },
    cache: { entries: Math.round(jitter(1200, 200)) },
  };
}
