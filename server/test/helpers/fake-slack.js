// Minimal in-process Slack Web API double: just enough of oauth.v2.access, conversations.list,
// conversations.join, auth.test and chat.postMessage to exercise PEAK's Slack connection flow.
import http from 'node:http';

export async function startFakeSlack({ token = 'xoxb-fake', team = 'Acme', channels = [], joinable = true } = {}) {
  const posted = [];
  const joined = [];
  let oauthCalls = 0;
  let canJoin = joinable;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const { pathname } = new URL(req.url, 'http://x');
    const method = pathname.split('/').pop();
    const send = (data, code = 200) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    const authed = req.headers.authorization === `Bearer ${token}`;

    if (method === 'oauth.v2.access') {
      oauthCalls++;
      if (body.code !== 'good-code') return send({ ok: false, error: 'bad_code' });
      return send({ ok: true, access_token: token, bot_user_id: 'U0PEAK', team: { id: 'T0ACME', name: team } });
    }
    if (method === 'auth.test') return send(authed ? { ok: true, user_id: 'U0PEAK', team } : { ok: false, error: 'invalid_auth' });
    if (method === 'conversations.list') {
      if (!authed) return send({ ok: false, error: 'invalid_auth' });
      // Two pages, so the cursor loop in listChannels is exercised.
      const page = Number(body.cursor || 0);
      const slice = channels.slice(page * 2, page * 2 + 2);
      const next = (page + 1) * 2 < channels.length ? String(page + 1) : '';
      return send({ ok: true, channels: slice, response_metadata: { next_cursor: next } });
    }
    if (method === 'conversations.join') {
      if (!canJoin) return send({ ok: false, error: 'channel_not_found' });
      joined.push(body.channel);
      return send({ ok: true, channel: { id: body.channel } });
    }
    if (method === 'chat.postMessage') {
      posted.push({ channel: body.channel, text: body.text });
      return send({ ok: true, channel: body.channel, ts: `${posted.length}.0001` });
    }
    if (method === 'chat.update') {
      posted.push({ channel: body.channel, text: body.text, edited: true });
      return send({ ok: true, channel: body.channel, ts: body.ts });
    }
    send({ ok: false, error: 'unknown_method' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    token,
    posted,
    joined,
    oauthCalls: () => oauthCalls,
    // Toggle what conversations.join does, to exercise the "can't post there" advice.
    setJoinable: (v) => (canJoin = v),
    close: () => server.close(),
  };
}

export const channel = (id, name, extra = {}) => ({ id, name, is_private: false, is_member: false, is_archived: false, ...extra });
