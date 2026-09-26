// Incident status derivation — the only real logic in the backend.
//
// The backend stores an immutable event log and *derives* status from it rather
// than mutating status as things happen. Two reasons, both about the demo:
//
//   1. Auditable. When a judge asks "how do you know it isn't just the model
//      claiming success?", the answer is a replay of the actual TrueForge
//      events plus the agent's own submitted Resolution. We never write
//      "resolved" ourselves.
//   2. Idempotent. Polling the same session twice cannot corrupt state, so a
//      dropped response or a double-clicked Approve is harmless.
//
// Pure function. No database, no fetch, no clock except what's passed in. That
// is what makes this testable before the agent core exists.

import { verdictToStatus } from './report.js';

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
 * Statuses we will never move out of. The poller and sampler stop once the
 * agent's turn has finished anyway; this is about not re-deriving forever.
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

/**
 * Decide an incident's status.
 *
 * @param {object}  input
 * @param {object}  input.paused      non-null while the runtime holds a tool call for approval
 * @param {object}  input.diagnosis   the agent's submitted Diagnosis, or null
 * @param {object}  input.resolution  the agent's submitted Resolution, or null
 * @param {boolean} input.turnDone    the current turn reported turn.done
 * @param {string}  input.turnStatus  done | error | cancelled | running | null
 * @param {string}  input.decision    'allow' | 'deny' | null — the human's choice
 * @param {string}  input.error       message from a failed background task, if any
 */
export function deriveStatus({
  paused = null,
  diagnosis = null,
  resolution = null,
  turnDone = false,
  turnStatus = null,
  decision = null,
  error = null,
} = {}) {
  // 1. A turn that ended in an error, or a background task that failed, is the
  //    most informative thing we know. Checked first so a failure during the
  //    deny path reads as "error" rather than being hidden behind "rejected".
  if (error) return { status: STATUS.ERROR, reason: error };
  if (turnStatus === 'error') return { status: STATUS.ERROR, reason: 'the agent turn failed' };
  if (turnStatus === 'cancelled') return { status: STATUS.CANCELLED, reason: 'the turn was cancelled' };

  // 2. The agent submitted a resolution. Its verdict is the answer — the
  //    agent's own structured judgement, not ours.
  const verdictStatus = verdictToStatus(resolution?.verdict);
  if (verdictStatus) {
    return { status: verdictStatus, reason: `resolution verdict: ${resolution.verdict}` };
  }

  // 3. The human said no. True the moment we record the decision; we don't wait
  //    for the agent's wrap-up to agree, so the badge can't sit on "executing"
  //    for a fix that is never going to run.
  if (decision === 'deny') {
    return { status: STATUS.REJECTED, reason: 'operator rejected the action' };
  }

  // 4. The turn finished but the agent never submitted a resolution.
  //    contracts/backend-api.md is explicit: that is an error, not a success.
  //    Reading it as anything else is how an agent gets to walk away from a
  //    broken service and have the dashboard call it fine.
  if (turnDone) {
    return { status: STATUS.ERROR, reason: 'the agent finished without submitting a resolution' };
  }

  // 5. Approved. The whitelisted tool is running, or the agent is verifying.
  if (decision === 'allow') {
    return { status: STATUS.EXECUTING, reason: 'action approved, executing' };
  }

  // 6. The runtime paused on the approval gate. This is the moment the whole
  //    project exists for, so it gets its own status.
  if (paused) {
    return { status: STATUS.AWAITING_APPROVAL, reason: 'waiting on a human decision' };
  }

  // 7. Turn running, nothing proposed yet. Note the agent submits its diagnosis
  //    *before* requesting approval, so a diagnosis without a gate means it is
  //    still working — not that it is done.
  return { status: STATUS.INVESTIGATING, reason: 'agent is investigating' };
}

/**
 * A turn that has produced nothing new for a while is worth *flagging* but must
 * not be *relabelled* — overwriting `investigating` with `stalled` would destroy
 * the real status, and could make a paused-for-approval incident look merely
 * slow. So this returns a flag, not a status.
 */
export function detectStall({ lastEventAt, now = Date.now(), thresholdMs = 90_000 } = {}) {
  if (!lastEventAt) return false;
  return now - new Date(lastEventAt).getTime() > thresholdMs;
}

export function isActive(status) {
  return !TERMINAL_STATUSES.has(status);
}

/** The status a fresh incident starts in. */
export const INITIAL_STATUS = STATUS.INVESTIGATING;

/** Re-exported so callers don't need two imports for one decision. */
export { verdictToStatus };
