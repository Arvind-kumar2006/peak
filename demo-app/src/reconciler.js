import { config } from './config.js';
import { faults } from './faults.js';
import { logger } from './logger.js';
import { reconcileRecentOrders } from './db/orders.js';
import { leakOneTick } from './inject/connLeak.js';

let timer = null;
let running = false;

/**
 * One reconciliation tick.
 *
 * Healthy: the real background job in src/db/orders.js. It scopes each client
 * correctly, so it is safe to run forever.
 *
 * Scenario A injected: run the fault injector instead, which leaks one client
 * per tick. At the default 6s interval and POOL_MAX 10 the pool saturates in
 * roughly one minute — slow enough to narrate, fast enough to demo.
 */
async function tick() {
  if (running) return;
  running = true;
  try {
    if (faults.connLeak) {
      await leakOneTick();
    } else {
      await reconcileRecentOrders();
    }
  } catch (err) {
    logger.warn('reconcile tick failed', { error: err.message, code: err.code });
  } finally {
    running = false;
  }
}

export function startReconciler() {
  if (timer) return;
  const intervalMs = Math.max(1000, config.reconcile.intervalSec * 1000);
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('reconciler started', { intervalSec: config.reconcile.intervalSec, pages: config.reconcile.pages });
}

export function stopReconciler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run a tick right now — used by the smoke test to avoid waiting. */
export async function runTickNow() {
  await tick();
}
