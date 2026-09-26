// /api/demo — operator controls for the demo app (P1).
//
// Thin proxy. The token check lives in P1's service; we forward ADMIN_TOKEN and
// surface their errors, because duplicating auth here would create two places
// to get it wrong.

import express from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { logger } from '../logger.js';
import { STATUS, TERMINAL_STATUSES } from '../domain/status.js';

export function createDemoRouter({ store, demoApp }) {
  const router = express.Router();

  // POST /api/demo/reset
  router.post('/reset', asyncHandler(async (_req, res) => {
    try {
      const result = await demoApp.reset();
      logger.info('demo reset via dashboard', { result });

      // A reset invalidates any in-flight investigation: the app the agent was
      // diagnosing no longer exists in that state. Close the open incidents so
      // the feed doesn't show a permanently "investigating" row after a reset
      // during rehearsal.
      const open = (await store.listIncidents({ limit: 50 })).filter((i) => !TERMINAL_STATUSES.has(i.status));
      await Promise.all(
        open.map((i) =>
          store.updateIncident(i.id, {
            status: STATUS.CANCELLED,
            error: 'Demo was reset while this incident was still open.',
          }),
        ),
      );
      if (open.length) logger.info('closed open incidents on reset', { count: open.length });

      return res.json({ reset: true, closedIncidents: open.map((i) => i.id), demoApp: result });
    } catch (err) {
      logger.error('reset failed', { err: err.message });
      return res.status(502).json({
        error: 'reset_failed',
        message: `Could not reset the demo app: ${err.message}`,
      });
    }
  }));

  return router;
}
