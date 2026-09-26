// Email/password and GitHub OAuth sign-in. Sessions are random tokens in an httpOnly cookie.
import { Router } from 'express';
import { db, now, newId } from './db.js';
import { hashPassword, verifyPassword, token } from './crypto.js';
import { config } from './config.js';
import { applyEnvDefaults } from './integrations/defaults.js';
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

function createUser({ email, name, passwordHash, githubId }) {
  const workspaceId = newId('ws');
  const id = newId('usr');
  db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(workspaceId, `${name || email || 'My'}'s workspace`, now());
  db.prepare('INSERT INTO users (id, email, name, password_hash, github_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    email ?? null,
    name ?? null,
    passwordHash ?? null,
    githubId ?? null,
    workspaceId,
    now(),
  );
  applyEnvDefaults(workspaceId).catch((err) => console.warn('[defaults]', err.message));
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function startSession(res, userId) {
  const t = token(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(t, userId, expires.toISOString());
  res.cookie(COOKIE, t, { httpOnly: true, sameSite: 'lax', secure, expires, path: '/' });
}

const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => [c.slice(0, c.indexOf('=')).trim(), c.slice(c.indexOf('=') + 1).trim()])
      .filter(([k]) => k),
  );

export function currentUser(req) {
  const t = cookies(req)[COOKIE];
  if (!t) return null;
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?').get(t, now());
  return row ?? null;
}

export function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  req.workspaceId = user.workspace_id;
  next();
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, github: !!u.github_id });
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

export const authRoutes = Router();
authRoutes.use(['/signup', '/login', '/github', '/github/callback'], perIp);

authRoutes.get('/providers', (req, res) => res.json({ github: !!(config.github.clientId && config.github.clientSecret) }));

authRoutes.post('/signup', signupPerIp, (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const password = String(req.body.password ?? '');
  const name = String(req.body.name ?? '').trim() || null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Enter a valid email');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'An account with this email already exists', 409);
  const user = createUser({ email, name, passwordHash: hashPassword(password) });
  startSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

authRoutes.post('/login', loginPerEmail, (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) return bad(res, 'Wrong email or password', 401);
  loginPerEmail.reset(email);
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

authRoutes.post('/logout', (req, res) => {
  const t = cookies(req)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRoutes.get('/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: publicUser(user) });
});

// ——— GitHub OAuth (sign-in only; repository access is a separate token on the Connect page) ———

authRoutes.get('/github', (req, res) => {
  if (!config.github.clientId) return bad(res, 'GitHub sign-in is not configured', 404);
  const state = token(16);
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO oauth_states (state, expires_at) VALUES (?, ?)').run(state, new Date(Date.now() + 10 * 60_000).toISOString());
  const qs = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: `${config.appUrl}/api/auth/github/callback`,
    scope: 'read:user user:email',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${qs}`);
});

authRoutes.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  // Stored in the database so a server restart mid-login doesn't break it. Single use.
  const valid = state && db.prepare('DELETE FROM oauth_states WHERE state = ? AND expires_at > ?').run(String(state), now()).changes === 1;
  if (!code || !valid) return res.redirect(`${config.appUrl}/login?error=github`);
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code, redirect_uri: `${config.appUrl}/api/auth/github/callback` }),
    }).then((r) => r.json());
    if (!tokenRes.access_token) throw new Error(tokenRes.error_description ?? 'no access token');
    const gh = (path) => fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${tokenRes.access_token}`, 'user-agent': 'peak' } }).then((r) => r.json());
    const profile = await gh('/user');
    const emails = await gh('/user/emails');
    const email = (Array.isArray(emails) ? emails.find((e) => e.primary && e.verified)?.email : null) ?? profile.email ?? null;

    let user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(profile.id));
    if (!user && email) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
      if (user) db.prepare('UPDATE users SET github_id = ? WHERE id = ?').run(String(profile.id), user.id);
    }
    if (!user) user = createUser({ email: email?.toLowerCase(), name: profile.name || profile.login, githubId: String(profile.id) });
    startSession(res, user.id);
    res.redirect(config.appUrl);
  } catch (err) {
    console.warn('[auth] GitHub sign-in failed:', err.message);
    res.redirect(`${config.appUrl}/login?error=github`);
  }
});
