// /api/incidents — the contract in contracts/backend-api.md.
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
import { STATUS } from '../domain/status.js';
import { syncIncident } from '../services/sync.js';

export function createIncidentsRouter({ store, demoApp, poller }) {
  const router = express.Router();

  /**
   * The investigation prompt.
   *
   * The agent's own instructions live in P3's SKILL.md; this is the *task*
   * message, and it deliberately restates the safety contract rather than
   * assuming the model remembers it: one action, human approval, verify after.
   */
  function investigationPrompt({ scenario, description }) {
    const lines = [
      'PRODUCTION INCIDENT — demo-app (deployed on Render).',
      '',
      `Observed: ${description}`,
      '',
      'Investigate and fix. Requirements:',
      '- Gather evidence with the read-only tools (service status, metrics, pool stats, recent commits, recent errors).',
      '- Every claim in your report must cite the tool that produced it.',
      '- Decide whether the cause is code-level (a recent deploy) or infra-level (no relevant deploy).',
      '- Propose exactly ONE whitelisted action. The runtime will pause for human approval before it runs.',
      '- After the action runs, verify with get_metrics_window over a 60s window and set `phase` to resolved, mitigated, or not_resolved.',
    ];
    if (scenario) {
      lines.push(
        '',
        `Operator hint: the injected scenario is "${scenario}". Treat it as a hint about what was done, not as the diagnosis — confirm it from tool evidence before you conclude anything.`,
      );
    }
    return lines.join('\n');
  }

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

    // The description is what the agent sees, and what the fake adapter matches
    // on, so make sure the scenario name is always in it.
    const described = [description, scenario ? `scenario=${scenario}` : null].filter(Boolean).join(' · ');

    // One id, generated up front: TrueForge session metadata carries the
    // incidentId, so the two must agree or the session can't be traced back to
    // the incident in the UI.
    const id = newIncidentId();

    // Inject first, and don't fail the request if it fails. The point of the
    // incident is to investigate the app; if the app is down we still want the
    // investigation, and the note below says so on the dashboard.
    let inject = { ok: true, result: null };
    if (scenario) inject = await demoApp.inject(scenario);

    let sessionId = null;
    try {
      const adapter = await getAdapter();
      ({ sessionId } = await adapter.createSession({ incidentId: id, description: described }));
    } catch (err) {
      logger.error('could not create a session', { err: err.message });
      return res.status(502).json({
        error: 'agent_unavailable',
        message: `Could not reach the agent runtime at ${config.trueforge.url}: ${err.message}`,
      });
    }

    const adapter = await getAdapter();
    const created = await store.createIncident({
      id,
      sessionId,
      scenario: scenario ?? null,
      description: described,
      status: STATUS.INVESTIGATING,
      trueforgeUrl: adapter.sessionUrl(sessionId),
    });

    try {
      const { turnId } = await adapter.startTurn({
        sessionId,
        input: [{ type: 'user.message', content: investigationPrompt({ scenario, description }) }],
      });
      const withTurn = await store.updateIncident(id, {
        lastTurnId: turnId,
        turnIds: [...(created.turn_ids ?? []), turnId],
      });

      // A failed injection belongs in the timeline, not in a field nobody
      // reads. It also explains to anyone watching the demo why the app's
      // metrics might not move.
      if (!inject.ok) {
        await store.appendEvents(id, turnId, [
          {
            eventId: `local_inject_failed_${id}`,
            type: 'demo.inject_failed',
            at: new Date().toISOString(),
            payload: { message: `Demo app unreachable, scenario not injected: ${inject.error}` },
          },
        ]);
      }

      // Kick the poller so the first events land immediately instead of up to
      // one poll interval later. Makes the demo feel instant.
      poller.tick().catch(() => {});
      return res.status(201).json(toIncident(withTurn));
    } catch (err) {
      logger.error('could not start the investigation turn', { incidentId: id, err: err.message });
      const failed = await store.updateIncident(id, {
        status: STATUS.ERROR,
        error: `Could not start the investigation turn: ${err.message}`,
      });
      return res.status(502).json(toIncident(failed));
    }
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

    let resumeTurnId;
    try {
      // The decision is delivered as the input to a NEW turn chained to the
      // paused one. That new turn id must become the incident's last_turn_id —
      // otherwise the poller keeps re-reading the turn that is already paused
      // and the incident sits in `executing` forever.
      ({ turnId: resumeTurnId } = await adapter.sendToolApproval({
        sessionId: row.session_id,
        // Chain to the paused turn — that is how TrueForge resumes a turn that
        // stopped on the approval gate.
        turnId: row.last_turn_id,
        threadId: pending.threadId,
        toolCallId: pending.toolCallId,
        status: decision,
        reason,
      }));
    } catch (err) {
      logger.error('approval failed', { incidentId: row.id, decision, err: err.message });
      return res.status(502).json({
        error: 'approval_failed',
        message: `Could not send the decision to the agent runtime: ${err.message}`,
      });
    }

    if (resumeTurnId) {
      await store.updateIncident(row.id, {
        lastTurnId: resumeTurnId,
        turnIds: [...(row.turn_ids ?? []), resumeTurnId],
      });
    }

    await store.recordDecision({
      incidentId: row.id,
      decision,
      reason,
      actor: 'operator',
      tool: pending.tool,
      args: pending.args,
    });

    poller.forgive(row.id);
    // Recompute now rather than waiting for the next tick, so the button's
    // effect is visible immediately. Still derived, never hand-written.
    const updated = await syncIncident({ store, incidentId: row.id });
    logger.info('operator decision recorded', { incidentId: row.id, decision, tool: pending.tool });

    return res.json(updated);
  });

  return router;
}
