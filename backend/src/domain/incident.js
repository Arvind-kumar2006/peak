// Incident row -> the API shape in contracts/backend-api.md.
//
// The contract splits the agent's output in two: `diagnosis` is available at
// `awaiting_approval` (it is what the human is approving), and `resolution`
// arrives at the end (it carries the verdict). An earlier revision of the
// contract had a single `report`; P3's current schema is the two-phase one, so
// this follows it.
//
// Everything here beyond those fields is additive, so the contract still holds.

import { randomUUID } from 'node:crypto';

/** ULID-ish, sortable by creation time, so ids sort like the feed does. */
export function newIncidentId() {
  const time = Date.now().toString(36).padStart(9, '0');
  return `inc_${time}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

/** Fields safe to return in the list endpoint (no report blobs, no timeline). */
export function toSummary(row) {
  return {
    id: row.id,
    sessionId: row.session_id ?? null,
    scenario: row.scenario ?? null,
    status: row.status,
    decision: row.decision ?? null,
    // The feed shows one line. Before the diagnosis lands, fall back to the
    // scenario so a row is never blank.
    summary: row.diagnosis?.summary ?? row.resolution?.reasoning ?? null,
    rootCauseCategory: row.diagnosis?.rootCause?.category ?? null,
    confidence: row.diagnosis?.rootCause?.confidence ?? null,
    pendingTool: row.pending_action?.tool ?? null,
    // Short feed titles ("Connection leak · 5a824ff") and the outcome line.
    commitSha: row.diagnosis?.rootCause?.commitSha ?? null,
    verdict: row.resolution?.verdict ?? null,
    trueforgeUrl: row.trueforge_url ?? null,
    error: row.error ?? null,
    stalled: Boolean(row.stalled),
    // Lets the UI say "wrapping up" on a rejected incident instead of freezing
    // the timeline before the agent's explanation arrives.
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
    diagnosis: row.diagnosis ?? null,
    resolution: row.resolution ?? null,
    pendingAction: row.pending_action ?? null,
    sessionId: row.session_id ?? null,
    createdAt: iso(row.created_at),
  };
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
