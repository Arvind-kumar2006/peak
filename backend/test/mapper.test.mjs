// Pending-action extraction.
//
// This is the part of the TrueForge contract P3 still has open ("document where
// the pending tool call's name + args live"). So these tests deliberately cover
// several plausible shapes, not just the one we happen to know. When P3 answers,
// we delete the shapes that turned out to be wrong — and nothing else breaks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPendingAction, normaliseEvent, describeEvent } from '../src/trueforge/mapper.js';

const gate = (callId, sourceId) => ({
  type: 'tool.approval_required',
  thread_id: 'main',
  tool_calls: [{ id: callId, source_event_id: sourceId }],
});

test('name and args from a model.message referenced by source_event_id', () => {
  // The shape contracts/trueforge.md describes.
  const events = [
    {
      id: 'msg_1',
      type: 'model.message',
      thread_id: 'main',
      tool_calls: [
        { id: 'call_1', function: { name: 'trigger_rollback', arguments: '{"toDeployId":"dep-1"}' } },
      ],
    },
    gate('call_1', 'msg_1'),
  ];
  const pending = extractPendingAction(events);
  assert.equal(pending.tool, 'trigger_rollback');
  assert.deepEqual(pending.args, { toDeployId: 'dep-1' });
  assert.equal(pending.threadId, 'main');
  assert.equal(pending.toolCallId, 'call_1');
  assert.equal(pending.unavailable, false);
});

test('args given as a decoded object rather than a JSON string', () => {
  const events = [
    { id: 'm', type: 'model.message', tool_calls: [{ id: 'c', function: { name: 'clear_cache', arguments: { reason: 'memory' } } }] },
    gate('c', 'm'),
  ];
  assert.deepEqual(extractPendingAction(events).args, { reason: 'memory' });
});

test('a flat { name, arguments } tool call', () => {
  const events = [
    { id: 'm', type: 'model.message', tool_calls: [{ id: 'c', name: 'restart_service', arguments: '{"reason":"down"}' }] },
    gate('c', 'm'),
  ];
  const pending = extractPendingAction(events);
  assert.equal(pending.tool, 'restart_service');
  assert.deepEqual(pending.args, { reason: 'down' });
});

test('a standalone tool.call event', () => {
  const events = [
    { id: 'c', type: 'tool.call', name: 'scale_service', args: { replicas: 3 } },
    gate('c', 'c'),
  ];
  const pending = extractPendingAction(events);
  assert.equal(pending.tool, 'scale_service');
  assert.deepEqual(pending.args, { replicas: 3 });
});

test('tool calls nested under message or payload', () => {
  for (const wrap of [(e) => ({ ...e, message: e.tool_calls }), (e) => ({ ...e, payload: { tool_calls: e.tool_calls } })]) {
    const events = [
      wrap({ id: 'm', type: 'model.message', tool_calls: [{ id: 'c', function: { name: 'clear_cache', arguments: '{}' } }] }),
      gate('c', 'm'),
    ];
    assert.equal(extractPendingAction(events).tool, 'clear_cache');
  }
});

test('a truncated argument string surfaces raw text instead of an empty object', () => {
  // "reason": "Error rate 42%..." is still the most useful thing on an
  // approval card, so showing it beats showing {}.
  const events = [
    { id: 'm', type: 'model.message', tool_calls: [{ id: 'c', function: { name: 'restart_service', arguments: '{"reason":"Error rate 42' } }] },
    gate('c', 'm'),
  ];
  const pending = extractPendingAction(events);
  assert.equal(pending.tool, 'restart_service');
  assert.ok(pending.args._raw.includes('Error rate 42'));
});

test('gate with an unlocatable tool call degrades instead of throwing', () => {
  // A pending action showing as unavailable is cosmetic. Crashing the approval
  // flow is demo-ending. P3 has this as an open question, so this path matters.
  const pending = extractPendingAction([gate('call_ghost', 'msg_gone')]);
  assert.equal(pending.tool, null);
  assert.equal(pending.unavailable, true);
  assert.equal(pending.toolCallId, 'call_ghost');
});

test('gate with no tool_calls at all still produces a card', () => {
  const pending = extractPendingAction([{ type: 'tool.approval_required', thread_id: 'main' }]);
  assert.equal(pending.unavailable, true);
  assert.equal(pending.toolCallId, null);
});

test('no gate means no pending action', () => {
  assert.equal(extractPendingAction([{ type: 'model.message' }]), null);
  assert.equal(extractPendingAction([]), null);
});

test('extra pending calls are surfaced rather than dropped', () => {
  const events = [
    { id: 'm', type: 'model.message', tool_calls: [
      { id: 'c1', function: { name: 'clear_cache', arguments: '{}' } },
      { id: 'c2', function: { name: 'restart_service', arguments: '{}' } },
    ] },
    { type: 'tool.approval_required', thread_id: 'main', tool_calls: [
      { id: 'c1', source_event_id: 'm' }, { id: 'c2', source_event_id: 'm' },
    ] },
  ];
  const pending = extractPendingAction(events);
  assert.equal(pending.tool, 'clear_cache');
  assert.equal(pending.extras.length, 1);
  assert.equal(pending.extras[0].tool, 'restart_service');
});

test('the most recent gate wins after approve/reject', () => {
  const events = [gate('c1', 'm1'), gate('c2', 'm2')];
  assert.equal(extractPendingAction(events).toolCallId, 'c2');
});

test('normaliseEvent produces stable ids and a passthrough payload', () => {
  const event = normaliseEvent({ id: 'e1', type: 'model.message', content: 'hi' }, 0);
  assert.equal(event.eventId, 'e1');
  assert.equal(event.type, 'model.message');
  // The whole raw object is kept so new event types render without a backend change.
  assert.equal(event.payload.content, 'hi');
  assert.ok(event.at);
});

test('normaliseEvent tolerates an event with no id', () => {
  const event = normaliseEvent({ type: 'mystery' }, 7);
  assert.equal(event.type, 'mystery');
  assert.ok(event.eventId);
});

test('describeEvent produces something printable for unknown types', () => {
  assert.equal(describeEvent({ type: 'tool.approval_required' }).includes('approval'), true);
  assert.equal(describeEvent({ type: 'weird.new.event' }), 'weird.new.event');
  assert.equal(describeEvent(null), 'event');
});
