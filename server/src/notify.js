// Slack messages for an incident. One message per incident, updated as it progresses
// (bot token), or a new message per stage (incoming webhook).
import { config } from './config.js';
import { adapters } from './integrations/index.js';
import { getIncident, getService, updateIncident, addEvent } from './store.js';

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

const short = (sha) => (sha ? sha.slice(0, 7) : '');
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });

export function buildMessage(incident, service) {
  const link = `${config.appUrl}/incidents/${incident.id}`;
  const d = incident.diagnosis;
  const fix = d?.proposed_fix;
  const blocks = [];
  let text;

  const openButton = { type: 'button', text: { type: 'plain_text', text: 'Open in PEAK' }, url: link, action_id: 'open' };

  switch (incident.status) {
    case 'investigating':
      text = `🚨 Production incident: ${incident.title}`;
      blocks.push(section(`🚨 *Production incident*\n*${service.name}*: ${incident.title}`), section('🔎 PEAK is investigating: reading errors and recent commits…'));
      break;
    case 'awaiting_approval':
      text = `🚨 ${incident.title}: fix waiting for approval`;
      blocks.push(
        section(`🚨 *Production incident*\n*${service.name}*: ${incident.title}`),
        section(`*Root cause*\n${d?.summary ?? 'See PEAK'}`),
        ...(d?.suspect_commit ? [section(`*Likely caused by* commit \`${short(d.suspect_commit.sha)}\`: ${d.suspect_commit.message.split('\n')[0]}`)] : []),
        section(`*PEAK proposes*\nRevert commit \`${short(fix?.sha)}\`${fix?.reason ? `: ${fix.reason}` : ''}`),
        {
          type: 'actions',
          elements: [
            // Approve/Reject work from Slack only when interactivity is set up (signing secret + public URL).
            ...(config.slack.signingSecret
              ? [
                  { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve fix' }, action_id: 'approve', value: incident.id },
                  { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'reject', value: incident.id },
                ]
              : []),
            { ...openButton, text: { type: 'plain_text', text: config.slack.signingSecret ? 'Details' : 'Review & approve in PEAK' } },
          ],
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '⏳ Waiting for approval…' }] },
      );
      break;
    case 'fixing':
    case 'verifying':
      text = `🛠 ${incident.title}: fix applied, verifying`;
      blocks.push(
        section(`🛠 *Fix approved by ${incident.approval?.by ?? 'a teammate'}*\n*${service.name}*: ${incident.title}`),
        section(incident.fix ? `Reverted \`${short(incident.fix.targetSha)}\` with commit \`${short(incident.fix.revertSha)}\`. Verifying recovery…` : 'Applying the fix…'),
      );
      break;
    case 'resolved':
    case 'unresolved': {
      const v = incident.verification ?? {};
      const good = incident.status === 'resolved';
      text = `${good ? '✅ Incident resolved' : '⚠️ Fix did not resolve the incident'}: ${incident.title}`;
      const lines = [
        v.before && v.after ? `Errors: ${v.before.errorsPerMin ?? '?'}/min → ${v.after.errorsPerMin ?? '?'}/min` : null,
        v.after?.healthy != null ? `Health: ${v.after.healthy ? '🟢 healthy' : '🔴 failing'}` : null,
        v.deploy?.release ? `Deployment: ${v.deploy.confirmed ? 'running' : 'not confirmed,'} \`${short(v.deploy.release)}\`` : null,
        `Incident duration: ${formatDuration(new Date(incident.resolvedAt ?? Date.now()) - new Date(incident.startedAt))}`,
      ].filter(Boolean);
      blocks.push(section(`${good ? '✅ *Incident resolved*' : '⚠️ *Fix applied, but the service has not recovered*'}\n*${service.name}*: ${incident.title}`), section(lines.join('\n')));
      if (!good) blocks.push(section('A human needs to take over. PEAK has stopped acting on this incident.'));
      break;
    }
    case 'rejected':
      text = `✋ Fix rejected: ${incident.title}`;
      blocks.push(section(`✋ *Fix rejected by ${incident.approval?.by ?? 'a teammate'}*\n*${service.name}*: ${incident.title}${incident.approval?.reason ? `\n> ${incident.approval.reason}` : ''}`), section('No changes were made. The incident is handed to the team.'));
      break;
    case 'needs_attention':
      text = `👀 ${incident.title}: needs a human`;
      blocks.push(section(`👀 *Needs a human*\n*${service.name}*: ${incident.title}`), section(`*Finding*\n${d?.summary ?? 'PEAK could not find a safe automatic fix.'}\n${fix?.reason ? `\n${fix.reason}` : ''}`));
      break;
    case 'failed':
      text = `⚠️ PEAK could not finish investigating: ${incident.title}`;
      blocks.push(section(`⚠️ *Investigation failed*\n*${service.name}*: ${incident.title}\n${incident.agent?.error ?? ''}`));
      break;
    default:
      text = incident.title;
      blocks.push(section(text));
  }
  if (incident.status !== 'awaiting_approval') blocks.push({ type: 'actions', elements: [openButton] });
  return { text, blocks };
}

// Post the first message or update it. Slack failures are logged on the timeline, never thrown:
// a Slack outage must not stop incident handling.
export async function notify(incidentId) {
  const incident = getIncident(incidentId);
  const { slack } = adapters(incident.workspaceId);
  if (!slack) return;
  const message = buildMessage(incident, getService(incident.serviceId));
  try {
    if (incident.slack?.ref) {
      await slack.update(incident.slack.ref, message);
    } else {
      const ref = await slack.post(message);
      updateIncident(incidentId, { slack: { ref, channel: slack.describe().channel } });
    }
  } catch (err) {
    addEvent(incidentId, 'slack.error', 'Slack notification failed', { error: err.message });
  }
}
