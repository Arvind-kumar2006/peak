import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'memory';
let server, base;

before(async () => {
  const express = (await import('express')).default;
  const { authRoutes } = await import('../src/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});
after(async () => {
  server.close();
  await (await import('../src/db.js')).db.close();
});

const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('password hashing: verifies the right password only', async () => {
  const { hashPassword, verifyPassword } = await import('../src/crypto.js');
  const h = hashPassword('correct horse');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', null));
  assert.notEqual(hashPassword('same'), hashPassword('same'), 'salted');
});

test('secret encryption round-trips and detects tampering', async () => {
  const { encrypt, decrypt } = await import('../src/crypto.js');
  const box = await encrypt({ token: 'ghp_secret' });
  assert.ok(!box.includes('ghp_secret'));
  assert.deepEqual(await decrypt(box), { token: 'ghp_secret' });
  const [iv, tag, data] = box.split('.');
  const flipped = Buffer.from(data, 'base64');
  flipped[0] ^= 1;
  await assert.rejects(decrypt([iv, tag, flipped.toString('base64')].join('.')));
});

test('signup → session cookie → me; wrong password is refused', async () => {
  const r = await post('/signup', { email: 'A@Example.com', password: 'password123', name: 'A' });
  assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /peak_session=.+HttpOnly/i);
  const me = await fetch(`${base}/me`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal((await me.json()).user.email, 'a@example.com');

  assert.equal((await post('/signup', { email: 'a@example.com', password: 'password123' })).status, 409);
  assert.equal((await post('/signup', { email: 'b@example.com', password: 'short' })).status, 400);
  assert.equal((await post('/login', { email: 'a@example.com', password: 'nope-nope' })).status, 401);
  assert.equal((await post('/login', { email: 'a@example.com', password: 'password123' })).status, 200);
});

test('login is rate limited per email', async () => {
  await post('/signup', { email: 'victim@example.com', password: 'password123' });
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post('/login', { email: 'victim@example.com', password: `guess${i}xx` })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.equal(codes[10], 429);
  // Even the right password is refused while locked out.
  assert.equal((await post('/login', { email: 'victim@example.com', password: 'password123' })).status, 429);
});

test('rateLimit: counts per key and resets after the window', async () => {
  const { rateLimit } = await import('../src/ratelimit.js');
  const limit = rateLimit({ windowMs: 50, max: 2, key: (req) => req.k });
  const run = (k) => {
    let status = 200;
    limit({ k }, { set() {}, status: (s) => ((status = s), { json() {} }) }, () => {});
    return status;
  };
  assert.deepEqual([run('a'), run('a'), run('a'), run('b')], [200, 200, 429, 200]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(run('a'), 200);
});
