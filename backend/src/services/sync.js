// Single place where TrueForge events become incident state.
//
// Both the background poller and the approve/reject routes call `syncIncident`.
// The routes need it too: pressing Approve should flip the badge to
// "executing" immediately rather than after the next poll tick, and because
// status is *derived* from the decision row rather than written by hand, the
// immediate update and the poller's later update can't disagree.

import { logger } from '../logger.js';
import { getAdapter } from '../trueforge/adapter.js';
import { extractPendingAction, normaliseEvent } from '../trueforge/mapper.js';
import { deriveStatus, detectStall } from '../domain/status.js';
import { toIncident } from '../domain/incident.js';

export async function syncIncident({ store, incidentId }) {
  const row = await store.getIncident(incidentId);
  if (!row) return null;
  if (!row.last_turn_id) return toIncident(row);

  const adapter = await getAdapter();
  const raw = await adapter.getTurnEvents({ sessionId: row.session_id, turnId: row.last_turn_id });

  const events = raw.map((e, i) => normaliseEvent(e, i));
  const inserted = await store.appendEvents(incidentId, row.last_turn_id, events);

  // The decision row, not the event log, is the record of "a human pressed a
  // button". The event log alone can't distinguish an approved action from one
  // the runtime ran unasked — which is exactly the claim this project makes, so
  // it needs a table we control.
  const decisions = await store.listDecisions(incidentId);
  const decision = decisions.length ? decisions[decisions.length - 1].decision : null;

  const derived = deriveStatus({ events: raw, decision });
  const pending = extractPendingAction(raw);
  const lastEventAt = events.at(-1)?.at ?? row.last_event_at;
  const turnDone = raw.find((e) => e?.type === 'turn.done');

  const updated = await store.updateIncident(incidentId, {
    status: derived.status,
    report: derived.report ?? row.report ?? null,
    // Keep the last known pending action visible while executing, so the card
    // can still show what was approved and what it was called with.
    pendingAction: pending ?? row.pending_action ?? null,
    error: derived.status === 'error' ? (turnDone?.state?.message ?? row.error ?? null) : null,
    lastEventAt,
    stalled: detectStall({ lastEventAt }),
    // Note this is about the *turn*, not the incident. A rejected incident still
    // has a turn that owes us a report, and the poller keys off this to know
    // when it is finally safe to stop.
    turnDone: Boolean(turnDone),
  });

  if (inserted > 0) {
    logger.info('incident synced', {
      incidentId,
      status: derived.status,
      newEvents: inserted,
      totalEvents: events.length,
      pendingTool: pending?.tool ?? null,
    });
  }
  return toIncident(updated);
}
