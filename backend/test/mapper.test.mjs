// Pending-action extraction and event normalisation.
//
// The pending action now comes from P3's `getPendingAction()`
// (contracts/backend-api.md), so this tests the glue between its return shape
// and the flat Incident object — in particular the degradation path, because a
// runtime that is waiting on a tool call we cannot describe is a state the
// dashboard has to survive.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingActionFrom, normaliseEvent, describeEvent, isReportTool } from '../src/trueforge/mapper.js';

const action = (over = {}) => ({
  toolCallId: 'call_1',
  threadId: 'main',
  tool: 'trigger_rollback',
  server: 'github-mcp',
  args: { toDeployId: 'dep-1' },
  ...over,
});

test('a single pending action becomes the contract shape', () => {
  const pending = pendingActionFrom([action()]);
  assert.equal(pending.tool, 'trigger_rollback');
  assert.equal(pending.toolCallId, 'call_1');
  assert.equal(pending.threadId, 'main');
  assert.deepEqual(pending.args, { toDeployId: 'dep-1' });
  assert.equal(pending.unavailable, false);
  assert.deepEqual(pending.extras, []);
});

test('extra pending calls are surfaced rather than dropped', () => {
  const pending = pendingActionFrom([
    action(),
    action({ toolCallId: 'call_2', tool: 'restart_service' }),
  ]);
  assert.equal(pending.tool, 'trigger_rollback');
  assert.equal(pending.extras.length, 1);
  assert.equal(pending.extras[0].tool, 'restart_service');
});

test('args delivered as a JSON string are decoded', () => {
  const pending = pendingActionFrom([action({ args: '{"reason":"pool exhausted"}' })]);
  assert.deepEqual(pending.args, { reason: 'pool exhausted' });
});

test('args that are an unparseable string become an empty object, not a crash', () => {
  assert.deepEqual(pendingActionFrom([action({ args: '{ truncated' })]).args, {});
});

test('a pending action with no tool is marked unavailable, not dropped', () => {
  // The runtime is waiting. Showing "details unavailable" beats hiding the fact
  // that a decision is needed.
  const pending = pendingActionFrom([action({ tool: null })]);
  assert.equal(pending.unavailable, true);
  assert.equal(pending.tool, null);
  assert.equal(pending.toolCallId, 'call_1');
});

test('a pending action with no tool call id is marked unavailable', () => {
  assert.equal(pendingActionFrom([action({ toolCallId: null })]).unavailable, true);
});

test('no pending actions means no pending action', () => {
  assert.equal(pendingActionFrom([]), null);
  assert.equal(pendingActionFrom(null), null);
  assert.equal(pendingActionFrom(undefined), null);
});

test('normaliseEvent keeps the raw payload and a stable id', () => {
  const event = normaliseEvent(
    { id: 'e1', type: 'model.message', created_at: '2026-09-26T10:00:00Z', tool_calls: [{ function: { name: 'get_pool_stats' } }] },
    0,
  );
  assert.equal(event.eventId, 'e1');
  assert.equal(event.type, 'model.message');
  // The whole raw object is kept so a new event type renders without a backend
  // change.
  assert.equal(event.payload.tool_calls[0].function.name, 'get_pool_stats');
  assert.equal(event.at, '2026-09-26T10:00:00Z');
});

test('normaliseEvent tolerates an event with no id or timestamp', () => {
  const event = normaliseEvent({ type: 'mystery' }, 7);
  assert.equal(event.type, 'mystery');
  assert.ok(event.eventId);
  assert.ok(event.at);
});

test('describeEvent names the tools a model.message called', () => {
  const d = describeEvent({
    type: 'model.message',
    tool_calls: [{ function: { name: 'get_pool_stats' } }, { function: { name: 'list_recent_commits' } }],
  });
  assert.match(d, /get_pool_stats/);
  assert.match(d, /list_recent_commits/);
});

test('describeEvent produces something printable for unknown types', () => {
  assert.match(describeEvent({ type: 'tool.approval_required' }), /approval/);
  assert.match(describeEvent({ type: 'tool.response', name: 'get_pool_stats' }), /get_pool_stats/);
  assert.equal(describeEvent({ type: 'weird.new.event' }), 'weird.new.event');
  assert.equal(describeEvent(null), 'event');
});

test('isReportTool identifies the report-mcp submission tools', () => {
  assert.equal(isReportTool('submit_diagnosis'), true);
  assert.equal(isReportTool('submit_resolution'), true);
  assert.equal(isReportTool('get_pool_stats'), false);
});
