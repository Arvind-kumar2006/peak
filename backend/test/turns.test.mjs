// Turn-state reading against the event shapes TrueForge 0.2.1 really emits
// (captured from a live session; see contracts/trueforge.md gotchas 7–9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestTurn, pausedFrom, turnDoneFrom, turnStatusFrom } from '../src/trueforge/turns.js';
import { deriveStatus } from '../src/domain/status.js';

const approval = { type: 'tool.approval_required', turn_id: 't1', thread_id: 'main', tool_calls: [{ id: 'call_1', source_event_id: 'e3' }] };

// Turn 1: investigate, then pause. TrueForge ends a paused turn with turn.done too.
const pausedTurn = [
  { type: 'turn.created', turn_id: 't1' },
  { type: 'model.message', turn_id: 't1', tool_calls: [{ id: 'call_1', function: { name: 'trigger_rollback', arguments: '{}' } }] },
  approval,
  { type: 'turn.done', turn_id: 't1', state: { status: 'done', output: null, required_actions: [approval] } },
];

// Turn 2: the approval resume, run to completion.
const resumedTurn = [
  { type: 'turn.created', turn_id: 't2' },
  { type: 'tool.response', turn_id: 't2', tool_call_id: 'call_1', content: '{"ok":true}' },
  { type: 'turn.done', turn_id: 't2', state: { status: 'done', output: { content: 'done' }, required_actions: [] } },
];

test('a paused turn is paused, not done', () => {
  assert.equal(turnDoneFrom(pausedTurn), false);
  assert.equal(turnStatusFrom(pausedTurn), null);
  assert.deepEqual(pausedFrom(pausedTurn)?.toolCalls, approval.tool_calls);
});

test('a paused turn derives awaiting_approval, never error', () => {
  const { status } = deriveStatus({
    paused: pausedFrom(pausedTurn),
    diagnosis: { rootCause: {} },
    turnDone: turnDoneFrom(pausedTurn),
    turnStatus: turnStatusFrom(pausedTurn),
  });
  assert.equal(status, 'awaiting_approval');
});

test('after a decision the old approval no longer counts as pending', () => {
  const running = [...pausedTurn, { type: 'turn.created', turn_id: 't2' }];
  assert.equal(pausedFrom(running), null);
  assert.equal(turnDoneFrom(running), false);
  const { status } = deriveStatus({ paused: pausedFrom(running), turnDone: false, decision: 'allow' });
  assert.equal(status, 'executing');
});

test('the resumed turn finishing is done', () => {
  const all = [...pausedTurn, ...resumedTurn];
  assert.equal(latestTurn(all).every((e) => e.turn_id === 't2'), true);
  assert.equal(pausedFrom(all), null);
  assert.equal(turnDoneFrom(all), true);
  assert.equal(turnStatusFrom(all), 'done');
});

test('a failed turn reports its error status', () => {
  const failed = [
    { type: 'turn.created', turn_id: 't1' },
    { type: 'turn.done', turn_id: 't1', state: { status: 'error', message: 'Request failed (401)', required_actions: [] } },
  ];
  assert.equal(turnStatusFrom(failed), 'error');
});
