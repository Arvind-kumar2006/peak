// Status derivation. This is the file that decides what the dashboard says is
// happening, so it gets the most test coverage.
//
// The tests are written as "here is a TrueForge event list, here is what the
// incident status must be" — because that is the actual contract with P3, and
// because it means these tests keep their value after the adapter is swapped
// from the fake to the real runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus, detectStall, isActive, STATUS } from '../src/domain/status.js';

const report = (phase) => ({ phase, summary: 's', rootCause: { category: 'code' }, evidence: [] });

/** A finished turn in the shape contracts/trueforge.md documents. */
const turnDone = (status, output) => ({
  type: 'turn.done',
  state: {
    status,
    ...(output ? { output: { type: 'model.message', content: JSON.stringify(output), thread_id: 'main' } } : {}),
    ...(status === 'error' ? { message: 'boom' } : {}),
  },
});

const approvalRequired = (callId = 'call_1', sourceId = 'msg_1') => ({
  type: 'tool.approval_required',
  thread_id: 'main',
  tool_calls: [{ id: callId, source_event_id: sourceId }],
});

test('a fresh incident is investigating', () => {
  const { status } = deriveStatus({ events: [{ type: 'model.message', content: 'starting' }] });
  assert.equal(status, STATUS.INVESTIGATING);
});

test('no events at all is still investigating, not an error', () => {
  // The turn is created a moment before the first event lands. Defaulting to
  // `error` here would flash a red badge on every incident.
  assert.equal(deriveStatus({ events: [] }).status, STATUS.INVESTIGATING);
});

test('the approval gate produces awaiting_approval', () => {
  const { status } = deriveStatus({
    events: [{ type: 'model.message' }, approvalRequired()],
  });
  assert.equal(status, STATUS.AWAITING_APPROVAL);
});

test('approving moves to executing', () => {
  const { status } = deriveStatus({ events: [approvalRequired()], decision: 'allow' });
  assert.equal(status, STATUS.EXECUTING);
});

test('rejecting is rejected immediately, without waiting for the agent', () => {
  // The action will not run the moment the human says no. Waiting for the
  // agent's wrap-up turn to agree would leave the UI showing "executing" for a
  // fix that is never going to execute.
  const { status } = deriveStatus({ events: [approvalRequired()], decision: 'deny' });
  assert.equal(status, STATUS.REJECTED);
});

test('a clean turn with phase=resolved is resolved', () => {
  const { status } = deriveStatus({ events: [turnDone('done', report('resolved'))] });
  assert.equal(status, STATUS.RESOLVED);
});

test('phase=mitigated and phase=not_resolved map through', () => {
  assert.equal(deriveStatus({ events: [turnDone('done', report('mitigated'))] }).status, STATUS.MITIGATED);
  assert.equal(deriveStatus({ events: [turnDone('done', report('not_resolved'))] }).status, STATUS.NOT_RESOLVED);
});

test('an errored turn is error, even if a decision was recorded', () => {
  // If the turn that handled the approval blew up, "error" is the truth worth
  // showing. Reporting "rejected" would hide a real bug.
  const { status } = deriveStatus({ events: [turnDone('error')], decision: 'deny' });
  assert.equal(status, STATUS.ERROR);
});

test('a cancelled turn is cancelled', () => {
  assert.equal(deriveStatus({ events: [turnDone('cancelled')] }).status, STATUS.CANCELLED);
});

test('a done turn with an unparseable report degrades to diagnosed, not resolved', () => {
  // Reporting "resolved" because a turn finished would be exactly the failure
  // mode this project exists to argue against.
  const { status, report: parsed } = deriveStatus({ events: [turnDone('done', 'I think it is fine now')] });
  assert.equal(status, STATUS.DIAGNOSED);
  assert.equal(parsed, null);
});

test('turn.done is found even when it is not the last event', () => {
  // TrueForge may append bookkeeping events after turn.done.
  const events = [turnDone('done', report('resolved')), { type: 'session.idle' }];
  assert.equal(deriveStatus({ events }).status, STATUS.RESOLVED);
});

test('running turn after approval stays executing until the turn finishes', () => {
  const events = [approvalRequired(), { type: 'model.message', content: 'rolling back...' }];
  assert.equal(deriveStatus({ events, decision: 'allow' }).status, STATUS.EXECUTING);
});

test('the full happy path end to end', () => {
  const investigation = [{ type: 'model.message' }, approvalRequired()];
  assert.equal(deriveStatus({ events: investigation }).status, STATUS.AWAITING_APPROVAL);

  const executing = [...investigation, { type: 'tool.result' }];
  assert.equal(deriveStatus({ events: executing, decision: 'allow' }).status, STATUS.EXECUTING);

  const finished = [...executing, turnDone('done', report('resolved'))];
  assert.equal(deriveStatus({ events: finished, decision: 'allow' }).status, STATUS.RESOLVED);
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
