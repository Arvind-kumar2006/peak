// Report parsing. The agent's final answer is model *text*, so it can arrive as
// raw JSON, fenced, or buried in a sentence. All three have to work, and none
// may throw.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReport, phaseToStatus } from '../src/domain/report.js';

const full = {
  phase: 'resolved',
  summary: 'Rolled back the bad commit.',
  rootCause: { category: 'code', description: 'leaked clients', confidence: 0.93, commitSha: 'a80e0f0' },
  evidence: [{ claim: 'pool saturated', tool: 'db.get_pool_stats', observation: '10/10' }],
  proposedFix: { action: 'trigger_rollback', args: { toDeployId: 'dep-1' }, reasoning: 'code-level' },
  verification: { windowSec: 60, before: {}, after: {}, verdict: 'stable' },
};

test('raw JSON in the verified model.message shape', () => {
  const report = extractReport({ type: 'model.message', content: JSON.stringify(full) });
  assert.equal(report.phase, 'resolved');
  assert.equal(report.rootCause.commitSha, 'a80e0f0');
  assert.equal(report.evidence.length, 1);
});

test('a plain string works too', () => {
  assert.equal(extractReport(JSON.stringify(full)).phase, 'resolved');
});

test('JSON inside a code fence', () => {
  const text = 'Here is the report:\n```json\n' + JSON.stringify(full) + '\n```';
  assert.equal(extractReport(text).phase, 'resolved');
});

test('JSON embedded in prose', () => {
  const text = `Based on the evidence, the service recovered.\n${JSON.stringify(full)}\nLet me know if you need more.`;
  assert.equal(extractReport(text).phase, 'resolved');
});

test('content parts array instead of a string', () => {
  const report = extractReport({ type: 'model.message', content: [{ type: 'text', text: JSON.stringify(full) }] });
  assert.equal(report.phase, 'resolved');
});

test('braces inside string values do not break the balanced-brace scan', () => {
  const tricky = { ...full, summary: 'the string contains { and } and a "quote' };
  const text = `prose ${JSON.stringify(tricky)} more prose`;
  const report = extractReport(text);
  assert.equal(report.summary, tricky.summary);
});

test('unrelated JSON is not mistaken for a report', () => {
  // e.g. the model echoing a tool's raw output, which has no phase.
  assert.equal(extractReport('{"foo":1,"bar":2}'), null);
});

test('garbage returns null instead of throwing', () => {
  for (const input of [null, undefined, '', 'not json at all', '{ broken', 42, {}]) {
    assert.doesNotThrow(() => extractReport(input), `threw on ${JSON.stringify(input)}`);
  }
  assert.equal(extractReport('not json at all'), null);
  assert.equal(extractReport(null), null);
});

test('missing optional fields normalise to null, never to invented values', () => {
  // A fabricated confidence of 0.9 on stage would be precisely the kind of lie
  // this project argues against.
  const report = extractReport(JSON.stringify({ phase: 'diagnosed', rootCause: { category: 'code' } }));
  assert.equal(report.rootCause.confidence, null);
  assert.equal(report.evidence.length, 0);
  assert.equal(report.verification, null);
  assert.equal(report.proposedFix.action, 'none');
});

test('phaseToStatus maps every schema phase', () => {
  for (const phase of ['diagnosed', 'resolved', 'mitigated', 'not_resolved', 'rejected']) {
    assert.equal(phaseToStatus(phase), phase);
  }
  assert.equal(phaseToStatus('nonsense'), null);
});
