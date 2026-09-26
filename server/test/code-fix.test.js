// Code fixes end to end through the real MCP tools: propose (validated diff) → approval gate
// → apply as a direct commit (push mode) or a pull request → merge → verify.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGithub } from './helpers/fake-github.js';

let gh, client, store, db;
const PAY = "export function build(order) {\n  return {\n    transaction_id: `txn_${order.id}`,\n    amount: order.total,\n  };\n}\n";
const EDIT = { path: 'src/pay.js', find: '    transaction_id: `txn_${order.id}`,', replace: '    payment_id: `pay_${order.id}`,' };

before(async () => {
  gh = await startFakeGithub();
  Object.assign(process.env, { GITHUB_API_URL: gh.url, DATABASE_URL: 'memory', VERIFY_WINDOW_SEC: '1', MERGE_POLL_SEC: '0.1' });
  ({ db } = await import('../src/db.js'));
  store = await import('../src/store.js');
  const { connect } = await import('../src/integrations/index.js');
  const { buildServer } = await import('../src/agent/tools.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  await db.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'test', '2026-01-01')");
  gh.commit('init', { 'src/pay.js': PAY, 'README.md': 'hi' });
  await connect('ws_1', 'github', { token: 't', repo: gh.repo });

  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});
after(async () => {
  gh.close();
  await db.close();
});

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const body = JSON.parse(r.content[0].text);
  return r.isError ? { error: body.error } : { result: body };
}

async function newIncident() {
  const service = await store.createService('ws_1', { name: 'API', sentryProject: 'api' });
  return store.createIncident({ workspaceId: 'ws_1', serviceId: service.id, title: 'errors', signal: {} });
}

const diagnose = (incident_id, edits = [EDIT]) =>
  call('submit_diagnosis', {
    incident_id,
    summary: 'The payload lost payment_id.',
    root_cause: 'buildPaymentRequest sends transaction_id; the gateway requires payment_id.',
    confidence: 0.9,
    suspect_commit: null,
    evidence: [
      { source: 'sentry', detail: 'payment_id is required' },
      { source: 'github', detail: 'src/pay.js sends transaction_id' },
    ],
    proposed_fix: { type: 'patch', title: 'Send payment_id to the gateway again', edits, reason: 'The gateway contract requires payment_id.' },
  });

const approve = (id) => store.transition(id, ['awaiting_approval'], 'fixing', { approval: { decision: 'approved', by: 'alice', at: new Date().toISOString() } });

async function waitFor(id, statuses) {
  for (let i = 0; i < 60; i++) {
    const inc = await store.getIncident(id);
    if (statuses.includes(inc.status)) return inc;
    await new Promise((r) => setTimeout(r, 100));
  }
  return store.getIncident(id);
}

test('an invalid patch is rejected at diagnosis, so the agent can correct it', async () => {
  const inc = await newIncident();
  const { error } = await diagnose(inc.id, [{ path: 'src/pay.js', find: 'not in the file', replace: 'x' }]);
  assert.match(error, /not found/);
  assert.equal((await store.getIncident(inc.id)).diagnosis, null, 'nothing recorded');
});

test('diagnosis stores the exact diff the human will approve', async () => {
  const inc = await newIncident();
  const { result } = await diagnose(inc.id);
  assert.match(result.next, /apply_patch/);
  const fix = (await store.getIncident(inc.id)).diagnosis.proposed_fix;
  assert.equal(fix.preview.changedLines, 2);
  assert.equal(fix.preview.mode, 'pr', 'pull requests by default');
  assert.match(fix.preview.diffs[0].patch, /\+\s+payment_id/);
});

test('apply_patch refuses without approval and leaves the repo alone', async () => {
  const inc = await newIncident();
  await diagnose(inc.id);
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  const tip = gh.head();
  const { error } = await call('apply_patch', { incident_id: inc.id, reason: 'fix' });
  assert.match(error, /not been approved/);
  assert.equal(gh.head(), tip);
  assert.equal(gh.pulls.size, 0);
});

test('pull-request mode: opens a PR, waits for the merge, then verifies', async () => {
  const inc = await newIncident();
  await diagnose(inc.id);
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  await approve(inc.id);
  const tip = gh.head();

  const { result, error } = await call('apply_patch', { incident_id: inc.id, reason: 'fix' });
  assert.equal(error, undefined);
  assert.equal(result.pullRequest.number, 1);
  assert.equal(gh.head(), tip, 'main untouched until the PR is merged');
  const pr = gh.pulls.get(1);
  assert.equal(pr.base, 'main');
  assert.match(pr.head, /^peak\/fix-/);
  assert.equal(pr.title, 'Send payment_id to the gateway again');

  let now = await store.getIncident(inc.id);
  assert.equal(now.status, 'awaiting_merge');

  const mergeSha = gh.mergePull(1);
  now = await waitFor(inc.id, ['resolved', 'unresolved']);
  assert.equal(now.status, 'resolved');
  assert.equal(now.fix.commitSha, mergeSha, 'verified against the merge commit');
  assert.match(gh.files()['src/pay.js'], /payment_id: `pay_/);

  const again = await call('apply_patch', { incident_id: inc.id, reason: 'again' });
  assert.match(again.error, /already applied|Incident is resolved/);
});

test('pull-request mode: a PR closed without merging leaves the incident unresolved', async () => {
  const inc = await newIncident();
  // A different edit so the branch content still contains transaction_id… reset the file first.
  gh.commit('reintroduce bug', { ...gh.files(), 'src/pay.js': PAY });
  await diagnose(inc.id);
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  await approve(inc.id);
  const { result } = await call('apply_patch', { incident_id: inc.id, reason: 'fix' });
  gh.closePull(result.pullRequest.number);
  const now = await waitFor(inc.id, ['unresolved', 'resolved']);
  assert.equal(now.status, 'unresolved');
  assert.match(now.verification.reason, /closed without merging/);
});

test('push mode: commits the approved change to the branch and verifies', async () => {
  await store.updateWorkspaceSettings('ws_1', { fixMode: 'push' });
  gh.commit('reintroduce bug', { ...gh.files(), 'src/pay.js': PAY });
  const inc = await newIncident();
  await diagnose(inc.id);
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  await approve(inc.id);

  const { result, error } = await call('apply_patch', { incident_id: inc.id, reason: 'fix' });
  assert.equal(error, undefined);
  assert.equal(gh.head(), result.commitSha, 'branch moved to the fix commit');
  assert.match(gh.files()['src/pay.js'], /payment_id: `pay_/);
  assert.match(gh.message(), /^Send payment_id to the gateway again/);
  const now = await waitFor(inc.id, ['resolved', 'unresolved']);
  assert.equal(now.status, 'resolved');
});

test('apply fails cleanly if the code changed after approval', async () => {
  gh.commit('reintroduce bug', { ...gh.files(), 'src/pay.js': PAY });
  const inc = await newIncident();
  await diagnose(inc.id);
  await store.transition(inc.id, ['investigating'], 'awaiting_approval');
  await approve(inc.id);
  gh.commit('someone else fixed it differently', { ...gh.files(), 'src/pay.js': PAY.replace('transaction_id', 'txn') });
  const tip = gh.head();
  const { error } = await call('apply_patch', { incident_id: inc.id, reason: 'fix' });
  assert.match(error, /not found/);
  assert.equal(gh.head(), tip);
});
