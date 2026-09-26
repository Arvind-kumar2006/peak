import { uptimeSec, RELEASE } from '../release.js';
import { snapshot } from '../metrics.js';
import { poolStats } from '../db/pool.js';
import { config } from '../config.js';
import { faults } from '../faults.js';

const DEGRADED_ERROR_RATE = 0.05;
const DEGRADED_MEMORY_RATIO = 0.6;

/** GET /health — exactly the three fields in contracts/demo-app-api.md. */
export function health(_req, res) {
  const m = snapshot();
  const pool = m.db.pool;
  const memoryRatio = m.process.memoryMB / config.memoryLimitMB;

  let status = 'ok';
  if (pool.inUse >= pool.max || m.http.errorRate > DEGRADED_ERROR_RATE || memoryRatio > 0.9) {
    status = 'down';
  } else if (pool.waiting > 0 || m.http.errorRate > 0.01 || memoryRatio > DEGRADED_MEMORY_RATIO) {
    status = 'degraded';
  }

  res.status(status === 'down' ? 503 : 200).json({
    status,
    release: RELEASE.full,
    uptimeSec: uptimeSec(),
  });
}

/** GET /metrics — exactly the shape in contracts/demo-app-api.md. */
export function metrics(_req, res) {
  res.json(snapshot());
}

/** P1-only diagnostics. Not part of any contract. */
export function diag(_req, res) {
  res.json({
    release: { ...RELEASE, startedAt: RELEASE.startedAt.toISOString() },
    uptimeSec: uptimeSec(),
    pool: poolStats(),
    faults: { ...faults },
    config: {
      pool: config.pool,
      windows: config.windows,
      memoryLimitMB: config.memoryLimitMB,
      reconcile: config.reconcile,
      cache: config.cache,
      traffic: config.traffic,
    },
    metrics: snapshot()._diag,
  });
}
