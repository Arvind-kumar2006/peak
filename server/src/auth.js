// Email/password and GitHub OAuth sign-in. Sessions are random tokens in an httpOnly cookie.
import { Router } from 'express';
import { db, now, newId, kvSet } from './db.js';
import { hashPassword, verifyPassword, token, encrypt } from './crypto.js';
import { config } from './config.js';
import { rateLimit } from './ratelimit.js';

const MINUTE = 60_000;
// Per IP across all auth endpoints, plus per email on login (slows credential stuffing
// that rotates IPs against one account).
const perIp = rateLimit({ windowMs: 15 * MINUTE, max: 30 });
const signupPerIp = rateLimit({ windowMs: 60 * MINUTE, max: 10, message: 'Too many sign-ups from this address. Try again later.' });
export const loginPerEmail = rateLimit({ windowMs: 15 * MINUTE, max: 10, key: (req) => String(req.body?.email ?? '').trim().toLowerCase() || null });

const COOKIE = 'peak_session';
const SESSION_DAYS = 30;
const secure = config.appUrl.startsWith('https://');

// Workspace + user in one statement, so a failed insert never leaves an orphan workspace.
// A duplicate email/GitHub id raises a unique violation (23505).
async function createUser({ email, name, passwordHash, githubId }) {
  const workspaceId = newId('ws');
  const user = await db.one(
    `WITH ws AS (INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?) RETURNING id)
     INSERT INTO users (id, email, name, password_hash, github_id, workspace_id, created_at)
     SELECT ?, ?, ?, ?, ?, ws.id, ? FROM ws RETURNING *`,
    workspaceId,
    `${name || email || 'My'}'s workspace`,
    now(),
    newId('usr'),
    email ?? null,
    name ?? null,
    passwordHash ?? null,
    githubId ?? null,
    now(),
  );
  return user;
}

async function startSession(res, userId) {
  const t = token(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', t, userId, expires.toISOString());
  res.cookie(COOKIE, t, { httpOnly: true, sameSite: 'lax', secure, expires, path: '/' });
}

const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => [c.slice(0, c.indexOf('=')).trim(), c.slice(c.indexOf('=') + 1).trim()])
      .filter(([k]) => k),
  );

export async function currentUser(req) {
  const t = cookies(req)[COOKIE];
  if (!t) return null;
  return db.one('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?', t, now());
}

export async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    req.user = user;
    req.workspaceId = user.workspace_id;
    next();
  } catch (err) {
    next(err);
  }
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, github: !!u.github_id });
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });
const isUniqueViolation = (err) => err?.code === '23505';

export const authRoutes = Router();
authRoutes.use(['/signup', '/login', '/github', '/github/callback'], perIp);

authRoutes.get('/providers', (req, res) => res.json({ github: githubOAuthEnabled() }));

authRoutes.post('/signup', signupPerIp, async (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const password = String(req.body.password ?? '');
  const name = String(req.body.name ?? '').trim() || null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Enter a valid email');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters');
  let user;
  try {
    user = await createUser({ email, name, passwordHash: hashPassword(password) });
  } catch (err) {
    if (isUniqueViolation(err)) return bad(res, 'An account with this email already exists', 409);
    throw err;
  }
  await startSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

authRoutes.post('/login', loginPerEmail, async (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const user = await db.one('SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) return bad(res, 'Wrong email or password', 401);
  loginPerEmail.reset(email);
  await startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

authRoutes.post('/logout', async (req, res) => {
  const t = cookies(req)[COOKIE];
  if (t) await db.run('DELETE FROM sessions WHERE token = ?', t);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRoutes.get('/me', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: publicUser(user) });
});

// ——— GitHub OAuth ———
// One OAuth App, two uses (both come back to /api/auth/github/callback):
//   login   — sign in with GitHub (scope read:user user:email)
//   connect — a signed-in user connects their own GitHub to their workspace (scope repo);
//             the token is held until they pick a repository on the Connections page.

const CALLBACK = () => `${config.appUrl}/api/auth/github/callback`;
export const githubOAuthEnabled = () => !!(config.github.clientId && config.github.clientSecret);

export async function githubAuthorizeUrl({ purpose, workspaceId }) {
  const state = token(16);
  await db.run('DELETE FROM oauth_states WHERE expires_at < ?', now());
  await db.run(
    'INSERT INTO oauth_states (state, expires_at, purpose, workspace_id) VALUES (?, ?, ?, ?)',
    state,
    new Date(Date.now() + 10 * 60_000).toISOString(),
    purpose,
    workspaceId ?? null,
  );
  const qs = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: CALLBACK(),
    scope: purpose === 'connect' ? 'repo read:user' : 'read:user user:email',
    state,
    ...(purpose === 'connect' ? { prompt: 'select_account' } : {}),
  });
  return `https://github.com/login/oauth/authorize?${qs}`;
}

authRoutes.get('/github', async (req, res) => {
  if (!githubOAuthEnabled()) return bad(res, 'GitHub sign-in is not configured', 404);
  res.redirect(await githubAuthorizeUrl({ purpose: 'login' }));
});

authRoutes.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  // Stored in the database so a server restart mid-login doesn't break it. Single use.
  const row = state ? await db.one('DELETE FROM oauth_states WHERE state = ? AND expires_at > ? RETURNING *', String(state), now()) : null;
  const connecting = row?.purpose === 'connect';
  const failTo = connecting ? `${config.appUrl}/setup?github=error` : `${config.appUrl}/login?error=github`;
  if (!code || !row) return res.redirect(failTo);
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code, redirect_uri: CALLBACK() }),
    }).then((r) => r.json());
    if (!tokenRes.access_token) throw new Error(tokenRes.error_description ?? 'no access token');
    const gh = (path) => fetch(`${config.github.apiUrl}${path}`, { headers: { authorization: `Bearer ${tokenRes.access_token}`, 'user-agent': 'peak' } }).then((r) => r.json());
    const profile = await gh('/user');

    if (connecting) {
      // The user who started the flow must still be signed in to the same workspace.
      const user = await currentUser(req);
      if (!user || user.workspace_id !== row.workspace_id) throw new Error('session changed during GitHub connect');
      const pending = { token: tokenRes.access_token, login: profile.login, expiresAt: Date.now() + 30 * 60_000 };
      await kvSet(`github_pending:${row.workspace_id}`, await encrypt(pending));
      return res.redirect(`${config.appUrl}/setup?github=choose`);
    }

    const emails = await gh('/user/emails');
    const email = (Array.isArray(emails) ? emails.find((e) => e.primary && e.verified)?.email : null) ?? profile.email ?? null;

    let user = await db.one('SELECT * FROM users WHERE github_id = ?', String(profile.id));
    if (!user && email) {
      user = await db.one('SELECT * FROM users WHERE email = ?', email.toLowerCase());
      if (user) await db.run('UPDATE users SET github_id = ? WHERE id = ?', String(profile.id), user.id);
    }
    if (!user) user = await createUser({ email: email?.toLowerCase(), name: profile.name || profile.login, githubId: String(profile.id) });
    await startSession(res, user.id);
    res.redirect(config.appUrl);
  } catch (err) {
    console.warn(`[auth] GitHub ${connecting ? 'connect' : 'sign-in'} failed:`, err.message);
    res.redirect(failTo);
  }
});
