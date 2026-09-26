// Single place where the agent's session state becomes incident state.
//
// Both the background poller and the approve/reject routes call `syncIncident`.
// The routes need it too: pressing Approve should flip the badge to
// "executing" immediately rather than after the next poll tick, and because
// status is *derived* from the decision row rather than written by hand, the
// immediate update and the poller's later update can't disagree.

import { logger } from '../logger.js';
import { getAdapter } from '../trueforge/adapter.js';
import { normaliseEvent } from '../trueforge/mapper.js';
import { deriveStatus, detectStall } from '../domain/status.js';
import { toIncident } from '../domain/incident.js';

export async function syncIncident({ store, incidentId }) {
  const row = await store.getIncident(incidentId);
  if (!row) return null;
  if (!row.session_id) return toIncident(row);

  const adapter = await getAdapter();
  const state = await adapter.readState({ sessionId: row.session_id });

  const events = (state.events ?? []).map((e, i) => normaliseEvent(e, i));
  const inserted = await store.appendEvents(incidentId, events);

  // The decision row, not the event log, is the record of "a human pressed a
  // button". The event log alone can't distinguish an approved action from one
  // the runtime ran unasked — which is exactly the claim this project makes, so
  // it needs a table we control.
  const decisions = await store.listDecisions(incidentId);
  const decision = decisions.length ? decisions[decisions.length - 1].decision : null;

  // A failure inside a background task is reported through the adapter, not
  // thrown, so it surfaces as `error` rather than vanishing into a log.
  const derived = deriveStatus({
    paused: state.paused,
    diagnosis: state.diagnosis,
    resolution: state.resolution,
    turnDone: state.turnDone,
    turnStatus: state.turnStatus,
    decision,
    error: row.error && !state.turnDone ? row.error : null,
  });

  const lastEventAt = events.at(-1)?.at ?? row.last_event_at;

  const updated = await store.updateIncident(incidentId, {
    status: derived.status,
    diagnosis: state.diagnosis ?? row.diagnosis ?? null,
    resolution: state.resolution ?? row.resolution ?? null,
    // Keep the last known pending action visible while executing, so the card
    // can still show what was approved and what it was called with.
    pendingAction: state.pendingAction ?? row.pending_action ?? null,
    lastEventAt,
    stalled: detectStall({ lastEventAt }),
    // About the *turn*, not the incident. A rejected incident is terminal while
    // its turn is still running and still owes us a Resolution.
    turnDone: Boolean(state.turnDone),
  });

  if (inserted > 0) {
    logger.info('incident synced', {
      incidentId,
      status: derived.status,
      newEvents: inserted,
      totalEvents: events.length,
      hasDiagnosis: Boolean(state.diagnosis),
      hasResolution: Boolean(state.resolution),
      pendingTool: state.pendingAction?.tool ?? null,
    });
  }
  return toIncident(updated);
}
