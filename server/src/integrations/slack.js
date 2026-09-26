// Live Slack adapter. PEAK connects to Slack over OAuth v2 ("Connect with Slack"): the user
// installs the app on their workspace, Slack hands back a bot token, and the user picks a
// channel from the list that token can see. No token or channel name is ever typed in.
//
// The adapter itself only needs a bot token with chat:write, so it still accepts a raw
// token (that is what older rows in the database hold, and what the tests use).
import { config } from '../config.js';

// One call helper for the whole file. `slackError` is the machine-readable code Slack
// returns (e.g. channel_not_found), which the connection flow turns into advice.
async function call(method, { token, body } = {}) {
  const res = await fetch(`${config.slack.apiUrl}/${method}`, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw Object.assign(new Error(`Slack ${method}: ${data.error}`), { slackError: data.error });
  return data;
}

export const slackOAuthEnabled = () => !!(config.slack.clientId && config.slack.clientSecret);

// Must match the app's Redirect URL in the Slack app manifest.
export const slackRedirectUri = () => `${config.appUrl}/api/auth/slack/callback`;

// Exchanges the one-time code for the bot token Slack minted for this installation.
// Returns the workspace it was installed into, so the UI can say which one it connected.
export async function slackExchangeCode(code) {
  const data = await call('oauth.v2.access', {
    body: { code, client_id: config.slack.clientId, client_secret: config.slack.clientSecret, redirect_uri: slackRedirectUri() },
  });
  if (!data.access_token) throw new Error('Slack did not return an access token');
  return {
    token: data.access_token,
    team: data.team?.name ?? null,
    teamId: data.team?.id ?? null,
    botUserId: data.bot_user_id ?? null,
  };
}

// Public and private channels the bot can see, as { id, name, private, member }.
// Private channels only appear once the bot has been invited to them.
export async function listChannels(botToken) {
  const out = [];
  for (let cursor = ''; ;) {
    const data = await call('conversations.list', {
      token: botToken,
      body: { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) },
    });
    out.push(
      ...(data.channels ?? []).map((c) => ({ id: c.id, name: c.name, private: c.is_private, member: c.is_member, archived: c.is_archived })),
    );
    cursor = data.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return out;
}

// The bot can only post where it is a member, so join the channel the user picked. Public
// channels work straight away; for a private one Slack refuses unless the app was added
// to it, and that refusal is what the caller turns into a helpful message.
export async function joinChannel(botToken, channel) {
  await call('conversations.join', { token: botToken, body: { channel } });
}

export function liveSlack({ botToken, webhookUrl, channel }) {
  const slack = (method, body) => call(method, { token: botToken, body });

  return {
    mode: 'live',
    describe: () => ({ channel, mode: 'live', via: botToken ? 'bot' : 'webhook' }),
    async post(message) {
      if (botToken) {
        const r = await slack('chat.postMessage', { channel, ...message });
        return { channel: r.channel, ts: r.ts };
      }
      const res = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
      if (!res.ok) throw new Error(`Slack webhook → ${res.status}: ${await res.text()}`);
      return { webhook: true };
    },
    async update(ref, message) {
      if (botToken && ref?.ts) return slack('chat.update', { channel: ref.channel, ts: ref.ts, ...message });
      return this.post(message); // webhooks can't edit: post the follow-up instead
    },
    async test() {
      if (botToken) return slack('auth.test', {});
      return { ok: true };
    },
  };
}
