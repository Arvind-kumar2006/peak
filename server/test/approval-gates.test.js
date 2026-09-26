// The safety story: revert_commit only runs for an approved incident, in the fixing state,
// on the exact commit the diagnosis proposed, once. Exercised through the real MCP server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGithub } from './helpers/fake-github.js';

let gh, client, store, db, bad;

before(async () => {
  gh = await startFakeGithub();
  Object.assign(process.env, { GITHUB_API_URL: gh.url, DB_PATH: ':memory:', VERIFY_WINDOW_SEC: '1' });
  ({ db } = await import('../src/db.js'));
  store = await import('../src/store.js');
  const { connect } = await import('../src/integrations/index.js');
  const { buildServer } = await import('../src/agent/tools.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'test', '2026-01-01')").run();
  await connect('ws_1', 'github', { token: 't', repo: gh.repo });

  gh.commit('init', { 'pay.js': 'payment_id' });
  bad = gh.commit('rename', { 'pay.js': 'transaction_id' });

  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});
after(() => gh.close());

function newIncident(patch = {}) {
  const service = store.createService('ws_1', { name: 'API', sentryProject: 'api' });
  const inc = store.createIncident({ workspaceId: 'ws_1', serviceId: service.id, title: 'errors', signal: {} });
  store.updateIncident(inc.id, { diagnosis: { summary: 's', proposed_fix: { type: 'revert_commit', sha: bad, reason: 'r' } }, ...patch });
  return store.getIncident(inc.id);
}
const approve = (id, by = 'alice') => store.transition(id, ['awaiting_approval'], 'fixing', { approval: { decision: 'approved', by, at: new Date().toISOString() } });

async function revert(incident_id, sha = bad) {
  const r = await client.callTool({ name: 'revert_commit', arguments: { incident_id, sha, reason: 'test' } });
  return { error: r.isError ? JSON.parse(r.content[0].text).error : null, result: r.isError ? null : JSON.parse(r.content[0].text) };
}

test('refuses without a recorded approval', async () => {
  const inc = newIncident();
  store.transition(inc.id, ['investigating'], 'awaiting_approval');
  const tip = gh.head();
  const { error } = await revert(inc.id);
  assert.match(error, /not been approved/);
  assert.equal(gh.head(), tip, 'nothing pushed');
});

test('refuses a commit other than the one proposed', async () => {
  const inc = newIncident();
  store.transition(inc.id, ['investigating'], 'awaiting_approval');
  approve(inc.id);
  const other = gh.commit('unrelated', { ...gh.files(), 'x.js': '1' });
  const tip = gh.head();
  const { error } = await revert(inc.id, other);
  assert.match(error, /Only the proposed commit/);
  assert.equal(gh.head(), tip);
});

test('refuses once a human closed the incident, even if it was approved', async () => {
  const inc = newIncident();
  store.transition(inc.id, ['investigating'], 'awaiting_approval');
  approve(inc.id);
  store.transition(inc.id, ['fixing'], 'resolved', { closure: { by: 'bob' } });
  const tip = gh.head();
  const { error } = await revert(inc.id);
  assert.match(error, /Incident is resolved/);
  assert.equal(gh.head(), tip);
});

test('approval is atomic: a second decision on the same incident loses', () => {
  const inc = newIncident();
  store.transition(inc.id, ['investigating'], 'awaiting_approval');
  assert.ok(approve(inc.id, 'alice'));
  assert.equal(store.transition(inc.id, ['awaiting_approval'], 'rejected'), null);
  assert.equal(store.getIncident(inc.id).approval.by, 'alice');
});

test('approved + fixing + proposed sha: reverts once, then verifies', async () => {
  const inc = newIncident();
  store.transition(inc.id, ['investigating'], 'awaiting_approval');
  approve(inc.id);

  const { error, result } = await revert(inc.id);
  assert.equal(error, null);
  assert.equal(gh.head(), result.revertSha);
  assert.equal(gh.files()['pay.js'], 'payment_id');
  assert.equal(store.getIncident(inc.id).fix.targetSha, bad);

  const again = await revert(inc.id);
  assert.match(again.error, /Already reverted/);

  // No health URL and no Sentry: the 1s watch window passes → resolved.
  for (let i = 0; i < 40 && !['resolved', 'unresolved'].includes(store.getIncident(inc.id).status); i++) await new Promise((r) => setTimeout(r, 100));
  const done = store.getIncident(inc.id);
  assert.equal(done.status, 'resolved');
  assert.equal(done.verification.verdict, 'resolved');
});

test('unknown incident ids are rejected', async () => {
  const { error } = await revert('inc_nope');
  assert.match(error, /Unknown incident_id/);
});
