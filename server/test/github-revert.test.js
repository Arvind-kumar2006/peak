import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGithub } from './helpers/fake-github.js';

let gh;
let github;
before(async () => {
  gh = await startFakeGithub();
  process.env.GITHUB_API_URL = gh.url;
  process.env.DB_PATH = ':memory:';
  const { liveGithub } = await import('../src/integrations/github.js');
  github = liveGithub({ token: 't', repo: gh.repo, branch: 'main' });
});
after(() => gh.close());

test('reverts a commit that is not the branch tip, keeping later unrelated changes', async () => {
  gh.commit('init', { 'src/pay.js': 'payment_id', 'README.md': 'v1' });
  const bad = gh.commit('rename field', { 'src/pay.js': 'transaction_id', 'README.md': 'v1' });
  gh.commit('docs', { 'src/pay.js': 'transaction_id', 'README.md': 'v2' });

  const r = await github.revertCommit(bad, { reason: 'errors' });
  assert.equal(gh.head(), r.revertSha, 'branch ref moved to the revert commit');
  assert.deepEqual(gh.files(), { 'src/pay.js': 'payment_id', 'README.md': 'v2' });
  assert.match(gh.message(), /^Revert "rename field"/);
  assert.match(gh.message(), new RegExp(`This reverts commit ${bad}`));
  assert.deepEqual(r.files, ['src/pay.js']);
});

test('refuses when a later commit changed the same file', async () => {
  gh.commit('init', { 'a.js': '1' });
  const bad = gh.commit('bad', { 'a.js': '2' });
  const tip = gh.commit('builds on bad', { 'a.js': '3' });
  await assert.rejects(github.revertCommit(bad), /later commits also changed a\.js/);
  assert.equal(gh.head(), tip, 'nothing was pushed');
});

test('reverting a commit that added a file deletes it', async () => {
  gh.commit('init', { 'a.js': '1' });
  const added = gh.commit('add b', { 'a.js': '1', 'b.js': 'new' });
  await github.revertCommit(added);
  assert.deepEqual(gh.files(), { 'a.js': '1' });
});

test('refuses merge commits', async () => {
  const side = gh.commit('side', { 'a.js': 'x' });
  gh.commit('main', { 'a.js': 'y' });
  const m = gh.merge('merge', { 'a.js': 'z' }, side);
  await assert.rejects(github.revertCommit(m), /exactly one parent/);
  assert.equal(gh.head(), m);
});
