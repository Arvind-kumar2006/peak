// Background turn poller.
//
// The dashboard polls *us* every 2s. If we forwarded that straight to TrueForge,
// every open browser tab would be polling the agent runtime — which caps event
// lists at 100 per page, so it is not free. So exactly one loop reads turn
// events, writes them to the store, and re-derives status. The dashboard then
// reads our database, and the event log it renders is one we persisted.

import { config } from '../config.js';
import { logger } from '../logger.js';
import { isActive } from '../domain/status.js';
import { syncIncident } from './sync.js';

/** Give up on an incident after this many consecutive failures, so a dead
 *  runtime doesn't produce an unbounded error log mid-demo. */
const MAX_CONSECUTIVE_FAILURES = 8;

export function createPoller({ store }) {
  let timer = null;
  let running = false;
  const abandoned = new Map();

  async function tick() {
    if (running) return; // a slow TrueForge must not queue overlapping polls
    running = true;
    try {
      const incidents = await store.listIncidents({ limit: 50 });
      // Poll while the incident is active, OR while its turn is still running.
      // The second clause matters for Reject: the incident becomes terminal the
      // moment a human says no, but the agent's wrap-up turn still owes us the
      // Resolution that explains the refusal.
      const worthPolling = incidents.filter(
        (i) => i.session_id && (isActive(i.status) || !i.turn_done),
      );
      if (worthPolling.length === 0) return;

      await Promise.all(
        worthPolling.map(async (incident) => {
          const failures = abandoned.get(incident.id) ?? 0;
          if (failures >= MAX_CONSECUTIVE_FAILURES) return;
          try {
            await syncIncident({ store, incidentId: incident.id });
            abandoned.delete(incident.id);
          } catch (err) {
            const next = failures + 1;
            abandoned.set(incident.id, next);
            // Loud on the first failure (usually TrueForge restarting), quiet
            // after that, so one blip doesn't spam the rehearsal transcript.
            logger[next === 1 ? 'error' : 'warn']('poll failed', {
              incidentId: incident.id,
              attempt: next,
              err: err.message,
            });
            if (next === MAX_CONSECUTIVE_FAILURES) {
              await store.updateIncident(incident.id, {
                error: `Lost contact with the agent runtime after ${next} attempts: ${err.message}`,
              });
            }
          }
        }),
      );
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, config.trueforge.pollIntervalMs);
      // Don't hold the event loop open on our account during shutdown.
      timer.unref?.();
      logger.info('poller started', { intervalMs: config.trueforge.pollIntervalMs });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    /** Forget the failure count for an incident — called after a manual
     *  approve/reject so a transient blip doesn't mark it abandoned. */
    forgive(incidentId) {
      abandoned.delete(incidentId);
    },
  };
}
