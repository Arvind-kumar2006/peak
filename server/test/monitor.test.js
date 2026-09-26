// Detection: failing health checks, slow responses, mute, and the hand-off cooldown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let server, url, store, db, checkService;
const mode = { status: 200, delayMs: 0 };

before(async () => {
  Object.assign(process.env, { DB_PATH: ':memory:', FAILED_CHECKS_TO_ALERT: '2', TRUEFORGE_URL: 'http://127.0.0.1:1', MODEL_PROVIDERS: 'openai', OPENAI_API_KEY: '' });
  server = http.createServer((req, res) => setTimeout(() => res.writeHead(mode.status, { 'content-type': 'application/json' }).end('{"status":"ok","release":"abc1234def"}'), mode.delayMs));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/health`;
  ({ db } = await import('../src/db.js'));
  store = await import('../src/store.js');
  ({ checkService } = await import('../src/monitor.js'));
  db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('ws_1', 'test', '2026-01-01')").run();
});
after(() => server.close());

const fresh = (extra = {}) => store.createService('ws_1', { name: `svc${Math.random()}`, healthUrl: url, ...extra });
const check = async (id) => checkService(store.getService(id));
const incidents = (serviceId) => store.listIncidents('ws_1', { limit: 100 }).filter((i) => i.serviceId === serviceId);

test('one failed check degrades; the second opens an incident', async () => {
  mode.status = 500;
  const s = fresh();
  assert.equal(await check(s.id), 'degraded');
  assert.equal(incidents(s.id).length, 0);
  assert.equal(await check(s.id), 'down');
  const [inc] = incidents(s.id);
  assert.match(inc.title, /health check failing/);
  assert.equal(inc.signal.failedChecks, 2);
  mode.status = 200;
});

test('healthy checks record the release and reset the failure count', async () => {
  const s = fresh();
  assert.equal(await check(s.id), 'healthy');
  assert.equal(store.getService(s.id).release, 'abc1234def');
  assert.equal(store.getService(s.id).failedChecks, 0);
});

test('slow responses over the threshold open a latency incident', async () => {
  mode.delayMs = 120;
  const s = fresh({ latencyThresholdMs: 60 });
  await check(s.id);
  assert.equal(incidents(s.id).length, 0);
  assert.equal(await check(s.id), 'degraded');
  assert.match(incidents(s.id)[0].title, /Slow responses/);
  mode.delayMs = 0;
});

test('a muted service is checked but does not open incidents', async () => {
  mode.status = 503;
  const s = fresh();
  store.setMute(s.id, { until: new Date(Date.now() + 60_000).toISOString(), reason: 'deploy' });
  await check(s.id);
  assert.equal(await check(s.id), 'down');
  assert.equal(incidents(s.id).length, 0);
  store.setMute(s.id, { until: null });
  await check(s.id);
  assert.equal(incidents(s.id).length, 1, 'alerts again once unmuted');
  mode.status = 200;
});

test('no new incident right after one was handed to a human', async () => {
  mode.status = 500;
  const s = fresh();
  await check(s.id);
  await check(s.id);
  const [first] = incidents(s.id);
  // The agent is offline in tests, so the incident fails quickly; wait for that.
  for (let i = 0; i < 50 && store.getIncident(first.id).status === 'investigating'; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getIncident(first.id).status, 'failed');
  await check(s.id);
  await check(s.id);
  assert.equal(incidents(s.id).length, 1, 'cooldown holds');
  mode.status = 200;
});

test('incident list pages by start time', () => {
  for (let i = 0; i < 5; i++) {
    const inc = store.createIncident({ workspaceId: 'ws_1', serviceId: fresh().id, title: `p${i}`, signal: {} });
    db.prepare('UPDATE incidents SET started_at = ? WHERE id = ?').run(`2020-01-0${i + 1}T00:00:00.000Z`, inc.id);
  }
  const page1 = store.listIncidents('ws_1', { limit: 3, before: '2020-12-31' });
  const page2 = store.listIncidents('ws_1', { limit: 3, before: page1.at(-1).startedAt });
  assert.deepEqual(page1.map((i) => i.title), ['p4', 'p3', 'p2']);
  assert.deepEqual(page2.map((i) => i.title), ['p1', 'p0']);
});
