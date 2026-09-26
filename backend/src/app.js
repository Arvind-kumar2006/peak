// Express app assembly. Kept separate from index.js so tests can mount the app
// without binding a port or starting background loops.

import express from 'express';
import { asyncHandler } from './asyncHandler.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getAdapter } from './trueforge/adapter.js';
import { createIncidentsRouter } from './routes/incidents.js';
import { createDemoRouter } from './routes/demo.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createPoller } from './services/poller.js';
import { createSampler } from './services/sampler.js';
import { createDemoApp } from './services/demoApp.js';

export async function createApp({ store }) {
  const app = express();
  const demoApp = createDemoApp();
  const poller = createPoller({ store });
  const sampler = createSampler({ store, demoApp });

  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      // Skip the 2s dashboard poll in the log: at 2s intervals it would bury
      // everything interesting that happens during a demo.
      if (req.path === '/api/metrics' && res.statusCode === 200) return;
      logger.info(`${req.method} ${req.originalUrl} → ${res.statusCode}`, { ms: Date.now() - started });
    });
    next();
  });

  // Minimal CORS. The dashboard dev server proxies /api, so this only matters
  // when something calls the backend cross-origin (e.g. a second laptop during
  // rehearsal).
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigin.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Additive, not in the contract: lets the dashboard (and a judge) see which
  // adapter and store are live without guessing.
  app.get('/api/health', asyncHandler(async (_req, res) => {
    const adapter = await getAdapter();
    const demoReachable = await demoApp.isReachable();
    res.json({
      status: 'ok',
      agent: { mode: adapter.mode, url: config.trueforge.url, agentName: config.trueforge.agentName },
      store: { kind: store.kind },
      demoApp: { url: config.demoApp.url, reachable: demoReachable },
      version: '0.1.0',
    });
  }));

  app.use('/api/incidents', createIncidentsRouter({ store, demoApp, poller }));
  app.use('/api/demo', createDemoRouter({ store, demoApp }));
  app.use('/api/metrics', createMetricsRouter({ store, demoApp }));

  app.use((req, res) => res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` }));

  // Last-resort handler. Anything that reaches here is a bug, but the dashboard
  // still gets a message it can show.
  app.use((err, _req, res, _next) => {
    logger.error('unhandled error', { err: err.message, stack: err.stack?.split('\n')[1]?.trim() });
    res.status(err.status ?? 500).json({
      error: 'internal_error',
      message: err.message || 'Something went wrong in the backend.',
    });
  });

  return { app, poller, sampler, demoApp };
}
