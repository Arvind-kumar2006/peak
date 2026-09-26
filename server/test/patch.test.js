import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPatch, PatchError, LIMITS } from '../src/patch.js';

const repo = {
  'src/pay.js': "export function build(order) {\n  return {\n    transaction_id: `txn_${order.id}`,\n    amount: order.total,\n  };\n}\n",
  'src/a.js': 'x\nx\n',
};
const read = async (path) => {
  if (!(path in repo)) throw new Error('Not Found');
  return repo[path];
};

test('applies a unique find/replace and returns an exact diff', async () => {
  const r = await buildPatch([{ path: 'src/pay.js', find: '    transaction_id: `txn_${order.id}`,', replace: '    payment_id: `pay_${order.id}`,' }], read);
  assert.match(r.files['src/pay.js'], /payment_id: `pay_\$\{order.id\}`/);
  assert.doesNotMatch(r.files['src/pay.js'], /transaction_id/);
  assert.equal(r.changedLines, 2);
  assert.match(r.diffs[0].patch, /^-\s+transaction_id/m);
  assert.match(r.diffs[0].patch, /^\+\s+payment_id/m);
});

test('replacement text is literal ($ patterns are not interpreted)', async () => {
  const r = await buildPatch([{ path: 'src/pay.js', find: 'amount: order.total,', replace: "amount: '$&$1',"}], read);
  assert.match(r.files['src/pay.js'], /amount: '\$&\$1',/);
});

test('rejects text that is missing or not unique', async () => {
  await assert.rejects(buildPatch([{ path: 'src/pay.js', find: 'nope', replace: 'y' }], read), /not found/);
  await assert.rejects(buildPatch([{ path: 'src/a.js', find: 'x', replace: 'y' }], read), /appears 2 times/);
});

test('only existing files; never CI, dependencies, secrets or infra', async () => {
  await assert.rejects(buildPatch([{ path: 'src/new.js', find: 'a', replace: 'b' }], read), /only change existing files/);
  for (const path of ['.github/workflows/ci.yml', 'package.json', 'web/package-lock.json', '.env', 'config/.env.production', 'Dockerfile', 'infra/main.tf', '../etc/passwd']) {
    await assert.rejects(buildPatch([{ path, find: 'a', replace: 'b' }], read), PatchError, path);
  }
});

test('enforces the size limits', async () => {
  const many = Array.from({ length: LIMITS.files + 1 }, (_, i) => ({ path: `f${i}.js`, find: 'a', replace: 'b' }));
  await assert.rejects(buildPatch(many, read), /at most 3 files/);
  const big = { 'big.js': Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') };
  const huge = big['big.js'].replace(/line/g, 'LINE');
  await assert.rejects(buildPatch([{ path: 'big.js', find: big['big.js'], replace: huge }], async (p) => big[p]), /changes 160 lines; the limit is 60/);
});
