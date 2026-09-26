// Incident row -> the API shape in contracts/backend-api.md.
//
// The contract lists 7 fields. We emit those plus a few additive ones
// (updatedAt, decision, error, lastEventAt, stalled) that the dashboard needs
// and that cost nothing to include. Additive-only, so the contract still holds.

import { randomUUID } from 'node:crypto';

/** ULID-ish, sortable by creation time, so ids sort like the feed does. */
export function newIncidentId() {
  const time = Date.now().toString(36).padStart(9, '0');
  return `inc_${time}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

/** Fields safe to return in the list endpoint (no report blob, no timeline). */
export function toSummary(row) {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    scenario: row.scenario ?? null,
    status: row.status,
    decision: row.decision ?? null,
    // The feed shows one line of the diagnosis. Reading report.summary off the
    // list endpoint is what makes the left column useful at a glance.
    summary: row.report?.summary ?? null,
    rootCauseCategory: row.report?.rootCause?.category ?? null,
    confidence: row.report?.rootCause?.confidence ?? null,
    pendingTool: row.pending_action?.tool ?? null,
    trueforgeUrl: row.trueforge_url ?? null,
    error: row.error ?? null,
    stalled: Boolean(row.stalled),
    // Lets the UI show "wrapping up" on a rejected incident instead of
    // freezing the timeline before the agent's explanation arrives.
    turnDone: row.turn_done !== false,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toIncident(row) {
  if (!row) return null;
  return {
    ...toSummary(row),
    description: row.description ?? null,
    report: row.report ?? null,
    pendingAction: row.pending_action ?? null,
    turnIds: row.turn_ids ?? [],
    lastTurnId: row.last_turn_id ?? null,
    lastEventAt: iso(row.last_event_at),
  };
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
