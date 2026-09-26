// Connected sources per workspace → adapters (GitHub, Sentry, Slack).
import { db, now, json, parse } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { liveGithub, githubClient } from './github.js';
import { liveSentry } from './sentry.js';
import { joinChannel, liveSlack } from './slack.js';

export const KINDS = ['github', 'sentry', 'slack'];

const rows = (workspaceId) => db.all('SELECT * FROM integrations WHERE workspace_id = ?', workspaceId);

// What the UI may see: never the secrets.
export async function listIntegrations(workspaceId) {
  const byKind = Object.fromEntries((await rows(workspaceId)).map((r) => [r.kind, r]));
  return KINDS.map((kind) => {
    const r = byKind[kind];
    return r ? { kind, connected: true, mode: r.mode, settings: parse(r.settings), connectedAt: r.connected_at } : { kind, connected: false };
  });
}

export async function adapters(workspaceId) {
  const out = { github: null, sentry: null, slack: null };
  for (const r of await rows(workspaceId)) {
    const settings = parse(r.settings);
    const secrets = r.secrets ? await decrypt(r.secrets) : {};
    if (r.kind === 'github') out.github = liveGithub({ ...settings, token: secrets.token });
    if (r.kind === 'sentry') out.sentry = liveSentry({ ...settings, token: secrets.token });
    if (r.kind === 'slack') out.slack = liveSlack({ ...settings, ...secrets });
  }
  return out;
}

async function save(workspaceId, kind, mode, settings, secrets) {
  await db.run(
    `INSERT INTO integrations (workspace_id, kind, mode, settings, secrets, connected_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, kind) DO UPDATE SET mode = excluded.mode, settings = excluded.settings, secrets = excluded.secrets, connected_at = excluded.connected_at`,
    workspaceId,
    kind,
    mode,
    json(settings),
    secrets ? await encrypt(secrets) : null,
    now(),
  );
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
    if (!info.permissions?.push) fail(new Error(`You can read ${repo} but cannot push to it; PEAK needs write access to apply fixes`));
    const branch = String(body.branch || info.default_branch);
    await githubClient(token)('GET', `/repos/${info.full_name}/branches/${encodeURIComponent(branch)}`).catch(() => fail(new Error(`Branch ${branch} not found in ${info.full_name}`)));
    await save(workspaceId, kind, 'live', { repo: info.full_name, branch, via: 'oauth', login: body.login ?? null }, { token });
  }
  if (kind === 'sentry') {
    const token = req(body.token, 'Auth token');
    const org = req(body.org, 'Organization slug');
    const url = String(body.url || 'https://sentry.io').trim();
    const projects = await liveSentry({ token, org, url }).listProjects().catch(fail);
    await save(workspaceId, kind, 'live', { org, url, projects }, { token });
  }
  if (kind === 'slack') {
    // The token came from the OAuth callback; the channel is picked from the list that token
    // can see. Nothing here is typed in by hand.
    const botToken = req(body.botToken, 'Slack authorization');
    const channel = req(body.channel, 'Channel');
    await liveSlack({ botToken, channel }).test().catch(fail);
    // A bot can only post where it is a member. Public channels are joined on the spot; a
    // private one has to have the app added to it in Slack first.
    await joinChannel(botToken, channel).catch((err) =>
      fail(new Error(err.slackError === 'channel_not_found' || err.slackError === 'method_not_supported_for_channel_type' || err.slackError === 'is_archived'
        ? `PEAK's bot can't join #${channel}. For a private channel, add the PEAK app to it in Slack first, or pick a public one.`
        : `PEAK's bot can't join #${channel}: ${err.message}`)),
    );
    await save(workspaceId, kind, 'live', { channel, channelName: body.channelName ?? null, team: body.team ?? null, teamId: body.teamId ?? null, via: 'oauth' }, { botToken });
  }
}

export async function disconnect(workspaceId, kind) {
  await db.run('DELETE FROM integrations WHERE workspace_id = ? AND kind = ?', workspaceId, kind);
}
