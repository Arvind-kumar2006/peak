// Central config for the P4 backend.
//
// Loads backend/.env if present (no dotenv dependency — P1's demo-app reads
// process.env directly, and a 10-line loader is cheaper than the dependency
// plus the lockfile churn). Real environment variables always win over .env,
// so a one-off override on the command line still does what you expect.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');

try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Don't clobber a real env var, and ignore the `export KEY=` style.
    if (key in process.env) continue;
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
} catch {
  // No .env file. Everything must come from the environment. Fine.
}

const num = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const oneOf = (v, allowed, d) => {
  if (v === undefined || v === null || v === '') return d;
  if (allowed.includes(v)) return v;
  // Warn rather than silently defaulting. A typo in a mode name should not
  // turn into a confusing behaviour difference ten minutes before a demo.
  console.warn(
    `[config] "${v}" is not one of ${allowed.join(' | ')} — falling back to "${d}".`,
  );
  return d;
};

export const config = {
  port: num(process.env.PORT, 4000),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  trueforge: {
    url: (process.env.TRUEFORGE_URL || 'http://localhost:8790').replace(/\/+$/, ''),
    // auto resolves at boot: use the real runtime when it answers, otherwise
    // fall back to the scripted fake. This is what lets the dashboard be built
    // and demoed before P3's agent exists, with zero code changes later.
    // NOTE: this was briefly spelled TRUIFORGE_MODE, and earlier drafts of the
    // docs used that. Both are accepted so nobody who copied one gets silently
    // ignored — and an unrecognised value now warns instead of quietly
    // defaulting, because "I asked for real and got the fake" is the kind of
    // thing you find out about during a demo.
    mode: oneOf(
      process.env.TRUEFORGE_MODE ?? process.env.TRUIFORGE_MODE,
      ['auto', 'real', 'fake'],
      'auto',
    ),
    // Only used for display. The AgentSpec and the prompt come from P3
    // (agent/agent-spec.mjs) so the backend and the agent can't drift apart.
    agentName: process.env.TRUEFORGE_AGENT_NAME || 'incident-investigator',
    // How often the background poller reads session state. The dashboard polls
    // us every 2s, so this is faster: a 2s dashboard poll should never show a
    // status that is already stale.
    pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 1500),
  },

  demoApp: {
    url: (process.env.DEMO_APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    adminToken: process.env.ADMIN_TOKEN || 'change-me',
    timeoutMs: num(process.env.DEMO_APP_TIMEOUT_MS, 8000),
  },

  store: {
    // P4 gets its own DSN and its own `peak` schema. Sharing P1's DATABASE_URL
    // would mean our migrations and theirs share a failure surface during the
    // one incident we are supposed to be debugging.
    url: process.env.PEAK_DATABASE_URL || process.env.DATABASE_URL || '',
    schema: process.env.PEAK_DB_SCHEMA || 'peak',
  },

  // Dashboard polls every 2s (contracts/backend-api.md). Anything slower makes
  // Approve feel broken on stage; anything faster just burns Neon reads.
  metricsCacheMs: num(process.env.METRICS_CACHE_MS, 1000),
};

/** Scenarios the demo app accepts. Mirrors contracts/demo-app-api.md. */
export const SCENARIOS = ['conn-leak', 'mem-leak'];

/**
 * Resolves `auto` mode by asking TrueForge whether it is up. Never throws: a
 * failed probe means "use the fake", which is a working demo either way.
 */
export async function resolveTrueforgeMode() {
  if (config.trueforge.mode !== 'auto') return config.trueforge.mode;
  try {
    const res = await fetch(`${config.trueforge.url}/api/v1/agents`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? 'real' : 'fake';
  } catch {
    return 'fake';
  }
}
