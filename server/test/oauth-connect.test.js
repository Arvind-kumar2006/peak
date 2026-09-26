// Connecting Slack and GitHub over OAuth instead of pasting credentials: the browser flow
// parks a token, the user picks a target, and only the encrypted token is kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'memory';
let slack, db, integrations, slackApi;

before(async () => {
  const { startFakeSlack, channel } = await import('./helpers/fake-slack.js');
  slack = await startFakeSlack({
    channels: [channel('C0ALERTS', 'alerts', { is_member: true }), channel('C0GENERAL', 'general'), channel('C0SECRET', 'secret', { is_private: true })],
  });
  Object.assign(process.env, { SLACK_API_URL: slack.url, SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'csec' });
  ({ db } = await import('../src/db.js'));
  slackApi = await import('../src/integrations/slack.js');
  integrations = await import('../src/integrations/index.js');
});

after(async () => {
  slack.close();
  await db.close();
});

const workspace = async (id) => {
  await db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', id, id, '2026-01-01');
  return id;
};

test('slackOAuthEnabled needs both id and secret', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(slackApi.slackOAuthEnabled(), true);
  const before2 = config.slack.clientId;
  config.slack.clientId = '';
  assert.equal(slackApi.slackOAuthEnabled(), false);
  config.slack.clientId = before2;
});

test('the authorize URL carries the configured scopes and the callback we registered', async () => {
  const { slackAuthorizeUrl } = await import('../src/auth.js');
  const url = new URL(await slackAuthorizeUrl({ workspaceId: 'ws_x' }));
  assert.equal(url.origin, 'https://slack.com');
  assert.equal(url.pathname, '/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.match(url.searchParams.get('scope'), /chat:write/);
  assert.match(url.searchParams.get('redirect_uri'), /\/api\/auth\/slack\/callback$/);
  assert.ok(url.searchParams.get('state'), 'carries a state to check on the way back');
  // The state is stored single-use, bound to the workspace that started the flow.
  const row = await db.one('SELECT * FROM oauth_states WHERE state = ?', url.searchParams.get('state'));
  assert.equal(row.purpose, 'slack');
  assert.equal(row.workspace_id, 'ws_x');
});

test('exchanging the code returns the bot token and the workspace it was installed on', async () => {
  const installed = await slackApi.slackExchangeCode('good-code');
  assert.equal(installed.token, slack.token);
  assert.equal(installed.team, 'Acme');
  assert.equal(installed.teamId, 'T0ACME');
  await assert.rejects(slackApi.slackExchangeCode('nope'), /bad_code/);
});

test('listChannels walks the cursor and flags private channels', async () => {
  const channels = await slackApi.listChannels(slack.token);
  assert.deepEqual(
    channels.map((c) => c.name),
    ['alerts', 'general', 'secret'],
  );
  assert.equal(channels[0].member, true, 'a channel the bot is already in is marked');
  assert.equal(channels[2].private, true);
});

test('connecting Slack joins the picked channel and stores only the encrypted token', async () => {
  const ws = await workspace('ws_slack');
  await integrations.connect(ws, 'slack', { botToken: slack.token, channel: 'C0GENERAL', channelName: 'general', team: 'Acme', teamId: 'T0ACME' });

  assert.deepEqual(slack.joined, ['C0GENERAL'], 'the bot joins the channel so it can post');

  const [row] = await integrations.listIntegrations(ws);
  const slackRow = (await db.all('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ?', ws, 'slack'))[0];
  assert.equal(JSON.parse(slackRow.settings).channel, 'C0GENERAL');
  assert.ok(!slackRow.secrets.includes(slack.token), 'the bot token is not stored in the clear');

  // The adapter that notify() uses works off that row.
  const { slack: adapter } = await integrations.adapters(ws);
  assert.equal(adapter.describe().channel, 'C0GENERAL');
  const ref = await adapter.post({ text: '🚨 investigating' });
  assert.equal(slack.posted.at(-1).channel, 'C0GENERAL');
  await adapter.update(ref, { text: '✅ resolved' }); // bot tokens can edit their own message
  assert.equal(slack.posted.length, 2);
});

test('connecting Slack refuses a bad token, and explains a channel the bot cannot join', async () => {
  const ws = await workspace('ws_slack_bad');
  await assert.rejects(integrations.connect(ws, 'slack', { botToken: 'xoxb-wrong', channel: 'C0GENERAL' }), /invalid_auth/);

  // A private channel the app was never added to: Slack says channel_not_found.
  slack.joined.length = 0;
  slack.setJoinable(false);
  await assert.rejects(integrations.connect(ws, 'slack', { botToken: slack.token, channel: 'C0SECRET', channelName: 'secret' }), /add the PEAK app to it in Slack first/);
  slack.setJoinable(true);
  assert.deepEqual(slack.joined, [], 'the bot never joined it');

  // Nothing was saved, so the card still reads "Not connected".
  assert.equal((await integrations.listIntegrations(ws)).find((i) => i.kind === 'slack').connected, false);
});

test('a channel id is required — it is picked from Slack, never typed', async () => {
  const ws = await workspace('ws_slack_noch');
  await assert.rejects(integrations.connect(ws, 'slack', { botToken: slack.token }), /Channel is required/);
  await assert.rejects(integrations.connect(ws, 'slack', { channel: 'C0GENERAL' }), /Slack authorization is required/);
});

test('GitHub connect is reached only through the OAuth path, and never keeps a raw token', async () => {
  const { startFakeGithub } = await import('./helpers/fake-github.js');
  const gh = await startFakeGithub();
  const { config } = await import('../src/config.js');
  const prev = config.github.apiUrl;
  config.github.apiUrl = gh.url;
  try {
    const ws = await workspace('ws_gh');
    gh.commit('init', { 'a.js': '1' });
    await integrations.connect(ws, 'github', { token: 'gho_oauth', repo: gh.repo, via: 'oauth', login: 'praveen' });

    const row = (await db.all('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ?', ws, 'github'))[0];
    const settings = JSON.parse(row.settings);
    assert.equal(settings.via, 'oauth');
    assert.equal(settings.login, 'praveen');
    assert.equal(settings.branch, 'main');
    assert.ok(!row.secrets.includes('gho_oauth'), 'the OAuth token is stored encrypted');
  } finally {
    config.github.apiUrl = prev;
    gh.close();
  }
});
