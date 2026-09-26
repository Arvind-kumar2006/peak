// Incident status derivation — the only real logic in the backend.
//
// The backend stores an immutable event log and *derives* status from it rather
// than mutating status as things happen. Two reasons, both about the demo:
//
//   1. Auditable. When a judge asks "how do you know it isn't just the model
//      claiming success?", the answer is a replay of the actual TrueForge
//      events. We never write "resolved" ourselves.
//   2. Idempotent. Polling the same turn twice cannot corrupt state, so a
//      dropped HTTP response or a double-clicked Approve is harmless.
//
// Pure functions only. No database, no fetch, no clock except what's passed in.
// That is what makes this testable today, before the agent exists.

import { extractReport, phaseToStatus } from './report.js';

export const STATUS = {
  INVESTIGATING: 'investigating',
  AWAITING_APPROVAL: 'awaiting_approval',
  EXECUTING: 'executing',
  DIAGNOSED: 'diagnosed',
  RESOLVED: 'resolved',
  MITIGATED: 'mitigated',
  NOT_RESOLVED: 'not_resolved',
  REJECTED: 'rejected',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

/**
 * Statuses we will never move out of. The poller and sampler stop working an
 * incident once it lands here.
 *
 * `diagnosed` counts as terminal: the agent finished and proposed a fix but
 * took no action. Nothing further will arrive on its own.
 */
export const TERMINAL_STATUSES = new Set([
  STATUS.DIAGNOSED,
  STATUS.RESOLVED,
  STATUS.MITIGATED,
  STATUS.NOT_RESOLVED,
  STATUS.REJECTED,
  STATUS.ERROR,
  STATUS.CANCELLED,
]);

/** Statuses where the human still has a button to press. */
export const AWAITING_DECISION = new Set([STATUS.AWAITING_APPROVAL]);

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

const eventsOfType = (events, type) => events.filter((e) => e?.type === type);

/**
 * The most recent turn.done in the event list.
 *
 * `turn.done` is not guaranteed to be the last event — TrueForge may append
 * bookkeeping events after it — so we scan rather than take the tail.
 */
function findTurnDone(events) {
  return last(eventsOfType(events, 'turn.done'));
}

/**
 * Decide an incident's status from the current turn's events.
 *
 * @param {object}  input
 * @param {Array}   input.events   TrueForge events for the current turn, in order.
 * @param {string}  input.decision 'allow' | 'deny' | null — the human's choice, if any.
 * @returns {{ status: string, report: object|null, reason: string }}
 */
export function deriveStatus({ events = [], decision = null } = {}) {
  const done = findTurnDone(events);
  const state = done?.state ?? null;
  const turnStatus = state?.status ?? null;

  // 1. A turn that ended in an error is the most informative thing we know.
  //    Checked before the decision because if the *deny* turn blew up, "error"
  //    is the truth on stage and "rejected" would hide a real bug.
  if (turnStatus === 'error') {
    return {
      status: STATUS.ERROR,
      report: extractReport(state?.output),
      reason: 'turn reported an error',
    };
  }

  // 2. The human said no. The proposed action will not run, so "rejected" is
  //    already true the moment we record the decision — we don't wait for the
  //    agent's wrap-up turn to agree. Stable, and it can't flap.
  if (decision === 'deny') {
    return { status: STATUS.REJECTED, report: extractReport(state?.output), reason: 'operator rejected the action' };
  }

  // 3. Operator or agent cancelled the turn.
  if (turnStatus === 'cancelled') {
    return { status: STATUS.CANCELLED, report: extractReport(state?.output), reason: 'turn was cancelled' };
  }

  // 4. Turn finished cleanly. The report's phase is the answer — this is the
  //    agent's structured verdict, not our opinion.
  if (turnStatus === 'done') {
    const report = extractReport(state?.output);
    const mapped = report ? phaseToStatus(report.phase) : null;
    if (mapped) {
      return { status: mapped, report, reason: `report phase: ${report.phase}` };
    }
    // Finished but no parseable report. Say "diagnosed" rather than inventing a
    // verdict — the truth is "it stopped and we couldn't read it", and the
    // dashboard shows the raw output so a human can judge.
    return { status: STATUS.DIAGNOSED, report: null, reason: 'turn done but no parseable report' };
  }

  // 5. Approved. The whitelisted tool is running (or about to).
  if (decision === 'allow') {
    return { status: STATUS.EXECUTING, report: extractReport(state?.output), reason: 'action approved, executing' };
  }

  // 6. The runtime paused on the approval gate. This is the moment the whole
  //    project exists for, so it gets its own status and a pendingAction.
  if (eventsOfType(events, 'tool.approval_required').length > 0) {
    return { status: STATUS.AWAITING_APPROVAL, report: null, reason: 'waiting on a human decision' };
  }

  // 7. Turn running, nothing proposed yet.
  return { status: STATUS.INVESTIGATING, report: null, reason: 'agent is investigating' };
}

/**
 * A live turn that has produced no new events for a while is worth *flagging*
 * but must not be *relabelled* — overwriting `investigating` with `stalled`
 * would destroy the real status and, worse, could make a paused-for-approval
 * incident look merely slow. So this returns a flag, not a status.
 */
export function detectStall({ lastEventAt, now = Date.now(), thresholdMs = 90_000 } = {}) {
  if (!lastEventAt) return false;
  return now - new Date(lastEventAt).getTime() > thresholdMs;
}

/** Statuses the dashboard should keep polling / sampling for. */
export function isActive(status) {
  return !TERMINAL_STATUSES.has(status);
}
