// Live Slack adapter: a bot token (chat:write) posts and updates messages; an incoming
// webhook URL works too, but can only post (no update when the incident resolves).
export function liveSlack({ botToken, webhookUrl, channel }) {
  async function slack(method, body) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
    return data;
  }

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
