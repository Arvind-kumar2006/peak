import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { recordRequest } from './metrics.js';
import { captureException } from './sentry.js';
import { RELEASE } from './release.js';
import { cacheLatencyPenaltyMs } from './cache.js';
import { health, metrics, diag } from './routes/observability.js';
import { orders, orderById, products, summary, notFound } from './routes/data.js';
import { requireAdmin, injectScenario, reset, cacheClear, state } from './routes/admin.js';

/** Paths that must not count towards http.rpm / errorRate / p95Ms. */
const UNMEASURED = new Set(['/health', '/metrics', '/_diag']);

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  /**
   * Records latency + outcome for every business request. Under Scenario B the
   * cache penalty rides in here, which is how "memory climbing" turns into
   * "p95 latency climbing" on the dashboard.
   */
  app.use((req, res, next) => {
    const path = req.path.split('?')[0];
    if (UNMEASURED.has(path) || path.startsWith('/admin')) {
      next();
      return;
    }

    const penalty = cacheLatencyPenaltyMs();
    const startedAt = process.hrtime.bigint();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      recordRequest(Math.round(elapsedMs + penalty), ok);
    };

    res.on('finish', () => finish(res.statusCode < 500));
    res.on('close', () => finish(res.statusCode < 500));

    if (penalty > 0) setTimeout(next, penalty);
    else next();
  });

  app.get('/health', health);
  app.get('/metrics', metrics);
  app.get('/_diag', diag);

  app.get('/orders', asyncHandler(orders));
  app.get('/orders/:id', asyncHandler(orderById));
  app.get('/products', asyncHandler(products));
  app.get('/summary', asyncHandler(summary));

  app.post('/admin/inject/:scenario', requireAdmin, injectScenario);
  app.post('/admin/reset', requireAdmin, asyncHandler(reset));
  app.post('/admin/cache/clear', requireAdmin, asyncHandler(cacheClear));
  app.get('/admin/state', requireAdmin, state);

  app.use(notFound);

  // Central error handler. Every 500 is logged with the release SHA and sent to
  // Sentry, which is what gives the agent "Sentry errors tagged with the bad
  // SHA" to work with.
  app.use((err, req, res, _next) => {
    const status = err?.code === 'POOL_EXHAUSTED' ? 500 : err?.status || 500;
    const message = err?.message || 'internal_error';

    if (status >= 500) {
      logger.error(message, {
        path: req.path,
        method: req.method,
        code: err?.code,
        status,
        poolTotal: err?.poolTotal,
        poolMax: err?.poolMax,
      });
      captureException(err, { tags: { path: req.path, code: err?.code || 'INTERNAL' } });
    }

    if (res.headersSent) return;
    res.status(status).json({ error: message, code: err?.code || 'INTERNAL', release: RELEASE.short });
  });

  return app;
}
