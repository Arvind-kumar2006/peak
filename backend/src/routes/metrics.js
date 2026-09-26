// /api/metrics — live metrics for the dashboard chart.
//
// The one behaviour worth calling out: when the demo app is unreachable we
// return the **last known sample** with `stale: true` and HTTP 200, not a 502.
// A chart that freezes with a "stale" badge tells the truth; a red error panel
// during a live demo is a distraction, and a judge cannot tell the difference
// between "we cached it" and "it's broken" unless we label it.

import express from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export function createMetricsRouter({ store, demoApp }) {
  const router = express.Router();
  let cache = { at: 0, value: null };

  router.get('/', asyncHandler(async (_req, res) => {
    if (Date.now() - cache.at < config.metricsCacheMs && cache.value) {
      return res.json(cache.value);
    }

    try {
      const metrics = await demoApp.metrics();
      cache = { at: Date.now(), value: metrics };
      return res.json(metrics);
    } catch (err) {
      const last = await store.latestSample();
      logger.warn('live metrics unavailable, serving last known sample', { err: err.message });
      return res.json({
        ...(last?.raw ?? {}),
        at: last?.at ?? null,
        stale: true,
        source: 'cache',
        message: `Live metrics unavailable (${err.message}). Showing the last recorded sample.`,
      });
    }
  }));

  return router;
}
