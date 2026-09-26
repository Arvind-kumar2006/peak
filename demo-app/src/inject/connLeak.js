import { acquire, release, poolStats, leakedCount } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Scenario A fault injector — LOCAL DEVELOPMENT ONLY.
 *
 * This exists because contracts/scenarios.md requires
 * `POST /admin/inject/conn-leak` to reproduce the leak without a redeploy, so
 * P2/P3/P4 can develop against a broken service before the bad commit is
 * deployed to Render.
 *
 * It produces byte-for-byte the same symptoms as the bad commit:
 *   pool.inUse climbs to max -> requests block -> "pool exhausted (10/10)"
 *   -> TimeoutError -> 500s on /orders -> errorRate spikes
 *   -> pg_stat_activity fills with "idle in transaction".
 *
 * The leak itself lives in ONE place only (the `finally` that is missing) so
 * production query code in src/db/orders.js stays correct and reviewable. Every
 * client taken here is registered with the pool's leak registry, so
 * POST /admin/reset can roll it back and return it in well under 5s.
 */
const RECONCILE_SQL = `SELECT o.id, o.status, o.total_cents
  FROM orders o
  ORDER BY o.id DESC
  LIMIT 50`;

export async function leakOneTick() {
  const stats = poolStats();

  if (stats.inUse >= stats.max) {
    // Same log line the agent will quote as evidence.
    logger.warn(`pool exhausted (${stats.inUse}/${stats.max})`, {
      path: '/orders',
      strandedClients: leakedCount(),
      hint: 'all pool clients are checked out and idle in transaction',
    });
    // Still try to take a client so the acquire times out and surfaces as a
    // 500 on the request path, exactly as a genuinely dry pool would.
    try {
      const client = await acquire();
      await client.query('BEGIN');
      await client.query(RECONCILE_SQL);
      return 1;
    } catch (err) {
      logger.error(err.message, { source: 'conn-leak-injector', code: err.code });
      return 0;
    }
  }

  const client = await acquire();
  try {
    await client.query('BEGIN');
    await client.query(RECONCILE_SQL);
  } catch (err) {
    release(client);
    throw err;
  }
  // BUG REPRODUCED: no COMMIT, no release. The connection stays checked out
  // and the transaction stays open, so Postgres reports "idle in transaction".
  logger.debug('leaked a client', { inUse: poolStats().inUse, max: poolStats().max });
  return 1;
}
