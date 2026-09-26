import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { sameCommit } = await import('../src/health.js');
const { buildMessage, formatDuration } = await import('../src/notify.js');

test('sameCommit matches full and short SHAs, not unrelated ones', () => {
  const sha = 'f86cf1d80ea9e87973f640c47662e2ad18f8c1cd';
  assert.ok(sameCommit(sha, sha));
  assert.ok(sameCommit('f86cf1d', sha));
  assert.ok(!sameCommit('f86c', sha)); // too short to trust
  assert.ok(!sameCommit('5299304', sha));
  assert.ok(!sameCommit(null, sha));
});

test('formatDuration', () => {
  assert.equal(formatDuration(381_000), '6m 21s');
  assert.equal(formatDuration(3_900_000), '1h 5m');
});

const service = { name: 'Checkout API' };
const base = { id: 'inc_1', title: 'Error spike', startedAt: '2026-09-26T10:00:00Z' };

test('approval message names the root cause and the commit to revert', () => {
  const msg = buildMessage(
    {
      ...base,
      status: 'awaiting_approval',
      diagnosis: {
        summary: 'payment_id was renamed',
        suspect_commit: { sha: 'a82f91c0000', message: 'rename payment_id' },
        proposed_fix: { type: 'revert_commit', sha: 'a82f91c0000', reason: 'restores payment_id' },
      },
    },
    service,
  );
  const text = JSON.stringify(msg.blocks);
  assert.match(text, /payment_id was renamed/);
  assert.match(text, /Revert commit `a82f91c`/);
  assert.match(text, /Waiting for approval/);
});

test('resolved message reports before/after errors and duration', () => {
  const msg = buildMessage(
    {
      ...base,
      status: 'resolved',
      resolvedAt: '2026-09-26T10:06:21Z',
      verification: { before: { errorsPerMin: 142 }, after: { errorsPerMin: 0, healthy: true }, deploy: { release: '5299304abc', confirmed: true } },
    },
    service,
  );
  const text = JSON.stringify(msg.blocks);
  assert.match(text, /142\/min → 0\/min/);
  assert.match(text, /Incident duration: 6m 21s/);
});
