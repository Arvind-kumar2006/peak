// Metric sampler.
//
// While any incident is open, snapshot /metrics every couple of seconds into
// peak.metric_samples. Two reasons this is not just a chart convenience:
//
//   1. Before/after evidence. The before/after comparison is the most
//      persuasive thing on the dashboard, and the agent's own `verification`
//      block can come back thin or vague. We keep our own numbers.
//   2. Recovery is a *claim*. Having a series that shows error rate flat for
//      60s after the action is what turns "the model says it's fixed" into
//      "here is the graph, it's fixed".

import { logger } from '../logger.js';

// 2s matches the dashboard's poll interval, so the chart's right edge is never
// more than one sample behind what the user sees.
const SAMPLE_INTERVAL_MS = 2000;

// Keep sampling this long after the turn finishes. The chart has to show the
// recovery *after* the verdict, not stop on it — and with the mock world the
// verification window is simulated, so the turn can end within a second of the
// approval and the chart used to show no "after" at all.
const TAIL_MS = 60_000;

export function createSampler({ store, demoApp }) {
  let timer = null;
  let lastIncidentId = null;
  let inFlight = false;

  async function sample() {
    if (inFlight) return;
    inFlight = true;
    try {
      const incidents = await store.listIncidents({ limit: 50 });
      // Keep sampling until the turn finishes, not until the status goes
      // terminal: a rejected incident still needs its after-numbers, otherwise
      // the chart just stops mid-spike and looks broken.
      const open = incidents.find(
        (i) => i.session_id && (!i.turn_done || Date.now() - new Date(i.updated_at).getTime() < TAIL_MS),
      );
      if (!open) return;

      const metrics = await demoApp.metrics();
      lastIncidentId = open.id;
      await store.addSample({
        incidentId: open.id,
        at: metrics.timestamp ?? new Date(),
        release: metrics.release ?? null,
        rpm: metrics.http?.rpm ?? null,
        errorRate: metrics.http?.errorRate ?? null,
        p95Ms: metrics.http?.p95Ms ?? null,
        memoryMB: metrics.process?.memoryMB ?? null,
        poolInUse: metrics.db?.pool?.inUse ?? null,
        poolWaiting: metrics.db?.pool?.waiting ?? null,
        cacheEntries: metrics.cache?.entries ?? null,
        raw: metrics,
      });
    } catch (err) {
      // Sampling is best-effort. A failed sample must never surface as a failed
      // request — the chart just gets a gap.
      logger.warn('sample failed', { err: err.message });
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(sample, SAMPLE_INTERVAL_MS);
      timer.unref?.();
      logger.info('sampler started', { intervalMs: SAMPLE_INTERVAL_MS });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    sample,
    get lastIncidentId() {
      return lastIncidentId;
    },
  };
}
