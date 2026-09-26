import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

const { Pool } = pg;

let pool = null;

/**
 * Callers currently blocked inside pool.connect(). pg exposes waitingCount in
 * recent versions, but we count it ourselves so /metrics never depends on the
 * pg version — and so `db.pool.waiting` in the contract is always truthful.
 */
let waiting = 0;

/**
 * Every client handed out, with the time it was checked out.
 *
 * Tracking all checkouts (not just deliberately leaked ones) is what lets
 * POST /admin/reset drain the pool no matter which code path stranded a client
 * — including the bad commit's reconciler, which never registers anything.
 * Reclamation is gated on a grace period so a reset during live traffic cannot
 * yank a client out from under an in-flight query: no legitimate query here
 * takes longer than LEAK_GRACE_MS, so anything older is stranded by definition.
 */
const checkedOut = new Map();

const LEAK_GRACE_MS = Number(process.env.LEAK_GRACE_MS || 30000);

export class PoolExhaustedError extends Error {
  constructor(total, max, cause) {
    // The exact string the agent and scenarios.md quote: "pool exhausted (10/10)".
    super(`pool exhausted (${total}/${max})`);
    this.name = 'TimeoutError';
    this.code = 'POOL_EXHAUSTED';
    this.poolTotal = total;
    this.poolMax = max;
    if (cause) this.cause = cause;
  }
}

export function getPool() {
  if (pool) return pool;

  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.pool.max,
    connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
    idleTimeoutMillis: config.pool.idleTimeoutMillis,
  });

  // A backend disconnect must not take the process down. On Render that would
  // look like our own crash and confuse the incident story.
  pool.on('error', (err) => {
    logger.error('postgres pool error', { error: err.message, code: err.code });
  });

  return pool;
}

function isConnectTimeout(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  return /timeout exceeded when trying to connect|timeout when trying to connect/i.test(msg);
}

/** Acquire a client, or fail fast with a legible error once the pool is dry. */
export async function acquire() {
  const p = getPool();
  waiting += 1;
  try {
    const client = await p.connect();
    checkedOut.set(client, Date.now());
    return client;
  } catch (err) {
    if (isConnectTimeout(err)) {
      throw new PoolExhaustedError(p.totalCount, p.options.max, err);
    }
    throw err;
  } finally {
    waiting -= 1;
  }
}

/** Release a client we own. Safe to call twice. */
export function release(client) {
  if (!client) return;
  checkedOut.delete(client);
  try {
    client.release();
  } catch {
    /* already released or destroyed */
  }
}

/** Clients held longer than the grace period — i.e. genuinely stranded. */
export function leakedCount(graceMs = LEAK_GRACE_MS) {
  const cutoff = Date.now() - graceMs;
  let n = 0;
  for (const at of checkedOut.values()) if (at < cutoff) n += 1;
  return n;
}

/**
 * Reclaim every stranded client: roll back the dangling transaction, then hand
 * the connection back to the pool. This is what makes /admin/reset fast
 * (contract: < 5s) and repeatable, and it works against the Scenario A bad
 * commit even though that code never registers anything.
 */
export async function reclaimLeaked(graceMs = LEAK_GRACE_MS) {
  const cutoff = Date.now() - graceMs;
  const stranded = [...checkedOut.entries()].filter(([, at]) => at < cutoff);
  let reclaimed = 0;
  for (const [client] of stranded) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be gone */
    }
    checkedOut.delete(client);
    try {
      client.release();
      reclaimed += 1;
    } catch {
      /* ignore */
    }
  }
  if (reclaimed > 0) {
    logger.warn('reclaimed stranded clients', { reclaimed, poolTotal: p_total() });
  }
  return reclaimed;
}

function p_total() {
  return pool ? pool.totalCount : 0;
}

/** True when the pool is no longer saturated and nothing is queueing. */
export function poolHealthy() {
  const s = poolStats();
  return s.inUse < s.max && s.waiting === 0;
}

/**
 * Give in-flight work a moment to finish so a reset reports a settled pool.
 *
 * Deliberately not "every client idle": under continuous traffic one client is
 * virtually always checked out, so that condition would never be true and every
 * reset would report failure. What matters is that the pool is no longer
 * saturated and the queue has drained.
 */
export async function waitForPoolHealthy(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (poolHealthy() && poolStats().inUse === 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return poolHealthy();
}

/** Live pool counters for GET /metrics. This is the *app's* pool, not Postgres. */
export function poolStats() {
  const p = pool;
  if (!p) {
    return { max: config.pool.max, inUse: 0, idle: 0, waiting: 0, total: 0 };
  }
  return {
    max: p.options.max ?? config.pool.max,
    total: p.totalCount,
    inUse: p.totalCount - p.idleCount,
    idle: p.idleCount,
    waiting,
  };
}

export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  checkedOut.clear();
  await p.end().catch(() => {});
}
