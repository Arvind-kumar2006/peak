// Connected sources per workspace → adapters (GitHub, Sentry, Slack).
import { db, now, json, parse } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { liveGithub, githubClient } from './github.js';
import { liveSentry } from './sentry.js';
import { liveSlack } from './slack.js';

export const KINDS = ['github', 'sentry', 'slack'];

function rows(workspaceId) {
  return db.prepare('SELECT * FROM integrations WHERE workspace_id = ?').all(workspaceId);
}

// What the UI may see: never the secrets.
export function listIntegrations(workspaceId) {
  const byKind = Object.fromEntries(rows(workspaceId).map((r) => [r.kind, r]));
  return KINDS.map((kind) => {
    const r = byKind[kind];
    return r ? { kind, connected: true, mode: r.mode, settings: parse(r.settings), connectedAt: r.connected_at } : { kind, connected: false };
  });
}

export function adapters(workspaceId) {
  const out = { github: null, sentry: null, slack: null };
  for (const r of rows(workspaceId)) {
    const settings = parse(r.settings);
    const secrets = r.secrets ? decrypt(r.secrets) : {};
    if (r.kind === 'github') out.github = liveGithub({ ...settings, token: secrets.token });
    if (r.kind === 'sentry') out.sentry = liveSentry({ ...settings, token: secrets.token });
    if (r.kind === 'slack') out.slack = liveSlack({ ...settings, ...secrets });
  }
  return out;
}

function save(workspaceId, kind, mode, settings, secrets) {
  db.prepare(
    `INSERT INTO integrations (workspace_id, kind, mode, settings, secrets, connected_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, kind) DO UPDATE SET mode = excluded.mode, settings = excluded.settings, secrets = excluded.secrets, connected_at = excluded.connected_at`,
  ).run(workspaceId, kind, mode, json(settings), secrets ? encrypt(secrets) : null, now());
}

const req = (v, name) => {
  const s = String(v ?? '').trim();
  if (!s) throw Object.assign(new Error(`${name} is required`), { status: 400 });
  return s;
};

// Validates credentials against the real API before saving, so a typo fails here and
// not in the middle of an incident.
export async function connect(workspaceId, kind, body) {
  if (!KINDS.includes(kind)) throw Object.assign(new Error(`Unknown integration ${kind}`), { status: 404 });
  const fail = (err) => {
    throw Object.assign(new Error(err.message), { status: 400 });
  };
  if (kind === 'github') {
    const token = req(body.token, 'Token');
    const repo = req(body.repo, 'Repository').replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '');
    const info = await githubClient(token)('GET', `/repos/${repo}`).catch(fail);
    if (!info.permissions?.push) fail(new Error(`The token can read ${repo} but cannot push to it; PEAK needs Contents: write to apply fixes`));
    save(workspaceId, kind, 'live', { repo: info.full_name, branch: String(body.branch || info.default_branch) }, { token });
  }
  if (kind === 'sentry') {
    const token = req(body.token, 'Auth token');
    const org = req(body.org, 'Organization slug');
    const url = String(body.url || 'https://sentry.io').trim();
    const projects = await liveSentry({ token, org, url }).listProjects().catch(fail);
    save(workspaceId, kind, 'live', { org, url, projects }, { token });
  }
  if (kind === 'slack') {
    const botToken = String(body.botToken ?? '').trim();
    const webhookUrl = String(body.webhookUrl ?? '').trim();
    if (!botToken && !webhookUrl) fail(new Error('Provide a bot token or an incoming webhook URL'));
    const channel = botToken ? req(body.channel, 'Channel') : String(body.channel || '(webhook channel)');
    const slack = liveSlack({ botToken, webhookUrl, channel });
    if (botToken) await slack.test().catch(fail);
    save(workspaceId, kind, 'live', { channel }, { botToken, webhookUrl });
  }
}

export function disconnect(workspaceId, kind) {
  db.prepare('DELETE FROM integrations WHERE workspace_id = ? AND kind = ?').run(workspaceId, kind);
}
