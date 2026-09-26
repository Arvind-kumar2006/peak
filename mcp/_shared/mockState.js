// Shared mock world for MOCK=1, so the three MCP servers (separate processes) agree:
// a trigger_rollback in github-mcp must change the metrics cloud-mcp reports.
// State lives in a small JSON file; numbers are P1's measured values (demo-app/README.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_FILE = process.env.MOCK_STATE_FILE ?? path.join(os.tmpdir(), 'peak-mock-state.json');

// Real commits from this repo: the Scenario A bad commit and its parent.
export const GOOD_SHA = '1e82fab38f75c38dda9dda331a2bc29190c9f09e';
export const BAD_SHA = '5a824ff0aec68b9d8ea362b81a1d98805d5872f7';
export const short = (sha) => sha.slice(0, 7);

// scenario: 'A' (conn leak via bad deploy) | 'B' (cache growth, no deploy) | 'healthy'
// startedAt: the incident is already ~3 minutes old when someone triggers the agent.
function defaultState(scenario = process.env.MOCK_SCENARIO ?? 'A') {
  return { scenario, startedAt: new Date(Date.now() - 3 * 60_000).toISOString(), action: null };
}

export function getState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return resetState();
  }
}

export function resetState(scenario) {
  const state = defaultState(scenario);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  return state;
}

// Called by every mocked write tool.
export function recordAction(tool, args) {
  const state = getState();
  state.action = { tool, args, at: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  return state;
}

// What each write tool does to each scenario:
//   'fixed'     → incident gone for good
//   'recurring' → symptoms clear, then come back (restart during a leak → "mitigated")
//   'none'      → no effect
const EFFECTS = {
  A: { trigger_rollback: 'fixed', restart_service: 'recurring' },
  B: { clear_cache: 'fixed', restart_service: 'fixed' },
};

export function effectOf(state) {
  if (!state.action) return 'none';
  return EFFECTS[state.scenario]?.[state.action.tool] ?? 'none';
}

const HEALTHY = {
  http: { rpm: 240, errorRate: 0.002, p95Ms: 3 },
  db: { pool: { max: 10, inUse: 1, idle: 9, waiting: 0 } },
  process: { memoryMB: 26, memoryLimitMB: 512 },
  cache: { entries: 40 },
};

const INCIDENT = {
  A: {
    http: { rpm: 240, errorRate: 0.3, p95Ms: 2003 },
    db: { pool: { max: 10, inUse: 10, idle: 0, waiting: 7 } },
    process: { memoryMB: 31, memoryLimitMB: 512 },
    cache: { entries: 40 },
  },
  B: {
    http: { rpm: 240, errorRate: 0.004, p95Ms: 173 },
    db: { pool: { max: 10, inUse: 1, idle: 9, waiting: 0 } },
    process: { memoryMB: 385, memoryLimitMB: 512 },
    cache: { entries: 717 },
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// Running release: the bad commit is live in Scenario A until it is rolled back.
export function runningSha(state) {
  if (state.scenario === 'A' && !(state.action?.tool === 'trigger_rollback')) return BAD_SHA;
  return GOOD_SHA;
}

// Metrics snapshot at time t (ms). Contract: contracts/demo-app-api.md
export function metricsAt(state, t = Date.now()) {
  // Samples from before the action show the world as it was then.
  if (state.action && t < Date.parse(state.action.at)) state = { ...state, action: null };
  const effect = effectOf(state);
  const sinceAction = state.action ? (t - Date.parse(state.action.at)) / 1000 : 0;
  let m;
  if (state.scenario === 'healthy' || effect === 'fixed') {
    m = clone(HEALTHY);
  } else if (effect === 'recurring' && state.scenario === 'A') {
    // Restart drains the pool, then the leak takes one client every ~6s again.
    m = clone(HEALTHY);
    const leaked = Math.min(10, 1 + Math.floor(sinceAction / 6));
    m.db.pool = { max: 10, inUse: leaked, idle: 10 - leaked, waiting: leaked >= 10 ? 7 : 0 };
    if (leaked >= 10) m.http = clone(INCIDENT.A.http);
  } else {
    m = clone(INCIDENT[state.scenario]);
  }
  return { timestamp: new Date(t).toISOString(), release: short(runningSha(state)), ...m };
}

