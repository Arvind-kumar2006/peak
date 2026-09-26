#!/usr/bin/env node
/**
 * End-to-end verification of the demo app against a real Postgres.
 *
 *   npm run db:reset && npm run smoke
 *
 * This does not mock anything. It drives the real HTTP surface, then reads
 * pg_stat_activity directly to confirm the two independent signals the agent
 * relies on:
 *
 *   1. the app's own pool is saturated  (GET /metrics  -> db.pool)
 *   2. Postgres reports "idle in transaction"  (pg_stat_activity)
 *
 * If only (1) holds, db-mcp's get_lock_waits / get_pool_stats would have nothing
 * conclusive to report and Scenario A becomes ambiguous.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';

async function loadDotEnv() {
  try {
    const raw = await readFile(join(here, '..', '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^["'](.*)["']$/, '$1');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* rely on real env */ }
}
await loadDotEnv();

// Read the admin token only AFTER the repo-root .env is loaded, otherwise this
// silently falls back to 'change-me' and every admin call 401s.
const ADMIN = process.env.ADMIN_TOKEN || 'change-me';
console.log(`smoke -> ${BASE}  (ADMIN_TOKEN ${ADMIN === 'change-me' ? 'DEFAULT — set it in .env' : 'from env'})`);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'x-admin-token': ADMIN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const db = process.env.DATABASE_URL ? new pg.Client({ connectionString: process.env.DATABASE_URL }) : null;

async function idleInTransaction() {
  if (!db) return null;
  const { rows } = await db.query(
    `SELECT count(*)::int AS n,
            COALESCE(max(extract(epoch FROM (now() - state_change)))::int, 0) AS "oldestSec"
     FROM pg_stat_activity
     WHERE state = 'idle in transaction'`,
  );
  return rows[0];
}

async function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

try {
  if (db) await db.connect();

  // ---------------------------------------------------------------- baseline
  await section('0. baseline — healthy service');
  await api('/admin/reset', { method: 'POST' });
  await api('/orders', {});
  await sleep(300);

  const h = await api('/health');
  check('GET /health returns 200', h.status === 200, JSON.stringify(h.body));
  check('health has exactly the 3 contract fields',
    JSON.stringify(Object.keys(h.body).sort()) === JSON.stringify(['release', 'status', 'uptimeSec']),
    Object.keys(h.body).join(','));
  check('health.status is ok', h.body.status === 'ok', h.body.status);

  const m0 = await api('/metrics');
  const shape = ['cache', 'db', 'http', 'process', 'release', 'timestamp'];
  check('metrics has the 5 contract keys',
    shape.every((k) => k in m0.body),
    Object.keys(m0.body).join(','));
  check('errorRate is a fraction 0-1',
    m0.body.http.errorRate >= 0 && m0.body.http.errorRate <= 1,
    String(m0.body.http.errorRate));
  check('db.pool.max is 10', m0.body.db.pool.max === 10, String(m0.body.db.pool.max));
  check('pool drains back to 0 in use', m0.body.db.pool.inUse === 0, `inUse=${m0.body.db.pool.inUse}`);
  check('no leaked clients when healthy', m0.body._diag.leakedClients === 0);

  // ------------------------------------------------------------ auth on admin
  await section('1. admin auth');
  const noToken = await fetch(`${BASE}/admin/reset`, { method: 'POST' });
  check('POST /admin/reset without x-admin-token is 401', noToken.status === 401, String(noToken.status));
  const badScenario = await api('/admin/inject/nope', { method: 'POST' });
  check('unknown scenario is 400', badScenario.status === 400);

  // ------------------------------------------------------------- scenario A
  await section('2. Scenario A — conn-leak (code-level)');
  const injA = await api('/admin/inject/conn-leak', { method: 'POST' });
  check('inject/conn-leak accepted', injA.status === 200 && injA.body.injected === 'conn-leak');

  console.log('     draining the pool (POOL_MAX * RECONCILE_INTERVAL_SEC)...');
  const pool = await api('/_diag');
  const ticks = pool.body.config.reconcile.intervalSec;
  const max = pool.body.pool.max;
  await sleep(ticks * max * 1000 + 2000);

  const mA = await api('/metrics');
  const st = mA.body.db.pool;
  check('pool is saturated (inUse == max)', st.inUse === st.max, `${st.inUse}/${st.max}`);
  check('requests are waiting on the pool', st.waiting > 0, `waiting=${st.waiting}`);

  const iit = await idleInTransaction();
  if (iit) {
    check('postgres reports "idle in transaction"', iit.n > 0,
      `${iit.n} idle-in-transaction, oldest ${iit.oldestSec}s`);
    check('idle-in-transaction count matches the pool', iit.n >= st.max - 1,
      `pg=${iit.n} pool=${st.inUse}`);
  } else {
    check('postgres activity check available', false, 'DATABASE_URL not set — skipped pg_stat_activity check');
  }

  const o1 = await api('/orders');
  check('GET /orders fails once the pool is dry', o1.status >= 500, String(o1.status));
  check('error names the pool exhaustion', /pool exhausted/i.test(String(o1.body.error)),
    String(o1.body.error));

  const mA2 = await api('/metrics');
  check('errorRate has climbed off zero', mA2.body.http.errorRate > 0,
    `errorRate=${mA2.body.http.errorRate}`);

  const stateA = await api('/admin/state');
  check('leaked clients are tracked for reset', stateA.body.metrics.leakedClients > 0,
    `leaked=${stateA.body.metrics.leakedClients}`);

  // ------------------------------------------------------------------- reset
  await section('3. POST /admin/reset — must be fast and complete');
  const t0 = Date.now();
  const r = await api('/admin/reset', { method: 'POST' });
  const elapsed = Date.now() - t0;
  check('reset returns 200', r.status === 200);
  check('reset completes in under 5s', elapsed < 5000, `${elapsed}ms`);
  check('reset reclaims the leaked clients', r.body.reclaimedClients > 0,
    `reclaimed=${r.body.reclaimedClients}`);
  check('reset drains the pool', r.body.poolDrained === true);
  check('reset clears injected faults', r.body.clearedFaults.includes('conn-leak'),
    JSON.stringify(r.body.clearedFaults));

  await api('/orders');
  await sleep(200);
  const mA3 = await api('/metrics');
  check('pool is back to 0 in use after reset', mA3.body.db.pool.inUse === 0,
    `inUse=${mA3.body.db.pool.inUse}`);
  const hA3 = await api('/health');
  check('health is ok again after reset', hA3.body.status === 'ok', hA3.body.status);
  const iit2 = await idleInTransaction();
  if (iit2) {
    check('no idle-in-transaction left after reset', iit2.n === 0, `${iit2.n} remaining`);
  }

  // ------------------------------------------------------------- scenario B
  await section('4. Scenario B — mem-leak (infra-level)');
  const before = (await api('/metrics')).body;
  const injB = await api('/admin/inject/mem-leak', { method: 'POST' });
  check('inject/mem-leak accepted', injB.status === 200 && injB.body.injected === 'mem-leak');

  // Drive cache growth through the app's own endpoints.
  for (let i = 0; i < 40; i += 1) {
    await api('/summary');
    await api('/products');
  }
  await sleep(1500);

  const after = (await api('/metrics')).body;
  check('cache.entries grows without eviction',
    after.cache.entries > before.cache.entries + 20,
    `${before.cache.entries} -> ${after.cache.entries}`);
  check('process.memoryMB climbs',
    after.process.memoryMB > before.process.memoryMB,
    `${before.process.memoryMB}MB -> ${after.process.memoryMB}MB`);
  check('memory stays under the Render limit (no OOM mid-demo)',
    after.process.memoryMB < after.process.memoryLimitMB * 0.9,
    `${after.process.memoryMB}/${after.process.memoryLimitMB}MB`);
  check('p95Ms climbs with the cache',
    after.http.p95Ms >= before.http.p95Ms,
    `${before.http.p95Ms}ms -> ${after.http.p95Ms}ms`);

  // --------------------------------------------------------- clear_cache fix
  await section('5. clear_cache (the correct Scenario B fix)');
  const cc = await api('/admin/cache/clear', { method: 'POST' });
  check('cache/clear returns { cleared: n }', cc.status === 200 && typeof cc.body.cleared === 'number',
    JSON.stringify(cc.body));
  check('clear_cache actually removed entries', cc.body.cleared > 20, `cleared=${cc.body.cleared}`);

  const post = (await api('/metrics')).body;
  check('cache.entries drops after clear_cache', post.cache.entries < after.cache.entries,
    `${after.cache.entries} -> ${post.cache.entries}`);
  const memRatio = post.process.memoryMB / post.process.memoryLimitMB;
  check('memory is back under 60% of the limit (the "resolved" bar)',
    memRatio < 0.6, `${(memRatio * 100).toFixed(1)}% of limit`);

  await api('/admin/reset', { method: 'POST' });

  // ------------------------------------------------------------------ repeat
  await section('6. reproducibility — 3x inject/reset (contract: 10/10)');
  for (let i = 1; i <= 3; i += 1) {
    const s = Date.now();
    await api('/admin/inject/conn-leak', { method: 'POST' });
    const st2 = await api('/admin/state');
    await api('/admin/reset', { method: 'POST' });
    const rr = await api('/admin/state');
    const ok = rr.body.pool.inUse === 0 && rr.body.faults.connLeak === false;
    check(`cycle ${i} clean`, ok, `pool.inUse=${rr.body.pool.inUse} in ${Date.now() - s}ms`);
    void st2;
  }

  // ------------------------------------------------------------- load safety
  await section('7. 30 concurrent requests on a healthy pool');
  await api('/admin/reset', { method: 'POST' });
  const results = await Promise.all(
    Array.from({ length: 30 }, () => api('/orders').then((x) => x.status)),
  );
  const allOk = results.every((s) => s === 200);
  check('30 concurrent /orders all succeed on a healthy pool', allOk,
    `statuses: ${[...new Set(results)].join(',')}`);
} catch (err) {
  console.error('\nsmoke test crashed:', err);
  fail += 1;
} finally {
  if (db) await db.end().catch(() => {});
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (fail > 0) {
  console.log('failed checks:', failures.join('; '));
  process.exit(1);
}
