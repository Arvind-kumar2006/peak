// Detection: failing health checks, slow responses, mute, and the hand-off cooldown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let server, url, store, db, checkService;
const mode = { status: 200, delayMs: 0 };

before(async () => {
  Object.assign(process.env, { DATABASE_URL: 'memory', FAILED_CHECKS_TO_ALERT: '2', TRUEFORGE_URL: 'http://127.0.0.1:1', MODEL_PROVIDERS: 'openai', OPENAI_API_KEY: '' });
  server = http.createServer((req, res) => setTimeout(() => res.writeHead(mode.status, { 'content-type': 'application/json' }).end('{"status":"ok","release":"abc1234def"}'), mode.delayMs));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/health`;
  ({ db } = await import('../src/db.js'));
  store = await import('../src/store.js');
  ({ checkService } = await import('../src/monitor.js'));
  await db.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'test', '2026-01-01')");
});
after(async () => {
  server.close();
  await db.close();
});

const fresh = (extra = {}) => store.createService('ws_1', { name: `svc${Math.random()}`, healthUrl: url, ...extra });
const check = async (id) => checkService(await store.getService(id));
const incidents = async (serviceId) => (await store.listIncidents('ws_1', { limit: 100 })).filter((i) => i.serviceId === serviceId);

test('one failed check degrades; the second opens an incident', async () => {
  mode.status = 500;
  const s = await fresh();
  assert.equal(await check(s.id), 'degraded');
  assert.equal((await incidents(s.id)).length, 0);
  assert.equal(await check(s.id), 'down');
  const [inc] = await incidents(s.id);
  assert.match(inc.title, /health check failing/);
  assert.equal(inc.signal.failedChecks, 2);
  mode.status = 200;
});

test('healthy checks record the release and reset the failure count', async () => {
  const s = await fresh();
  assert.equal(await check(s.id), 'healthy');
  assert.equal((await store.getService(s.id)).release, 'abc1234def');
  assert.equal((await store.getService(s.id)).failedChecks, 0);
});

test('slow responses over the threshold open a latency incident', async () => {
  mode.delayMs = 120;
  const s = await fresh({ latencyThresholdMs: 60 });
  await check(s.id);
  assert.equal((await incidents(s.id)).length, 0);
  assert.equal(await check(s.id), 'degraded');
  assert.match((await incidents(s.id))[0].title, /Slow responses/);
  mode.delayMs = 0;
});

test('a muted service is checked but does not open incidents', async () => {
  mode.status = 503;
  const s = await fresh();
  await store.setMute(s.id, { until: new Date(Date.now() + 60_000).toISOString(), reason: 'deploy' });
  await check(s.id);
  assert.equal(await check(s.id), 'down');
  assert.equal((await incidents(s.id)).length, 0);
  await store.setMute(s.id, { until: null });
  await check(s.id);
  assert.equal((await incidents(s.id)).length, 1, 'alerts again once unmuted');
  mode.status = 200;
});

test('no new incident right after one was handed to a human', async () => {
  mode.status = 500;
  const s = await fresh();
  await check(s.id);
  await check(s.id);
  const [first] = await incidents(s.id);
  // The agent is offline in tests, so the incident fails quickly; wait for that.
  for (let i = 0; i < 50 && (await store.getIncident(first.id)).status === 'investigating'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await store.getIncident(first.id)).status, 'failed');
  await check(s.id);
  await check(s.id);
  assert.equal((await incidents(s.id)).length, 1, 'cooldown holds');
  mode.status = 200;
});

test('incident pages never skip rows, even with identical start times', async () => {
  // Isolated workspace: 5 incidents, three of them in the same millisecond.
  await db.run("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_p', 'paging', '2026-01-01')");
  const svc = await store.createService('ws_p', { name: 'p', healthUrl: url });
  const times = ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-03', '2020-01-03'].map((d) => `${d}T00:00:00.000Z`);
  const ids = [];
  for (const [i, t] of times.entries()) {
    const inc = await store.createIncident({ workspaceId: 'ws_p', serviceId: svc.id, title: `p${i}`, signal: {} });
    await db.run('UPDATE incidents SET started_at = ? WHERE id = ?', t, inc.id);
    ids.push(inc.id);
  }
  const seen = [];
  let after;
  do {
    const page = await store.pageIncidents('ws_p', { limit: 2, after });
    seen.push(...page.items.map((i) => i.id));
    after = page.next;
  } while (after);
  assert.equal(seen.length, 5);
  assert.deepEqual([...seen].sort(), [...ids].sort(), 'every incident exactly once');
});
