// /api/incidents — the contract in contracts/backend-api.md.
//
// One shape note that explains most of this file: P3's client is *blocking*.
// `tf.start()` returns when the turn pauses for approval or finishes, and
// `tf.approve()` returns after the agent has watched its 60s recovery window.
// So neither can sit inside a request handler — the route records the incident,
// kicks off a background task, and returns. The poller picks up the result.
// That is why `POST /api/incidents` responds immediately with `investigating`,
// exactly as the contract says it should.
//
// Design rule for every handler here: **the dashboard must never see a bare
// 500.** An incident is a record of something going wrong; returning an opaque
// failure while the UI shows "error" with no explanation is the least useful
// thing we could do. Every failure path returns a message a human can read.

import express from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { config, SCENARIOS } from '../config.js';
import { logger } from '../logger.js';
import { getAdapter } from '../trueforge/adapter.js';
import { newIncidentId, toIncident, toSummary } from '../domain/incident.js';
import { INITIAL_STATUS, STATUS } from '../domain/status.js';
import { syncIncident } from '../services/sync.js';

export function createIncidentsRouter({ store, demoApp, poller }) {
  const router = express.Router();

  // POST /api/incidents — inject a scenario, open a session, start the turn.
  router.post('/', asyncHandler(async (req, res) => {
    const { scenario, description } = req.body ?? {};

    if (scenario && !SCENARIOS.includes(scenario)) {
      return res.status(400).json({
        error: 'unknown_scenario',
        allowed: SCENARIOS,
        message: `Scenario must be one of: ${SCENARIOS.join(', ')}`,
      });
    }

    // The description is what the agent sees. The scenario tag is recorded here
    // but deliberately NOT put in the prompt — P3's incidentPrompt keeps it away
    // from the model so the agent has to find the cause from evidence rather
    // than being told the answer.
    const described = [description, scenario ? `scenario=${scenario}` : null].filter(Boolean).join(' · ');

    // Inject first, and don't fail the request if it fails. The point of the
    // incident is to investigate the app; if the app is down we still want the
    // investigation, and a timeline entry says so.
    let inject = { ok: true, result: null };
    if (scenario) inject = await demoApp.inject(scenario);

    // One id up front: TrueForge session metadata carries the incidentId, so
    // the two must agree or the session can't be traced back from the UI.
    const id = newIncidentId();
    const adapter = await getAdapter();

    let session;
    try {
      session = await adapter.createSession({ incidentId: id, description: described });
    } catch (err) {
      logger.error('could not create a session', { err: err.message });
      return res.status(502).json({
        error: 'agent_unavailable',
        message: `Could not reach the agent runtime at ${config.trueforge.url}: ${err.message}`,
      });
    }

    const created = await store.createIncident({
      id,
      sessionId: session.sessionId,
      scenario: scenario ?? null,
      description: described,
      status: INITIAL_STATUS,
      trueforgeUrl: adapter.sessionUrl(session.sessionId),
    });

    // Kick off the investigation. It runs for as long as the agent needs; the
    // poller and the dashboard watch it from here.
    try {
      adapter.startInvestigation({
        session: session.session ?? { id: session.sessionId },
        sessionId: session.sessionId,
        description: described,
        onUpdate: ({ ok, error }) => {
          if (!ok) {
            // Recorded on the incident, so the dashboard shows the reason
            // instead of an incident stuck at `investigating` forever.
            store.updateIncident(id, { error: `Investigation failed: ${error}` }).catch(() => {});
          }
          poller.forgive(id);
          poller.tick().catch(() => {});
        },
      });
    } catch (err) {
      logger.error('could not start the investigation', { incidentId: id, err: err.message });
      const failed = await store.updateIncident(id, {
        status: STATUS.ERROR,
        error: `Could not start the investigation: ${err.message}`,
      });
      return res.status(502).json(toIncident(failed));
    }

    if (!inject.ok) {
      await store.appendEvents(id, [
        {
          eventId: `local_inject_failed_${id}`,
          type: 'demo.inject_failed',
          at: new Date().toISOString(),
          payload: { message: `Demo app unreachable, scenario not injected: ${inject.error}` },
        },
      ]);
    }

    // Kick the poller so the first events land immediately rather than up to
    // one poll interval later. Makes the demo feel instant.
    poller.tick().catch(() => {});
    return res.status(201).json(toIncident(await store.getIncident(id) ?? created));
  }));

  // GET /api/incidents — newest first, summary shape only.
  router.get('/', asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await store.listIncidents({ limit });
    res.json({ incidents: rows.map(toSummary) });
  }));

  // GET /api/incidents/:id — the 2s poll endpoint.
  router.get('/:id', asyncHandler(async (req, res) => {
    const row = await store.getIncident(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'No such incident.' });

    const [events, decisions, samples] = await Promise.all([
      store.listEvents(row.id, { limit: 300 }),
      store.listDecisions(row.id),
      store.listSamples({ incidentId: row.id, limit: 400 }),
    ]);

    res.json({
      ...toIncident(row),
      timeline: events.map((e) => ({ id: e.id, type: e.type, at: e.at, payload: e.payload })),
      decisions: decisions.map((d) => ({
        decision: d.decision,
        reason: d.reason,
        actor: d.actor,
        tool: d.tool,
        args: d.args,
        at: d.at instanceof Date ? d.at.toISOString() : d.at,
      })),
      metrics: samples.map((s) => ({
        at: s.at instanceof Date ? s.at.toISOString() : s.at,
        release: s.release,
        rpm: s.rpm,
        errorRate: s.error_rate,
        p95Ms: s.p95_ms,
        memoryMB: s.memory_mb,
        poolInUse: s.pool_in_use,
        poolWaiting: s.pool_waiting,
        cacheEntries: s.cache_entries,
      })),
    });
  }));

  // POST /api/incidents/:id/approve
  router.post('/:id/approve', (req, res, next) => decide(req, res, 'allow', next));

  // POST /api/incidents/:id/reject
  router.post('/:id/reject', (req, res, next) => decide(req, res, 'deny', next));

  const decide = asyncHandler(async (req, res, decision) => {
    const row = await store.getIncident(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'No such incident.' });

    if (row.status !== STATUS.AWAITING_APPROVAL) {
      return res.status(409).json({
        error: 'not_awaiting_approval',
        status: row.status,
        message: `This incident is "${row.status}", so there is nothing to ${decision === 'allow' ? 'approve' : 'reject'}.`,
      });
    }

    const pending = row.pending_action;
    if (!pending?.toolCallId) {
      // The gate fired but we never located the tool call. Say so precisely,
      // because this is the one failure that would otherwise look like a
      // mystery on stage.
      return res.status(409).json({
        error: 'pending_action_unresolved',
        message:
          'The runtime is waiting for approval but we could not identify which tool call it wants approved. Check the TrueForge session for details.',
        trueforgeUrl: row.trueforge_url,
      });
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
    const adapter = await getAdapter();

    // Record the human's decision *before* dispatching it, so the badge moves
    // immediately and so the audit row exists even if the dispatch fails.
    await store.recordDecision({
      incidentId: row.id,
      decision,
      reason,
      actor: 'operator',
      tool: pending.tool,
      args: pending.args,
    });

    try {
      adapter.submitDecision({
        sessionId: row.session_id,
        decision,
        reason,
        onUpdate: ({ ok, error }) => {
          if (!ok) {
            store
              .updateIncident(row.id, { error: `Could not ${decision === 'allow' ? 'execute the action' : 'reject'}: ${error}` })
              .catch(() => {});
          }
          poller.forgive(row.id);
          poller.tick().catch(() => {});
        },
      });
    } catch (err) {
      logger.error('dispatching the decision failed', { incidentId: row.id, err: err.message });
      return res.status(502).json({
        error: 'approval_failed',
        message: `Could not send the decision to the agent runtime: ${err.message}`,
      });
    }

    poller.forgive(row.id);
    // Recompute now rather than waiting for the next tick, so the button's
    // effect is visible immediately. Still derived, never hand-written.
    const updated = await syncIncident({ store, incidentId: row.id });
    logger.info('operator decision recorded', { incidentId: row.id, decision, tool: pending.tool });

    return res.json(updated);
  });

  return router;
}
