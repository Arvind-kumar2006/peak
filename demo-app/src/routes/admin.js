import { timingSafeEqual } from 'node:crypto';
import { config, scenarios as VALID } from '../config.js';
import { inject, clearFaults, faults } from '../faults.js';
import { clearCache } from '../cache.js';
import { reclaimLeaked, waitForPoolHealthy, poolStats } from '../db/pool.js';
import { snapshot, resetSamples } from '../metrics.js';
import { logger } from '../logger.js';

function tokenMatches(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(config.adminToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** x-admin-token guard for every /admin/* route. */
export function requireAdmin(req, res, next) {
  if (!tokenMatches(req.get('x-admin-token'))) {
    logger.warn('admin request rejected: bad token', { path: req.path, ip: req.ip });
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

/** POST /admin/inject/:scenario */
export function injectScenario(req, res) {
  const { scenario } = req.params;
  if (!VALID.includes(scenario)) {
    res.status(400).json({ error: 'unknown_scenario', allowed: VALID });
    return;
  }
  const out = inject(scenario);
  logger.warn('fault injected', { scenario, faults: { ...faults } });
  res.json(out);
}

/**
 * POST /admin/reset
 *
 * Contract: clears all injected faults, drains the pool, clears the cache —
 * and must do it in under 5s so rehearsals are fast and repeatable. Leaked
 * clients are rolled back and returned rather than waiting for the pool to
 * time them out, which is what keeps this at ~100ms.
 */
export async function reset(_req, res) {
  const cleared = clearFaults();
  // graceMs 0: an operator reset means "make this healthy now", so reclaim
  // every outstanding client immediately instead of waiting out the leak grace
  // period. Safe because faults are already cleared, so no new checkouts are
  // being started against the pool.
  const reclaimed = await reclaimLeaked(0);
  const poolRecovered = await waitForPoolHealthy(3000);
  const cacheEntries = clearCache();
  resetSamples();

  const m = snapshot();
  logger.warn('reset complete', {
    clearedFaults: cleared,
    reclaimedClients: reclaimed,
    poolRecovered,
    cacheEntries,
    pool: m.db.pool,
  });

  res.json({
    reset: true,
    clearedFaults: cleared,
    reclaimedClients: reclaimed,
    poolRecovered,
    cacheCleared: cacheEntries,
    pool: poolStats(),
  });
}

/**
 * POST /admin/cache/clear — what cloud-mcp.clear_cache calls.
 *
 * Clearing the cache also stops the injected unbounded growth. That is the
 * honest semantics of this fix, not a shortcut: the growth models a runaway
 * cache-fill job, and clearing the cache is the operator action that stops it.
 * Without this, the very next request would re-add an entry and Scenario B
 * could never reach "resolved" — the agent would correctly report not_resolved
 * forever, and the demo would hang at the last step.
 */
export async function cacheClear(_req, res) {
  const stoppedGrowth = faults.cacheGrowth;
  const cleared = clearCache();
  if (stoppedGrowth) {
    faults.cacheGrowth = false;
    logger.warn('cache cleared and runaway fill stopped', { cleared });
  } else {
    logger.warn('cache cleared', { cleared });
  }
  res.json({ cleared, stoppedGrowth });
}

/** GET /admin/state — current fault state, handy during rehearsals. */
export function state(_req, res) {
  res.json({ faults: { ...faults }, pool: poolStats(), metrics: snapshot()._diag });
}
