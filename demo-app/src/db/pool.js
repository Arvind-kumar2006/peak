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
 * Clients this process deliberately failed to release (the injected leak).
 * Tracked so POST /admin/reset can actually reclaim them instead of leaving the
 * pool permanently exhausted between rehearsals.
 */
const leaked = new Set();

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

/**
 * Acquire a client, or fail fast with a legible error once the pool is dry.
 * `registerLeak` is used only by the injected-fault code path.
 */
export async function acquire({ registerLeak = false } = {}) {
  const p = getPool();
  waiting += 1;
  try {
    const client = await p.connect();
    if (registerLeak) leaked.add(client);
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
  leaked.delete(client);
  try {
    client.release();
  } catch {
    /* already released or destroyed */
  }
}

export function leakedCount() {
  return leaked.size;
}

/**
 * Reclaim every leaked client: roll back the dangling transaction, then hand
 * the connection back to the pool. This is what makes /admin/reset fast
 * (contract: < 5s) and repeatable.
 */
export async function reclaimLeaked() {
  const clients = [...leaked];
  let reclaimed = 0;
  for (const client of clients) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be gone */
    }
    try {
      client.release();
      reclaimed += 1;
    } catch {
      /* ignore */
    }
  }
  leaked.clear();
  if (reclaimed > 0) {
    logger.info('reclaimed leaked clients', { reclaimed, remaining: p_total() });
  }
  return reclaimed;
}

function p_total() {
  return pool ? pool.totalCount : 0;
}

/** Wait (bounded) for the pool to fall back to zero in-use clients. */
export async function waitForPoolIdle(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pool) return true;
    if (pool.idleCount >= pool.totalCount) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pool ? pool.idleCount >= pool.totalCount : true;
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
  leaked.clear();
  await p.end().catch(() => {});
}
