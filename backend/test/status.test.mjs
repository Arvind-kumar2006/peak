// Status derivation. This is the file that decides what the dashboard says is
// happening, so it gets the most test coverage.
//
// The tests are written as "here is the agent's state, here is what the incident
// status must be" — because that is the actual contract with P3, and because it
// means these tests keep their value after the adapter is swapped from the
// scripted fake to the real runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, detectStall, isActive, STATUS } from '../src/domain/status.js';

const diagnosis = { summary: 's', rootCause: { category: 'code' } };
const resolution = (verdict) => ({ verdict, actionTaken: 'none', windowSec: 60 });

// The shape contracts/backend-api.md describes: a paused turn, or a finished one.
const paused = { kind: 'approval', turnId: 't1', threadId: 'main', toolCalls: [{ id: 'c1' }] };

test('a fresh incident is investigating', () => {
  assert.equal(deriveStatus({}).status, STATUS.INVESTIGATING);
});

test('a diagnosis without a gate means it is still working, not done', () => {
  // The agent submits its diagnosis *before* requesting approval. Reading a
  // diagnosis as "finished" would park every incident in the wrong state.
  assert.equal(deriveStatus({ diagnosis }).status, STATUS.INVESTIGATING);
});

test('the approval gate produces awaiting_approval', () => {
  assert.equal(deriveStatus({ diagnosis, paused }).status, STATUS.AWAITING_APPROVAL);
});

test('approving moves to executing', () => {
  assert.equal(deriveStatus({ diagnosis, paused, decision: 'allow' }).status, STATUS.EXECUTING);
});

test('rejecting is rejected immediately, without waiting for the agent', () => {
  // The action will not run the moment a human says no. Waiting for the wrap-up
  // turn to agree would show "executing" for a fix that never executes.
  assert.equal(deriveStatus({ diagnosis, paused, decision: 'deny' }).status, STATUS.REJECTED);
});

test('every resolution verdict maps to its status', () => {
  for (const verdict of ['resolved', 'mitigated', 'not_resolved', 'rejected']) {
    assert.equal(deriveStatus({ diagnosis, decision: 'allow', resolution: resolution(verdict) }).status, verdict);
  }
});

test('the verdict beats the recorded decision', () => {
  // A submitted Resolution is the agent's own structured judgement and is the
  // last word. Otherwise a rejection could never be reported as `rejected`.
  assert.equal(deriveStatus({ decision: 'deny', resolution: resolution('rejected') }).status, STATUS.REJECTED);
});

test('a finished turn with no resolution is an error, not a success', () => {
  // contracts/backend-api.md is explicit. Reading this as anything else is
  // exactly how an agent walks away from a broken service and the dashboard
  // calls it fine.
  const result = deriveStatus({ diagnosis, turnDone: true, turnStatus: 'done' });
  assert.equal(result.status, STATUS.ERROR);
  assert.match(result.reason, /without submitting a resolution/);
});

test('a resolution rescues a finished turn', () => {
  assert.equal(
    deriveStatus({ diagnosis, resolution: resolution('resolved'), turnDone: true, turnStatus: 'done' }).status,
    STATUS.RESOLVED,
  );
});

test('an errored turn is error even if a decision was recorded', () => {
  // If the turn that handled the approval blew up, "error" is the truth on
  // stage. Reporting "rejected" would hide a real bug.
  assert.equal(deriveStatus({ turnStatus: 'error', decision: 'deny' }).status, STATUS.ERROR);
});

test('a background task failure is surfaced as error', () => {
  const result = deriveStatus({ error: 'connection refused' });
  assert.equal(result.status, STATUS.ERROR);
  assert.match(result.reason, /connection refused/);
});

test('a cancelled turn is cancelled', () => {
  assert.equal(deriveStatus({ turnStatus: 'cancelled' }).status, STATUS.CANCELLED);
});

test('the full happy path end to end', () => {
  assert.equal(deriveStatus({}).status, STATUS.INVESTIGATING);
  assert.equal(deriveStatus({ diagnosis }).status, STATUS.INVESTIGATING);
  assert.equal(deriveStatus({ diagnosis, paused }).status, STATUS.AWAITING_APPROVAL);
  assert.equal(deriveStatus({ diagnosis, paused, decision: 'allow' }).status, STATUS.EXECUTING);
  assert.equal(
    deriveStatus({ diagnosis, paused, decision: 'allow', resolution: resolution('resolved'), turnDone: true, turnStatus: 'done' })
      .status,
    STATUS.RESOLVED,
  );
});

test('the full reject path end to end', () => {
  assert.equal(deriveStatus({ diagnosis, paused }).status, STATUS.AWAITING_APPROVAL);
  assert.equal(deriveStatus({ diagnosis, paused, decision: 'deny' }).status, STATUS.REJECTED);
  assert.equal(
    deriveStatus({ diagnosis, paused, decision: 'deny', resolution: resolution('rejected'), turnDone: true, turnStatus: 'done' })
      .status,
    STATUS.REJECTED,
  );
});

test('terminal statuses are terminal', () => {
  for (const s of [STATUS.RESOLVED, STATUS.MITIGATED, STATUS.NOT_RESOLVED, STATUS.REJECTED, STATUS.ERROR, STATUS.DIAGNOSED, STATUS.CANCELLED]) {
    assert.equal(isActive(s), false, `${s} should not be active`);
  }
  for (const s of [STATUS.INVESTIGATING, STATUS.AWAITING_APPROVAL, STATUS.EXECUTING]) {
    assert.equal(isActive(s), true, `${s} should be active`);
  }
});

test('stall is a flag, never a status', () => {
  // Overwriting `investigating` with `stalled` would destroy the real status —
  // and could make a paused-for-approval incident look merely slow.
  const old = new Date(Date.now() - 120_000).toISOString();
  assert.equal(detectStall({ lastEventAt: old }), true);
  assert.equal(detectStall({ lastEventAt: new Date().toISOString() }), false);
  assert.equal(detectStall({ lastEventAt: null }), false);
});
