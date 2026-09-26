// Diagnosis / Resolution parsing.
//
// The agent submits these as the *arguments* to `submit_diagnosis` and
// `submit_resolution`. In MCP those arguments arrive as a JSON *string*, so the
// parser's first job is tolerating that — and its second, more important job is
// never throwing and never inventing a value.

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDiagnosis, extractResolution, verdictToStatus, VERDICTS } from '../src/domain/report.js';

const fullDiagnosis = {
  summary: 'A bad commit leaks Postgres clients.',
  rootCause: { category: 'code', description: 'missing client.release()', confidence: 0.93, commitSha: 'a80e0f0' },
  evidence: [{ claim: 'pool saturated', tool: 'db.get_pool_stats', observation: '10/10' }],
  ruledOut: ['Not traffic: rpm flat.'],
  proposedFix: { action: 'trigger_rollback', args: { toDeployId: 'dep-1' }, reasoning: 'code-level', expectedOutcome: 'resolves' },
  before: { errorRate: 0.42, p95Ms: 3812 },
};

const fullResolution = {
  verdict: 'resolved',
  actionTaken: 'trigger_rollback',
  windowSec: 60,
  before: { errorRate: 0.42 },
  after: { errorRate: 0.002 },
  reasoning: 'Stable for the full window.',
  followUp: 'Add client.release() and open a PR.',
};

test('diagnosis from a JSON string (how MCP delivers arguments)', () => {
  const d = extractDiagnosis(JSON.stringify(fullDiagnosis));
  assert.equal(d.summary, fullDiagnosis.summary);
  assert.equal(d.rootCause.commitSha, 'a80e0f0');
  assert.equal(d.rootCause.confidence, 0.93);
  assert.equal(d.evidence.length, 1);
  assert.deepEqual(d.ruledOut, ['Not traffic: rpm flat.']);
  assert.equal(d.proposedFix.expectedOutcome, 'resolves');
  assert.deepEqual(d.before, { errorRate: 0.42, p95Ms: 3812 });
});

test('diagnosis from an already-decoded object', () => {
  assert.equal(extractDiagnosis(fullDiagnosis).summary, fullDiagnosis.summary);
});

test('resolution from a JSON string', () => {
  const r = extractResolution(JSON.stringify(fullResolution));
  assert.equal(r.verdict, 'resolved');
  assert.equal(r.windowSec, 60);
  assert.deepEqual(r.after, { errorRate: 0.002 });
  assert.equal(r.followUp, 'Add client.release() and open a PR.');
});

test('unparseable or absent args return null instead of throwing', () => {
  // The dashboard polls every 2s. A throw here is a 500 on every tick.
  for (const input of [null, undefined, '', 'not json', '{ broken', 42, []]) {
    assert.doesNotThrow(() => extractDiagnosis(input), `diagnosis threw on ${JSON.stringify(input)}`);
    assert.doesNotThrow(() => extractResolution(input), `resolution threw on ${JSON.stringify(input)}`);
    assert.equal(extractDiagnosis(input), null);
    assert.equal(extractResolution(input), null);
  }
});

test('missing optional fields normalise to null, never to invented values', () => {
  // A fabricated confidence of 0.9 on stage would be precisely the kind of lie
  // this project argues against.
  const d = extractDiagnosis(JSON.stringify({ rootCause: { category: 'code' } }));
  assert.equal(d.rootCause.confidence, null);
  assert.equal(d.summary, null);
  assert.equal(d.rootCause.category, 'code');
  assert.equal(d.rootCause.commitSha, null);
  assert.equal(d.evidence.length, 0);
  assert.deepEqual(d.ruledOut, []);
  assert.equal(d.proposedFix.action, 'none');
  assert.deepEqual(d.proposedFix.args, {});
  assert.equal(d.before, null);
});

test('an unrecognised rootCause category degrades to unknown', () => {
  const d = extractDiagnosis(JSON.stringify({ rootCause: { category: 'cosmic-rays' } }));
  assert.equal(d.rootCause.category, 'unknown');
});

test('ruledOut keeps only strings', () => {
  const d = extractDiagnosis(JSON.stringify({ ...fullDiagnosis, ruledOut: ['ok', 42, null, { a: 1 }] }));
  assert.deepEqual(d.ruledOut, ['ok']);
});

test('a non-numeric confidence is dropped, not coerced', () => {
  const d = extractDiagnosis(JSON.stringify({ rootCause: { category: 'code', confidence: 'high' } }));
  assert.equal(d.rootCause.confidence, null);
});

test('resolution without a usable verdict is null-ish and does not set a status', () => {
  // deriveStatus keys entirely off verdictToStatus, so a missing verdict can
  // never accidentally look like a success.
  const r = extractResolution(JSON.stringify({ actionTaken: 'clear_cache' }));
  assert.equal(r.verdict, null);
  assert.equal(verdictToStatus(r.verdict), null);
  assert.equal(r.actionTaken, 'clear_cache');
});

test('verdictToStatus covers exactly the schema enum', () => {
  assert.deepEqual(VERDICTS.sort(), ['mitigated', 'not_resolved', 'rejected', 'resolved']);
  for (const v of VERDICTS) assert.equal(verdictToStatus(v), v);
  assert.equal(verdictToStatus('diagnosed'), null);
  assert.equal(verdictToStatus(undefined), null);
});
