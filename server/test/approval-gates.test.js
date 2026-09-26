// The safety story: revert_commit only runs for an approved incident, in the fixing state,
// on the exact commit the diagnosis proposed, once. Exercised through the real MCP server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGithub } from './helpers/fake-github.js';

let gh, client, store, db, bad;

before(async () => {
  gh = await startFakeGithub();
  Object.assign(process.env, { GITHUB_API_URL: gh.url, DATABASE_URL: 'memory', VERIFY_WINDOW_SEC: '1' });
  ({ db } = await import('../src/db.js'));
  store = await import('../src/store.js');
  const { connect } = await import('../src/integrations/index.js');
  const { buildServer } = await import('../src/agent/tools.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  await db.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'test', '2026-01-01')");
  await connect('ws_1', 'github', { token: 't', repo: gh.repo });

  gh.commit('init', { 'pay.js': 'payment_id' });
  bad = gh.commit('rename', { 'pay.js': 'transaction_id' });

  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});
after(async () => {
  gh.close();
  await db.close();
});

async function newIncident(patch = {}) {
  const service = await store.createService('ws_1', { name: 'API', sentryProject: 'api' });
  const inc = await store.createIncident({ workspaceId: 'ws_1', serviceId: service.id, title: 'errors', signal: {} });
  return store.updateIncident(inc.id, { diagnosis: { summary: 's', proposed_fix: { type: 'revert_commit', sha: bad, reason: 'r' } }, ...patch });
}
const approve = (id, by = 'alice') => store.transition(id, ['awaiting_approval'], 'fixing', { approval: { decision: 'approved', by, at: new Date().toISOString() } });

async function revert(incident_id, sha = bad) {
  const r = await client.callTool({ name: 'revert_commit', arguments: { incident_id, sha, reason: 'test' } });
  return { error: r.isError ? JSON.parse(r.content[0].text).error : null, result: r.isError ? null : JSON.parse(r.content[0].text) };
}

test('refuses without a recorded approval', async () => {
  const inc = await newIncident();
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  const tip = gh.head();
  const { error } = await revert(inc.id);
  assert.match(error, /not been approved/);
  assert.equal(gh.head(), tip, 'nothing pushed');
});

test('refuses a commit other than the one proposed', async () => {
  const inc = await newIncident();
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  await approve(inc.id);
  const other = gh.commit('unrelated', { ...gh.files(), 'x.js': '1' });
  const tip = gh.head();
  const { error } = await revert(inc.id, other);
  assert.match(error, /Only the proposed commit/);
  assert.equal(gh.head(), tip);
});

test('refuses once a human closed the incident, even if it was approved', async () => {
  const inc = await newIncident();
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  await approve(inc.id);
  await store.transition(inc.id, ['fixing'], 'resolved', { closure: { by: 'bob' } });
  const tip = gh.head();
  const { error } = await revert(inc.id);
  assert.match(error, /Incident is resolved/);
  assert.equal(gh.head(), tip);
});

test('approval is atomic: concurrent decisions, exactly one wins', async () => {
  const inc = await newIncident();
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  const results = await Promise.all([approve(inc.id, 'alice'), store.transition(inc.id, ['awaiting_approval'], 'rejected'), approve(inc.id, 'carol')]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results[0]?.status, 'fixing', 'first one in wins');
  assert.equal((await store.getIncident(inc.id)).approval.by, 'alice');
});

test('approved + fixing + proposed sha: reverts once, then verifies', async () => {
  const inc = await newIncident();
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  await approve(inc.id);

  const { error, result } = await revert(inc.id);
  assert.equal(error, null);
  assert.equal(gh.head(), result.revertSha);
  assert.equal(gh.files()['pay.js'], 'payment_id');
  assert.equal((await store.getIncident(inc.id)).fix.targetSha, bad);

  const again = await revert(inc.id);
  assert.match(again.error, /Already reverted/);

  // No health URL and no Sentry: the 1s watch window passes → resolved.
  let done;
  for (let i = 0; i < 40; i++) {
    done = await store.getIncident(inc.id);
    if (['resolved', 'unresolved'].includes(done.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(done.status, 'resolved');
  assert.equal(done.verification.verdict, 'resolved');
});

test('unknown incident ids are rejected', async () => {
  const { error } = await revert('inc_nope');
  assert.match(error, /Unknown incident_id/);
});
