// Slack interactivity: the Approve / Reject buttons in incident messages.
// Set the app's Interactivity Request URL to <APP_URL>/api/slack/interactions and
// SLACK_SIGNING_SECRET in .env. Anyone who can see the message can approve.
import { Router, urlencoded } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { decide } from '../agent/runner.js';
import { getIncident } from '../store.js';
import { listIntegrations } from '../integrations/index.js';

export const slackRoutes = Router();

function verified(req) {
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!config.slack.signingSecret || !ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = `v0=${createHmac('sha256', config.slack.signingSecret).update(`v0:${ts}:${req.rawBody}`).digest('hex')}`;
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

slackRoutes.post(
  '/interactions',
  urlencoded({ extended: false, verify: (req, _res, buf) => (req.rawBody = buf.toString('utf8')) }),
  async (req, res) => {
    if (!verified(req)) return res.status(401).send('bad signature');
    const payload = JSON.parse(req.body.payload ?? '{}');
    const action = payload.actions?.[0];
    res.status(200).send(''); // ack within 3s; the message is updated by notify()
    if (!action || !['approve', 'reject'].includes(action.action_id)) return;

    const incident = getIncident(action.value);
    const slackConnected = incident && listIntegrations(incident.workspaceId).find((i) => i.kind === 'slack')?.connected;
    if (!slackConnected) return;
    const by = `${payload.user?.name ?? payload.user?.username ?? 'someone'} (Slack)`;
    try {
      await decide(incident.id, { decision: action.action_id, by, reason: action.action_id === 'reject' ? 'Rejected from Slack' : undefined });
    } catch (err) {
      if (payload.response_url) {
        await fetch(payload.response_url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: `PEAK: ${err.message}` }),
        }).catch(() => {});
      }
    }
  },
);
